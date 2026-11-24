// ============================================================
// SOLSTICE MANOR — procedural soundscape & SFX engine
//
// Every sound is synthesised with the Web Audio API; there are no audio files.
//
// Signal flow:
//   ambient layers ─> ambientBus ─┐
//   one-shot voices ─> sfxBus ────┼─> warmth shelf ─> soft limiter ─> master ─> out
//   reverb sends ─> convolver ────┘
//
// Everything tonal sits in D major so that overlapping puzzle chimes, harp
// chords, wind-chimes and pads always agree with one another.
// ============================================================

import type { FloorMaterial, HarpColor, ZoneId } from '../shared/types.js';

// ------------------------------------------------------------
// World anchors & zone mixes
// ------------------------------------------------------------

interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

const FIREPLACE: Vec3 = { x: 0, y: 1, z: 17.5 };
const FOUNTAIN: Vec3 = { x: 0, y: 1.2, z: -4 };
const KOI_POND: Vec3 = { x: -19, y: 0.6, z: -6 };

const LAYER_NAMES = [
  'clock',
  'hearth',
  'breeze',
  'birds',
  'chimes',
  'fountain',
  'pond',
  'glassPad',
  'workshop',
  'highWind',
  'starPad',
] as const;

type LayerName = (typeof LAYER_NAMES)[number];

/**
 * Per-zone level (0..1) of each ambient layer. For the spatial layers (hearth,
 * fountain, pond) this is how much of the source gets through the walls; the
 * distance falloff is multiplied on top.
 */
type ZoneMix = Readonly<Record<LayerName, number>> & { readonly reverb: number };

function zoneMix(mix: Partial<Record<LayerName | 'reverb', number>>): ZoneMix {
  return {
    clock: 0,
    hearth: 0,
    breeze: 0,
    birds: 0,
    chimes: 0,
    fountain: 0,
    pond: 0,
    glassPad: 0,
    workshop: 0,
    highWind: 0,
    starPad: 0,
    reverb: 0.5,
    ...mix,
  };
}

const ZONE_MIX: Readonly<Record<ZoneId, ZoneMix>> = {
  foyer: zoneMix({ clock: 1, hearth: 1, breeze: 0.06, fountain: 0.3, reverb: 0.6 }),
  tea_south: zoneMix({ clock: 0.5, hearth: 0.6, breeze: 0.05, fountain: 0.1, reverb: 0.4 }),
  tea_north: zoneMix({ clock: 0.45, hearth: 0.5, breeze: 0.06, fountain: 0.12, reverb: 0.4 }),
  study: zoneMix({ clock: 0.65, hearth: 0.6, breeze: 0.05, fountain: 0.1, reverb: 0.45 }),
  courtyard: zoneMix({ breeze: 0.85, birds: 1, chimes: 0.12, fountain: 1, reverb: 0.4 }),
  skygarden: zoneMix({ breeze: 1, birds: 0.8, chimes: 1, fountain: 0.85, reverb: 0.4 }),
  conservatory: zoneMix({ breeze: 0.08, birds: 0.2, fountain: 0.3, pond: 1, glassPad: 1, reverb: 0.9 }),
  workshop: zoneMix({ workshop: 1, fountain: 0.22, reverb: 0.65 }),
  observatory: zoneMix({ breeze: 0.25, birds: 0.2, chimes: 0.25, fountain: 0.55, highWind: 1, starPad: 1, reverb: 0.8 }),
};

const OUTDOOR_ZONES: ReadonlySet<ZoneId> = new Set<ZoneId>(['courtyard', 'skygarden', 'observatory']);
/** Zones in which the birds may sing: open air, plus faintly through the glasshouse. */
const BIRD_ZONES: ReadonlySet<ZoneId> = new Set<ZoneId>([
  'courtyard',
  'skygarden',
  'observatory',
  'conservatory',
]);

/** Absolute gain of each layer when its mix level is 1. */
const LAYER_LEVEL: Readonly<Record<LayerName, number>> = {
  clock: 0.5,
  hearth: 0.55,
  breeze: 0.3,
  birds: 0.5,
  chimes: 0.6,
  fountain: 0.5,
  pond: 0.4,
  glassPad: 0.3,
  workshop: 0.5,
  highWind: 0.34,
  starPad: 0.34,
};

// ------------------------------------------------------------
// Musical material
// ------------------------------------------------------------

const midiToHz = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

/** Organ pipes: longer pipe = lower note, exactly like the real thing. */
const ORGAN_MIDI: readonly number[] = [62, 59, 57, 54, 50]; // lengths 1..5 → D4 B3 A3 F#3 D3

const HARP_CHORDS: Readonly<Record<HarpColor, readonly number[]>> = {
  amber: [50, 57, 62, 66, 69, 76], // D add9 — golden, home
  emerald: [55, 59, 62, 66, 71, 74], // G maj7 — leafy, open
  azure: [57, 64, 66, 69, 73, 78], // A6 — bright sky
  violet: [52, 59, 62, 66, 67, 74], // E m9 — dusk
};

/** D-major pentatonic from D4 upward, used for glissandi and wind-chimes. */
const PENTATONIC: readonly number[] = [62, 64, 66, 69, 71, 74, 76, 78, 81, 83, 86, 88, 90];

// ------------------------------------------------------------
// Small numeric helpers
// ------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);
const vary = (amount: number): number => 1 + rand(-amount, amount);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Inverse-square-ish falloff: 1 at the source, 0.5 at `ref` metres, 0 by `max`. */
function falloff(dist: number, ref: number, max: number): number {
  const r = dist / ref;
  return (1 / (1 + r * r)) * clamp((max - dist) / (max * 0.4), 0, 1);
}

// ------------------------------------------------------------
// Offline-baked buffers
// ------------------------------------------------------------

type NoiseColor = 'white' | 'pink' | 'brown';

function writeNoise(out: Float32Array, color: NoiseColor): void {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let last = 0;
  for (let i = 0; i < out.length; i++) {
    const w = Math.random() * 2 - 1;
    if (color === 'white') {
      out[i] = w * 0.6;
    } else if (color === 'pink') {
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.16;
    } else {
      last = (last + 0.02 * w) / 1.02;
      out[i] = last * 3.2;
    }
  }
}

/** Noise whose tail is equal-power crossfaded into its head, so it loops without a seam. */
function makeNoise(ctx: BaseAudioContext, seconds: number, color: NoiseColor): AudioBuffer {
  const sr = ctx.sampleRate;
  const length = Math.floor(seconds * sr);
  const fade = Math.floor(Math.min(0.25, seconds / 4) * sr);
  const raw = new Float32Array(length + fade);
  writeNoise(raw, color);
  const buffer = ctx.createBuffer(1, length, sr);
  const data = buffer.getChannelData(0);
  data.set(raw.subarray(0, length));
  for (let i = 0; i < fade; i++) {
    const k = (i / fade) * (Math.PI / 2);
    data[i] = raw[i] * Math.sin(k) + raw[length + i] * Math.cos(k);
  }
  return buffer;
}

interface BubbleOptions {
  seconds: number;
  perSecond: number;
  minHz: number;
  maxHz: number;
  level: number;
}

/**
 * A loop of water droplets. Each is a decaying sine whose pitch rises slightly, which
 * is how a real air bubble rings as it surfaces. Writes wrap around for a seamless loop.
 */
function makeBubbles(ctx: BaseAudioContext, o: BubbleOptions): AudioBuffer {
  const sr = ctx.sampleRate;
  const length = Math.floor(o.seconds * sr);
  const buffer = ctx.createBuffer(1, length, sr);
  const data = buffer.getChannelData(0);
  const count = Math.floor(o.seconds * o.perSecond);
  for (let n = 0; n < count; n++) {
    const start = Math.floor(Math.random() * length);
    const hz = o.minHz * Math.pow(o.maxHz / o.minHz, Math.random());
    const decay = rand(0.018, 0.05) * Math.sqrt(600 / hz);
    const rise = rand(1, 7);
    const amp = o.level * Math.pow(Math.random(), 2) * 0.9 + o.level * 0.05;
    const size = Math.min(length, Math.floor(decay * 7 * sr));
    let phase = 0;
    for (let i = 0; i < size; i++) {
      const t = i / sr;
      phase += (2 * Math.PI * hz * (1 + rise * t)) / sr;
      const attack = Math.min(1, t / 0.003);
      data[(start + i) % length] += Math.sin(phase) * Math.exp(-t / decay) * attack * amp;
    }
  }
  return buffer;
}

