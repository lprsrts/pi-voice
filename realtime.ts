import type { AudioPipes } from "./audio.ts";
import { providerFiles, type ProviderFiles } from "./config.ts";
import { PI_TOOLS } from "./pi-bridge.ts";
import { Captions, type CaptionLine, waveform, type VoiceState } from "./protocol.ts";

// Eleven Realtime over its OpenAI-compatible WebSocket protocol. Instructions,
// voice, and tools come from providers/elevenlabs/ (or the user override directory)
// and are sent per session; there is no dashboard agent.

const ENDPOINT = "wss://api.elevenlabs.io/v1/convai/realtime";
const SECRETS = "https://api.elevenlabs.io/v1/convai/realtime/client_secrets";
const RATE = 24000; // PCM16 mono both ways; the native helper runs unresampled at this rate
// Tools whose result needs no spoken follow-up when the model already acknowledged
// before calling them (Max speaks a short preamble, then calls the tool in a new response).
// Eleven Realtime auto-creates a response ~1s after a function_call_output the client
// did not follow with response.create (measured); that one is cancelled for these tools.
const ACK_ONLY_TOOLS = new Set(["ask_pi", "cancel_pi"]);

type SessionFile = { model: string; voice: string; max_duration_seconds?: number; temperature?: number; turn_detection?: object };

/** The session config sent when minting the client secret (authoritative for that session). */
export function sessionConfig(files: ProviderFiles = providerFiles("elevenlabs")) {
  const file = files.session<SessionFile>();
  const instructions = files.text("instructions.md");
  return {
    type: "realtime",
    model: file.model,
    instructions,
    output_modalities: ["audio"],
    tools: PI_TOOLS,
    tool_choice: "auto",
    ...(file.temperature === undefined ? {} : { temperature: file.temperature }),
    ...(file.max_duration_seconds === undefined ? {} : { max_duration_seconds: file.max_duration_seconds }),
    audio: {
      input: { format: { type: "audio/pcm", rate: RATE }, ...(file.turn_detection ? { turn_detection: file.turn_detection } : {}) },
      output: { format: { type: "audio/pcm" }, voice: file.voice },
    },
  };
}

type Hooks = {
  state: (state: VoiceState) => void;
  samples: (source: "input" | "output", samples: number[]) => void;
  error: (message: string) => void;
  closed: () => void;
  /** Function calls from the model; must return quickly (Pi work continues in the background). */
  tool: (name: string, args: Record<string, unknown>) => object;
  /** Whether Pi is working, for the resting waveform state. */
  busy: () => boolean;
  /** The phrase the agent is saying now and how much of it is spoken, in step with playback. */
  caption?: (line: CaptionLine) => void;
};

type AudioFactory = (callbacks: ConstructorParameters<typeof AudioPipes>[0]) => AudioPipes;

export class RealtimeVoice {
  private hooks: Hooks;
  private audioFactory: AudioFactory;
  private ws?: WebSocket;
  private audio?: AudioPipes;
  private abort = new AbortController();
  private stopped = false;
  private muted = false;
  private deadline?: ReturnType<typeof setTimeout>;
  private resolveStart?: () => void;
  private rejectStart?: (error: Error) => void;
  // Turn management: responses are only requested when nobody is talking.
  private responding = false;
  private creating = false; // response.create sent, not yet acknowledged
  private userSpeaking = false;
  private wantResponse = false;
  // Playback bookkeeping for interruption truncation.
  private playingItem?: string;
  private interrupted = new Set<string>(); // late audio deltas of barged-in items are dropped
  private playedMs = 0;
  private playing = false;
  private lastAudible = 0;
  private handledCalls = new Set<string>();
  private spokeThisTurn = false; // audio since the user's last turn ended
  private cancelAutoUntil = 0;    // cancel a server-created response arriving before this time
  private dropped = new Set<string>(); // responses whose audio is discarded

  private captions: Captions;
  private captionItem?: string;

  constructor(hooks: Hooks, audioFactory: AudioFactory) {
    this.hooks = hooks;
    this.audioFactory = audioFactory;
    this.captions = new Captions(line => this.hooks.caption?.(line));
  }

