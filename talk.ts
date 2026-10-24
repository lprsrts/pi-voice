import { assistantText, PiBridge, sessionBriefing, type PiControl, type PiHost } from "./pi-bridge.ts";
import type { VoiceHooks, VoiceSession } from "./providers.ts";
import type { CaptionLine, VoiceState } from "./protocol.ts";

// A talk session runs from /talk start to /talk stop. It owns the Pi bridge;
// voice connections (billed per second) come and go under it. Auto-pause closes
// the connection after a stretch of silence, and Pi's next result opens a new
// one to say it. Results that arrive while voice is closed are said as soon as
// a connection is open again (by auto-resume or the next /talk start).

export type TalkHost = {
  pi: PiHost;
  control: PiControl;
  /** The Pi session's branch and working directory, for briefings and run adoption. */
  branch(): readonly unknown[];
  cwd(): string;
  /** A voice session bound to its audio; `getKey` runs before its network deadline. */
  createVoice(hooks: VoiceHooks): VoiceSession;
  getKey(signal: AbortSignal): Promise<string>;
  notify(message: string, level: "info" | "warning" | "error"): void;
  /** UI hooks for the voice bar. */
  view?: {
    state?(state: VoiceState): void;
    samples?(source: "input" | "output", samples: number[]): void;
    caption?(line: CaptionLine): void;
  };
  /** Seconds of silence before auto-pause, while Pi works and while nothing runs (0 = never). */
  pauseAfter?(): { busy: number; idle: number };
  now?(): number;
};

const PENDING_LIMIT = 5;

export class TalkSession {
  readonly bridge: PiBridge;
  private host: TalkHost;
  private voice?: VoiceSession;
  private ready = false;   // the open connection's session has started
  private paused = false;  // closed by auto-pause while Pi works; reopens for its result
  private pending: string[] = [];
  private lastActivity = 0;
  private speaking = false;
  private timer?: ReturnType<typeof setInterval>;
  private ended = false;

  constructor(host: TalkHost) {
    this.host = host;
    const now = host.now ?? (() => Date.now());
    this.bridge = new PiBridge(host.pi, host.control, text => this.deliver(text), now, text => { if (this.ready) this.voice?.context?.(text); });
    // Voice started mid-task: keep announcing the running task, and know the last answer.
    const branch = host.branch() as any[];
    const lastOf = (pick: (message: any) => string) => {
      for (let i = branch.length - 1; i >= 0; i--) { const text = branch[i]?.type === "message" ? pick(branch[i].message) : ""; if (text) return text; }
      return undefined;
    };
    this.bridge.adopt(
      lastOf(message => message?.role === "user" ? (typeof message.content === "string" ? message.content : assistantText({ role: "assistant", content: message.content })) : ""),
      lastOf(assistantText),
    );
  }

  private now() { return (this.host.now ?? Date.now)(); }

  get connected() { return !!this.voice; }
  get isPaused() { return this.paused; }
  get waiting() { return this.pending.length; }

  /** A result or prompt notice from Pi: said now, or when voice is next open. */
  deliver(text: string) {
    if (this.ended) return;
    if (this.voice && this.ready) { this.voice.notify(text); return; }
    this.pending = [...this.pending.slice(-(PENDING_LIMIT - 1)), text];
    if (this.voice) return; // still connecting: said once it is ready
    // Auto-paused: come back to say it. Closed by the user: it waits for the next open().
    if (this.paused) { this.paused = false; this.open(); }
  }

  /** Opens a voice connection (no-op if one is open). */
  open() {
    if (this.voice || this.ended) return;
    this.paused = false;
    this.lastActivity = this.now();
    this.speaking = false;
    const bridge = this.bridge;
    const view = this.host.view ?? {};
    const voice: VoiceSession = this.host.createVoice({
      state: state => {
        // Silence is counted from when the voice stops talking, not from before it spoke.
        if (this.speaking && state !== "speaking") this.lastActivity = this.now();
        this.speaking = state === "speaking";
        view.state?.(state);
      },
      samples: (source, samples) => view.samples?.(source, samples),
      error: message => this.host.notify(message, "error"),
      caption: line => view.caption?.(line),
      closed: () => { if (this.voice === voice) { this.voice = undefined; this.ready = false; view.state?.(this.host.control.isIdle() ? "idle" : "thinking"); } },
      tool: (name, args) => bridge.call(name, args),
      busy: () => !this.host.control.isIdle(),
      briefing: () => sessionBriefing(this.host.branch(), { cwd: this.host.cwd(), status: bridge.status() }),
      activity: () => { this.lastActivity = this.now(); },
    });
    this.voice = voice;
    this.ready = false;
    void voice.start(signal => this.host.getKey(signal)).then(() => {
      if (this.voice !== voice) return;
      this.ready = true;
      // Results that arrived while voice was closed or connecting, oldest first.
      const said = this.pending;
      this.pending = [];
      for (const text of said) voice.notify(text);
    }).catch(error => {
      voice.stop();
      if (this.voice !== voice) return; // closed meanwhile; no error banner
      this.voice = undefined;
      view.state?.("error");
      this.host.notify(error instanceof Error ? error.message : "Voice failed to start.", "error");
    });
    if (!this.timer) { this.timer = setInterval(() => this.checkIdle(), 1000); this.timer.unref?.(); }
  }

  mute(value: boolean) { this.voice?.mute(value); }

  /** Closes the voice connection; the talk session (bridge, results to say) stays. */
  close() {
    const voice = this.voice;
    this.voice = undefined;
    this.ready = false;
    this.paused = false;
    voice?.stop();
    this.host.view?.state?.(this.host.control.isIdle() ? "idle" : "thinking");
  }

  /** Auto-pause: nobody has talked for a while, so stop paying for an open connection. */
  checkIdle() {
    if (!this.voice || !this.ready || this.speaking) return;
    const working = !this.host.control.isIdle();
    const after = this.host.pauseAfter?.() ?? { busy: 15, idle: 60 };
    const limit = (working ? after.busy : after.idle) * 1000;
    if (!limit || this.now() - this.lastActivity < limit) return;
    this.close();
    this.paused = working; // only Pi's result brings voice back by itself
    this.host.notify(working
      ? "Voice paused while I work; it comes back with the result. /talk start to speak sooner."
      : "Voice paused after a quiet stretch. /talk start to talk again.", "info");
  }

  /** The Pi session ended: nothing more to say. */
  end() {
    this.ended = true;
    this.close();
    clearInterval(this.timer);
    this.timer = undefined;
    this.pending = [];
    this.bridge.detach();
  }
}

/** PI_VOICE_AUTOPAUSE (while Pi works, default 15 s) and PI_VOICE_IDLE_PAUSE (nothing running, default 60 s). */
export function pauseAfterFromEnv(env: NodeJS.ProcessEnv = process.env): { busy: number; idle: number } {
  const read = (name: string, fallback: number) => {
    const raw = env[name]?.trim();
    const value = Number(raw);
    return raw && Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return { busy: read("PI_VOICE_AUTOPAUSE", 15), idle: read("PI_VOICE_IDLE_PAUSE", 60) };
}

export function describePause(after = pauseAfterFromEnv()): string {
  const part = (seconds: number, when: string) => seconds > 0 ? `${seconds} s of silence ${when}` : "";
  return [part(after.busy, "while I work"), part(after.idle, "when nothing runs")].filter(Boolean).join(" or ") || "never (auto-pause is off)";
}