/** Sparse woody pops and tiny ember ticks for the fireplace. */
function makeCrackle(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const length = Math.floor(seconds * sr);
  const buffer = ctx.createBuffer(1, length, sr);
  const data = buffer.getChannelData(0);
  const count = Math.floor(seconds * 7);
  let cluster = 0;
  for (let n = 0; n < count; n++) {
    // Half of the crackles bunch up in little flurries, as real embers do.
    if (n % 2 === 0) cluster = Math.random() * length;
    const start = Math.floor(n % 2 === 0 ? cluster : cluster + rand(0.02, 0.12) * sr);
    const big = Math.random() < 0.12;
    const decay = big ? rand(0.008, 0.016) : rand(0.0015, 0.005);
    const amp = big ? rand(0.25, 0.45) : rand(0.05, 0.22);
    const smooth = big ? 0.25 : 0.45;
    const size = Math.floor(decay * 8 * sr);
    let lp = 0;
    for (let i = 0; i < size; i++) {
      lp += smooth * (Math.random() * 2 - 1 - lp);
      const t = i / sr;
      data[(start + i) % length] += lp * Math.min(1, t / 0.0006) * Math.exp(-t / decay) * amp;
    }
  }
  return buffer;
}

/** Warm stereo room: a decaying noise tail that darkens as it fades. */
function makeRoomImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const length = Math.floor(seconds * sr);
  const buffer = ctx.createBuffer(2, length, sr);
  const preDelay = Math.floor(0.012 * sr);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let lp = 0;
    for (let i = preDelay; i < length; i++) {
      const k = (i - preDelay) / (length - preDelay);
      const bright = 0.5 * Math.pow(1 - k, 2) + 0.05;
      lp += bright * (Math.random() * 2 - 1 - lp);
      const onset = Math.min(1, (i - preDelay) / (0.01 * sr));
      data[i] = lp * onset * Math.exp(-k * 5.5) * (1 - k);
    }
  }
  return buffer;
}

/** A felt-soft Karplus-Strong harp string. `rootHz` is the pitch it really came out at. */
interface HarpString {
  buffer: AudioBuffer;
  rootHz: number;
}

function makeHarpString(ctx: BaseAudioContext, hz: number): HarpString {
  const sr = ctx.sampleRate;
  const stretch = clamp(250 / hz, 0.12, 0.5);
  const period = Math.max(8, Math.round(sr / hz - stretch));
  const rootHz = sr / (period + stretch);
  const seconds = clamp(3.4 * Math.pow(220 / hz, 0.35), 1.4, 3.6);
  const rho = Math.pow(0.001, 1 / (rootHz * seconds));
  const length = Math.floor(seconds * sr);
  const buffer = ctx.createBuffer(1, length, sr);
  const out = buffer.getChannelData(0);

  // A finger-soft excitation: noise smoothed around the period, then comb-filtered
  // for a pluck one fifth of the way along the string.
  let line = new Float32Array(period);
  for (let i = 0; i < period; i++) line[i] = Math.random() * 2 - 1;
  const passes = clamp(Math.round(period / 40), 1, 6);
  for (let p = 0; p < passes; p++) {
    const next = new Float32Array(period);
    for (let i = 0; i < period; i++) {
      next[i] = (line[(i + period - 1) % period] + 2 * line[i] + line[(i + 1) % period]) / 4;
    }
    line = next;
  }
  const offset = Math.max(1, Math.floor(period / 5));
  let mean = 0;
  const combed = new Float32Array(period);
  for (let i = 0; i < period; i++) {
    combed[i] = line[i] - 0.8 * line[(i + offset) % period];
    mean += combed[i] / period;
  }

  let peak = 0;
  for (let i = 0; i < length; i++) {
    let v: number;
    if (i < period) v = combed[i] - mean;
    else {
      const a = out[i - period];
      const b = i > period ? out[i - period - 1] : 0;
      v = rho * ((1 - stretch) * a + stretch * b);
    }
    out[i] = v;
    peak = Math.max(peak, Math.abs(v));
  }
  const scale = peak > 0 ? 0.9 / peak : 1;
  const attack = Math.max(1, Math.floor(0.002 * sr));
  const release = Math.floor(0.2 * sr);
  for (let i = 0; i < length; i++) {
    out[i] *= scale * Math.min(1, i / attack) * Math.min(1, (length - 1 - i) / release);
  }
  return { buffer, rootHz };
}

// ------------------------------------------------------------
// The live audio graph, created once on the first user gesture
// ------------------------------------------------------------

interface AudioGraph {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly sfxBus: GainNode;
  readonly ambientBus: GainNode;
  readonly reverbIn: GainNode;
  readonly reverbOut: GainNode;
  readonly layers: Readonly<Record<LayerName, GainNode>>;
  readonly fountainTone: BiquadFilterNode;
  readonly noise: Readonly<Record<NoiseColor, AudioBuffer>>;
  readonly organWave: PeriodicWave;
  readonly harpStrings: Map<number, HarpString>;
  /** Permanently running ambient sources; stopped only by dispose(). */
  readonly sources: AudioScheduledSourceNode[];
  /** Every permanent node, so that dispose() can unhook the whole graph. */
  readonly nodes: AudioNode[];
  readonly onStateChange: () => void;
}

// ------------------------------------------------------------
// Voice — one self-cleaning one-shot sound
// ------------------------------------------------------------

interface FilterSpec {
  type: BiquadFilterType;
  hz: number;
  hzEnd?: number;
  q?: number;
}

interface EnvelopeSpec {
  /** Seconds after the start of the voice. */
  at?: number;
  attack?: number;
  /** Time spent at full level after the attack. */
  hold?: number;
  /** Total time from onset to silence (-60 dB). */
  dur: number;
  gain: number;
  filter?: FilterSpec;
}

interface ToneSpec extends EnvelopeSpec {
  hz: number;
  hzEnd?: number;
  /** Seconds the pitch glide takes; defaults to the whole note. */
  glide?: number;
  wave?: OscillatorType | PeriodicWave;
  detune?: number;
  vibrato?: { hz: number; cents: number };
}

interface NoiseSpec extends EnvelopeSpec {
  color?: NoiseColor;
}

interface VoiceOptions {
  dest: AudioNode;
  gain: number;
  reverb: number;
  pan?: number;
  pitch?: number;
  delay?: number;
}

class Voice {
  private readonly out: GainNode;
  private readonly shared: AudioNode[] = [];
  private readonly live = new Set<AudioScheduledSourceNode>();
  private readonly chains = new Map<AudioScheduledSourceNode, AudioNode[]>();
  private readonly start: number;
  private readonly pitch: number;
  private sealed = false;
  private finished = false;

