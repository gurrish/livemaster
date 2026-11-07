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
  updatedAt: string;
}

export interface PresetInput {
  name: string;
  settings: AudioSettings;
}

export interface AudioTrack {
  id: string;
  name: string;
  size: number;
  updatedAt: string;
  settings?: AudioSettings;
}

export interface Viewer {
  signedIn: boolean;
  email: string | null;
  isAdmin: boolean;
}
