export type Environment = "studio" | "car" | "phone" | "laptop" | "headphones";

export interface AudioSettings {
  eq: {
    low: number;
    mid: number;
    high: number;
  };
  compressor: {
    threshold: number;
    ratio: number;
    attack: number;
    release: number;
  };
  limiterCeiling: number;
}

export interface Preset {
  id: string;
  name: string;
  settings: AudioSettings;
  environment: Environment;
  updatedAt: string;
}

export interface PresetInput {
  name: string;
  settings: AudioSettings;
  environment: Environment;
}

export interface AudioTrack {
  id: string;
  name: string;
  size: number;
  updatedAt: string;
}

export interface Viewer {
  signedIn: boolean;
  email: string | null;
  isAdmin: boolean;
}