  constructor(
    private readonly graph: AudioGraph,
    options: VoiceOptions,
    private readonly onFinished: (voice: Voice) => void,
  ) {
    const { ctx } = graph;
    this.start = ctx.currentTime + 0.006 + (options.delay ?? 0);
    this.pitch = options.pitch ?? 1;
    this.out = ctx.createGain();
    this.out.gain.value = options.gain;
    this.shared.push(this.out);
    let tail: AudioNode = this.out;
    if (options.pan) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = clamp(options.pan, -1, 1);
      tail.connect(panner);
      tail = panner;
      this.shared.push(panner);
    }
    tail.connect(options.dest);
    if (options.reverb > 0) {
      const send = ctx.createGain();
      send.gain.value = options.reverb;
      tail.connect(send);
      send.connect(graph.reverbIn);
      this.shared.push(send);
    }
  }

  get sourceCount(): number {
    return this.live.size;
  }

  /** Call once the recipe has added all its sources. */
  seal(): void {
    this.sealed = true;
    if (this.live.size === 0) this.finish();
  }

  /** Immediately tear everything down. */
  kill(): void {
    for (const source of this.live) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Never started; disconnecting is enough.
      }
      this.release(source);
    }
    this.live.clear();
    this.finish();
  }

  tone(spec: ToneSpec): void {
    const { ctx } = this.graph;
    const t = this.start + (spec.at ?? 0);
    const osc = ctx.createOscillator();
    const chain: AudioNode[] = [];
    if (spec.wave instanceof Object) osc.setPeriodicWave(spec.wave);
    else osc.type = spec.wave ?? 'sine';
    const nyquist = ctx.sampleRate * 0.45;
    const hz = clamp(spec.hz * this.pitch, 20, nyquist);
    osc.frequency.setValueAtTime(hz, t);
    if (spec.hzEnd !== undefined) {
      const hzEnd = clamp(spec.hzEnd * this.pitch, 20, nyquist);
      osc.frequency.exponentialRampToValueAtTime(hzEnd, t + Math.max(0.005, spec.glide ?? spec.dur));
    }
    if (spec.detune) osc.detune.value = spec.detune;
    const end = this.shape(osc, spec, t, chain);
    if (spec.vibrato) {
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = spec.vibrato.hz;
      depth.gain.setValueAtTime(0, t);
      depth.gain.linearRampToValueAtTime(spec.vibrato.cents, t + Math.min(0.4, spec.dur * 0.6));
      lfo.connect(depth);
      depth.connect(osc.detune);
      this.run(lfo, [depth], t, end);
    }
    this.run(osc, chain, t, end);
  }

  noise(spec: NoiseSpec): void {
    const { ctx } = this.graph;
    const t = this.start + (spec.at ?? 0);
    const source = ctx.createBufferSource();
    const buffer = this.graph.noise[spec.color ?? 'pink'];
    source.buffer = buffer;
    source.loop = true;
    const chain: AudioNode[] = [];
    const end = this.shape(source, spec, t, chain);
    this.run(source, chain, t, end, Math.random() * buffer.duration);
  }

  /** A harp string, resampled by at most two semitones from a baked neighbour. */
  pluck(midi: number, at: number, gain: number, brightness = 2600): void {
    const { ctx, harpStrings } = this.graph;
    const key = Math.round(midi / 4) * 4;
    let string = harpStrings.get(key);
    if (!string) {
      string = makeHarpString(ctx, midiToHz(key));
      harpStrings.set(key, string);
    }
    const t = this.start + at;
    const source = ctx.createBufferSource();
    source.buffer = string.buffer;
    source.playbackRate.value = (midiToHz(midi) / string.rootHz) * this.pitch;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = brightness;
    filter.Q.value = 0.3;
    const amp = ctx.createGain();
    amp.gain.value = gain;
    source.connect(filter);
    filter.connect(amp);
    amp.connect(this.out);
    const duration = string.buffer.duration / source.playbackRate.value;
    this.run(source, [filter, amp], t, t + duration + 0.02);
  }

  private shape(source: AudioNode, spec: EnvelopeSpec, t: number, chain: AudioNode[]): number {
    const { ctx } = this.graph;
    const attack = Math.max(0.001, spec.attack ?? 0.003);
    const sustainEnd = t + attack + (spec.hold ?? 0);
    const end = Math.max(t + spec.dur, sustainEnd + 0.015);
    let head = source;
    if (spec.filter) {
      const filter = ctx.createBiquadFilter();
      filter.type = spec.filter.type;
      filter.Q.value = spec.filter.q ?? 0.7;
      filter.frequency.setValueAtTime(spec.filter.hz, t);
      if (spec.filter.hzEnd !== undefined) {
        filter.frequency.exponentialRampToValueAtTime(spec.filter.hzEnd, end);
      }
      head.connect(filter);
      head = filter;
      chain.push(filter);
    }
    const peak = Math.max(spec.gain, 1e-5);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(peak, t + attack);
    if (spec.hold) amp.gain.setValueAtTime(peak, sustainEnd);
    amp.gain.exponentialRampToValueAtTime(peak * 0.001, end);
    amp.gain.linearRampToValueAtTime(0, end + 0.01);
    head.connect(amp);
    amp.connect(this.out);
    chain.push(amp);
    return end + 0.02;
  }

  private run(
    source: AudioScheduledSourceNode,
    chain: AudioNode[],
    start: number,
    stop: number,
    offset?: number,
  ): void {
    this.chains.set(source, chain);
    this.live.add(source);
    source.onended = () => {
      source.onended = null;
      this.live.delete(source);
      this.release(source);
      if (this.sealed && this.live.size === 0) this.finish();
    };
    if (offset !== undefined && source instanceof AudioBufferSourceNode) source.start(start, offset);
    else source.start(start);
    source.stop(stop);
  }

  private release(source: AudioScheduledSourceNode): void {
    source.disconnect();
    for (const node of this.chains.get(source) ?? []) node.disconnect();
    this.chains.delete(source);
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    for (const node of this.shared) node.disconnect();
    this.onFinished(this);
  }
}

// ------------------------------------------------------------
// Instruments — small reusable timbres the recipes are built from
// ------------------------------------------------------------

/** Round brass/bronze bell; higher partials are quiet and die quickly, so it never pings. */
function bell(v: Voice, hz: number, at: number, gain: number, dur: number): void {
  v.tone({ hz: hz * 0.5, at, gain: gain * 0.22, dur: dur * 0.8, attack: 0.012 });
  v.tone({ hz, at, gain, dur, attack: 0.004 });
  v.tone({ hz: hz * 2.003, at, gain: gain * 0.3, dur: dur * 0.55, attack: 0.003 });
  v.tone({ hz: hz * 2.76, at, gain: gain * 0.13, dur: dur * 0.28, attack: 0.002 });
  if (hz < 900) v.tone({ hz: hz * 4.1, at, gain: gain * 0.06, dur: dur * 0.12, attack: 0.002 });
}

/** Crystal glint: two nearly pure partials beating softly. */
function glint(v: Voice, hz: number, at: number, gain: number, dur: number): void {
  v.tone({ hz, at, gain, dur, attack: 0.006 });
  v.tone({ hz: hz * 1.0035, at, gain: gain * 0.5, dur: dur * 0.9, attack: 0.01 });
  v.tone({ hz: hz * 2.005, at, gain: gain * 0.14, dur: dur * 0.4, attack: 0.004 });
}

/** Mellow horn section note: two detuned saws through an opening lowpass. */
function brass(v: Voice, hz: number, at: number, gain: number, hold: number, release = 0.7): void {
  const dur = 0.07 + hold + release;
  const filter: FilterSpec = { type: 'lowpass', hz: Math.min(hz * 4.5, 2100), hzEnd: hz * 1.4, q: 0.5 };
  for (const detune of [-5, 6]) {
    v.tone({
      hz,
      at,
      gain: gain * 0.5,
      attack: 0.07,
      hold,
      dur,
      wave: 'sawtooth',
      detune,
      filter,
      vibrato: { hz: 4.8, cents: 6 },
    });
  }
  v.tone({ hz, at, gain: gain * 0.55, attack: 0.05, hold, dur });
}

/** Slow warm string/organ-ish pad note. */
function pad(v: Voice, hz: number, at: number, gain: number, hold: number, release: number): void {
  const dur = 0.35 + hold + release;
  v.tone({ hz, at, gain, attack: 0.35, hold, dur, wave: 'triangle', detune: -4 });
  v.tone({ hz: hz * 2, at, gain: gain * 0.25, attack: 0.45, hold, dur, detune: 5 });
}

/** Hollow wood knock. */
function knock(v: Voice, hz: number, at: number, gain: number, dur = 0.13): void {
  v.tone({ hz: hz * 1.35, hzEnd: hz, glide: 0.04, at, gain, dur, attack: 0.002 });
  v.tone({ hz: hz * 2.4, at, gain: gain * 0.28, dur: dur * 0.5, attack: 0.002, wave: 'triangle' });
  v.noise({ at, gain: gain * 0.55, dur: 0.035, filter: { type: 'bandpass', hz: hz * 4.5, q: 1.1 } });
}

/** Weighty metal-on-metal clunk. */
function clunk(v: Voice, hz: number, at: number, gain: number, dur = 0.24): void {
  v.tone({ hz: hz * 1.5, hzEnd: hz, glide: 0.05, at, gain, dur, attack: 0.002 });
  v.tone({ hz: hz * 2.63, at, gain: gain * 0.3, dur: dur * 0.8, attack: 0.002, wave: 'triangle' });
  v.tone({ hz: hz * 4.17, at, gain: gain * 0.13, dur: dur * 0.55, attack: 0.002 });
  v.noise({ at, gain: gain * 0.6, dur: 0.045, filter: { type: 'bandpass', hz: hz * 8, q: 0.9 } });
}

/** Small precise mechanical click. */
function click(v: Voice, at: number, gain: number, hz = 1700): void {
  v.noise({ at, gain, dur: 0.018, attack: 0.001, filter: { type: 'bandpass', hz, q: 1.4 } });
  v.tone({ hz: hz * 0.42, hzEnd: hz * 0.3, at, gain: gain * 0.5, dur: 0.03, attack: 0.001 });
}

/** A run of ratchet clicks from `at`, `gap` seconds apart (each gap scaled by `accel`). */
function ratchet(
  v: Voice,
  at: number,
  count: number,
  gap: number,
  accel: number,
  gain: number,
  hz: number,
): number {
  let t = at;
  let step = gap;
  for (let i = 0; i < count; i++) {
    click(v, t, gain * vary(0.15), hz * vary(0.06));
    t += step;
    step *= accel;
  }
  return t;
}

/** Harp sweep across the D pentatonic. */
function glissando(v: Voice, at: number, from: number, to: number, gap: number, gain: number): number {
  const dir = to >= from ? 1 : -1;
  const count = Math.abs(to - from) + 1;
  for (let i = 0; i < count; i++) {
    const swell = 0.65 + 0.35 * (i / Math.max(1, count - 1));
    v.pluck(PENTATONIC[from + i * dir], at + i * gap, gain * swell * vary(0.08));
  }
  return at + count * gap;
}

// ------------------------------------------------------------
// SFX recipes
// ------------------------------------------------------------

type Extra = Readonly<Record<string, unknown>>;

