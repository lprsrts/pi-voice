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
/** Unvoiced audio before a voiced frame that makes it a speech onset (a turn's first word). */
const ONSET_QUIET_MS = 250;

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
 * Live captions for the agent's speech, one phrase at a time. Providers time
 * their text in one of two ways, and both are handled:
 *
 * - GPT-Live stamps every transcript fragment with a range on its session clock
 *   (start_ms/end_ms). Output audio on the primary socket carries no timing, and
 *   the local count of played audio drifts from that clock (a late first frame,
 *   dropped frames, audio flushed on barge-in), so each turn re-anchors it: the
 *   turn's first voiced onset after the user spoke is where its first fragment
 *   starts. Fragments then pace against played audio plus that offset.
 *
 * - ElevenLabs sends no timing. Each delta is stamped with the voiced audio
 *   queued when it arrived; deltas sharing a stamp arrived in one burst and
 *   pace together. A span closes when the next delta's stamp or the item's
 *   audio-done fixes its length, and is then paced exactly by its share of the
 *   played audio; while it is open, the audio queued so far only tracks the
 *   delivery pace, so the cursor advances by the session's calibrated speaking
 *   rate instead.
 *
 * Time is counted in voiced audio only, so pauses and breaths do not advance
 * the caption; they fall on phrase breaks. Within a turn the cursor never
 * moves backward: later knowledge refines what is left to say, not what was
 * already spoken.
 */
export class Captions {
  private queuedMs = 0;
  private playedMs = 0;
  private sessionMs = 0; // all played output audio, silence included
  private offset = 0;    // GPT-Live session timeline minus sessionMs, anchored per turn
  private quietMs = Infinity; // unvoiced audio played since the last voiced frame
  private onsets: number[] = []; // sessionMs of recent speech onsets (voice after a pause)
  private userAt = 0;    // sessionMs when the user last started speaking
  private pending: { at: number; text: string; turn?: boolean; end?: number; from?: number; to?: number; sat?: number; after?: number; anchored?: boolean }[] = [];
  private shown = "";
  private spoken = 0; // high-water mark of spoken characters in the current turn
  private charsPerMs = 1 / 70; // speaking-rate prior (~14 chars/s), calibrated from closed spans
  private readonly onLine: (line: CaptionLine) => void;

  /** onLine gets the current phrase (empty to clear) and how much of it has been spoken. */
  constructor(onLine: (line: CaptionLine) => void) { this.onLine = onLine; }

