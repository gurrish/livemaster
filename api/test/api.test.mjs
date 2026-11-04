import assert from "node:assert/strict";
import { test } from "node:test";

process.env.STORAGE_MODE = "memory";
process.env.DEV_AUTH = "true";
process.env.NODE_ENV = "development";
process.env.GLOBAL_ADMIN_EMAILS = "admin@local.test";

const { handle } = await import("../dist/src/index.js");
const context = { error: (...args) => { throw new Error(`Unexpected API error: ${args.join(" ")}`); } };
const adminHeaders = { "x-dev-user-email": "admin@local.test" };

function request(path, method = "GET", headers = {}, body) {
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

function wavFixture() {
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(40, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8_000, 24);
  bytes.writeUInt32LE(16_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(4, 40);
  return bytes;
}

test("admin-only WAV and preset API validates, stores, reads and deletes data", async () => {
  const denied = await handle(request("/api/tracks"), context);
  assert.equal(denied.status, 401);

  const forbidden = await handle(request("/api/tracks", "GET", { "x-dev-user-email": "visitor@local.test" }), context);
  assert.equal(forbidden.status, 403);

  const invalidAudio = await handle(request("/api/tracks", "POST", {
    ...adminHeaders,
    "content-type": "application/octet-stream",
    "x-file-name": "bad.wav",
  }, Buffer.from("not a WAV")), context);
  assert.equal(invalidAudio.status, 400);

  const truncatedWav = Buffer.alloc(44);
  truncatedWav.write("RIFF", 0);
  truncatedWav.writeUInt32LE(36, 4);
  truncatedWav.write("WAVE", 8);
  const invalidChunks = await handle(request("/api/tracks", "POST", {
    ...adminHeaders,
    "content-type": "application/octet-stream",
    "x-file-name": "truncated.wav",
  }, truncatedWav), context);
  assert.equal(invalidChunks.status, 400);

  const wav = wavFixture();
  const uploaded = await handle(request("/api/tracks", "POST", {
    ...adminHeaders,
    "content-type": "application/octet-stream",
    "x-file-name": encodeURIComponent("mix.wav"),
  }, wav), context);
  assert.equal(uploaded.status, 201);
  const track = await uploaded.json();
  assert.equal(track.name, "mix.wav");
  assert.equal(track.size, wav.length);

  const listed = await handle(request("/api/tracks", "GET", adminHeaders), context);
  assert.deepEqual(await listed.json(), [track]);
  const downloaded = await handle(request(`/api/tracks/${track.id}`, "GET", adminHeaders), context);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), wav);

  const presetInput = {
    name: "Mix A",
    settings: {
      eq: { low: 2, mid: 0, high: -1 },
      compressor: { threshold: -18, ratio: 4, attack: 0.003, release: 0.25 },
      limiterCeiling: -1,
    },
    environment: "studio",
  };
  const createdPreset = await handle(request("/api/presets", "POST", {
    ...adminHeaders,
    "content-type": "application/json",
  }, JSON.stringify(presetInput)), context);
  assert.equal(createdPreset.status, 201);
  const preset = await createdPreset.json();
  assert.equal(preset.name, "Mix A");

  const invalidPreset = await handle(request("/api/presets", "POST", {
    ...adminHeaders,
    "content-type": "application/json",
  }, JSON.stringify({ ...presetInput, settings: { ...presetInput.settings, limiterCeiling: 5 } })), context);
  assert.equal(invalidPreset.status, 400);

  assert.equal((await handle(request(`/api/presets/${preset.id}`, "DELETE", adminHeaders), context)).status, 200);
  assert.equal((await handle(request(`/api/tracks/${track.id}`, "DELETE", adminHeaders), context)).status, 200);
  assert.deepEqual(await (await handle(request("/api/tracks", "GET", adminHeaders), context)).json(), []);
});
