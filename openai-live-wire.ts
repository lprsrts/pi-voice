import { clipTokens } from "./protocol.ts";

// The OpenAI GPT-Live wire protocol (guides/voice-websockets, live-delegation):
// the socket, the client events, and the server events as plain callbacks on
// the session clock. It knows nothing of Pi, captions, or audio devices.

const ENDPOINT = "wss://api.openai.com/v1/live/sessions";
// A live session streams frames about every 100 ms, silence included (p99 under 0.3 s, max
// under 1 s in recorded runs, one 5.5 s server stall); this long without one, the link is
// dead even if no close came.
// Muted, GPT-Live sends nothing at all, so the watchdog rests until unmuted.
const SILENT_LINK_MS = 10000;
// Every update (commentary/thinking append) is acknowledged with "*.appended", in 0.5–2.1 s
// (28 recorded). A session that acknowledges none for this long is stuck, even if it still
// sends the odd frame: measured once, audio stopped and no update was ever taken in.
const UNACKED_MS = 8000;
const APPEND_TOKENS = 400; // commentary/thinking accept at most 500 tokens; the estimate is pessimistic, and this leaves margin

/** Node's WebSocket (undici) accepts headers; the browser typings do not know that. */
type HeaderSocket = new (url: string, init: { headers: Record<string, string> }) => WebSocket;

/** Server events. Times are session-clock milliseconds, when GPT-Live gives them. */
export type WireEvents = {
  started: () => void;
  audio: (pcm: Buffer) => void;
  outputText: (delta: string, startMs?: number, endMs?: number) => void;
  inputText: (delta: string, startMs?: number, endMs?: number) => void;
  /** The model hands the user's request to the client, as of `offsetMs` of the input. */
  delegation: (id: string | undefined, offsetMs?: number) => void;
  closed: () => void;
  /** The started session was lost (network drop, server hangup, duration limit), not ended by either side on purpose. */
  lost: (message: string) => void;
  /** Fatal errors end the session; others are configuration problems it survives. */
  error: (message: string, fatal: boolean) => void;
};

const ms = (value: unknown) => typeof value === "number" ? value : undefined;

export class GptLiveWire {
  private events: WireEvents;
  private ws?: WebSocket;
  private seq = 0;
  private live = false;
  private closing = false;
  private deadline?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setInterval>;
  private lastFrame = 0;
  private muted = false;
  private unacked: { kind: string; at: number }[] = [];
  private resolveStart?: () => void;
  private rejectStart?: (error: Error) => void;

  constructor(events: WireEvents) { this.events = events; }

