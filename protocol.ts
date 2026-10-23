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

/** Peak above which a PCM16 block counts as voice rather than silence or breath. */
const VOICE_PEAK = 600;

/** Milliseconds of voiced audio in a PCM16 buffer, judged per 20 ms block. */
export function voicedMs(pcm: Buffer, rate: number): number {
  const block = Math.max(2, Math.floor(rate * 0.02) * 2);
  let ms = 0;
  for (let start = 0; start + 1 < pcm.length; start += block) {
    const end = Math.min(pcm.length, start + block);
    for (let i = start; i + 1 < end; i += 2) {
      if (Math.abs(pcm.readInt16LE(i)) > VOICE_PEAK) { ms += (end - start) / 2 / rate * 1000; break; }
    }
  }
  return ms;
}

/**
 * Live captions for the agent's speech, one phrase at a time. Transcript text
 * usually arrives ahead of its audio, so each delta is stamped with the amount
 * of audio queued when it arrived, and its characters are spread over the audio
 * that follows, up to the next delta. Time is counted in voiced audio only, so
 * pauses and breaths do not advance the caption; they fall on phrase breaks.
 */
export class Captions {
  private queuedMs = 0;
  private playedMs = 0;
  private pending: { at: number; text: string; turn?: boolean }[] = [];
  private shown = "";
  private readonly onLine: (line: CaptionLine) => void;

  /** onLine gets the current phrase (empty to clear) and how much of it has been spoken. */
  constructor(onLine: (line: CaptionLine) => void) { this.onLine = onLine; }

  /** Transcript text for audio that is about to be (or already was) queued. */
  text(delta: string) {
    // Eleven v3 voices put delivery tags such as "[Tone]" into the transcript.
    const clean = delta.replace(/\[[^\]]*\]\s*/g, "");
    if (clean) { this.pending.push({ at: this.queuedMs, text: clean }); this.emit(); }
  }

  queued(pcm: Buffer, rate: number) { this.queuedMs += voicedMs(pcm, rate); this.emit(); }

  played(frame: Buffer, rate: number) { this.playedMs += voicedMs(frame, rate); this.emit(); }

  /** Queued audio was dropped (barge-in): unplayed text never gets said. */
  interrupt() {
    this.pending = this.pending.filter(entry => entry.at < this.playedMs);
    this.queuedMs = this.playedMs;
    this.emit();
  }

  /** A new turn starts with the audio queued from now on: its first phrase replaces the line. */
  turn() { this.pending.push({ at: this.queuedMs, text: "", turn: true }); }

  private emit() {
    // The current turn is everything after the last turn marker that has started playing.
    let first = 0;
    for (let i = 0; i < this.pending.length; i++) if (this.pending[i].turn && this.pending[i].at < this.playedMs) first = i;
    this.pending.splice(0, first);
    let text = "", cursor = 0;
    for (let i = 0; i < this.pending.length; i++) {
      const entry = this.pending[i];
      if (entry.turn && i > 0) break; // the next turn has not started yet
      const end = this.pending[i + 1]?.at ?? this.queuedMs;
      // Strictly after its mark: a pause before a delta keeps the previous phrase up.
      if (entry.text && this.playedMs > entry.at) {
        const share = end > entry.at ? Math.min(1, (this.playedMs - entry.at) / (end - entry.at)) : 0;
        cursor = text.length + Math.max(1, Math.round(share * entry.text.length));
      }
      text += entry.text;
    }
    const line = phraseAt(text, cursor);
    const key = JSON.stringify(line);
    if (key !== this.shown) { this.shown = key; this.onLine(line); }
  }
}

/** Phrase breaks: sentence ends, commas, semicolons, colons, and dashes followed by a space. */
const PHRASE = /[^,;:.!?…—–]*(?:[,;:.!?…]+["”’)]*|\s[—–])(?=\s|$)\s*|[^,;:.!?…—–]+$|[^\s]+\s*/g;

/** A caption phrase: `continues` an unfinished sentence, and/or leaves it `open` for more. */
export type CaptionLine = { phrase: string; spoken: number; continues: boolean; open: boolean };

const SENTENCE_END = /[.!?…]+["”’)]*$/;

/** The phrase that contains the character at `cursor` (1-based count of spoken characters), and how much of it is spoken. */
export function phraseAt(text: string, cursor: number): CaptionLine {
  const none = { phrase: "", spoken: 0, continues: false, open: false };
  if (cursor <= 0) return none;
  let start = 0, previous = "";
  for (const match of text.match(PHRASE) ?? []) {
    const end = start + match.length;
    const phrase = match.replace(/\s+/g, " ").trim();
    if (cursor <= end || end >= text.length) {
      return { phrase, spoken: Math.min(phrase.length, cursor - start), continues: previous !== "" && !SENTENCE_END.test(previous), open: !SENTENCE_END.test(phrase) };
    }
    if (phrase) previous = phrase;
    start = end;
  }
  return none;
}

/**
 * The caption text for a bar `width` columns wide. A break inside a sentence
 * shows as "…" on both sides (the comma, semicolon, colon, or dash it replaces
 * is dropped). A phrase wider than the bar is split into whole-word chunks, and
 * the chunk holding the spoken position is shown.
 */
export function formatCaption(line: CaptionLine, width: number, measure: (text: string) => number = text => text.length): string {
  const core = line.phrase.replace(/\s*[,;:—–]+$/, "");
  if (!core) return "";
  const decorate = (text: string, lead: boolean, tail: boolean) => `${lead ? "…" : ""}${text}${tail ? "…" : ""}`;
  const whole = decorate(core, line.continues, line.open);
  if (measure(whole) <= width) return whole;
  const budget = Math.max(1, width - 2); // room for both ellipses
  const chunks: { text: string; end: number }[] = [];
  let chunk = "", start = 0;
  for (const word of core.split(" ")) {
    const next = chunk ? `${chunk} ${word}` : word;
    if (chunk && measure(next) > budget) {
      chunks.push({ text: chunk, end: start + chunk.length });
      start += chunk.length + 1;
      chunk = word;
    } else chunk = next;
  }
  chunks.push({ text: chunk, end: start + chunk.length });
  const index = Math.max(0, chunks.findIndex(c => line.spoken <= c.end));
  const last = chunks.length - 1;
  return decorate(chunks[index].text, index > 0 || line.continues, index < last || line.open);
}
