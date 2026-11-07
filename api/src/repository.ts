import { TableClient, type TableEntity } from "@azure/data-tables";
import { BlobServiceClient } from "@azure/storage-blob";
import { audioSettingsSchema, presetInputSchema, type AudioSettings, type AudioTrack, type Preset, type PresetInput, type StoredAudioTrack } from "./domain.js";

export interface Repository {
  listPresets(): Promise<Preset[]>;
  getPreset(id: string): Promise<Preset | undefined>;
  savePreset(preset: Preset): Promise<void>;
  deletePreset(id: string): Promise<void>;
  listTracks(): Promise<AudioTrack[]>;
  getTrack(id: string): Promise<AudioTrack | undefined>;
  saveTrack(track: AudioTrack, bytes: Buffer): Promise<void>;
  updateTrackSettings(id: string, settings: AudioSettings): Promise<void>;
  stageTrackChunk(id: string, index: number, bytes: Buffer): Promise<void>;
  readStagedTrack(id: string, chunkCount: number): Promise<Buffer | undefined>;
  deleteStagedTrack(id: string): Promise<void>;
  readTrack(id: string): Promise<StoredAudioTrack | undefined>;
  deleteTrack(id: string): Promise<void>;
}

type StoredPreset = TableEntity<Record<string, unknown>>;
type StoredTrack = TableEntity<Record<string, unknown>>;

function fromEntity(entity: StoredPreset): Preset {
  if (typeof entity.rowKey !== "string" || typeof entity.updatedAt !== "string" || typeof entity.settings !== "string") {
    throw new Error("Stored preset has an invalid shape.");
  }
  const settings: unknown = JSON.parse(entity.settings);
  const input = presetInputSchema.parse({
    name: entity.name,
    settings,
  });
  return { ...input, id: entity.rowKey, updatedAt: entity.updatedAt };
}

export class MemoryRepository implements Repository {
  private readonly presets = new Map<string, Preset>();
  private readonly tracks = new Map<string, StoredAudioTrack>();
  private readonly stagedTracks = new Map<string, Map<number, Buffer>>();

  async listPresets(): Promise<Preset[]> {
    return [...this.presets.values()].map((preset) => structuredClone(preset));
  }
  async getPreset(id: string): Promise<Preset | undefined> {
    const preset = this.presets.get(id);
    return preset ? structuredClone(preset) : undefined;
  }
  async savePreset(preset: Preset): Promise<void> {
    this.presets.set(preset.id, structuredClone(preset));
  }
  async deletePreset(id: string): Promise<void> {
    this.presets.delete(id);
  }
  async listTracks(): Promise<AudioTrack[]> {
    return [...this.tracks.values()].map(({ track }) => structuredClone(track));
  }
  async getTrack(id: string): Promise<AudioTrack | undefined> {
    const stored = this.tracks.get(id);
    return stored ? structuredClone(stored.track) : undefined;
  }
  async saveTrack(track: AudioTrack, bytes: Buffer): Promise<void> {
    this.tracks.set(track.id, { track: structuredClone(track), bytes: Buffer.from(bytes) });
  }
  async updateTrackSettings(id: string, settings: AudioSettings): Promise<void> {
    const stored = this.tracks.get(id);
    if (stored) stored.track = { ...stored.track, settings: structuredClone(settings), updatedAt: new Date().toISOString() };
  }
  async stageTrackChunk(id: string, index: number, bytes: Buffer): Promise<void> {
    const chunks = this.stagedTracks.get(id) ?? new Map<number, Buffer>();
    chunks.set(index, Buffer.from(bytes));
    this.stagedTracks.set(id, chunks);
  }
  async readStagedTrack(id: string, chunkCount: number): Promise<Buffer | undefined> {
    const chunks = this.stagedTracks.get(id);
    if (!chunks) return undefined;
    const ordered = Array.from({ length: chunkCount }, (_, index) => chunks.get(index));
    return ordered.every((chunk): chunk is Buffer => chunk !== undefined) ? Buffer.concat(ordered) : undefined;
  }
  async deleteStagedTrack(id: string): Promise<void> {
    this.stagedTracks.delete(id);
  }
  async readTrack(id: string): Promise<StoredAudioTrack | undefined> {
    const stored = this.tracks.get(id);
    return stored ? { track: structuredClone(stored.track), bytes: Buffer.from(stored.bytes) } : undefined;
  }
  async deleteTrack(id: string): Promise<void> {
    this.tracks.delete(id);
  }
}

