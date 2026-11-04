export type Environment = "studio" | "car" | "phone" | "laptop" | "headphones";

export interface AudioSettings {
  eq: {
    low: number;
    lowMid: number;
    highMid: number;
    high: number;
  };
  compressor: {
    threshold: number;
    ratio: number;
    attack: number;
    release: number;
  };
  limiterCeiling: number;
  mono: boolean;
  pan: number;
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
  settings?: AudioSettings;
  environment?: Environment;
}

export interface Viewer {
  signedIn: boolean;
  email: string | null;
  isAdmin: boolean;
}
