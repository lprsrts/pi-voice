import type { AudioPipes } from "./audio.ts";
import { providerFiles, type ProviderFiles } from "./config.ts";
import { CONVERSATION_MARK, VOICE_REMARK, VOICE_REQUEST } from "./pi-bridge.ts";
import { GptLiveWire } from "./openai-live-wire.ts";
import { Captions, type CaptionLine, voicedMs, waveform, type VoiceState } from "./protocol.ts";

// OpenAI GPT-Live (wss://api.openai.com/v1/live/sessions) with client
// delegation: the Pi session itself is the backend. When GPT-Live delegates,
// the user's words since the last delegation (its input transcript) go to Pi
// as a message; Pi works with its own model, tools, and environment, and its
// progress (thinking, silent) and results (commentary, spoken) go back tagged
// with the delegation. Config lives in providers/openai-live/.

const RATE = 24000; // PCM16 mono both ways; the native helper runs unresampled at this rate
const SPEECH_PEAK = 600;
// A delegation's request is complete once a fragment reaches its offset_ms (measured
// live: the last word's fragment arrived with or before the delegation every time);
// otherwise late fragments get this long to arrive.
const DELEGATION_SETTLE_MS = 350;
// While Pi works, these are handled locally instead of being sent to Pi as messages.
const STOP_REQUEST = /^(please\s+)?(stop|cancel|abort|halt|never\s?mind|forget it)(\s+(it|that|this|the task|the job|everything|pi|now))*(\s+please)?[.!]*$/i;
const STATUS_REQUEST = /^(so\s+|and\s+|okay,?\s+|ok,?\s+)?(what('?s| is)\s+(pi|it|he|she)\s+doing|what('?re|\s+are)\s+you\s+(doing|working\s+on|up\s+to)|how('?s| is)\s+it\s+going|how far|(is|are)\s+(it|pi|you)\s+(done|finished)|any\s+(news|progress|update)|status|progress)\b[^.!?]{0,40}[.?!]*$/i;

// GPT-Live sometimes does not delegate words said while Pi works, even a correction it
// acknowledges ("Noted", "I'll pivot to that"; measured live: 8 of 28 mid-task corrections),
// then reads out the result as if they were done. Words still not delegated this long after
// they were said go to Pi as a remark, and Pi decides whether they change the task; its own
// delegations came 0.8–2.2 s after the words ended (16 runs). Its acknowledgements cannot
// tell a correction from small talk ("Noted", "Sure" for both), and reminding it drew no
// delegation (0 of 2). If Pi has finished meanwhile, the result is read out with a note
// that they were not done.
const UNANSWERED_MS = 3500;

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
  dropped?: (message: string) => void;
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
  /** Moments the voice bar marks: a request handed to Pi, or the user talking over the voice. */
  event?: (event: "handoff" | "interrupt") => void;
};

type AudioFactory = (callbacks: ConstructorParameters<typeof AudioPipes>[0]) => AudioPipes;

export class LiveVoice {
  private hooks: Hooks;
  private audioFactory: AudioFactory;
  private wire?: GptLiveWire;
  private audio?: AudioPipes;
  private abort = new AbortController();
  private stopped = false;
  private muted = false;
  // Pi backend: what the user said (input transcript, session clock), how far
  // delegations have consumed it, and the delegation Pi is answering.
  private heard: { start: number; end: number; text: string; sent?: boolean; busy?: boolean; unanswered?: boolean; handled?: boolean }[] = [];
  private unansweredTimer?: ReturnType<typeof setTimeout>;
  private remarked = false; // the last words went to Pi as a remark; a late delegation of them is not sent again
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
      // Cancelled by stop(): quiet. Otherwise say why (no key, helper build failed), like any other startup failure.
      if (this.stopped) return;
      this.fail(error instanceof Error ? error.message : "Voice failed to start.");
      return;
    }
    if (this.stopped) return;
    this.wire = new GptLiveWire({
      started: () => this.started(),
      audio: pcm => { this.audio?.enqueue(pcm); this.captions.queued(pcm, RATE); this.replyQueuedMs += voicedMs(pcm, RATE); },
      outputText: (delta, start, end) => this.outputText(delta, start, end),
      inputText: (delta, start, end) => this.inputText(delta, start, end),
      delegation: (id, offset) => this.delegated(id, offset),
      closed: () => this.stop(),
      lost: message => this.lost(message),
      // Configuration problems are nonfatal on the live side; surface them, keep talking.
      error: (message, fatal) => fatal ? this.fail(message) : this.hooks.error(message),
    });
    try {
      await this.wire.start(key, config);
    } catch (error) {
      if (this.stopped) return;
      this.stop();
      throw error instanceof Error ? error : new Error("Voice startup failed.");
    }
  }

  private rest() {
    if (this.stopped || this.playing) return;
    this.hooks.state(this.hooks.busy() ? "thinking" : this.muted ? "idle" : "listening");
  }

  /** A Pi update GPT-Live should say aloud (it paraphrases commentary), tied to the delegation Pi is answering. */
  notify(text: string, answer?: string) {
    this.readout = answer ?? true;
    // Words GPT-Live ignored that never reached Pi: the result must not be read out as if they were done.
    clearTimeout(this.unansweredTimer);
    this.remarked = false;
    // Marked, or said too recently to be marked (Pi finished first).
    const lost = this.heard.filter(fragment => fragment.busy && !fragment.sent && !fragment.handled);
    for (const fragment of lost) fragment.handled = true; // noted once
    const words = lost.map(fragment => fragment.text).join("").replace(/\s+/g, " ").trim();
    if (words) this.wire?.say(`While I worked the user said "${words}", and it did not reach this task: the update that follows is all that was done. If those words asked for something to be done (a correction, an addition, a further step), say in one short sentence which part was not done. If they were thanks, an opinion, or thinking aloud, do not mention them.`, this.delegation ?? null, "context");
    this.wire?.say(text, this.delegation ?? null, "result");
  }

  /** Words said while Pi worked that went nowhere: not delegated, not handled as stop or status, not yet marked. */
  private pendingWords() {
    return this.heard.filter(fragment => fragment.busy && !fragment.sent && !fragment.handled && !fragment.unanswered);
  }

  /** Words said while Pi works were not delegated: the next result must not be read out as if they were done. */
  private unanswered() {
    if (this.stopped || !this.hooks.busy()) return;
    const fragments = this.pendingWords();
    for (const fragment of fragments) fragment.unanswered = true;
    const words = fragments.map(fragment => fragment.text).join("").replace(/\s+/g, " ").trim();
    // Stop and status are GPT-Live's to delegate (handled locally); they are only noted.
    if (!words || STOP_REQUEST.test(words) || STATUS_REQUEST.test(words)) return;
    const result = this.hooks.tool("ask_pi", { request: `${VOICE_REMARK}${words}`, when: "now" }) as { status?: string };
    if (result.status !== "steered") return;
    for (const fragment of fragments) fragment.sent = true;
    this.consumedMs = Math.max(this.consumedMs, ...fragments.map(fragment => fragment.end));
    this.remarked = true;
    this.wire?.say(`The user's words "${words}" went to the running task as a remark; it applies them only if they change the task. Do not say they were done unless the result says so.`, this.delegation ?? null, "context");
  }

  /** Silent context GPT-Live can use when asked, without speaking it now. */
  context(text: string) { this.wire?.say(text, this.delegation ?? null, "context"); }

  private startAudio() {
    this.audio = this.audioFactory({
      input: frame => {
        if (this.stopped || this.muted) return;
        this.hooks.samples("input", waveform(frame));
        this.wire?.appendAudio(frame);
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

  private started() {
    if (this.audio) return;
    try { this.startAudio(); }
    catch (error) { this.fail(`Local audio failed to start: ${error instanceof Error ? error.message : "unknown error"}`); return; }
    this.rest();
  }

  private outputText(delta: string, start?: number, end?: number) {
    const timed = start !== undefined && end !== undefined;
    if (this.userTurn) {
      this.userTurn = false;
      this.voiceFrom = timed ? start : undefined;
      this.replyAt = Date.now();
      this.replyHeardMs = 0;
      this.captions.turn(timed ? start : undefined);
    }
    this.said = (this.said + delta).slice(-600);
    this.reply = (this.reply + delta.replace(/\[[^\]]*\]\s*/g, "")).slice(-TRANSCRIPT_CHARS);
    if (this.hooks.busy()) this.working = true;
    if (this.commitTimer) this.commitSoon();
    this.captions.text(delta, timed ? start : undefined, timed ? end : undefined);
  }

  private inputText(delta: string, start?: number, end?: number) {
    this.hooks.activity?.();
    this.hear(delta, start, end);
    // A late fragment of words spoken before the voice's current reply began is
    // not new speech: it neither interrupts the reply nor starts a user turn.
    // The session clock says so when it can; otherwise the reply has barely started.
    if (!this.userTurn && start !== undefined && this.voiceFrom !== undefined && start < this.voiceFrom) return;
    const replyPending = this.playing || this.replyHeardMs === 0 || this.replyQueuedMs - this.replyPlayedMs > 50;
    if (!this.userTurn && replyPending && Date.now() - this.replyAt < LATE_WORDS.ms && this.replyHeardMs < LATE_WORDS.playedMs) { this.userWords(); return; }
    // The previous exchange is finished: write it before this turn's words.
    if (!this.userTurn) {
      this.commit(start ?? this.heard.at(-1)?.start);
      this.readout = this.working = false;
    }
    // GPT-Live decides when to yield; while the user talks over playback, drop the
    // locally queued audio so the model's own stop is not delayed by our buffer.
    if (this.playing) { this.audio?.interrupt(); this.captions.interrupt(); this.playing = false; this.hooks.samples("output", []); this.hooks.event?.("interrupt"); }
    if (!this.userTurn) {
      this.captions.userSpeech(); // the first fragment of the user's turn marks where they began
      // A new user turn. What Pi's conversation lacks of the finished one and the
      // voice's reply (said while Pi worked) goes with the next request as context
      // (a turn already sent as a request is not repeated); the request itself is
      // only the new turn's words.
      const from = start ?? this.heard.at(-1)?.start ?? -Infinity;
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
  }

  private delegated(id: string | undefined, offset = Infinity) {
    this.hooks.state("thinking");
    this.commitSoon(); // the request shows even if the voice does not answer aloud
    if (id === undefined) return;
    if (this.waiting) this.release(); // an earlier one still waiting goes first
    if ((this.heard.at(-1)?.end ?? -Infinity) >= offset) { this.delegate(id); return; }
    // The last words of the request are still in flight: wait for them, briefly.
    const timer = setTimeout(() => this.release(), DELEGATION_SETTLE_MS);
    timer.unref?.();
    this.waiting = { id, offset, timer };
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
    const busy = this.hooks.busy();
    this.heard = [...this.heard.slice(-79), { start: from, end: to, text, busy }];
    if (this.waiting && to >= this.waiting.offset) this.release();
    if (busy) {
      clearTimeout(this.unansweredTimer);
      this.unansweredTimer = setTimeout(() => this.unanswered(), UNANSWERED_MS);
      this.unansweredTimer.unref?.();
    }
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
    if (!words && this.remarked && this.hooks.busy()) { this.delegation = id; this.wire?.say("Already added to the running task.", id, "context"); return; }
    this.remarked = false;
    const request = words || this.lastRequest;
    if (!request) { this.wire?.say("No request was heard for this delegation; ask the user to repeat it.", id, "context"); return; }
    this.lastRequest = request;
    const busy = this.hooks.busy();
    if (busy && (STOP_REQUEST.test(request) || STATUS_REQUEST.test(request))) for (const fragment of fresh) fragment.handled = true;
    if (busy && STOP_REQUEST.test(request)) {
      const result = this.hooks.tool("cancel_pi", {}) as { status?: string };
      this.wire?.say(result.status === "cancelled" ? "I stopped the task." : "Nothing was running.", id, "result");
      return;
    }
    if (busy && STATUS_REQUEST.test(request)) {
      this.wire?.say(describeStatus(this.hooks.tool("pi_status", {})), id, "result");
      return;
    }
    // The request is the latest turn; what was said since the last request (an
    // explanation over several turns, the voice's questions) is what it refers to.
    const result = this.hooks.tool("ask_pi", { request: `${VOICE_REQUEST}${request}${conversationContext(this.conversation)}`, when: "now" }) as { status?: string; error?: string };
    if (result.error) { this.wire?.say(`I couldn't take that request: ${result.error}`, id, "result"); return; }
    for (const fragment of fresh) fragment.sent = true; // Pi's message shows these words; the spoken history skips them
    this.hooks.transcript?.("user", "", false); // Pi's own message takes over from the live line
    this.hooks.event?.("handoff");
    this.working = true; // the acknowledgement that follows is about the work
    this.conversation = [];
    this.delegatedFrom = this.turnFrom;
    this.delegation = id;
    this.wire?.say(result.status === "started"
      ? "I've started on it. The result arrives as an update; do not state any result before that."
      : "I was already working; this was added to the running task. The result arrives as an update.", id, "context");
  }

  mute(value: boolean) {
    this.muted = value;
    this.audio?.mute(value);
    this.wire?.mute(value);
    this.hooks.samples("input", []);
    this.rest();
  }

  private fail(message: string) {
    if (this.stopped) return;
    this.stop();
    this.hooks.state("error");
    this.hooks.error(message);
  }

  /** The connection went away mid-session: the owner decides whether to come back, else it is an error. */
  private lost(message: string) {
    if (this.stopped) return;
    if (!this.hooks.dropped) return this.fail(message);
    this.hooks.dropped(message);
    this.stop();
  }

  /** Closes gracefully once the session is live, so billing is finalized. */
  stop() {
    if (this.stopped) return;
    clearTimeout(this.unansweredTimer);
    this.wire?.close(!!this.audio);
    this.commit();
    this.stopped = true;
    if (this.waiting) { clearTimeout(this.waiting.timer); this.waiting = undefined; }
    this.abort.abort();
    this.audio?.stop();
    this.audio = undefined;
    this.hooks.closed();
  }
}