  /** Transcript text; GPT-Live fragments carry their range on the session clock. */
  text(delta: string, from?: number, to?: number) {
    // Eleven v3 voices put delivery tags such as "[Tone]" into the transcript.
    const clean = delta.replace(/\[[^\]]*\]\s*/g, "");
    if (!clean) return;
    const at = this.queuedMs;
    const last = this.pending.at(-1);
    if (last && !last.turn && last.end === undefined && last.to === undefined && last.at !== at) this.close(at);
    this.pending.push(from !== undefined && to !== undefined ? { at, text: clean, from, to } : { at, text: clean });
    this.emit();
  }

  queued(pcm: Buffer, rate: number) { this.queuedMs += voicedMs(pcm, rate); this.emit(); }

  played(frame: Buffer, rate: number) {
    const voiced = voicedMs(frame, rate), ms = frame.length / 2 / rate * 1000;
    if (voiced > 0 && this.quietMs >= ONSET_QUIET_MS) this.onsets = [...this.onsets.slice(-7), this.sessionMs];
    this.quietMs = voiced > 0 ? 0 : this.quietMs + ms;
    this.playedMs += voiced;
    this.sessionMs += ms;
    this.emit();
  }

  /** The user started speaking (GPT-Live): the next turn's speech begins after this point. */
  userSpeech() { this.userAt = this.sessionMs; }

  /** Local estimate of the GPT-Live session timeline. */
  private get timeline() { return this.sessionMs + this.offset; }

  /** Queued audio was dropped (barge-in): unplayed text never gets said. */
  interrupt() {
    const heard = (entry: { at: number; from?: number; sat?: number }) =>
      (entry.sat ?? entry.from) !== undefined
        ? (entry.sat ?? entry.from)! < this.timeline
        : entry.at < this.playedMs;
    this.pending = this.pending.filter(entry => entry.turn || entry.to === undefined ? heard(entry) : entry.from! < this.timeline);
    this.queuedMs = this.playedMs;
    this.emit();
  }

  /** A new turn starts: its first phrase replaces the line. GPT-Live markers carry the new speech's session position. */
  turn(from?: number) {
    const at = this.queuedMs;
    const last = this.pending.at(-1);
    if (last && !last.turn && last.end === undefined && last.to === undefined) this.close(at);
    this.pending.push({ at, text: "", turn: true, ...(from !== undefined ? { sat: from, after: this.userAt } : {}) });
    this.emit();
  }

  /** The item's audio is fully queued (ElevenLabs response.output_audio.done): its open span is now known exactly. */
  done() { this.close(this.queuedMs); }

  /** Fixes the open group's span at `end` and calibrates the speaking rate from it. */
  private close(end: number) {
    let start = this.pending.length;
    while (start > 0 && !this.pending[start - 1].turn && this.pending[start - 1].end === undefined && this.pending[start - 1].to === undefined) start--;
    const at = this.pending[start]?.at;
    if (at === undefined) return;
    let len = 0;
    for (let i = start; i < this.pending.length; i++) { this.pending[i].end = end; len += this.pending[i].text.length; }
    // Only human-plausible rates calibrate the prior (chars per voiced ms).
    if (len >= 8 && end - at >= 100) {
      const sample = len / (end - at);
      if (sample > 0.005 && sample < 0.05) this.charsPerMs = this.charsPerMs * 0.6 + sample * 0.4;
    }
    this.emit();
  }

  private emit() {
    // Anchor each timed turn to its speech onset: the first onset after the user
    // spoke is where the turn's first fragment starts on the session timeline.
    for (const marker of this.pending) {
      if (!marker.turn || marker.sat === undefined || marker.anchored) continue;
      const onset = this.onsets.find(at => at >= marker.after!);
      if (onset !== undefined) { this.offset = marker.sat - onset; marker.anchored = true; }
    }
    // The current turn is everything after the last turn marker that has started playing.
    let first = 0;
    for (let i = 0; i < this.pending.length; i++) {
      const marker = this.pending[i];
      if (!marker.turn) continue;
      if (marker.sat !== undefined ? marker.sat < this.timeline : marker.at < this.playedMs) first = i;
    }
    if (first > 0) this.spoken = 0; // a new turn counts its spoken characters from zero
    this.pending.splice(0, first);
    let text = "", cursor = 0;
    for (let i = 0; i < this.pending.length;) {
      const entry = this.pending[i];
      if (entry.turn) { if (i > 0) break; i++; continue; } // the next turn has not started; the marker adds no text
      if (entry.to !== undefined) {
        // A timed fragment (GPT-Live): pace it against the anchored timeline.
        const from = entry.from!, to = entry.to, now = this.timeline;
        if (now > from) {
          const share = to > from ? Math.min(1, (now - from) / (to - from)) : 1;
          cursor = text.length + Math.max(1, Math.round(share * entry.text.length));
        }
        text += entry.text;
        i++;
        continue;
      }
      // Deltas sharing a stamp arrived in one burst ahead of their audio: their
      // combined text paces together over the span up to the next stamp.
      const at = entry.at;
      let j = i, len = 0;
      while (j < this.pending.length && !this.pending[j].turn && this.pending[j].to === undefined && this.pending[j].at === at) {
        len += this.pending[j].text.length;
        j++;
      }
      const end = this.pending[j]?.at ?? entry.end;
      // Strictly after its mark: a pause before a delta keeps the previous phrase up.
      if (this.playedMs > at) {
        if (end !== undefined && end > at) {
          const share = Math.min(1, (this.playedMs - at) / (end - at));
          cursor = text.length + Math.max(1, Math.round(share * len));
        } else {
          // The span is still open: the audio queued so far tracks the delivery
          // pace, not the sentence's length, so pace by the speaking rate the
          // session has calibrated from closed spans instead.
          cursor = text.length + Math.min(len, Math.max(1, Math.round((this.playedMs - at) * this.charsPerMs)));
        }
      }
      for (let k = i; k < j; k++) text += this.pending[k].text;
      i = j;
    }
    this.spoken = Math.max(this.spoken, cursor); // audio cannot unplay: what was spoken stays spoken
    const line = phraseAt(text, this.spoken);
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

/**
 * Cuts text to at most `max` tokens by a deliberately pessimistic estimate, at a
 * piece boundary, marking the cut with "…". Code, paths, numbers, and non-Latin
 * text tokenize far denser than prose, so each letter run counts one token per
 * four letters, and every digit, symbol, and non-ASCII character counts one.
 */
export function clipTokens(text: string, max: number): string {
  let tokens = 0, end = 0;
  for (const piece of text.matchAll(/[A-Za-z]+|\s+|[\s\S]/g)) {
    const value = piece[0];
    const cost = /^[A-Za-z]/.test(value) ? Math.ceil(value.length / 4) : /^\s+$/.test(value) ? (value.includes("\n") ? 1 : 0) : 1;
    if (tokens + cost > max - 1) return `${text.slice(0, end).trimEnd()} …`; // one token left for the ellipsis
    tokens += cost;
    end = piece.index! + value.length;
  }
  return text;
}