  /** getKey runs before the network deadline so a keychain dialog or helper build is not cut off. */
  async start(getKey: (signal: AbortSignal) => Promise<string> | string, config = sessionConfig()) {
    if (process.platform !== "darwin") throw new Error("This audio backend currently supports macOS only.");
    this.hooks.state("thinking");
    let key: string;
    try {
      key = String(await getKey(this.abort.signal));
      if (!key) throw new Error("No ElevenLabs API key available.");
    } catch (error) {
      if (!this.stopped) this.stop();
      throw error instanceof Error ? error : new Error("Voice failed to start.");
    }
    this.deadline = setTimeout(() => this.fail("Voice startup timed out."), 30000);
    try {
      // Short-lived client secret scoped to this session config; the API key never touches the socket.
      const response = await fetch(SECRETS, {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ session: config, expires_after: { anchor: "created_at", seconds: 60 } }),
        signal: this.abort.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`ElevenLabs Realtime authorization failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}.`);
      }
      const { value } = await response.json() as { value?: string };
      if (typeof value !== "string" || !value) throw new Error("ElevenLabs returned no Realtime client secret.");
      if (this.stopped) return;
      await new Promise<void>((resolve, reject) => {
        this.resolveStart = resolve;
        this.rejectStart = reject;
        const ws = this.ws = new WebSocket(ENDPOINT, ["realtime", `openai-insecure-api-key.${value}`]);
        ws.addEventListener("message", event => {
          if (this.stopped) return;
          try {
            if (typeof event.data !== "string" || event.data.length > 8_000_000) throw new Error("Invalid WebSocket frame.");
            this.handle(JSON.parse(event.data));
          } catch (error) {
            this.fail(`Invalid Realtime event: ${error instanceof Error ? error.message : "unknown"}. Voice stopped.`);
          }
        });
        ws.addEventListener("error", () => this.fail("ElevenLabs Realtime connection failed."));
        ws.addEventListener("close", event => {
          if (this.stopped) return;
          if (!this.audio) this.fail(`ElevenLabs closed the connection before the session started (${event.code}${event.reason ? `: ${event.reason}` : ""}).`);
          else if (event.code === 1000) this.stop(); // includes max_duration_seconds
          else this.fail(`ElevenLabs Realtime connection closed (${event.code}${event.reason ? `: ${event.reason}` : ""}).`);
        });
      });
    } catch (error) {
      if (this.stopped) return;
      this.stop();
      throw error instanceof Error ? error : new Error("Voice startup failed.");
    }
  }

  private send(value: object) {
    if (this.stopped || this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > 512_000) { this.fail("Voice network upload stalled."); return; }
    this.ws.send(JSON.stringify(value));
  }

  private rest() {
    if (this.stopped || this.playing || this.userSpeaking) return;
    this.hooks.state(this.responding || this.hooks.busy() ? "thinking" : this.muted ? "idle" : "listening");
  }

  /** Requests a response at the next moment nobody is talking. */
  private pump() {
    if (!this.wantResponse || this.responding || this.creating || this.userSpeaking || this.stopped) return;
    this.wantResponse = false;
    this.creating = true;
    this.cancelAutoUntil = 0;
    this.send({ type: "response.create" });
  }

  /**
   * Tells the model about a Pi update and has it speak at the next quiet moment.
   * Eleven Realtime ignores system-role items (measured: the model stalled or invented
   * results), so updates are user-role items explicitly labelled as coming from Pi.
   */
  notify(text: string) {
    this.spokeThisTurn = false;
    this.cancelAutoUntil = 0;
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: `(Automatic update from Pi, not spoken by the user.) ${text}` }] } });
    this.wantResponse = true;
    this.pump();
  }

  private startAudio() {
    this.audio = this.audioFactory({
      input: frame => {
        if (this.stopped || this.muted) return;
        this.hooks.samples("input", waveform(frame));
        this.send({ type: "input_audio_buffer.append", audio: frame.toString("base64") });
      },
      output: (frame, audible) => {
        if (this.stopped) return;
        if (audible) {
          this.playedMs += 20;
          this.captions.played(frame, RATE);
          this.lastAudible = Date.now();
          if (!this.playing) { this.playing = true; this.hooks.state("speaking"); }
          this.hooks.samples("output", waveform(frame));
        } else if (this.playing && Date.now() - this.lastAudible > 250) {
          this.playing = false;
          this.hooks.samples("output", []);
          this.rest();
        }
      },
      error: message => this.fail(message),
    });
    this.audio.start(RATE, RATE);
    if (this.muted) this.audio.mute(true);
  }

  // Server events follow OpenAI's Realtime protocol, as ElevenLabs implements it.
  private handle(event: any) {
    switch (event.type) {
      case "session.created":
        if (this.audio) return;
        try { this.startAudio(); }
        catch (error) { this.fail(`Local audio failed to start: ${error instanceof Error ? error.message : "unknown error"}`); return; }
        clearTimeout(this.deadline);
        this.resolveStart?.();
        this.resolveStart = this.rejectStart = undefined;
        this.rest();
        break;
      case "input_audio_buffer.speech_started":
        this.userSpeaking = true;
        this.cancelAutoUntil = 0;
        if (this.playing || this.playingItem) this.interrupt();
        this.hooks.state("listening");
        break;
      case "input_audio_buffer.speech_stopped":
        this.userSpeaking = false;
        this.spokeThisTurn = false;
        this.hooks.state("thinking");
        this.pump();
        break;
      case "response.created": {
        const own = this.creating;
        this.creating = false;
        this.responding = true;
        const id = event.response?.id;
        if (!own && typeof id === "string" && Date.now() < this.cancelAutoUntil) {
          this.cancelAutoUntil = 0;
          this.dropped.add(id);
          this.send({ type: "response.cancel", response_id: id });
        }
        break;
      }
      case "response.output_audio.delta": {
        if (this.interrupted.has(event.item_id) || this.dropped.has(event.response_id)) break;
        this.spokeThisTurn = true;
        if (event.item_id !== this.playingItem) { this.playingItem = event.item_id; this.playedMs = 0; }
        const pcm = Buffer.from(event.delta, "base64");
        if (pcm.length) { this.audio?.enqueue(pcm); this.captions.queued(pcm, RATE); }
        break;
      }
      case "response.output_audio_transcript.delta":
        if (this.interrupted.has(event.item_id) || this.dropped.has(event.response_id)) break;
        if (event.item_id !== this.captionItem) { this.captionItem = event.item_id; this.captions.turn(); }
        this.captions.text(String(event.delta ?? ""));
        break;
      case "response.output_audio.done":
        this.audio?.finish();
        break;
      case "response.done":
        this.responding = false;
        for (const item of event.response?.output ?? []) {
          if (item?.type === "function_call") this.functionCall(item);
        }
        this.pump();
        this.rest();
        break;
      case "error": {
        const error = event.error ?? {};
        this.creating = false; // a failed response.create is not retried, so it cannot loop
        // A response.create that raced a server-created response: retry after that one is done.
        if (/active response/i.test(String(error.message ?? "")) || error.code === "conversation_already_has_active_response") {
          this.wantResponse = true;
          return;
        }
        // Benign races (e.g. truncating an item that already finished) must not end the call.
        if (/truncat|cancel/i.test(String(error.message ?? "") + String(error.code ?? ""))) return;
        this.hooks.error(`ElevenLabs Realtime: ${String(error.message ?? error.code ?? "error").slice(0, 300)}`);
        break;
      }
    }
  }

  /** User barge-in: drop queued audio and tell the server how much was actually heard. */
  private interrupt() {
    this.audio?.interrupt();
    this.captions.interrupt();
    if (this.playingItem) {
      this.interrupted.add(this.playingItem);
      this.send({ type: "conversation.item.truncate", item_id: this.playingItem, content_index: 0, audio_end_ms: this.playedMs });
    }
    this.playingItem = undefined;
    this.playing = false;
    this.hooks.samples("output", []);
  }

  private functionCall(item: { call_id?: string; name?: string; arguments?: string }) {
    if (typeof item.call_id !== "string" || typeof item.name !== "string") return;
    if (this.handledCalls.has(item.call_id)) return;
    this.handledCalls.add(item.call_id);
    let output: object;
    try {
      const args = item.arguments ? JSON.parse(item.arguments) : {};
      output = this.hooks.tool(item.name, args && typeof args === "object" ? args : {});
    } catch (error) {
      output = { error: error instanceof Error ? error.message : "Tool failed." };
    }
    this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: item.call_id, output: JSON.stringify(output) } });
    if (ACK_ONLY_TOOLS.has(item.name) && this.spokeThisTurn) this.cancelAutoUntil = Date.now() + 3000;
    else this.wantResponse = true;
  }

  mute(value: boolean) {
    this.muted = value;
    this.audio?.mute(value);
    if (value) { this.userSpeaking = false; this.send({ type: "input_audio_buffer.clear" }); }
    this.hooks.samples("input", []);
    this.rest();
    this.pump();
  }

  private fail(message: string) {
    if (this.stopped) return;
    this.stop();
    this.hooks.state("error");
    this.hooks.error(message);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    clearTimeout(this.deadline);
    this.audio?.stop();
    this.rejectStart?.(new Error("Voice stopped."));
    this.resolveStart = this.rejectStart = undefined;
    this.ws?.close();
    this.hooks.closed();
  }
}