export class TableRepository implements Repository {
  private readonly table: TableClient;
  private readonly tracks: TableClient;
  private readonly blobs: BlobServiceClient;

  constructor(connectionString: string) {
    this.table = TableClient.fromConnectionString(connectionString, "AudioPresets");
    this.tracks = TableClient.fromConnectionString(connectionString, "AudioTracks");
    this.blobs = BlobServiceClient.fromConnectionString(connectionString);
  }

  private async ensureTable() {
    await this.table.createTable().catch((error: unknown) => {
      if (!(error instanceof Error) || !("statusCode" in error) || error.statusCode !== 409) throw error;
    });
  }

  async listPresets(): Promise<Preset[]> {
    await this.ensureTable();
    const presets: Preset[] = [];
    for await (const entity of this.table.listEntities<StoredPreset>()) presets.push(fromEntity(entity));
    return presets;
  }

  async getPreset(id: string): Promise<Preset | undefined> {
    try {
      return fromEntity(await this.table.getEntity<StoredPreset>("presets", id));
    } catch (error) {
      if (error instanceof Error && "statusCode" in error && error.statusCode === 404) return undefined;
      throw error;
    }
  }

  async savePreset(preset: Preset): Promise<void> {
    await this.ensureTable();
    const { id, settings, ...fields } = preset;
    await this.table.upsertEntity({
      partitionKey: "presets",
      rowKey: id,
      ...fields,
      settings: JSON.stringify(settings),
    }, "Replace");
  }

  async deletePreset(id: string): Promise<void> {
    try {
      await this.table.deleteEntity("presets", id);
    } catch (error) {
      if (!(error instanceof Error) || !("statusCode" in error) || error.statusCode !== 404) throw error;
    }
  }

  async listTracks(): Promise<AudioTrack[]> {
    await this.ensureTrackTable();
    const result: AudioTrack[] = [];
    for await (const entity of this.tracks.listEntities<StoredTrack>()) result.push(this.trackFromEntity(entity));
    return result;
  }

  private async ensureTrackTable() {
    await this.tracks.createTable().catch((error: unknown) => {
      if (!(error instanceof Error) || !("statusCode" in error) || error.statusCode !== 409) throw error;
    });
  }

  private trackFromEntity(entity: StoredTrack): AudioTrack {
    if (typeof entity.rowKey !== "string" || typeof entity.name !== "string"
      || typeof entity.size !== "number" || typeof entity.updatedAt !== "string") {
      throw new Error("Stored audio track has an invalid shape.");
    }
    const track: AudioTrack = { id: entity.rowKey, name: entity.name, size: entity.size, updatedAt: entity.updatedAt };
    if (typeof entity.settings === "string") track.settings = audioSettingsSchema.parse(JSON.parse(entity.settings));
    return track;
  }

  async getTrack(id: string): Promise<AudioTrack | undefined> {
    try {
      return this.trackFromEntity(await this.tracks.getEntity<StoredTrack>("tracks", id));
    } catch (error) {
      if (error instanceof Error && "statusCode" in error && error.statusCode === 404) return undefined;
      throw error;
    }
  }

  private audioContainer() {
    return this.blobs.getContainerClient("audio-tracks");
  }

  private stagedBlobId(id: string) {
    return `upload-${id}`;
  }

  private blockId(index: number) {
    return Buffer.from(index.toString().padStart(8, "0")).toString("base64");
  }

