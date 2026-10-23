export type VoiceState = "idle" | "listening" | "thinking" | "speaking" | "error";

/** Fixed-size, sample-aligned frames independent of OS pipe boundaries. */
export class PcmFramer {
  private pending: Buffer = Buffer.alloc(0);
  readonly bytes: number;
  constructor(rate: number) { this.bytes = Math.floor(rate * 0.02) * 2; }
  flush(): Buffer | undefined {
    if (!this.pending.length) return;
    const frame = Buffer.alloc(this.bytes);
    this.pending.copy(frame);
    this.pending = Buffer.alloc(0);
    return frame;
  }
  push(chunk: Buffer): Buffer[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: Buffer[] = [];
    while (this.pending.length >= this.bytes) {
      frames.push(Buffer.from(this.pending.subarray(0, this.bytes)));
      this.pending = this.pending.subarray(this.bytes);
    }
    return frames;
  }
}

export function waveform(pcm: Buffer): number[] {
  const count = Math.min(512, Math.floor(pcm.length / 2));
  return Array.from({ length: count }, (_, i) => pcm.readInt16LE(i * 2) / 32768);
}

/**
 * The strongest frequency in a frame (Hz), searched on a log grid over the
 * voice band with a Hann window and Goertzel filters, refined by parabolic
 * interpolation between neighbouring grid points. Undefined for silence.
 */
export function dominantFrequency(samples: number[], rate: number, low = 80, high = 4000, bins = 64): number | undefined {
  const n = samples.length;
  if (n < 64) return;
  const top = Math.min(high, rate / 2 * 0.95);
  const ratio = Math.log(top / low) / (bins - 1);
  const windowed = samples.map((value, i) => value * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1))));
  const power = new Array<number>(bins);
  let best = 0;
  for (let k = 0; k < bins; k++) {
    const coeff = 2 * Math.cos(2 * Math.PI * low * Math.exp(ratio * k) / rate);
    let s1 = 0, s2 = 0;
    for (const value of windowed) { const s0 = value + coeff * s1 - s2; s2 = s1; s1 = s0; }
    power[k] = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    if (power[k] > power[best]) best = k;
  }
  if (!(power[best] > 1e-6)) return;
  let offset = 0;
  if (best > 0 && best < bins - 1) {
    const [a, b, c] = [power[best - 1], power[best], power[best + 1]];
    const curve = a - 2 * b + c;
    if (curve < 0) offset = Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / curve));
  }
  return low * Math.exp(ratio * (best + offset));
}
