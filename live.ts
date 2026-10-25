import type { AudioPipes } from "./audio.ts";
import { providerFiles, type ProviderFiles } from "./config.ts";
import { CONVERSATION_MARK, VOICE_REQUEST } from "./pi-bridge.ts";
import { Captions, clipTokens, type CaptionLine, voicedMs, waveform, type VoiceState } from "./protocol.ts";

// OpenAI GPT-Live (wss://api.openai.com/v1/live/sessions) with client
// delegation: the Pi session itself is the backend. When GPT-Live delegates,
// the user's words since the last delegation (its input transcript) go to Pi
// as a message; Pi works with its own model, tools, and environment, and its
// progress (thinking, silent) and results (commentary, spoken) go back tagged
// with the delegation. Config lives in providers/openai-live/.

const ENDPOINT = "wss://api.openai.com/v1/live/sessions";
const RATE = 24000; // PCM16 mono both ways; the native helper runs unresampled at this rate
const APPEND_TOKENS = 400; // commentary/thinking accept at most 500 tokens; the estimate is pessimistic, and this leaves margin
const SPEECH_PEAK = 600;
// A delegation's request is complete once a fragment reaches its offset_ms (measured
// live: the last word's fragment arrived with or before the delegation every time);
// otherwise late fragments get this long to arrive.
const DELEGATION_SETTLE_MS = 350;
// While Pi works, these are handled locally instead of being sent to Pi as messages.
const STOP_REQUEST = /^(please\s+)?(stop|cancel|abort|halt|never\s?mind|forget it)(\s+(it|that|this|the task|the job|everything|pi|now))*(\s+please)?[.!]*$/i;
const STATUS_REQUEST = /^(so\s+|and\s+|okay,?\s+|ok,?\s+)?(what('?s| is)\s+(pi|it|he|she)\s+doing|what('?re|\s+are)\s+you\s+(doing|working\s+on|up\s+to)|how('?s| is)\s+it\s+going|how far|(is|are)\s+(it|pi|you)\s+(done|finished)|any\s+(news|progress|update)|status|progress)\b[^.!?]{0,40}[.?!]*$/i;

const CONTEXT_CHARS = 3000;
// The spoken history: a finished exchange (the user's words, then the voice's
// reply) is written once the voice has been quiet this long, or at once when
// the user starts a new turn or voice stops.
const TRANSCRIPT_QUIET_MS = 1200;
// ...unless the transcript is still ahead of the audio (the reply goes on after
// a pause), up to this long.
const TRANSCRIPT_WAIT_MS = 8000;
const TRANSCRIPT_CHARS = 4000;
// GPT-Live can start replying before the transcript of the user's last words
// arrives. A fragment that lands this soon after the reply began, before this
// much of it has played, still belongs to the user's turn (measured live: the
// last word trailed the reply's first transcript by well under a second).
// Tests that script exchanges in no time set `ms` to 0.
export const LATE_WORDS = { ms: 1500, playedMs: 700 };

/** The part of a reply that was heard before the user cut it off, at a word boundary, marked with "…". */
export function heardPart(text: string, fraction: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (fraction >= 1) return clean;
  const cut = clean.slice(0, Math.max(0, Math.round(clean.length * fraction)));
  const words = cut.length < clean.length && clean[cut.length] !== " " ? cut.replace(/\S*$/, "") : cut;
  const kept = words.replace(/[\s,;:—–-]+$/, "");
  return kept ? `${kept}…` : "";
}

/** The spoken conversation since the last request, newest kept, for the request Pi receives. */
export function conversationContext(conversation: { role: "user" | "voice"; text: string }[]): string {
  const lines: string[] = [];
  let chars = 0;
  for (let i = conversation.length - 1; i >= 0; i--) {
    const line = `- ${conversation[i].role === "user" ? "User" : "You (voice)"}: ${conversation[i].text}`;
    if (chars + line.length > CONTEXT_CHARS) { if (!lines.length) lines.unshift(`${line.slice(0, CONTEXT_CHARS - 1)}…`); break; }
    lines.unshift(line);
    chars += line.length;
  }
  return lines.length ? `${CONVERSATION_MARK}${lines.join("\n")}` : "";
}

/** The work's status (pi_status) as a first-person sentence the voice can relay. */
export function describeStatus(status: any): string {
  if (status?.state === "idle") return status.last_result ? `Nothing is running. My last answer: ${status.last_result}` : "Nothing is running.";
  const doing = status?.state === "waiting_for_approval" ? "waiting for the user to answer a prompt in the terminal" : "working";
  const parts = [`I'm ${doing} on "${status?.task ?? "a task"}"${typeof status?.elapsed_s === "number" ? ` for ${status.elapsed_s} seconds` : ""}`];
  if (status?.last_tool) parts.push(`last step: ${status.last_tool}`);
  if (status?.queued?.length) parts.push(`${status.queued.length} more request${status.queued.length === 1 ? "" : "s"} queued`);
  return `${parts.join("; ")}.`;
}   // GPT-Live streams continuously, silence included (measured: 44.8 s of audio in a 47 s session)

/** Whether a PCM16 frame carries speech rather than the stream's silence. */
export function audibleFrame(frame: Buffer): boolean {
  for (let i = 0; i + 1 < frame.length; i += 2) if (Math.abs(frame.readInt16LE(i)) > SPEECH_PEAK) return true;
  return false;
}

/** A built-in voice name, or a custom (prompt-generated) voice by ID with its original description. */
type LiveVoiceSetting = string | { id: string; name?: string; description?: string };
type LiveFile = { model: string; voice: LiveVoiceSetting };

/** The session.start payload, from providers/openai-live/ or the user override directory. */
export function liveSessionConfig(files: ProviderFiles = providerFiles("openai-live")) {
  const file = files.session<LiveFile>();
  const instructions = files.text("instructions.md");
  const custom = typeof file.voice === "object" ? file.voice : undefined;
  return {
    model: file.model,
    // Custom voices perform best with their original description in the instructions (OpenAI custom-voices guide).
    instructions: custom?.description ? `${instructions}\n\nVoice: ${custom.description}` : instructions,
    audio: { format: { type: "audio/pcm", rate: RATE }, output: { voice: custom ? { id: custom.id } : file.voice } },
    // Pi is the backend: GPT-Live hands over a delegation ID; pi-voice gives Pi the task.
    delegation: { type: "client" },
  };
}

type Hooks = {
  state: (state: VoiceState) => void;
  samples: (source: "input" | "output", samples: number[]) => void;
  error: (message: string) => void;
  closed: () => void;
  /** Pi bridge calls (ask_pi, pi_status, cancel_pi); return at once while Pi works in the background. */
  tool: (name: string, args: Record<string, unknown>) => object;
  /** Whether Pi is working, for the resting waveform state. */
  busy: () => boolean;
  /** What this voice session should know at start: the agent's memory of the Pi session. */
  briefing?: () => string;
  /** Someone is talking: the user (input transcript) or the voice (audible playback). */
  activity?: () => void;
  /** The phrase the agent is saying now and how much of it is spoken, in step with playback. */
  caption?: (line: CaptionLine) => void;
  /**
   * What is being said right now, for the chat: the user's words as they are
   * recognized, or the voice's reply as far as it has played; `answer` when it
   * reads out a Pi result that the chat shows in its place.
   */
  live?: (role: "user" | "voice", text: string, answer?: string) => void;
  /**
   * A turn is over: what to keep of it (the user's words, or the voice's reply cut
   * where the user interrupted it). Empty when nothing is kept: a request handed
   * to Pi, or what was said while Pi works.
   */
  transcript?: (role: "user" | "voice", text: string, interrupted: boolean, answer?: string) => void;
};

type AudioFactory = (callbacks: ConstructorParameters<typeof AudioPipes>[0]) => AudioPipes;

/** Node's WebSocket (undici) accepts headers; the browser typings do not know that. */
type HeaderSocket = new (url: string, init: { headers: Record<string, string> }) => WebSocket;

export class LiveVoice {
  private hooks: Hooks;
  private audioFactory: AudioFactory;
  private ws?: WebSocket;
  private audio?: AudioPipes;
  private abort = new AbortController();
  private stopped = false;
  private closing = false;
  private muted = false;
  private deadline?: ReturnType<typeof setTimeout>;
  private resolveStart?: () => void;
  private rejectStart?: (error: Error) => void;
  private seq = 0;
  // Pi backend: what the user said (input transcript, session clock), how far
  // delegations have consumed it, and the delegation Pi is answering.
  private heard: { start: number; end: number; text: string; sent?: boolean; busy?: boolean }[] = [];
  private consumedMs = -1;
  private lastRequest = "";
  private said = "";  // what the voice has said since the user last spoke
  private turnFrom = -Infinity; // session-clock start of the user's current turn
  // Everything said since the last delegation, finished turns only: the request
  // is the latest turn, and this is the conversation that leads up to it.
  private conversation: { role: "user" | "voice"; text: string }[] = [];
  private delegatedFrom?: number; // turnFrom of the turn the last delegation took
  private voiceFrom?: number; // session-clock start of the voice's current reply
  private delegation?: string;
  private waiting?: { id: string; offset: number; timer: ReturnType<typeof setTimeout> };
  // Playback bookkeeping for the waveform state.
  private playing = false;
  private lastAudible = 0;

  private captions: Captions;
  private userTurn = true; // the next output transcript starts a new caption line
  // Spoken history: the voice's words and audio since the last commit, and where
  // the user's committed words end on the session clock.
  private reply = "";
  private replyQueuedMs = 0;
  private replyPlayedMs = 0;
  private committedFrom = -Infinity;
  private commitTimer?: ReturnType<typeof setTimeout>;
  private heardAt = 0; // when the user's last words arrived (wall clock)
  // Until the user speaks again, the voice is reading out a Pi result, or talking
  // while Pi works: neither is shown or kept, except a read-out that stands in
  // for Pi's answer in the chat (`readout` is then that answer's placeholder).
  private readout: boolean | string = false;
  private working = false;
  private waitingSince = 0; // when a pending commit first found the reply still going
  // Whether the current turn's words and the voice's reply joined Pi's conversation;
  // only what did not goes with the next request as context.
  private keptUser = false;
  private keptVoice = false;
  private voiceSaid = "";    // the voice's current turn as far as it has played
  private voiceShown = 0;    // how much of it earlier (settled) replies already took
  private replyAt = 0;       // when the voice's current reply began (wall clock)
  private replyHeardMs = 0;  // voiced audio of the current reply played so far

  constructor(hooks: Hooks, audioFactory: AudioFactory) {
    this.hooks = hooks;
    this.audioFactory = audioFactory;
    this.captions = new Captions(line => this.hooks.caption?.(line), said => this.voiceSpoken(said));
  }

  /** getKey runs before the network deadline so a keychain dialog or helper build is not cut off. */
  async start(getKey: (signal: AbortSignal) => Promise<string> | string, config = liveSessionConfig()) {
    if (process.platform !== "darwin") throw new Error("This audio backend currently supports macOS only.");
    // Each voice session starts blank; the Pi session is the memory it continues from.
    const briefing = this.hooks.briefing?.();
    if (briefing) config = { ...config, instructions: `${config.instructions}\n\n${briefing}` };
    this.hooks.state("thinking");
    let key: string;
    try {
      key = String(await getKey(this.abort.signal));
      if (!key) throw new Error("No OpenAI API key available.");
    } catch (error) {
      if (!this.stopped) this.stop();
      throw error instanceof Error ? error : new Error("Voice failed to start.");
    }
    if (this.stopped) return;
    this.deadline = setTimeout(() => this.fail("Voice startup timed out."), 30000);
    try {
      await new Promise<void>((resolve, reject) => {
        this.resolveStart = resolve;
        this.rejectStart = reject;
        // Server-side connection: the project key goes in the Authorization header, never in the URL.
        const ws = this.ws = new (WebSocket as unknown as HeaderSocket)(ENDPOINT, { headers: { Authorization: `Bearer ${key}` } });
        ws.addEventListener("open", () => this.send({ type: "session.start", session: config }));
        ws.addEventListener("message", event => {
          if (this.stopped) return;
          try {
            if (typeof event.data !== "string" || event.data.length > 8_000_000) throw new Error("Invalid WebSocket frame.");
            this.handle(JSON.parse(event.data));
          } catch (error) {
            this.fail(`Invalid GPT-Live event: ${error instanceof Error ? error.message : "unknown"}. Voice stopped.`);
          }
        });
        ws.addEventListener("error", () => this.fail("OpenAI GPT-Live connection failed (check the API key and project access)."));
        ws.addEventListener("close", event => {
          if (this.stopped) return;
          if (!this.audio) this.fail(`OpenAI closed the connection before the session started (${event.code}${event.reason ? `: ${event.reason}` : ""}).`);
          else if (this.closing || event.code === 1000) this.stop();
          else this.fail(`OpenAI GPT-Live connection closed (${event.code}${event.reason ? `: ${event.reason}` : ""}).`);
        });
      });
    } catch (error) {
      if (this.stopped) return;
      this.stop();
      throw error instanceof Error ? error : new Error("Voice startup failed.");
    }
  }

  private send(value: Record<string, unknown>) {
    if (this.stopped || this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > 512_000) { this.fail("Voice network upload stalled."); return; }
    this.ws.send(JSON.stringify({ event_id: `pi_${++this.seq}`, ...value }));
  }

  private rest() {
    if (this.stopped || this.playing) return;
    this.hooks.state(this.hooks.busy() ? "thinking" : this.muted ? "idle" : "listening");
  }

  /** A Pi update GPT-Live should say aloud (it paraphrases commentary), tied to the delegation Pi is answering. */
  notify(text: string, answer?: string) { this.readout = answer ?? true; this.commentary(text, this.delegation ?? null); }

  /** Silent context GPT-Live can use when asked, without speaking it now. */
  context(text: string) { this.thinking(text, this.delegation ?? null); }

  private commentary(text: string, delegation: string | null) {
    this.send({ type: "session.commentary.append", delegation_id: delegation, content: clipTokens(text, APPEND_TOKENS) });
  }

  private thinking(text: string, delegation: string | null) {
    this.send({ type: "session.thinking.append", delegation_id: delegation, content: clipTokens(text, APPEND_TOKENS) });
  }

  private startAudio() {
    this.audio = this.audioFactory({
      input: frame => {
        if (this.stopped || this.muted) return;
        this.hooks.samples("input", waveform(frame));
        this.send({ type: "session.input_audio.append", audio: frame.toString("base64") });
      },
      output: (frame, queued) => {
        if (this.stopped) return;
        if (queued && audibleFrame(frame)) {
          this.lastAudible = Date.now();
          this.hooks.activity?.();
          if (!this.playing) { this.playing = true; this.hooks.state("speaking"); }
          this.cancelCommit();
          this.waitingSince = 0;
          this.hooks.samples("output", waveform(frame));
        } else if (this.playing && Date.now() - this.lastAudible > 250) {
          this.playing = false;
          this.hooks.samples("output", []);
          this.rest();
          this.commitSoon();
        }
      },
      // Captions advance on the device clock: the helper reports each frame as the speaker plays it.
      played: frame => {
        if (this.stopped) return;
        this.captions.played(frame, RATE);
        const voiced = voicedMs(frame, RATE);
        this.replyPlayedMs += voiced;
        this.replyHeardMs += voiced;
      },
      error: message => this.fail(message),
    });
    this.audio.start(RATE, RATE);
    if (this.muted) this.audio.mute(true);
  }

  // Server events follow OpenAI's GPT-Live protocol (guides/voice-websockets, live-delegation).
  private handle(event: any) {
    switch (event.type) {
      case "session.started":
        if (this.audio) return;
        try { this.startAudio(); }
        catch (error) { this.fail(`Local audio failed to start: ${error instanceof Error ? error.message : "unknown error"}`); return; }
        clearTimeout(this.deadline);
        this.resolveStart?.();
        this.resolveStart = this.rejectStart = undefined;
        this.rest();
        break;
      case "session.output_audio.delta": {
        const pcm = Buffer.from(event.delta, "base64");
        if (pcm.length) { this.audio?.enqueue(pcm); this.captions.queued(pcm, RATE); this.replyQueuedMs += voicedMs(pcm, RATE); }
        break;
      }
      case "session.output_transcript.delta": {
        // GPT-Live times every fragment on its session clock (start_ms/end_ms);
        // per the API docs these ranges replace packet arrival times for pacing.
        const timed = typeof event.start_ms === "number" && typeof event.end_ms === "number";
        if (this.userTurn) {
          this.userTurn = false;
          this.voiceFrom = timed ? event.start_ms : undefined;
          this.replyAt = Date.now();
          this.replyHeardMs = 0;
          this.captions.turn(timed ? event.start_ms : undefined);
        }
        this.said = (this.said + String(event.delta ?? "")).slice(-600);
        this.reply = (this.reply + String(event.delta ?? "").replace(/\[[^\]]*\]\s*/g, "")).slice(-TRANSCRIPT_CHARS);
        if (this.hooks.busy()) this.working = true;
        if (this.commitTimer) this.commitSoon();
        this.captions.text(String(event.delta ?? ""), timed ? event.start_ms : undefined, timed ? event.end_ms : undefined);
        break;
      }
      case "session.input_transcript.delta": {
        this.hooks.activity?.();
        this.hear(String(event.delta ?? ""), event.start_ms, event.end_ms);
        // A late fragment of words spoken before the voice's current reply began is
        // not new speech: it neither interrupts the reply nor starts a user turn.
        // The session clock says so when it can; otherwise the reply has barely started.
        if (!this.userTurn && typeof event.start_ms === "number" && this.voiceFrom !== undefined && event.start_ms < this.voiceFrom) break;
        const replyPending = this.playing || this.replyHeardMs === 0 || this.replyQueuedMs - this.replyPlayedMs > 50;
        if (!this.userTurn && replyPending && Date.now() - this.replyAt < LATE_WORDS.ms && this.replyHeardMs < LATE_WORDS.playedMs) { this.userWords(); break; }
        // The previous exchange is finished: write it before this turn's words.
        if (!this.userTurn) {
          this.commit(typeof event.start_ms === "number" ? event.start_ms : this.heard.at(-1)?.start);
          this.readout = this.working = false;
        }
        // GPT-Live decides when to yield; while the user talks over playback, drop the
        // locally queued audio so the model's own stop is not delayed by our buffer.
        if (this.playing) { this.audio?.interrupt(); this.captions.interrupt(); this.playing = false; this.hooks.samples("output", []); }
        if (!this.userTurn) {
          this.captions.userSpeech(); // the first fragment of the user's turn marks where they began
          // A new user turn. What Pi's conversation lacks of the finished one and the
          // voice's reply (said while Pi worked) goes with the next request as context
          // (a turn already sent as a request is not repeated); the request itself is
          // only the new turn's words.
          const from = typeof event.start_ms === "number" ? event.start_ms : (this.heard.at(-1)?.start ?? -Infinity);
          const previous = this.turnWords(this.turnFrom, from);
          if (previous && this.turnFrom !== this.delegatedFrom && !this.keptUser) this.conversation.push({ role: "user", text: previous });
          if (this.said.trim() && !this.keptVoice) this.conversation.push({ role: "voice", text: this.said.trim() });
          this.conversation = this.conversation.slice(-40);
          this.keptUser = this.keptVoice = false;
          this.said = "";
          this.turnFrom = from;
        }
        this.userTurn = true;
        this.hooks.state("listening");
        this.userWords();
        break;
      }
      case "session.delegation.created": {
        this.hooks.state("thinking");
        const id = event.delegation?.id;
        this.commitSoon(); // the request shows even if the voice does not answer aloud
        if (typeof id !== "string") break;
        if (this.waiting) this.release(); // an earlier one still waiting goes first
        const offset = typeof event.offset_ms === "number" ? event.offset_ms : Infinity;
        if ((this.heard.at(-1)?.end ?? -Infinity) >= offset) { this.delegate(id); break; }
        // The last words of the request are still in flight: wait for them, briefly.
        const timer = setTimeout(() => this.release(), DELEGATION_SETTLE_MS);
        timer.unref?.();
        this.waiting = { id, offset, timer };
        break;
      }
      case "session.closed":
        this.stop();
        break;
      case "error": {
        const error = event.error ?? {};
        const message = String(error.message ?? error.code ?? "error").slice(0, 300);
        // Configuration problems are nonfatal on the live side; surface them, keep talking.
        this.hooks.error(`OpenAI GPT-Live: ${message}`);
        break;
      }
    }
  }

  private cancelCommit() {
    clearTimeout(this.commitTimer);
    this.commitTimer = undefined;
  }

  /** Writes the finished exchange once the voice has been quiet for a moment. */
  private commitSoon() {
    this.cancelCommit();
    this.commitTimer = setTimeout(() => {
      this.commitTimer = undefined;
      // Still saying it, or the user is still talking: wait. A transcript ahead of
      // the audio means the reply goes on after a pause: wait for it too, a while.
      const unsaid = this.reply.replace(/\s+/g, "").length - this.voiceSaid.slice(this.voiceShown).replace(/\s+/g, "").length > 3;
      this.waitingSince ||= Date.now();
      if (this.playing || this.replyQueuedMs - this.replyPlayedMs > 50 || Date.now() - this.heardAt < TRANSCRIPT_QUIET_MS
        || (unsaid && Date.now() - this.waitingSince < TRANSCRIPT_WAIT_MS)) this.commitSoon();
      else this.commit();
    }, TRANSCRIPT_QUIET_MS);
    this.commitTimer.unref?.();
  }

  /**
   * Writes the user's words since the last commit (before `until` on the session
   * clock: a new turn's words wait for the next one; a request handed to Pi is
   * already in the chat as its message, and words said while Pi works stay on
   * the live line), then the voice's reply,
   * cut to what was heard if the user interrupted it.
   */
  private commit(until = Infinity) {
    this.cancelCommit();
    this.waitingSince = 0;
    const words = this.heard.filter(fragment => fragment.start >= this.committedFrom && fragment.start < until);
    const join = (list: typeof words) => list.map(fragment => fragment.text).join("").replace(/\s+/g, " ").trim();
    const user = join(words.filter(fragment => !fragment.sent && !fragment.busy));
    const spokeAtAll = !!join(words);
    if (words.length) this.committedFrom = Math.max(...words.map(fragment => fragment.start)) + 0.001;
    const interrupted = this.replyQueuedMs - this.replyPlayedMs > 150; // unplayed audio was dropped
    const voice = heardPart(this.reply, interrupted && this.replyQueuedMs > 0 ? this.replyPlayedMs / this.replyQueuedMs : 1);
    this.reply = "";
    this.replyQueuedMs = this.replyPlayedMs = 0;
    if (spokeAtAll) this.hooks.transcript?.("user", user, false);
    if (user) this.keptUser = true;
    // A read-out of Pi's result repeats the answer just above it in the chat, and
    // what is said while Pi works (progress, acknowledgements) is not kept.
    const answer = typeof this.readout === "string" ? this.readout : undefined;
    const shown = answer !== undefined || !(this.readout || this.working);
    if (voice) this.hooks.transcript?.("voice", shown ? voice : "", interrupted, answer);
    if (voice && shown) this.keptVoice = true; // in Pi's conversation, or Pi's own answer
    this.voiceShown = this.voiceSaid.length; // the next reply in this turn starts after it
  }

  /** The user's words of the current turn so far, for the chat (not while Pi works, and not once handed to Pi). */
  private userWords() {
    const from = Math.max(this.turnFrom, this.committedFrom);
    const words = this.heard.filter(fragment => fragment.start >= from && !fragment.sent && !fragment.busy);
    const text = words.map(fragment => fragment.text).join("").replace(/\s+/g, " ").trim();
    if (text) this.hooks.live?.("user", text);
  }

  /** The voice's reply as far as it has played, for the chat (not progress remarks or a read-out of Pi's result). */
  private voiceSpoken(said: string) {
    if (said.length < this.voiceSaid.length) this.voiceShown = 0; // a new turn
    this.voiceSaid = said;
    const text = said.slice(this.voiceShown).trim();
    const answer = typeof this.readout === "string" ? this.readout : undefined;
    if (!text || (answer === undefined && (this.readout || this.working || this.hooks.busy()))) return;
    this.hooks.live?.("voice", text, answer);
  }

  /** Keeps the user's recent words on the session clock (fragments without timing go at the end). */
  private hear(text: string, start?: number, end?: number) {
    if (!text.trim()) return;
    this.heardAt = Date.now();
    const last = this.heard.at(-1)?.end ?? 0;
    const from = typeof start === "number" ? start : last, to = typeof end === "number" ? end : from + 1;
    this.heard = [...this.heard.slice(-79), { start: from, end: to, text, busy: this.hooks.busy() }];
    if (this.waiting && to >= this.waiting.offset) this.release();
  }

  /** What the user said between two session-clock positions. */
  private turnWords(from: number, to: number): string {
    return this.heard.filter(fragment => fragment.start >= from && fragment.start < to).map(fragment => fragment.text).join("").replace(/\s+/g, " ").trim();
  }

  /** Hands the waiting delegation to Pi now. */
  private release() {
    const waiting = this.waiting;
    if (!waiting) return;
    this.waiting = undefined;
    clearTimeout(waiting.timer);
    this.delegate(waiting.id);
  }

  /**
   * GPT-Live delegated: Pi takes the user's words since the last delegation.
   * A bare "stop"/"cancel" while Pi works aborts it, and a status question while
   * Pi works is answered from Pi's state without interrupting it.
   */
  private delegate(id: string) {
    if (this.stopped) return;
    const fresh = this.heard.filter(fragment => fragment.end > this.consumedMs && fragment.start >= this.turnFrom);
    if (fresh.length) this.consumedMs = Math.max(...fresh.map(fragment => fragment.end));
    const words = fresh.map(fragment => fragment.text).join("").replace(/\s+/g, " ").trim();
    const request = words || this.lastRequest;
    if (!request) { this.thinking("No request was heard for this delegation; ask the user to repeat it.", id); return; }
    this.lastRequest = request;
    const busy = this.hooks.busy();
    if (busy && STOP_REQUEST.test(request)) {
      const result = this.hooks.tool("cancel_pi", {}) as { status?: string };
      this.commentary(result.status === "cancelled" ? "I stopped the task." : "Nothing was running.", id);
      return;
    }
    if (busy && STATUS_REQUEST.test(request)) {
      this.commentary(describeStatus(this.hooks.tool("pi_status", {})), id);
      return;
    }
    // The request is the latest turn; what was said since the last request (an
    // explanation over several turns, the voice's questions) is what it refers to.
    const result = this.hooks.tool("ask_pi", { request: `${VOICE_REQUEST}${request}${conversationContext(this.conversation)}`, when: "now" }) as { status?: string; error?: string };
    if (result.error) { this.commentary(`I couldn't take that request: ${result.error}`, id); return; }
    for (const fragment of fresh) fragment.sent = true; // Pi's message shows these words; the spoken history skips them
    this.hooks.transcript?.("user", "", false); // Pi's own message takes over from the live line
    this.working = true; // the acknowledgement that follows is about the work
    this.conversation = [];
    this.delegatedFrom = this.turnFrom;
    this.delegation = id;
    this.thinking(result.status === "started"
      ? "I've started on it. The result arrives as an update; do not state any result before that."
      : "I was already working; this was added to the running task. The result arrives as an update.", id);
  }

  mute(value: boolean) {
    this.muted = value;
    this.audio?.mute(value);
    this.send({ type: value ? "session.input_audio.mute" : "session.input_audio.unmute" });
    this.hooks.samples("input", []);
    this.rest();
  }

  private fail(message: string) {
    if (this.stopped) return;
    this.stop();
    this.hooks.state("error");
    this.hooks.error(message);
  }

  /** Graceful close finalizes billing (session.closed); the socket is torn down after 3 s regardless. */
  stop() {
    if (this.stopped) return;
    if (!this.closing && this.ws?.readyState === WebSocket.OPEN && this.audio) {
      this.closing = true;
      this.send({ type: "session.close" });
      this.audio.stop();
      this.audio = undefined;
      const ws = this.ws;
      setTimeout(() => ws.close(), 3000).unref();
    }
    if (!this.stopped) this.commit();
    this.stopped = true;
    if (this.waiting) { clearTimeout(this.waiting.timer); this.waiting = undefined; }
    this.abort.abort();
    clearTimeout(this.deadline);
    this.audio?.stop();
    this.rejectStart?.(new Error("Voice stopped."));
    this.resolveStart = this.rejectStart = undefined;
    if (!this.closing) this.ws?.close();
    this.hooks.closed();
  }
}