interface SfxRecipe {
  /** Overall level of the voice. */
  gain: number;
  /** Reverb send. */
  reverb: number;
  /** Fractional random pitch spread, for sounds that repeat a lot. */
  spread?: number;
  build: (v: Voice, extra: Extra) => void;
}

const SFX: Readonly<Record<string, SfxRecipe>> = {
  pickup: {
    gain: 0.5,
    reverb: 0.3,
    build: (v) => {
      click(v, 0, 0.12, 1300);
      bell(v, midiToHz(69), 0.01, 0.34, 0.8);
      bell(v, midiToHz(74), 0.12, 0.38, 1.2);
    },
  },

  key_unlock: {
    gain: 0.7,
    reverb: 0.3,
    build: (v) => {
      // Key seats, two tumblers fall, the latch slides home…
      click(v, 0, 0.3, 1500);
      clunk(v, 190, 0.09, 0.4, 0.16);
      click(v, 0.21, 0.28, 1200);
      clunk(v, 150, 0.3, 0.55, 0.26);
      v.noise({
        at: 0.4,
        gain: 0.3,
        dur: 0.26,
        attack: 0.05,
        hold: 0.06,
        filter: { type: 'bandpass', hz: 620, hzEnd: 1000, q: 1.6 },
      });
      clunk(v, 118, 0.62, 0.55, 0.34);
      // …and the room warms up in answer.
      [50, 57, 62, 66, 69].forEach((m, i) => {
        v.pluck(m, 0.72 + i * 0.045, 0.26);
        pad(v, midiToHz(m), 0.72, 0.045, 0.35, 1.3);
      });
      bell(v, midiToHz(74), 0.96, 0.12, 1.5);
    },
  },

  door_open: {
    gain: 0.85,
    reverb: 0.4,
    build: (v) => {
      clunk(v, 105, 0, 0.5, 0.3);
      v.noise({
        at: 0.1,
        color: 'brown',
        gain: 0.75,
        attack: 0.3,
        hold: 0.75,
        dur: 1.9,
        filter: { type: 'lowpass', hz: 420, hzEnd: 190 },
      });
      v.noise({
        at: 0.12,
        gain: 0.16,
        attack: 0.25,
        hold: 0.6,
        dur: 1.6,
        filter: { type: 'bandpass', hz: 480, hzEnd: 330, q: 1.2 },
      });
      for (const [hz, gain] of [[73, 0.24], [110, 0.18], [147, 0.1]] as const) {
        v.tone({ hz, hzEnd: hz * 0.95, at: 0.1, gain, attack: 0.35, hold: 0.6, dur: 1.9, wave: 'triangle' });
      }
      for (let i = 0; i < 6; i++) knock(v, rand(120, 160), 0.22 + i * 0.2 + rand(-0.03, 0.03), 0.07, 0.1);
      clunk(v, 86, 1.6, 0.5, 0.45);
      bell(v, midiToHz(50), 1.62, 0.09, 1.6);
    },
  },

  lever_pull: {
    gain: 0.7,
    reverb: 0.3,
    build: (v) => {
      ratchet(v, 0, 3, 0.045, 0.85, 0.22, 1150);
      // Spring tension, then the arm hits its stop.
      v.tone({
        hz: 210,
        hzEnd: 330,
        at: 0.02,
        gain: 0.1,
        attack: 0.04,
        dur: 0.18,
        wave: 'triangle',
        vibrato: { hz: 34, cents: 45 },
      });
      clunk(v, 128, 0.16, 0.62, 0.3);
      v.tone({ hz: 640, hzEnd: 600, at: 0.17, gain: 0.06, dur: 0.32, vibrato: { hz: 22, cents: 40 } });
      bell(v, midiToHz(66), 0.2, 0.13, 1.1);
    },
  },

  coop_tick: {
    gain: 0.8,
    reverb: 0.2,
    build: (v) => {
      for (const at of [0, 0.16]) {
        knock(v, at === 0 ? 330 : 415, at, 0.34, 0.12);
        glint(v, midiToHz(at === 0 ? 74 : 78), at, 0.12, 0.4);
      }
    },
  },

  uv_toggle: {
    gain: 0.55,
    reverb: 0.15,
    build: (v, extra) => {
      click(v, 0, 0.5, 1500);
      knock(v, 240, 0.012, 0.28, 0.08);
      if (extra.on === false) {
        v.tone({ hz: 220, hzEnd: 110, at: 0.02, gain: 0.1, dur: 0.22, wave: 'triangle' });
        return;
      }
      for (const [hz, gain] of [[110, 0.2], [220, 0.14], [331, 0.07]] as const) {
        v.tone({ hz: hz * 0.9, hzEnd: hz, glide: 0.18, at: 0.04, gain, attack: 0.09, hold: 0.2, dur: 0.9, wave: 'triangle' });
      }
      v.tone({ hz: 660, at: 0.06, gain: 0.025, attack: 0.12, dur: 0.6, vibrato: { hz: 12, cents: 14 } });
    },
  },

  mirror_rotate: {
    gain: 0.8,
    reverb: 0.35,
    spread: 0.02,
    build: (v) => {
      const end = ratchet(v, 0, 5, 0.06, 0.94, 0.26, 1250);
      clunk(v, 210, end, 0.22, 0.14);
      glint(v, midiToHz(81), end + 0.03, 0.14, 0.9);
      glint(v, midiToHz(86), end + 0.1, 0.09, 1.0);
    },
  },

  valve_turn: {
    gain: 0.9,
    reverb: 0.2,
    spread: 0.06,
    build: (v) => {
      v.tone({
        hz: 235,
        hzEnd: 320,
        gain: 0.16,
        attack: 0.06,
        hold: 0.1,
        dur: 0.36,
        wave: 'sawtooth',
        vibrato: { hz: 17, cents: 70 },
        filter: { type: 'bandpass', hz: 620, hzEnd: 780, q: 2.2 },
      });
      ratchet(v, 0.02, 3, 0.1, 0.95, 0.12, 900);
      clunk(v, 165, 0.31, 0.26, 0.16);
      // Pressure release, then water finding its way through the pipe.
      v.noise({
        at: 0.33,
        gain: 0.22,
        attack: 0.05,
        hold: 0.05,
        dur: 0.6,
        filter: { type: 'bandpass', hz: 1900, hzEnd: 800, q: 0.6 },
      });
      for (let i = 0; i < 4; i++) {
        const hz = rand(340, 620);
        v.tone({ hz, hzEnd: hz * 1.35, at: 0.45 + i * 0.085 + rand(0, 0.03), gain: 0.1, dur: 0.09, attack: 0.006 });
      }
    },
  },

  gear_place: {
    gain: 0.75,
    reverb: 0.25,
    build: (v) => {
      clunk(v, 138, 0, 0.6, 0.32);
      bell(v, midiToHz(57), 0.01, 0.1, 0.8);
      v.tone({
        hz: 120,
        hzEnd: 240,
        glide: 0.5,
        at: 0.14,
        gain: 0.12,
        attack: 0.12,
        hold: 0.2,
        dur: 0.85,
        wave: 'triangle',
        vibrato: { hz: 19, cents: 20 },
      });
      ratchet(v, 0.16, 11, 0.085, 0.92, 0.12, 1050);
    },
  },

  dial_click: {
    gain: 0.8,
    reverb: 0.1,
    spread: 0.04,
    build: (v) => {
      click(v, 0, 0.55, 1600);
      v.tone({ hz: 310, hzEnd: 250, at: 0.002, gain: 0.22, dur: 0.05, attack: 0.001, wave: 'triangle' });
      click(v, 0.03, 0.18, 1250);
    },
  },

  plate_step: {
    gain: 0.75,
    reverb: 0.25,
    build: (v) => {
      v.noise({ gain: 0.16, attack: 0.03, dur: 0.12, filter: { type: 'bandpass', hz: 520, q: 1 } });
      clunk(v, 92, 0.07, 0.75, 0.38);
      click(v, 0.2, 0.2, 950);
      bell(v, midiToHz(50), 0.09, 0.08, 1.0);
    },
  },

  ping: {
    gain: 0.5,
    reverb: 0.4,
    build: (v) => {
      bell(v, midiToHz(74), 0, 0.4, 1.0);
      bell(v, midiToHz(69), 0.17, 0.38, 1.5);
    },
  },

  puzzle_solved: {
    gain: 0.75,
    reverb: 0.4,
    build: (v) => {
      // Two pickup notes, then a Dmaj7 bloom.
      brass(v, midiToHz(57), 0, 0.2, 0.08, 0.2);
      brass(v, midiToHz(62), 0.17, 0.22, 0.08, 0.2);
      [50, 57, 62, 66, 69, 73].forEach((m, i) => brass(v, midiToHz(m), 0.36, i < 2 ? 0.15 : 0.12, 0.85, 1.3));
      glissando(v, 0.34, 0, 9, 0.06, 0.24);
      bell(v, midiToHz(78), 0.95, 0.13, 1.8);
      bell(v, midiToHz(81), 1.1, 0.12, 2.0);
      glint(v, midiToHz(85), 1.28, 0.07, 2.0);
    },
  },

  error: {
    gain: 0.55,
    reverb: 0.15,
    build: (v) => {
      knock(v, 165, 0, 0.6, 0.2);
      knock(v, 131, 0.14, 0.5, 0.26);
    },
  },

  minigame_catch: {
    gain: 0.65,
    reverb: 0.3,
    build: (v) => {
      const step = Math.floor(Math.random() * 3);
      [0, 1, 2].forEach((i) => v.pluck(PENTATONIC[4 + step + i], i * 0.05, 0.46, 3000));
      glint(v, midiToHz(PENTATONIC[7 + step]), 0.11, 0.1, 0.5);
    },
  },

  minigame_cog: {
    gain: 0.55,
    reverb: 0.12,
    spread: 0.06,
    build: (v) => {
      clunk(v, 175, 0, 0.5, 0.16);
      v.tone({ hz: 287, hzEnd: 262, at: 0.004, gain: 0.16, dur: 0.14, wave: 'triangle' });
    },
  },

  minigame_sync: {
    gain: 0.5,
    reverb: 0.4,
    build: (v) => {
      [62, 69, 74, 78].forEach((m, i) => bell(v, midiToHz(m), i * 0.035, 0.22, 1.1));
      glint(v, midiToHz(81), 0.15, 0.12, 1.1);
    },
  },

  oracle_win: {
    gain: 0.6,
    reverb: 0.5,
    build: (v) => {
      for (const m of [50, 57, 62, 66, 73]) pad(v, midiToHz(m), 0.05, 0.07, 1.5, 1.6);
      let t = glissando(v, 0, 0, 12, 0.062, 0.27);
      t = glissando(v, t + 0.06, 11, 4, 0.05, 0.2);
      glissando(v, t + 0.04, 3, 12, 0.055, 0.27);
      [74, 78, 81, 85].forEach((m, i) => glint(v, midiToHz(m), 1.5 + i * 0.16, 0.1, 1.6));
      bell(v, midiToHz(62), 1.9, 0.2, 2.2);
    },
  },

  oracle_miss: {
    gain: 0.6,
    reverb: 0.2,
    build: (v) => {
      // Pfff…
      v.noise({
        gain: 0.28,
        attack: 0.03,
        hold: 0.08,
        dur: 0.6,
        filter: { type: 'bandpass', hz: 1800, hzEnd: 480, q: 0.5 },
      });
      // …wah, wah, waaaah.
      const wah = (midi: number, drop: number, at: number, hold: number, wobble: number): void => {
        const hz = midiToHz(midi);
        v.tone({
          hz,
          hzEnd: hz * Math.pow(2, -drop / 12),
          glide: hold + 0.2,
          at,
          gain: 0.26,
          attack: 0.06,
          hold,
          dur: hold + 0.34,
          wave: 'sawtooth',
          vibrato: { hz: 5.5, cents: wobble },
          filter: { type: 'lowpass', hz: 1050, hzEnd: 300, q: 2.2 },
        });
        v.tone({ hz, hzEnd: hz * Math.pow(2, -drop / 12), glide: hold + 0.2, at, gain: 0.16, attack: 0.06, hold, dur: hold + 0.34 });
      };
      wah(57, 0.6, 0.38, 0.16, 5);
      wah(56, 0.6, 0.76, 0.16, 5);
      wah(55, 5, 1.14, 0.75, 45);
    },
  },

  victory: {
    gain: 0.62,
    reverb: 0.45,
    build: (v) => {
      // Horn call, then IV – V – vi – I with bells, harp and soft timpani.
      [57, 62, 66].forEach((m, i) => brass(v, midiToHz(m), i * 0.2, 0.22, 0.1, 0.2));
      const chords: ReadonlyArray<{ at: number; hold: number; notes: readonly number[] }> = [
        { at: 0.64, hold: 0.75, notes: [43, 55, 59, 62, 66] },
        { at: 1.74, hold: 0.75, notes: [45, 57, 61, 64, 69] },
        { at: 2.84, hold: 0.75, notes: [47, 54, 62, 66, 69] },
        { at: 3.94, hold: 2.1, notes: [38, 50, 57, 62, 66, 69, 76] },
      ];
      for (const chord of chords) {
        for (const m of chord.notes) brass(v, midiToHz(m), chord.at, 0.11, chord.hold, 0.9);
        v.tone({ hz: 118, hzEnd: 74, glide: 0.08, at: chord.at, gain: 0.4, dur: 0.6, attack: 0.004 });
        v.noise({ at: chord.at, color: 'brown', gain: 0.24, dur: 0.3, filter: { type: 'lowpass', hz: 340 } });
      }
      const melody: ReadonlyArray<readonly [number, number]> = [
        [74, 0.64],
        [78, 1.0],
        [76, 1.74],
        [81, 2.1],
        [78, 2.84],
        [74, 3.2],
        [76, 3.57],
        [81, 3.94],
        [86, 4.3],
      ];
      for (const [m, at] of melody) bell(v, midiToHz(m), at, 0.17, 1.9);
      glissando(v, 3.25, 0, 12, 0.055, 0.22);
      glissando(v, 4.6, 0, 12, 0.09, 0.2);
      [74, 78, 81, 85, 88].forEach((m, i) => glint(v, midiToHz(m), 5.2 + i * 0.19, 0.06, 2.4));
      bell(v, midiToHz(50), 3.94, 0.26, 4.2);
    },
  },
};

