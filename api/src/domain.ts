import { z } from "zod";

export const environmentSchema = z.enum(["studio", "car", "phone", "laptop", "headphones"]);
export type Environment = z.infer<typeof environmentSchema>;

export const audioSettingsSchema = z.object({
  eq: z.object({
    low: z.number().min(-12).max(12),
    lowMid: z.number().min(-12).max(12).optional(),
    highMid: z.number().min(-12).max(12).optional(),
    mid: z.number().min(-12).max(12).optional(),
    high: z.number().min(-12).max(12),
  }).strict().transform(({ mid, lowMid, highMid, ...eq }) => ({
    ...eq,
    lowMid: lowMid ?? 0,
    highMid: highMid ?? mid ?? 0,
  })),
  compressor: z.object({
    threshold: z.number().min(-60).max(0),
    ratio: z.number().min(1).max(20),
    attack: z.number().min(0.001).max(1),
    release: z.number().min(0.01).max(1),
  }).strict(),
  limiterCeiling: z.number().min(-12).max(0),
  mono: z.boolean().default(false),
  pan: z.number().min(-1).max(1).default(0),
}).strict();

export type AudioSettings = z.infer<typeof audioSettingsSchema>;
export const presetInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  settings: audioSettingsSchema,
  environment: environmentSchema,
}).strict();

export const trackSettingsSchema = z.object({
  settings: audioSettingsSchema,
  environment: environmentSchema,
}).strict();

export type PresetInput = z.infer<typeof presetInputSchema>;
export type TrackSettings = z.infer<typeof trackSettingsSchema>;
export type Preset = PresetInput & {
  id: string;
  updatedAt: string;
};

export interface AudioTrack {
  id: string;
  name: string;
  size: number;
  updatedAt: string;
  settings?: AudioSettings;
  environment?: Environment;
}

export interface StoredAudioTrack {
  track: AudioTrack;
  bytes: Buffer;
}
