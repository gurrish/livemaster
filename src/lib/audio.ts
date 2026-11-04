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
  lowMid: BiquadFilterNode;
  highMid: BiquadFilterNode;
  high: BiquadFilterNode;
  compressor: DynamicsCompressorNode;
  limiter: DynamicsCompressorNode;
  environmentLow: BiquadFilterNode;
  environmentMid: BiquadFilterNode;
  environmentHigh: BiquadFilterNode;
  hardCeiling: WaveShaperNode;
  dry: GainNode;
  wet: GainNode;
  output: GainNode;
}

function setValue(parameter: AudioParam, value: number, context: BaseAudioContext) {
  parameter.setTargetAtTime(value, context.currentTime, 0.015);
}

function createEffects(context: BaseAudioContext, settings: AudioSettings, environment: Environment, bypassed: boolean, outputGain: number): EffectNodes {
  const low = context.createBiquadFilter();
  low.type = "lowshelf";
  low.frequency.value = 120;
  const lowMid = context.createBiquadFilter();
  lowMid.type = "peaking";
  lowMid.frequency.value = 500;
  lowMid.Q.value = 0.7;
  const highMid = context.createBiquadFilter();
  highMid.type = "peaking";
  highMid.frequency.value = 2_500;
  highMid.Q.value = 0.7;
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
  const output = context.createGain();
  dry.gain.value = bypassed ? 1 : 0;
  wet.gain.value = bypassed ? 0 : 1;
  output.gain.value = outputGain;

  const nodes = { low, lowMid, highMid, high, compressor, limiter, environmentLow, environmentMid, environmentHigh, hardCeiling, dry, wet, output };
  updateEffects(nodes, context, settings, environment, bypassed, outputGain);
  return nodes;
}

function updateEffects(nodes: EffectNodes, context: BaseAudioContext, settings: AudioSettings, environment: Environment, bypassed: boolean, outputGain: number) {
  setValue(nodes.low.gain, settings.eq.low, context);
  setValue(nodes.lowMid.gain, settings.eq.lowMid, context);
  setValue(nodes.highMid.gain, settings.eq.highMid, context);
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
  setValue(nodes.output.gain, outputGain, context);
}

export function connectAudioEffects(
  source: AudioNode,
  context: BaseAudioContext,
  settings: AudioSettings,
  environment: Environment,
  bypassed = false,
  outputGain = 1,
): EffectNodes {
  const nodes = createEffects(context, settings, environment, bypassed, outputGain);
  source.connect(nodes.dry);
  nodes.dry.connect(nodes.output);
  source.connect(nodes.low);
  nodes.low.connect(nodes.lowMid);
  nodes.lowMid.connect(nodes.highMid);
  nodes.highMid.connect(nodes.high);
  nodes.high.connect(nodes.compressor);
  nodes.compressor.connect(nodes.limiter);
  nodes.limiter.connect(nodes.environmentLow);
  nodes.environmentLow.connect(nodes.environmentMid);
  nodes.environmentMid.connect(nodes.environmentHigh);
  nodes.environmentHigh.connect(nodes.hardCeiling);
  nodes.hardCeiling.connect(nodes.wet);
  nodes.wet.connect(nodes.output);
  nodes.output.connect(context.destination);
  return nodes;
}

export function updateAudioEffects(
  nodes: EffectNodes | null,
  context: BaseAudioContext | null,
  settings: AudioSettings,
  environment: Environment,
  bypassed: boolean,
  outputGain = 1,
) {
  if (nodes && context) updateEffects(nodes, context, settings, environment, bypassed, outputGain);
}

async function renderAudio(
  input: AudioBuffer,
  settings: AudioSettings,
  environment: Environment,
  bypassed: boolean,
): Promise<AudioBuffer> {
  const context = new OfflineAudioContext(input.numberOfChannels, input.length, input.sampleRate);
  const source = context.createBufferSource();
  source.buffer = input;
  connectAudioEffects(source, context, settings, environment, bypassed);
  source.start();
  return context.startRendering();
}

interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function highPassCoefficients(sampleRate: number): BiquadCoefficients {
  const frequency = 38.13547087602444;
  const q = 0.5003270373238773;
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const cosine = Math.cos(omega);
  const alpha = Math.sin(omega) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cosine) / (2 * a0),
    b1: -(1 + cosine) / a0,
    b2: (1 + cosine) / (2 * a0),
    a1: (-2 * cosine) / a0,
    a2: (1 - alpha) / a0,
  };
}

function highShelfCoefficients(sampleRate: number): BiquadCoefficients {
  const frequency = 1_681.974450955533;
  const gain = 3.999843853973347;
  const slope = 1;
  const amplitude = 10 ** (gain / 40);
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const cosine = Math.cos(omega);
  const sine = Math.sin(omega);
  const alpha = (sine / 2) * Math.sqrt((amplitude + 1 / amplitude) * (1 / slope - 1) + 2);
  const beta = 2 * Math.sqrt(amplitude) * alpha;
  const a0 = (amplitude + 1) - (amplitude - 1) * cosine + beta;
  return {
    b0: (amplitude * ((amplitude + 1) + (amplitude - 1) * cosine + beta)) / a0,
    b1: (-2 * amplitude * ((amplitude - 1) + (amplitude + 1) * cosine)) / a0,
    b2: (amplitude * ((amplitude + 1) + (amplitude - 1) * cosine - beta)) / a0,
    a1: (2 * ((amplitude - 1) - (amplitude + 1) * cosine)) / a0,
    a2: ((amplitude + 1) - (amplitude - 1) * cosine - beta) / a0,
  };
}