// ------------------------------------------------------------
// Footstep recipes
// ------------------------------------------------------------

const FOOTSTEPS: Readonly<Record<FloorMaterial, { gain: number; build: (v: Voice) => void }>> = {
  wood: {
    gain: 0.46,
    build: (v) => {
      knock(v, 112, 0, 0.6, 0.12);
      v.tone({ hz: 268, hzEnd: 238, at: 0.003, gain: 0.14, dur: 0.07, wave: 'triangle' });
      knock(v, 128, rand(0.045, 0.06), 0.18, 0.07); // toe follows heel
      if (Math.random() < 0.13) {
        const hz = rand(190, 260);
        v.tone({
          hz,
          hzEnd: hz * rand(1.1, 1.25),
          at: 0.05,
          gain: 0.05,
          attack: 0.05,
          dur: rand(0.18, 0.3),
          wave: 'sawtooth',
          vibrato: { hz: 23, cents: 55 },
          filter: { type: 'bandpass', hz: 700, q: 2 },
        });
      }
    },
  },
  stone: {
    gain: 0.54,
    build: (v) => {
      v.tone({ hz: 150, hzEnd: 98, glide: 0.04, gain: 0.5, dur: 0.08, attack: 0.002 });
      v.noise({ gain: 0.42, dur: 0.045, attack: 0.002, filter: { type: 'bandpass', hz: 1500, q: 0.8 } });
      v.noise({
        at: rand(0.03, 0.05),
        gain: rand(0.12, 0.24),
        dur: 0.09,
        attack: 0.018,
        filter: { type: 'bandpass', hz: 1000, hzEnd: 720, q: 0.8 },
      });
    },
  },
  glass: {
    gain: 0.56,
    build: (v) => {
      v.tone({ hz: 190, hzEnd: 135, glide: 0.04, gain: 0.4, dur: 0.07, attack: 0.002 });
      v.tone({ hz: 1180, gain: 0.12, dur: 0.1, attack: 0.002 });
      v.tone({ hz: 1890, gain: 0.05, dur: 0.06, attack: 0.002 });
      v.noise({ gain: 0.3, dur: 0.022, attack: 0.001, filter: { type: 'bandpass', hz: 2200, q: 1 } });
      click(v, rand(0.05, 0.065), 0.1, 1700);
    },
  },
  metal: {
    gain: 0.5,
    build: (v) => {
      v.tone({ hz: 148, hzEnd: 108, glide: 0.04, gain: 0.5, dur: 0.11, attack: 0.002 });
      v.tone({ hz: 322, gain: 0.15, dur: 0.26, attack: 0.003 });
      v.tone({ hz: 541, gain: 0.08, dur: 0.2, attack: 0.003 });
      v.tone({ hz: 873, gain: 0.04, dur: 0.13, attack: 0.003 });
      v.noise({ gain: 0.26, dur: 0.035, attack: 0.002, filter: { type: 'bandpass', hz: 1150, q: 1 } });
    },
  },
  grass: {
    gain: 0.54,
    build: (v) => {
      v.tone({ hz: 108, hzEnd: 72, glide: 0.05, gain: 0.5, dur: 0.1, attack: 0.006 });
      v.noise({ gain: 0.45, dur: 0.1, attack: 0.014, filter: { type: 'lowpass', hz: 700 } });
      v.noise({
        at: 0.015,
        gain: 0.16,
        dur: 0.15,
        attack: 0.03,
        filter: { type: 'bandpass', hz: rand(1900, 2500), hzEnd: 1500, q: 0.7 },
      });
    },
  },
};