  /** Connects and starts the session; settles once it has started, or rejects when closed first. */
  start(key: string, session: object) {
    this.deadline = setTimeout(() => this.events.error("Voice startup timed out.", true), 30000);
    return new Promise<void>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
      // Server-side connection: the project key goes in the Authorization header, never in the URL.
      const ws = this.ws = new (WebSocket as unknown as HeaderSocket)(ENDPOINT, { headers: { Authorization: `Bearer ${key}` } });
      ws.addEventListener("open", () => this.send({ type: "session.start", session }));
      ws.addEventListener("message", event => {
        if (this.closing) return;
        this.lastFrame = Date.now();
        try {
          if (typeof event.data !== "string" || event.data.length > 8_000_000) throw new Error("Invalid WebSocket frame.");
          this.handle(JSON.parse(event.data));
        } catch (error) {
          this.events.error(`Invalid GPT-Live event: ${error instanceof Error ? error.message : "unknown"}. Voice stopped.`, true);
        }
      });
      ws.addEventListener("error", () => {
        if (this.closing) return;
        if (this.live) this.events.lost("OpenAI GPT-Live connection lost.");
        else this.events.error("OpenAI GPT-Live connection failed (check the API key and project access).", true);
      });
      ws.addEventListener("close", event => {
        if (this.closing) return;
        const why = `${event.code}${event.reason ? `: ${event.reason}` : ""}`;
        if (!this.live) this.events.error(`OpenAI closed the connection before the session started (${why}).`, true);
        else if (event.code === 1000) this.events.closed();
        else if (event.code === 1008) this.events.error(`OpenAI GPT-Live connection closed (${why}).`, true); // policy: not a network problem
        else this.events.lost(`OpenAI GPT-Live connection lost (${why}).`);
      });
    });
  }

  private handle(event: any) {
    switch (event.type) {
      case "session.started":
        if (this.live) return;
        this.live = true;
        clearTimeout(this.deadline);
        this.watchdog = setInterval(() => {
          if (this.closing || this.muted) return;
          if (Date.now() - this.lastFrame > SILENT_LINK_MS) this.events.lost(`OpenAI GPT-Live connection lost (no data for ${SILENT_LINK_MS / 1000} s).`);
          else if (this.unacked.length && Date.now() - this.unacked[0].at > UNACKED_MS) this.events.lost(`OpenAI GPT-Live stopped taking updates (none acknowledged for ${UNACKED_MS / 1000} s).`);
        }, 1000);
        this.watchdog.unref?.();
        this.events.started();
        this.resolveStart?.();
        this.resolveStart = this.rejectStart = undefined;
        break;
      case "session.thinking.appended":
      case "session.commentary.appended": {
        const kind = event.type.split(".")[1];
        const i = this.unacked.findIndex(update => update.kind === kind);
        if (i >= 0) this.unacked.splice(i, 1);
        break;
      }
      case "session.output_audio.delta": {
        const pcm = Buffer.from(event.delta, "base64");
        if (pcm.length) this.events.audio(pcm);
        break;
      }
      // GPT-Live times every fragment on its session clock (start_ms/end_ms);
      // per the API docs these ranges replace packet arrival times for pacing.
      case "session.output_transcript.delta":
        this.events.outputText(String(event.delta ?? ""), ms(event.start_ms), ms(event.end_ms));
        break;
      case "session.input_transcript.delta":
        this.events.inputText(String(event.delta ?? ""), ms(event.start_ms), ms(event.end_ms));
        break;
      case "session.delegation.created": {
        const id = event.delegation?.id;
        this.events.delegation(typeof id === "string" ? id : undefined, ms(event.offset_ms));
        break;
      }
      // Closed by the server, not on request (requested closes are not listened to).
      case "session.closed": {
        const reason = String(event.reason ?? event.session?.reason ?? "");
        if (/^(expired|connection_lost|remote_hangup)$/.test(reason)) this.events.lost(`OpenAI GPT-Live session ended (${reason}).`);
        else this.events.closed();
        break;
      }
      case "error": {
        const error = event.error ?? {};
        const message = String(error.message ?? error.code ?? "error").slice(0, 300);
        this.events.error(`OpenAI GPT-Live: ${message}`, false);
        break;
      }
    }
  }

  appendAudio(pcm: Buffer) { this.send({ type: "session.input_audio.append", audio: pcm.toString("base64") }); }

  /** Tells the model about a delegation: a result it says aloud (it paraphrases), or context it keeps until asked. */
  say(text: string, delegationId: string | null, kind: "result" | "context") {
    if (this.live && !this.closing) this.unacked.push({ kind: kind === "result" ? "commentary" : "thinking", at: Date.now() });
    this.send({ type: kind === "result" ? "session.commentary.append" : "session.thinking.append", delegation_id: delegationId, content: clipTokens(text, APPEND_TOKENS) });
  }

  mute(on: boolean) {
    this.muted = on;
    this.lastFrame = Date.now();
    this.send({ type: on ? "session.input_audio.mute" : "session.input_audio.unmute" });
  }

  /** Graceful close of a live session finalizes billing (session.closed); the socket is torn down after 3 s regardless. */
  close(graceful = true) {
    if (this.closing) return;
    this.closing = true;
    clearTimeout(this.deadline);
    clearInterval(this.watchdog);
    const ws = this.ws;
    if (graceful && this.live && ws?.readyState === WebSocket.OPEN) {
      this.write({ type: "session.close" });
      setTimeout(() => ws.close(), 3000).unref();
    } else ws?.close();
    this.rejectStart?.(new Error("Voice stopped."));
    this.resolveStart = this.rejectStart = undefined;
  }

  private send(value: Record<string, unknown>) { if (!this.closing) this.write(value); }

  private write(value: Record<string, unknown>) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > 512_000) {
      if (this.live) this.events.lost("OpenAI GPT-Live connection lost (upload stalled).");
      else this.events.error("Voice network upload stalled.", true);
      return;
    }
    this.ws.send(JSON.stringify({ event_id: `pi_${++this.seq}`, ...value }));
  }
}
