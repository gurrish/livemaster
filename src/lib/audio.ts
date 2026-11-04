import type { AudioSettings, Environment } from "../types";

const profiles: Record<Environment, { lowCut: number; highCut: number; bass: number; presence: number }> = {
  studio: { lowCut: 20, highCut: 20_000, bass: 0, presence: 0 },
  car: { lowCut: 35, highCut: 16_000, bass: 2, presence: 1 },
  phone: { lowCut: 250, highCut: 7_000, bass: 0, presence: 2 },
  laptop: { lowCut: 130, highCut: 14_000, bass: 0, presence: 1 },
  headphones: { lowCut: 35, highCut: 18_000, bass: 0, presence: -1 },
};

interface EffectNodes {
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  compressor: DynamicsCompressorNode;
  limiter: DynamicsCompressorNode;
  environmentLow: BiquadFilterNode;
  environmentMid: BiquadFilterNode;
  environmentHigh: BiquadFilterNode;
  hardCeiling: WaveShaperNode;
  dry: GainNode;
  wet: GainNode;
}

function setValue(parameter: AudioParam, value: number, context: BaseAudioContext) {
  parameter.setTargetAtTime(value, context.currentTime, 0.015);
}

function createEffects(context: BaseAudioContext, settings: AudioSettings, environment: Environment, bypassed: boolean): EffectNodes {
  const low = context.createBiquadFilter();
  low.type = "lowshelf";
  low.frequency.value = 120;
  const mid = context.createBiquadFilter();
  mid.type = "peaking";
  mid.frequency.value = 1_000;
  mid.Q.value = 0.7;
  const high = context.createBiquadFilter();
  high.type = "highshelf";
  high.frequency.value = 8_000;

  const compressor = context.createDynamicsCompressor();
  compressor.knee.value = 12;
  const limiter = context.createDynamicsCompressor();
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.1;

  const environmentLow = context.createBiquadFilter();
  environmentLow.type = "highpass";
  environmentLow.Q.value = 0.707;
  const environmentMid = context.createBiquadFilter();
  environmentMid.type = "peaking";
  environmentMid.frequency.value = 2_000;
  environmentMid.Q.value = 0.7;
  const environmentHigh = context.createBiquadFilter();
  environmentHigh.type = "lowpass";
  environmentHigh.Q.value = 0.707;
  const hardCeiling = context.createWaveShaper();
  hardCeiling.oversample = "4x";
  const dry = context.createGain();
  const wet = context.createGain();
  dry.gain.value = bypassed ? 1 : 0;
  wet.gain.value = bypassed ? 0 : 1;

  const nodes = { low, mid, high, compressor, limiter, environmentLow, environmentMid, environmentHigh, hardCeiling, dry, wet };
  updateEffects(nodes, context, settings, environment, bypassed);
  return nodes;
}

function updateEffects(nodes: EffectNodes, context: BaseAudioContext, settings: AudioSettings, environment: Environment, bypassed: boolean) {
  setValue(nodes.low.gain, settings.eq.low, context);
  setValue(nodes.mid.gain, settings.eq.mid, context);
  setValue(nodes.high.gain, settings.eq.high, context);
  setValue(nodes.compressor.threshold, settings.compressor.threshold, context);
  setValue(nodes.compressor.ratio, settings.compressor.ratio, context);
  setValue(nodes.compressor.attack, settings.compressor.attack, context);
  setValue(nodes.compressor.release, settings.compressor.release, context);
  setValue(nodes.limiter.threshold, settings.limiterCeiling, context);

  const profile = profiles[environment];
  setValue(nodes.environmentLow.frequency, profile.lowCut, context);
  setValue(nodes.environmentMid.gain, profile.presence, context);
  setValue(nodes.environmentHigh.frequency, profile.highCut, context);
  setValue(nodes.environmentLow.Q, 0.707, context);
  setValue(nodes.environmentHigh.Q, 0.707, context);
  setValue(nodes.low.gain, settings.eq.low + profile.bass, context);
  const ceiling = bypassed ? 1 : 10 ** (settings.limiterCeiling / 20);
  const curve = new Float32Array(32_769);
  for (let index = 0; index < curve.length; index += 1) {
    const sample = (index / (curve.length - 1)) * 2 - 1;
    curve[index] = Math.max(-ceiling, Math.min(ceiling, sample));
  }
  nodes.hardCeiling.curve = curve;
  setValue(nodes.dry.gain, bypassed ? 1 : 0, context);
  setValue(nodes.wet.gain, bypassed ? 0 : 1, context);
}

export function connectAudioEffects(
  source: AudioNode,
  context: BaseAudioContext,
  settings: AudioSettings,
  environment: Environment,
  bypassed = false,
): EffectNodes {
  const nodes = createEffects(context, settings, environment, bypassed);
  source.connect(nodes.dry);
  nodes.dry.connect(context.destination);
  source.connect(nodes.low);
  nodes.low.connect(nodes.mid);
  nodes.mid.connect(nodes.high);
  nodes.high.connect(nodes.compressor);
  nodes.compressor.connect(nodes.limiter);
  nodes.limiter.connect(nodes.environmentLow);
  nodes.environmentLow.connect(nodes.environmentMid);
  nodes.environmentMid.connect(nodes.environmentHigh);
  nodes.environmentHigh.connect(nodes.hardCeiling);
  nodes.hardCeiling.connect(nodes.wet);
  nodes.wet.connect(context.destination);
  return nodes;
}

export function updateAudioEffects(
  nodes: EffectNodes | null,
  context: BaseAudioContext | null,
  settings: AudioSettings,
  environment: Environment,
  bypassed: boolean,
) {
  if (nodes && context) updateEffects(nodes, context, settings, environment, bypassed);
}

export async function renderWav(
  input: AudioBuffer,
  settings: AudioSettings,
  environment: Environment,
  bypassed: boolean,
): Promise<Blob> {
  const context = new OfflineAudioContext(input.numberOfChannels, input.length, input.sampleRate);
  const source = context.createBufferSource();
  source.buffer = input;
  connectAudioEffects(source, context, settings, environment, bypassed);
  source.start();
  const rendered = await context.startRendering();
  const channels = rendered.numberOfChannels;
  const samples = rendered.length;
  const bytes = new ArrayBuffer(44 + samples * channels * 2);
  const view = new DataView(bytes);
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };

  writeText(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rendered.sampleRate, true);
  view.setUint32(28, rendered.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples * channels * 2, true);

  const channelData = Array.from({ length: channels }, (_, channel) => rendered.getChannelData(channel));
  const ceiling = 10 ** (settings.limiterCeiling / 20);
  let offset = 44;
  for (let sample = 0; sample < samples; sample += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = Math.max(-ceiling, Math.min(ceiling, channelData[channel][sample]));
      view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([bytes], { type: "audio/wav" });
}