  async saveTrack(track: AudioTrack, bytes: Buffer): Promise<void> {
    const container = this.audioContainer();
    await container.createIfNotExists();
    await container.getBlockBlobClient(track.id).uploadData(bytes, {
      blobHTTPHeaders: { blobContentType: "audio/wav" },
    });
    try {
      await this.ensureTrackTable();
      await this.tracks.upsertEntity({
        partitionKey: "tracks",
        rowKey: track.id,
        name: track.name,
        size: track.size,
        updatedAt: track.updatedAt,
        ...(track.settings ? { settings: JSON.stringify(track.settings) } : {}),
      }, "Replace");
    } catch (error) {
      await container.getBlockBlobClient(track.id).deleteIfExists();
      throw error;
    }
  }

  async updateTrackSettings(id: string, settings: AudioSettings): Promise<void> {
    const track = await this.getTrack(id);
    if (!track) return;
    await this.ensureTrackTable();
    await this.tracks.upsertEntity({
      partitionKey: "tracks",
      rowKey: id,
      name: track.name,
      size: track.size,
      updatedAt: new Date().toISOString(),
      settings: JSON.stringify(settings),
    }, "Replace");
  }

  async stageTrackChunk(id: string, index: number, bytes: Buffer): Promise<void> {
    const container = this.audioContainer();
    await container.createIfNotExists();
    await container.getBlockBlobClient(this.stagedBlobId(id)).stageBlock(this.blockId(index), bytes, bytes.length);
  }

  async readStagedTrack(id: string, chunkCount: number): Promise<Buffer | undefined> {
    const blob = this.audioContainer().getBlockBlobClient(this.stagedBlobId(id));
    const blocks = await blob.getBlockList("uncommitted");
    const stagedIds = new Set((blocks.uncommittedBlocks ?? []).map((block) => block.name));
    const blockIds = Array.from({ length: chunkCount }, (_, index) => this.blockId(index));
    if (!blockIds.every((blockId) => stagedIds.has(blockId))) return undefined;
    await blob.commitBlockList(blockIds, { blobHTTPHeaders: { blobContentType: "application/octet-stream" } });
    return blob.downloadToBuffer();
  }

  async deleteStagedTrack(id: string): Promise<void> {
    await this.audioContainer().getBlockBlobClient(this.stagedBlobId(id)).deleteIfExists();
  }

  async readTrack(id: string): Promise<StoredAudioTrack | undefined> {
    const track = await this.getTrack(id);
    if (!track) return undefined;
    try {
      const bytes = await this.audioContainer().getBlockBlobClient(id).downloadToBuffer();
      return { track, bytes };
    } catch (error) {
      if (error instanceof Error && "statusCode" in error && error.statusCode === 404) return undefined;
      throw error;
    }
  }

  async deleteTrack(id: string): Promise<void> {
    await this.audioContainer().getBlockBlobClient(id).deleteIfExists();
    try {
      await this.tracks.deleteEntity("tracks", id);
    } catch (error) {
      if (!(error instanceof Error) || !("statusCode" in error) || error.statusCode !== 404) throw error;
    }
  }
}

let repository: Repository | undefined;
export function getRepository(): Repository {
  if (repository) return repository;
  const mode = process.env.STORAGE_MODE ?? (process.env.NODE_ENV === "development" ? "memory" : "table");
  if (mode === "memory") repository = new MemoryRepository();
  else if (mode === "table" && process.env.STORAGE_CONNECTION_STRING) {
    repository = new TableRepository(process.env.STORAGE_CONNECTION_STRING);
  } else {
    throw new Error("Configure STORAGE_CONNECTION_STRING with STORAGE_MODE=table, or use STORAGE_MODE=memory locally.");
  }
  return repository;
}

export function createPreset(id: string, input: PresetInput): Preset {
  return { ...input, id, updatedAt: new Date().toISOString() };
}
