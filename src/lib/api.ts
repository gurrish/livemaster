import type { AudioTrack, Preset, PresetInput, Viewer } from "../types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (import.meta.env.DEV) {
    const email = localStorage.getItem("livemaster-dev-email");
    if (email) headers.set("x-dev-user-email", email);
  }
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || `Något gick fel (felkod ${response.status}).`);
  }
  return response.json() as Promise<T>;
}

export const getViewer = () => request<Viewer>("/api/me");
export const getPresets = () => request<Preset[]>("/api/presets");
export const createPreset = (preset: PresetInput) => request<Preset>("/api/presets", { method: "POST", body: JSON.stringify(preset) });
export const updatePreset = (id: string, preset: PresetInput) => request<Preset>(`/api/presets/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(preset) });
export const deletePreset = (id: string) => request<{ ok: true }>(`/api/presets/${encodeURIComponent(id)}`, { method: "DELETE" });
export const getTracks = () => request<AudioTrack[]>("/api/tracks");
const uploadChunkSize = 8 * 1024 * 1024;

export async function uploadTrack(file: File, onProgress?: (progress: number) => void): Promise<AudioTrack> {
  const uploadId = crypto.randomUUID();
  const chunkCount = Math.ceil(file.size / uploadChunkSize);
  try {
    for (let index = 0; index < chunkCount; index += 1) {
      const start = index * uploadChunkSize;
      const chunk = file.slice(start, Math.min(start + uploadChunkSize, file.size));
      await request<{ ok: true }>(`/api/uploads/${uploadId}/chunks/${index}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: chunk,
      });
      onProgress?.(Math.floor(((index + 1) / chunkCount) * 99));
    }
    const track = await request<AudioTrack>(`/api/uploads/${uploadId}/complete`, {
      method: "POST",
      headers: {
        "x-file-name": encodeURIComponent(file.name),
        "x-file-size": String(file.size),
        "x-chunk-count": String(chunkCount),
      },
    });
    onProgress?.(100);
    return track;
  } catch (error) {
    try {
      await request<{ ok: true }>(`/api/uploads/${uploadId}`, { method: "DELETE" });
    } catch (cleanupError) {
      throw new Error("Uppladdningen misslyckades och tillfälliga delar kunde inte rensas.", {
        cause: new AggregateError([error, cleanupError]),
      });
    }
    throw error;
  }
}
export const deleteTrack = (id: string) => request<{ ok: true }>(`/api/tracks/${encodeURIComponent(id)}`, { method: "DELETE" });

export async function downloadTrack(id: string): Promise<ArrayBuffer> {
  const headers = new Headers();
  if (import.meta.env.DEV) {
    const email = localStorage.getItem("livemaster-dev-email");
    if (email) headers.set("x-dev-user-email", email);
  }
  const response = await fetch(`/api/tracks/${encodeURIComponent(id)}`, { headers });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || `Begäran misslyckades (status ${response.status}).`);
  }
  return response.arrayBuffer();
}
