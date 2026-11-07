import { app, type HttpRequest, type InvocationContext } from "@azure/functions";
import { randomUUID } from "node:crypto";
import type { AudioTrack } from "./domain.js";
import { presetInputSchema, trackSettingsSchema } from "./domain.js";
import { createPreset, getRepository } from "./repository.js";

const maxTrackBytes = 100 * 1024 * 1024;
const maxChunkBytes = 8 * 1024 * 1024;
const maxTrackChunks = Math.ceil(maxTrackBytes / maxChunkBytes);
const trackIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Identity {
  id: string;
  email: string;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function identity(request: HttpRequest): Identity | undefined {
  const encoded = request.headers.get("x-ms-client-principal");
  if (!encoded && process.env.DEV_AUTH === "true" && process.env.NODE_ENV !== "production") {
    const email = (request.headers.get("x-dev-user-email") || process.env.DEV_AUTH_EMAIL || "").trim().toLowerCase();
    return email ? { id: email, email } : undefined;
  }
  if (!encoded) return undefined;

  try {
    const principal: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    if (!principal || typeof principal !== "object" || !("userDetails" in principal) || !("userId" in principal)) return undefined;
    const { userDetails, userId } = principal;
    if (typeof userDetails !== "string" || typeof userId !== "string" || !userDetails.includes("@")) return undefined;
    return { id: userId, email: userDetails.trim().toLowerCase() };
  } catch {
    return undefined;
  }
}

function isAdmin(email: string | undefined): boolean {
  if (!email) return false;
  const admins = (process.env.GLOBAL_ADMIN_EMAILS || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  return admins.includes(email.toLowerCase());
}

function requireAdmin(request: HttpRequest) {
  const actor = identity(request);
  if (!actor) throw new HttpError(401, "Logga in som administratör för att använda arbetsytan.");
  if (!isAdmin(actor.email)) throw new HttpError(403, "Kontot saknar behörighet att hantera ljudinställningar.");
  return actor;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function readBody(request: HttpRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Förfrågan innehåller ogiltig JSON.");
  }
}

function responsePath(pathname: string): string[] {
  try {
    return pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new HttpError(400, "Adressen innehåller ogiltig kodning.");
  }
}

function audioFileName(request: HttpRequest): string {
  const encoded = request.headers.get("x-file-name");
  if (!encoded) throw new HttpError(400, "Ange ett namn för WAV-filen.");
  let name: string;
  try {
    name = decodeURIComponent(encoded);
  } catch {
    throw new HttpError(400, "Filnamnet är ogiltigt.");
  }
  const basename = name.replace(/\\/g, "/").split("/").pop()?.replace(/[\u0000-\u001f\u007f]/g, "").trim() ?? "";
  if (!basename || basename.length > 180 || !basename.toLowerCase().endsWith(".wav")) {
    throw new HttpError(400, "Välj en WAV-fil med ett filnamn på högst 180 tecken.");
  }
  return basename;
}

function isWav(bytes: Buffer): boolean {
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") return false;
  const end = bytes.readUInt32LE(4) + 8;
  if (end > bytes.length || end < 44) return false;

  let hasFormat = false;
  let hasAudio = false;
  let offset = 12;
  while (offset + 8 <= end) {
    const chunkName = bytes.toString("ascii", offset, offset + 4);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (chunkSize + (chunkSize % 2) > end - dataOffset) return false;
    if (chunkName === "fmt ") {
      if (chunkSize < 16 || bytes.readUInt16LE(dataOffset + 2) === 0 || bytes.readUInt32LE(dataOffset + 4) === 0) return false;
      hasFormat = true;
    }
    if (chunkName === "data" && chunkSize > 0) hasAudio = true;
    offset = dataOffset + chunkSize + (chunkSize % 2);
  }
  return hasFormat && hasAudio;
}

export async function handle(request: HttpRequest, context: InvocationContext): Promise<Response> {
  try {
    const segments = responsePath(new URL(request.url).pathname);
    const [api, resource, id, action, indexSegment] = segments;
    if (api !== "api") throw new HttpError(404, "API-adressen hittades inte.");
    const method = request.method.toUpperCase();

    if (resource === "me" && method === "GET") {
      const actor = identity(request);
      return json({ signedIn: Boolean(actor), email: actor?.email ?? null, isAdmin: isAdmin(actor?.email) });
    }
    if (resource !== "presets" && resource !== "tracks" && resource !== "uploads") throw new HttpError(404, "API-adressen hittades inte.");
    requireAdmin(request);
    const repo = getRepository();

    if (resource === "uploads" && id) {
      if (!trackIdPattern.test(id)) throw new HttpError(404, "Uppladdningen hittades inte.");
      if (action === "chunks" && indexSegment !== undefined && segments.length === 5 && method === "POST") {
        const index = Number(indexSegment);
        const declaredLength = Number(request.headers.get("content-length") || 0);
        if (!Number.isSafeInteger(index) || index < 0 || index >= maxTrackChunks) throw new HttpError(400, "Uppladdningsdelen har ett ogiltigt nummer.");
        if (declaredLength > maxChunkBytes) throw new HttpError(413, "En uppladdningsdel får vara högst 8 MiB.");
        const bytes = Buffer.from(await request.arrayBuffer());
        if (!bytes.length || bytes.length > maxChunkBytes) throw new HttpError(413, "En uppladdningsdel får vara högst 8 MiB.");
        await repo.stageTrackChunk(id, index, bytes);
        return json({ ok: true });
      }
      if (!action && segments.length === 3 && method === "DELETE") {
        await repo.deleteStagedTrack(id);
        return json({ ok: true });
      }
      if (action === "complete" && !indexSegment && segments.length === 4 && method === "POST") {
        const name = audioFileName(request);
        const size = Number(request.headers.get("x-file-size"));
        const chunkCount = Number(request.headers.get("x-chunk-count"));
        if (!Number.isSafeInteger(size) || size <= 0) throw new HttpError(400, "Filstorleken är ogiltig.");
        if (size > maxTrackBytes) throw new HttpError(413, "Maximal storlek för WAV-filer är 100 MiB.");
        if (!Number.isSafeInteger(chunkCount) || chunkCount !== Math.ceil(size / maxChunkBytes)) {
          throw new HttpError(400, "Antalet uppladdningsdelar stämmer inte med filstorleken.");
        }
        const bytes = await repo.readStagedTrack(id, chunkCount);
        if (!bytes) throw new HttpError(400, "Uppladdningen saknar delar. Försök spara filen igen.");
        if (bytes.length !== size || !isWav(bytes)) {
          await repo.deleteStagedTrack(id);
          throw new HttpError(400, "Filen verkar inte vara en giltig WAV-ljudfil.");
        }
        const parsedSettings = trackSettingsSchema.safeParse(await readBody(request));
        if (!parsedSettings.success) throw new HttpError(400, "Kontrollera ljudinställningarna.");
        const track: AudioTrack = {
          ...parsedSettings.data,
          id,
          name,
          size: bytes.length,
          updatedAt: new Date().toISOString(),
        };
        await repo.saveTrack(track, bytes);
        await repo.deleteStagedTrack(id);
        return json(track, 201);
      }
      throw new HttpError(404, "API-adressen hittades inte.");
    }
    if (resource === "uploads") throw new HttpError(404, "API-adressen hittades inte.");

    if (resource === "tracks" && !id && method === "GET") {
      const tracks = await repo.listTracks();
      tracks.sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
      return json(tracks);
    }
    if (resource === "tracks" && !id && method === "POST") {
      const declaredLength = Number(request.headers.get("content-length") || 0);
      if (declaredLength > maxTrackBytes) throw new HttpError(413, "Maximal storlek för WAV-filer är 100 MiB.");
      const name = audioFileName(request);
      const bytes = Buffer.from(await request.arrayBuffer());
      if (!bytes.length || bytes.length > maxTrackBytes) throw new HttpError(413, "Maximal storlek för WAV-filer är 100 MiB.");
      if (!isWav(bytes)) throw new HttpError(400, "Filen verkar inte vara en giltig WAV-ljudfil.");
      const track: AudioTrack = {
        id: randomUUID(),
        name,
        size: bytes.length,
        updatedAt: new Date().toISOString(),
      };
      await repo.saveTrack(track, bytes);
      return json(track, 201);
    }
    if (resource === "tracks" && id) {
      if (!trackIdPattern.test(id)) throw new HttpError(404, "Ljudfilen hittades inte.");
      if (method === "GET") {
        const stored = await repo.readTrack(id);
        if (!stored) throw new HttpError(404, "Ljudfilen hittades inte.");
        return new Response(stored.bytes, {
          headers: {
            "Content-Type": "audio/wav",
            "Content-Length": String(stored.track.size),
            "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(stored.track.name)}`,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      if (action === "settings" && method === "PUT") {
        const parsed = trackSettingsSchema.safeParse(await readBody(request));
        if (!parsed.success) throw new HttpError(400, "Kontrollera ljudinställningarna.");
        const track = await repo.getTrack(id);
        if (!track) throw new HttpError(404, "Ljudfilen hittades inte.");
        await repo.updateTrackSettings(id, parsed.data.settings);
        return json({
          ...track,
          ...parsed.data,
          updatedAt: new Date().toISOString(),
        });
      }
      if (method === "DELETE") {
        if (!await repo.getTrack(id)) throw new HttpError(404, "Ljudfilen hittades inte.");
        await repo.deleteTrack(id);
        return json({ ok: true });
      }
      throw new HttpError(404, "API-adressen hittades inte.");
    }
    if (resource === "tracks") throw new HttpError(404, "API-adressen hittades inte.");

    if (!id && method === "GET") {
      const presets = await repo.listPresets();
      presets.sort((first, second) => first.name.localeCompare(second.name, "sv"));
      return json(presets);
    }
    if (!id && method === "POST") {
      const parsed = presetInputSchema.safeParse(await readBody(request));
      if (!parsed.success) throw new HttpError(400, "Kontrollera förinställningens uppgifter.");
      if ((await repo.listPresets()).length >= 100) throw new HttpError(409, "Gränsen på 100 sparade förinställningar har nåtts.");
      const preset = createPreset(randomUUID(), parsed.data);
      await repo.savePreset(preset);
      return json(preset, 201);
    }
    if (id && method === "PUT") {
      if (!await repo.getPreset(id)) throw new HttpError(404, "Förinställningen hittades inte.");
      const parsed = presetInputSchema.safeParse(await readBody(request));
      if (!parsed.success) throw new HttpError(400, "Kontrollera förinställningens uppgifter.");
      const preset = createPreset(id, parsed.data);
      await repo.savePreset(preset);
      return json(preset);
    }
    if (id && method === "DELETE") {
      if (!await repo.getPreset(id)) throw new HttpError(404, "Förinställningen hittades inte.");
      await repo.deletePreset(id);
      return json({ ok: true });
    }
    throw new HttpError(404, "API-adressen hittades inte.");
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    context.error("Request failed", error);
    return json({ error: "Förfrågan kunde inte behandlas. Försök igen senare." }, 500);
  }
}

app.http("api", {
  route: "{*path}",
  methods: ["GET", "POST", "PUT", "DELETE"],
  authLevel: "anonymous",
  handler: handle,
});