// ------------------------------------------------------------
// Engine
// ------------------------------------------------------------

const MASTER_LEVEL = 0.85;
/** Above this many live sources, decorative sounds (steps, birds, chimes) are skipped. */
const SOFT_SOURCE_LIMIT = 150;
/** Above this many live sources, everything new is skipped. */
const HARD_SOURCE_LIMIT = 320;
/** The same sound within this window is one event heard twice (local echo + server). */
const DEDUPE_SECONDS = 0.03;
/** Sounds requested while the context is still waking up are kept for this long. */
const WAKE_GRACE_MS = 350;
const MIX_INTERVAL = 0.08;
const LOOKAHEAD = 0.2;

interface PendingSound {
  readonly expires: number;
  readonly play: () => void;
}

export class SoundscapeEngine {
  private graph: AudioGraph | null = null;
  private muted = false;
  private readonly voices = new Set<Voice>();
  private readonly lastPlayed = new Map<string, number>();
  private pending: PendingSound[] = [];

  private listener: Vec3 = { x: 0, y: 0, z: 14.5 };
  private zone: ZoneId = 'foyer';
  private readonly targets = new Map<LayerName, number>();
  private reverbTarget = -1;
  private mixTimer = 0;
  private mixStarted = false;

  private nextClock = 0;
  private clockTock = false;
  private nextEscapement = 0;
  private escapementBeat = 0;
  private birdTimer = 3;
  private chimeTimer = 4;
  private glintTimer = 5;
  private stepSide = 1;

  // ---------------- lifecycle ----------------

  /** Create (or wake) the audio context. Safe to call on every user gesture. */
  init(): void {
    if (this.graph && this.graph.ctx.state === 'closed') this.dispose();
    if (!this.graph) {
      try {
        this.graph = this.buildGraph();
      } catch (err) {
        console.warn('[audio] Web Audio unavailable; continuing silently.', err);
        return;
      }
    }
    this.wake();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    const graph = this.graph;
    if (!graph) return;
    try {
      this.ramp(graph.master.gain, muted ? 0 : MASTER_LEVEL, 0.06);
    } catch {
      // The context closed underneath us; nothing is audible anyway.
    }
    if (muted) this.pending = [];
  }

  isMuted(): boolean {
    return this.muted;
  }

  dispose(): void {
    const graph = this.graph;
    this.graph = null;
    this.pending = [];
    for (const voice of [...this.voices]) {
      try {
        voice.kill();
      } catch {
        // Already torn down.
      }
    }
    this.voices.clear();
    this.lastPlayed.clear();
    this.targets.clear();
    this.reverbTarget = -1;
    this.mixTimer = 0;
    this.mixStarted = false;
    this.nextClock = 0;
    this.nextEscapement = 0;
    if (!graph) return;
    graph.ctx.removeEventListener('statechange', graph.onStateChange);
    for (const source of graph.sources) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    for (const node of graph.nodes) node.disconnect();
    graph.harpStrings.clear();
    if (graph.ctx.state !== 'closed') graph.ctx.close().catch(() => undefined);
  }

  // ---------------- public playback ----------------

  updateSpatial(playerX: number, playerY: number, playerZ: number, zone: ZoneId, dt: number): void {
    if (finite(playerX) && finite(playerY) && finite(playerZ)) {
      this.listener = { x: playerX, y: playerY, z: playerZ };
    }
    if (Object.hasOwn(ZONE_MIX, zone)) this.zone = zone;
    const graph = this.graph;
    if (!graph || graph.ctx.state !== 'running') return;
    const step = finite(dt) ? clamp(dt, 0, 0.25) : 0;
    try {
      this.mixTimer -= step;
      if (this.mixTimer <= 0) {
        this.mixTimer = MIX_INTERVAL;
        this.updateMix(graph);
      }
      if (!this.muted) this.runAmbientEvents(graph, step);
    } catch {
      // Audio must never interrupt the render loop.
    }
  }

  playFootstep(material: FloorMaterial): void {
    if (!Object.hasOwn(FOOTSTEPS, material)) return;
    const step = FOOTSTEPS[material];
    this.stepSide = -this.stepSide;
    const side = this.stepSide;
    this.trigger(
      'footstep',
      (graph) => ({
        dest: graph.sfxBus,
        gain: step.gain * vary(0.22),
        reverb: 0.1,
        pan: side * rand(0.04, 0.1),
        pitch: vary(0.09),
      }),
      step.build,
      true,
    );
  }

  /**
   * Play a named effect. `extra` may carry `volume` (0..1.5) and a world position
   * `x`/`y`/`z`, in which case the sound is gently attenuated with distance.
   * For `uv_toggle`, `on: false` plays the switch-off variant.
   */
  playSfx(name: string, extra: Record<string, unknown> = {}): void {
    if (!Object.hasOwn(SFX, name)) return;
    const recipe = SFX[name];
    const details: Extra = extra ?? {};
    const volume = finite(details.volume) ? clamp(details.volume, 0, 1.5) : 1;
    const level = recipe.gain * volume * this.distanceGain(details);
    if (level <= 0) return;
    this.trigger(
      name,
      (graph) => ({
        dest: graph.sfxBus,
        gain: level,
        reverb: recipe.reverb,
        pitch: recipe.spread ? vary(recipe.spread) : 1,
      }),
      (v) => recipe.build(v, details),
    );
  }

  /** Length 1 (shortest, highest) to 5 (longest, lowest). */
  playOrganPipe(length: number): void {
    if (!finite(length)) return;
    const index = clamp(Math.round(length), 1, 5) - 1;
    const hz = midiToHz(ORGAN_MIDI[index]);
    this.trigger(
      `organ_${index}`,
      (graph) => ({ dest: graph.sfxBus, gain: 0.42, reverb: 0.45, pitch: vary(0.0015) }),
      (v, graph) => {
        // Chiff of air across the mouth of the pipe, then a slow wooden speak.
        v.noise({ gain: 0.1, attack: 0.012, dur: 0.11, filter: { type: 'bandpass', hz: hz * 3, q: 1.6 } });
        v.noise({ gain: 0.035, attack: 0.08, hold: 0.9, dur: 1.6, filter: { type: 'bandpass', hz: hz * 2, q: 2.5 } });
        const body = { attack: 0.075, hold: 0.85, dur: 1.75 };
        v.tone({ hz, gain: 0.34, ...body, wave: graph.organWave, detune: -3 });
        v.tone({ hz, gain: 0.2, ...body, wave: graph.organWave, detune: 4, vibrato: { hz: 4.2, cents: 4 } });
        v.tone({ hz: hz * 0.5, gain: 0.14, ...body, attack: 0.12 });
        v.tone({ hz: hz * 2, gain: 0.04, ...body, attack: 0.05, wave: 'triangle' });
      },
    );
  }

  playWindHarp(color: HarpColor): void {
    if (!Object.hasOwn(HARP_CHORDS, color)) return;
    const chord = HARP_CHORDS[color];
    this.trigger(
      `harp_${color}`,
      (graph) => ({ dest: graph.sfxBus, gain: 0.62, reverb: 0.55 }),
      (v) => {
        chord.forEach((m, i) => {
          v.pluck(m, i * 0.085 * vary(0.06), 0.36 * vary(0.08));
          // A breath of wind answers each string an octave up.
          if (i >= 2) glint(v, midiToHz(m + 12), 0.2 + i * 0.1, 0.028, 1.8);
        });
        chord.slice(0, 4).forEach((m) => pad(v, midiToHz(m), 0.1, 0.028, 0.7, 1.5));
      },
    );
  }

  // ---------------- voice management ----------------

  private trigger(
    key: string,
    options: (graph: AudioGraph) => VoiceOptions,
    build: (voice: Voice, graph: AudioGraph) => void,
    decorative = false,
  ): void {
    const graph = this.graph;
    if (!graph || this.muted) return;
    const play = (): void => {
      if (this.graph !== graph || this.muted) return;
      const now = graph.ctx.currentTime;
      const last = this.lastPlayed.get(key);
      if (last !== undefined && now - last < DEDUPE_SECONDS) return;
      this.lastPlayed.set(key, now);
      this.spawn(graph, options(graph), build, decorative);
    };
    if (graph.ctx.state === 'running') {
      play();
    } else if (!decorative) {
      // The very first click both unlocks audio and makes a sound. Hold that sound for
      // a moment rather than letting a backlog burst out whenever the context resumes.
      const now = performance.now();
      this.pending = this.pending.filter((p) => p.expires > now).slice(-5);
      this.pending.push({ expires: now + WAKE_GRACE_MS, play });
      this.wake();
    }
  }

