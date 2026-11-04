import { z } from "zod";

export const environmentSchema = z.enum(["studio", "car", "phone", "laptop", "headphones"]);

export const audioSettingsSchema = z.object({
  eq: z.object({
    low: z.number().min(-12).max(12),
    mid: z.number().min(-12).max(12),
    high: z.number().min(-12).max(12),
  }).strict(),
  compressor: z.object({
    threshold: z.number().min(-60).max(0),
    ratio: z.number().min(1).max(20),
    attack: z.number().min(0.001).max(1),
    release: z.number().min(0.01).max(1),
  }).strict(),
  limiterCeiling: z.number().min(-12).max(0),
}).strict();

export const presetInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  settings: audioSettingsSchema,
  environment: environmentSchema,
}).strict();

export type PresetInput = z.infer<typeof presetInputSchema>;
export type Preset = PresetInput & {
  id: string;
  updatedAt: string;
};

export interface AudioTrack {
  id: string;
  name: string;
  size: number;
  updatedAt: string;
}

export interface StoredAudioTrack {
  track: AudioTrack;
  bytes: Buffer;
}