function filterSample(value: number, coefficients: BiquadCoefficients, state: [number, number]): number {
  const output = coefficients.b0 * value + state[0];
  state[0] = coefficients.b1 * value - coefficients.a1 * output + state[1];
  state[1] = coefficients.b2 * value - coefficients.a2 * output;
  return output;
}

function integratedLufs(buffer: AudioBuffer): number | null {
  const frameCount = buffer.length;
  if (frameCount === 0) return null;
  const sampleRate = buffer.sampleRate;
  const windowSize = Math.min(frameCount, Math.max(1, Math.round(sampleRate * 0.4)));
  const hopSize = Math.max(1, Math.round(sampleRate * 0.1));
  const ring = new Float64Array(windowSize);
  const shelf = highShelfCoefficients(sampleRate);
  const highPass = highPassCoefficients(sampleRate);
  const channelData = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
  const shelfStates = channelData.map((): [number, number] => [0, 0]);
  const highPassStates = channelData.map((): [number, number] => [0, 0]);
  const blocks: number[] = [];
  let runningEnergy = 0;
  let nextBlockFrame = windowSize - 1;

  for (let frame = 0; frame < frameCount; frame += 1) {
    let frameEnergy = 0;
    for (let channel = 0; channel < channelData.length; channel += 1) {
      if (channel === 3 && channelData.length >= 6) continue;
      const weighted = filterSample(
        filterSample(channelData[channel][frame], shelf, shelfStates[channel]),
        highPass,
        highPassStates[channel],
      );
      const channelWeight = channel >= 4 || (channel === 3 && channelData.length < 6) ? 1.41 : 1;
      frameEnergy += channelWeight * weighted * weighted;
    }

    const ringIndex = frame % windowSize;
    runningEnergy += frameEnergy - ring[ringIndex];
    ring[ringIndex] = frameEnergy;
    if (frame === nextBlockFrame) {
      blocks.push(runningEnergy / windowSize);
      nextBlockFrame += hopSize;
    }
  }
  if (nextBlockFrame - hopSize < frameCount - 1) blocks.push(runningEnergy / windowSize);

  const loudness = (energy: number) => -0.691 + 10 * Math.log10(energy);
  const absoluteGateBlocks = blocks.filter((energy) => energy > 0 && loudness(energy) >= -70);
  if (absoluteGateBlocks.length === 0) return null;
  const absoluteMean = absoluteGateBlocks.reduce((sum, energy) => sum + energy, 0) / absoluteGateBlocks.length;
  const relativeGate = loudness(absoluteMean) - 10;
  const gatedBlocks = absoluteGateBlocks.filter((energy) => loudness(energy) >= relativeGate);
  if (gatedBlocks.length === 0) return null;
  return loudness(gatedBlocks.reduce((sum, energy) => sum + energy, 0) / gatedBlocks.length);
}

export interface LoudnessAnalysis {
  integratedLufs: number | null;
  samplePeakDb: number;
  normalizationGain: number;
  normalizedLufs: number | null;
}

export async function analyzeLoudness(
  input: AudioBuffer,
  settings: AudioSettings,
  environment: Environment,
  bypassed: boolean,
): Promise<LoudnessAnalysis> {
  const rendered = await renderAudio(input, settings, environment, bypassed);
  let peak = 0;
  for (let channel = 0; channel < rendered.numberOfChannels; channel += 1) {
    const data = rendered.getChannelData(channel);
    for (let frame = 0; frame < data.length; frame += 1) peak = Math.max(peak, Math.abs(data[frame]));
  }
  const integrated = integratedLufs(rendered);
  const samplePeakDb = peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY;
  const maximumPeakDb = Math.min(settings.limiterCeiling, -1);
  const gainDb = integrated === null ? 0 : Math.min(-14 - integrated, maximumPeakDb - samplePeakDb);
  return {
    integratedLufs: integrated,
    samplePeakDb,
    normalizationGain: 10 ** (gainDb / 20),
    normalizedLufs: integrated === null ? null : integrated + gainDb,
  };
}

export async function renderWav(
  input: AudioBuffer,
  settings: AudioSettings,
  environment: Environment,
  bypassed: boolean,
  outputGain = 1,
): Promise<Blob> {
  const rendered = await renderAudio(input, settings, environment, bypassed);
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
  const ceiling = bypassed ? 1 : 10 ** (settings.limiterCeiling / 20);
  let offset = 44;
  for (let sample = 0; sample < samples; sample += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = Math.max(-ceiling, Math.min(ceiling, channelData[channel][sample] * outputGain));
      view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([bytes], { type: "audio/wav" });
}