  private spawn(
    graph: AudioGraph,
    options: VoiceOptions,
    build: (voice: Voice, graph: AudioGraph) => void,
    decorative: boolean,
  ): void {
    let active = 0;
    for (const voice of this.voices) active += voice.sourceCount;
    if (active > (decorative ? SOFT_SOURCE_LIMIT : HARD_SOURCE_LIMIT)) return;
    let voice: Voice | null = null;
    try {
      voice = new Voice(graph, options, (done) => this.voices.delete(done));
      this.voices.add(voice);
      build(voice, graph);
    } catch {
      // A failed effect is simply shorter or silent.
    } finally {
      voice?.seal();
    }
  }

  private wake(): void {
    const ctx = this.graph?.ctx;
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    try {
      ctx.resume().catch(() => undefined);
    } catch {
      // Autoplay policy still holds; the next gesture will try again.
    }
  }

  private flushPending(): void {
    const queue = this.pending;
    this.pending = [];
    const now = performance.now();
    for (const sound of queue) if (sound.expires > now) sound.play();
  }

  private distanceGain(extra: Extra): number {
    const { x, y, z } = extra;
    if (!finite(x) || !finite(z)) return 1;
    const at: Vec3 = { x, y: finite(y) ? y : this.listener.y, z };
    // Coop cues must stay audible across the estate, so never fade out completely.
    return 0.22 + 0.78 * falloff(distance(this.listener, at), 14, 60);
  }

  /** Glide to a value without clicks and without growing the automation timeline. */
  private ramp(param: AudioParam, value: number, timeConstant: number): void {
    const graph = this.graph;
    if (!graph) return;
    const now = graph.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setTargetAtTime(value, now, timeConstant);
  }

  // ---------------- ambient mix ----------------

  private updateMix(graph: AudioGraph): void {
    const mix = ZONE_MIX[this.zone];
    const outdoor = OUTDOOR_ZONES.has(this.zone);
    const fountainDist = distance(this.listener, FOUNTAIN);
    const spatial: Partial<Record<LayerName, number>> = {
      hearth: falloff(distance(this.listener, FIREPLACE), 7, 36),
      fountain: falloff(fountainDist, 5.5, 40),
      pond: 0.2 + 0.8 * falloff(distance(this.listener, KOI_POND), 6, 30),
    };
    // First update fades in slowly; after that zones cross-fade over about a second.
    const timeConstant = this.mixStarted ? 0.45 : 1.1;
    this.mixStarted = true;
    for (const name of LAYER_NAMES) {
      const target = mix[name] * (spatial[name] ?? 1) * LAYER_LEVEL[name];
      const previous = this.targets.get(name);
      if (previous !== undefined && Math.abs(previous - target) < 0.0015 && (target > 0 || previous === 0)) {
        continue;
      }
      this.targets.set(name, target);
      this.ramp(graph.layers[name].gain, target, timeConstant);
    }
    // Walls and distance both dull the water's sparkle.
    const tone = outdoor ? clamp(4800 - fountainDist * 130, 1300, 4800) : 620;
    const previousTone = graph.fountainTone.frequency.value;
    if (Math.abs(previousTone - tone) > 20) this.ramp(graph.fountainTone.frequency, tone, 0.35);
    if (this.reverbTarget !== mix.reverb) {
      this.reverbTarget = mix.reverb;
      this.ramp(graph.reverbOut.gain, mix.reverb, 0.6);
    }
  }

  private runAmbientEvents(graph: AudioGraph, dt: number): void {
    const now = graph.ctx.currentTime;
    const mix = ZONE_MIX[this.zone];

    // Grandfather clock: tick… tock… at a steady 1 Hz.
    if (mix.clock > 0) {
      if (this.nextClock < now) this.nextClock = now + 0.1;
      while (this.nextClock < now + LOOKAHEAD) {
        const tock = this.clockTock;
        this.ambientVoice(graph, 'clock', 0.8, 0.14 * mix.clock, this.nextClock - now, (v) => {
          knock(v, tock ? 208 : 246, 0, 0.3, 0.09);
          v.noise({ gain: 0.2, dur: 0.02, attack: 0.001, filter: { type: 'bandpass', hz: tock ? 950 : 1150, q: 2 } });
        });
        this.clockTock = !tock;
        this.nextClock += 1;
      }
    }

    // Workshop escapement: an easy four-to-the-bar of warm brass.
    if (mix.workshop > 0) {
      if (this.nextEscapement < now) this.nextEscapement = now + 0.1;
      while (this.nextEscapement < now + LOOKAHEAD) {
        const beat = this.escapementBeat;
        this.ambientVoice(graph, 'workshop', 0.7, 0.1 * mix.workshop, this.nextEscapement - now, (v) => {
          const accent = beat % 4 === 0;
          click(v, 0, accent ? 0.3 : 0.18, beat % 2 === 0 ? 1000 : 820);
          v.tone({ hz: beat % 2 === 0 ? 294 : 247, gain: accent ? 0.1 : 0.06, dur: 0.22, attack: 0.004, wave: 'triangle' });
          if (beat === 0) clunk(v, 98, 0.03, 0.26, 0.3);
          if (beat === 6) ratchet(v, 0.1, 4, 0.06, 0.95, 0.08, 900);
        });
        this.escapementBeat = (beat + 1) % 8;
        this.nextEscapement += 0.5;
      }
    }

    if (BIRD_ZONES.has(this.zone)) {
      this.birdTimer -= dt;
      if (this.birdTimer <= 0) {
        this.birdTimer = rand(5, 11);
        this.songbird(graph, mix.birds);
      }
    }

    if (mix.chimes > 0) {
      this.chimeTimer -= dt;
      if (this.chimeTimer <= 0) {
        this.chimeTimer = rand(7, 14);
        this.windChimes(graph, mix.chimes);
      }
    }

    const shimmer = Math.max(mix.glassPad, mix.starPad);
    if (shimmer > 0) {
      this.glintTimer -= dt;
      if (this.glintTimer <= 0) {
        this.glintTimer = rand(5, 10);
        const layer: LayerName = mix.starPad > 0 ? 'starPad' : 'glassPad';
        const notes = layer === 'starPad' ? [74, 78, 81, 85, 88] : [69, 71, 74, 76, 78];
        this.ambientVoice(graph, layer, 0.5, 0.2, 0, (v) => {
          glint(v, midiToHz(pick(notes)), 0, 0.14, 2.6);
          glint(v, midiToHz(pick(notes)), rand(0.25, 0.7), 0.09, 2.6);
        }, rand(-0.5, 0.5));
      }
    }
  }

  private ambientVoice(
    graph: AudioGraph,
    layer: LayerName,
    gain: number,
    reverb: number,
    delay: number,
    build: (voice: Voice) => void,
    pan = 0,
  ): void {
    this.spawn(
      graph,
      {
        dest: graph.layers[layer],
        gain,
        reverb: reverb * LAYER_LEVEL[layer],
        delay: Math.max(0, delay),
        pan,
      },
      build,
      true,
    );
  }

  private songbird(graph: AudioGraph, level: number): void {
    const base = rand(1500, 2100);
    const song = Math.floor(Math.random() * 3);
    this.ambientVoice(graph, 'birds', 0.5, 0.35 * level, 0, (v) => {
      const chirp = (at: number, from: number, to: number, dur: number, gain: number): void =>
        v.tone({
          hz: from,
          hzEnd: to,
          at,
          gain,
          attack: Math.min(0.03, dur * 0.3),
          hold: dur * 0.2,
          dur,
          vibrato: { hz: 26, cents: 18 },
        });
      if (song === 0) {
        // "tee-yoo, tee-yoo"
        for (let i = 0; i < 2 + Math.floor(Math.random() * 2); i++) {
          chirp(i * 0.34, base * 1.05, base * 1.32, 0.14, 0.1);
          chirp(i * 0.34 + 0.14, base * 1.3, base * 0.95, 0.18, 0.09);
        }
      } else if (song === 1) {
        // Soft ascending warble
        for (let i = 0; i < 5; i++) {
          const hz = base * (0.92 + i * 0.075);
          chirp(i * 0.12, hz, hz * (i % 2 === 0 ? 1.14 : 0.93), 0.13, 0.06 + i * 0.008);
        }
      } else {
        // Two lazy whistles, the second answering a third lower
        chirp(0, base * 1.1, base * 1.2, 0.32, 0.09);
        chirp(0.46, base * 0.96, base * 0.9, 0.4, 0.08);
      }
    }, rand(-0.75, 0.75));
  }

  private windChimes(graph: AudioGraph, level: number): void {
    this.ambientVoice(graph, 'chimes', 0.5, 0.5 * level, 0, (v) => {
      const count = 3 + Math.floor(Math.random() * 4);
      let at = 0;
      for (let i = 0; i < count; i++) {
        // PENTATONIC[2..9] is F#4..B5: sweet rather than tinny.
        bell(v, midiToHz(PENTATONIC[2 + Math.floor(Math.random() * 8)]), at, rand(0.06, 0.13), rand(1.8, 2.6));
        at += rand(0.09, 0.42);
      }
    }, rand(-0.5, 0.5));
  }

  // ---------------- graph construction ----------------

  private buildGraph(): AudioGraph {
    const scope = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
    const Ctor: typeof AudioContext | undefined = scope.AudioContext ?? scope.webkitAudioContext;
    if (!Ctor) throw new Error('AudioContext is not supported');
    const ctx = new Ctor({ latencyHint: 'interactive' });
    try {
      return this.wireGraph(ctx);
    } catch (err) {
      ctx.close().catch(() => undefined);
      throw err;
    }
  }

  private wireGraph(ctx: AudioContext): AudioGraph {
    const nodes: AudioNode[] = [];
    const sources: AudioScheduledSourceNode[] = [];
    const keep = <T extends AudioNode>(node: T): T => {
      nodes.push(node);
      return node;
    };
    const gain = (value: number, dest?: AudioNode): GainNode => {
      const node = keep(ctx.createGain());
      node.gain.value = value;
      if (dest) node.connect(dest);
      return node;
    };
    const filter = (type: BiquadFilterType, hz: number, q: number, dest: AudioNode): BiquadFilterNode => {
      const node = keep(ctx.createBiquadFilter());
      node.type = type;
      node.frequency.value = hz;
      node.Q.value = q;
      node.connect(dest);
      return node;
    };
    const loop = (buffer: AudioBuffer, dest: AudioNode, rate = 1): void => {
      const node = keep(ctx.createBufferSource());
      node.buffer = buffer;
      node.loop = true;
      node.playbackRate.value = rate;
      node.connect(dest);
      node.start(0, Math.random() * buffer.duration);
      sources.push(node);
    };
    const drone = (type: OscillatorType, hz: number, dest: AudioNode | AudioParam, detune = 0): void => {
      const node = keep(ctx.createOscillator());
      node.type = type;
      node.frequency.value = hz;
      node.detune.value = detune;
      if (dest instanceof AudioParam) node.connect(dest);
      else node.connect(dest);
      node.start();
      sources.push(node);
    };
    /** Slow sine modulation of a parameter around its own value. */
    const sway = (param: AudioParam, hz: number, depth: number): void => {
      const amount = keep(ctx.createGain());
      amount.gain.value = depth;
      amount.connect(param);
      drone('sine', hz, amount);
    };

    // --- Output chain ---
    const master = gain(this.muted ? 0 : MASTER_LEVEL, ctx.destination);
    const limiter = keep(ctx.createDynamicsCompressor());
    limiter.threshold.value = -12;
    limiter.knee.value = 12;
    limiter.ratio.value = 5;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.22;
    limiter.connect(master);
    const warmth = keep(ctx.createBiquadFilter());
    warmth.type = 'highshelf';
    warmth.frequency.value = 4200;
    warmth.gain.value = -5;
    warmth.connect(limiter);

    const sfxBus = gain(0.9, warmth);
    const ambientBus = gain(0.75, warmth);

    const reverbOut = gain(0.5, warmth);
    const convolver = keep(ctx.createConvolver());
    convolver.normalize = true;
    convolver.buffer = makeRoomImpulse(ctx, 2.1);
    convolver.connect(reverbOut);
    const reverbIn = filter('highpass', 160, 0.5, convolver);
    const reverbSend = gain(1, reverbIn);

    const layers = {} as Record<LayerName, GainNode>;
    for (const name of LAYER_NAMES) layers[name] = gain(0, ambientBus);

    const noise: Record<NoiseColor, AudioBuffer> = {
      white: makeNoise(ctx, 2, 'white'),
      pink: makeNoise(ctx, 6, 'pink'),
      brown: makeNoise(ctx, 4, 'brown'),
    };

    // --- Hearth: ember roar that breathes, plus crackle ---
    const roar = gain(0.5, layers.hearth);
    sway(roar.gain, 0.23, 0.12);
    sway(roar.gain, 0.61, 0.07);
    loop(noise.pink, filter('lowpass', 340, 0.4, roar), 0.9);
    const embers = gain(0.5, layers.hearth);
    loop(makeCrackle(ctx, 9), filter('lowpass', 2600, 0.4, embers));

    // --- Breeze: two drifting bands of pink noise ---
    const leafGust = gain(0.4, layers.breeze);
    sway(leafGust.gain, 0.083, 0.22);
    sway(leafGust.gain, 0.19, 0.1);
    const leaves = filter('bandpass', 620, 0.6, leafGust);
    sway(leaves.frequency, 0.067, 220);
    loop(noise.pink, leaves);
    const softAir = gain(0.5, layers.breeze);
    sway(softAir.gain, 0.053, 0.22);
    loop(noise.pink, filter('bandpass', 280, 0.5, softAir), 0.83);

    // --- Birds sing through a gentle top-end roll-off (chimes go straight to the bus) ---
    layers.birds.disconnect();
    layers.birds.connect(filter('lowpass', 3400, 0.3, ambientBus));

    // --- Fountain: broad wash of falling water plus individual bubbles ---
    const fountainTone = filter('lowpass', 4000, 0.3, layers.fountain);
    const wash = gain(0.36, fountainTone);
    sway(wash.gain, 0.37, 0.05);
    loop(noise.pink, filter('bandpass', 950, 0.35, wash), 1.07);
    const bubbleOptions: BubbleOptions = { seconds: 7, perSecond: 42, minHz: 380, maxHz: 1500, level: 0.3 };
    loop(makeBubbles(ctx, bubbleOptions), gain(0.75, fountainTone));

    // --- Koi pond: slower, rounder droplets over a thin trickle ---
    const trickle = gain(0.12, layers.pond);
    sway(trickle.gain, 0.29, 0.035);
    loop(noise.pink, filter('bandpass', 720, 0.7, trickle), 0.95);
    loop(
      makeBubbles(ctx, { seconds: 8, perSecond: 9, minHz: 300, maxHz: 950, level: 0.36 }),
      filter('lowpass', 2400, 0.4, layers.pond),
    );

    // --- Pads: each chord tone swells on its own slow cycle ---
    const chordPad = (layer: LayerName, notes: readonly number[], level: number, tone: number): void => {
      const warm = filter('lowpass', tone, 0.3, layers[layer]);
      notes.forEach((m, i) => {
        const swell = gain(level * 0.6, warm);
        sway(swell.gain, 0.047 + i * 0.017, level * 0.35);
        const pair = i < 2 ? 'triangle' : 'sine';
        drone(pair, midiToHz(m), swell, -4);
        drone(pair, midiToHz(m), swell, 4);
      });
    };
    chordPad('glassPad', [50, 57, 62, 66, 69], 0.045, 1100); // D major, rooted and serene
    chordPad('starPad', [50, 57, 66, 73, 76], 0.045, 1500); // D maj9, open voicing

    // --- Workshop: low gear resonance turning over slowly ---
    const hum = gain(0.065, filter('lowpass', 420, 0.5, layers.workshop));
    sway(hum.gain, 0.5, 0.016);
    sway(hum.gain, 0.11, 0.012);
    drone('triangle', midiToHz(38), hum);
    drone('triangle', midiToHz(45), hum, -5);
    drone('sine', midiToHz(50), hum, 5);
    loop(noise.brown, filter('lowpass', 260, 0.4, gain(0.16, layers.workshop)));

    // --- High wind on the Sky-Deck ---
    const gust = gain(0.45, layers.highWind);
    sway(gust.gain, 0.071, 0.24);
    const highBand = filter('bandpass', 480, 0.8, gust);
    sway(highBand.frequency, 0.059, 170);
    sway(highBand.frequency, 0.137, 60);
    loop(noise.pink, highBand, 0.9);
    loop(noise.pink, filter('lowpass', 220, 0.4, gain(0.5, layers.highWind)), 0.75);

    // Flutes, mostly: strong fundamental and a little quint for a wooden colour.
    const harmonics = new Float32Array([0, 1, 0.34, 0.22, 0.1, 0.05, 0.03, 0.012, 0.01]);
    const organWave = ctx.createPeriodicWave(new Float32Array(harmonics.length), harmonics);

    const onStateChange = (): void => {
      if (ctx.state === 'running') this.flushPending();
    };
    ctx.addEventListener('statechange', onStateChange);

    return {
      ctx,
      master,
      sfxBus,
      ambientBus,
      reverbIn: reverbSend,
      reverbOut,
      layers,
      fountainTone,
      noise,
      organWave,
      harpStrings: new Map(),
      sources,
      nodes,
      onStateChange,
    };
  }
}
