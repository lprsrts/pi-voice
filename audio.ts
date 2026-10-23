import { spawn, type ChildProcess } from "node:child_process";
import { aecEnabled } from "./native.ts";
import { PcmFramer } from "./protocol.ts";

// All audio runs through the native helper (native/VoiceIO.swift) on the system
// default input/output. No shell, no inherited terminal IO, no audio files.

/** Captures the last stderr lines so device failures carry a diagnosable reason. */
function watchStderr(child: ChildProcess, onLine?: (line: string) => boolean, limit = 4): () => string {
  const lines: string[] = [];
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    for (let line of chunk.split("\n")) {
      line = line.trim();
      if (!line || onLine?.(line)) continue; // handled status lines are not error context
      if (!lines.includes(line)) {
        lines.push(line);
        if (lines.length > limit) lines.shift();
      }
    }
  });
  return () => lines.join(" | ").slice(-400);
}

function terminate(child: ChildProcess | undefined) {
  if (!child) return;
  child.stdin?.destroy();
  child.kill("SIGTERM");
  const timeout = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 1000);
  timeout.unref();
  child.once("exit", () => clearTimeout(timeout));
}

export type Route = { input: string; output: string };

export function parseRoute(text: string): Route {
  const value = JSON.parse(text);
  if (typeof value?.input !== "string" || typeof value?.output !== "string") throw new Error("Malformed device route.");
  return { input: value.input, output: value.output };
}

function aecArgs(): string[] {
  return ["--aec", aecEnabled() ? "on" : "off"];
}

// ---------- bounded one-shot helper runner (devices, tone, bursts) ----------

type RunResult = { code: number | null; stdout: Buffer; stderr: string };

function runHelper(helper: string, args: string[], options: { stdin?: Buffer; timeoutMs?: number } = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 15000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    const errors: string[] = [];
    const child = spawn(helper, args, { stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`Audio helper timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    timer.unref();
    const settle = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const line = chunk.trim();
      if (line && line !== "ready" && !errors.includes(line) && errors.length < 30) errors.push(line);
    });
    child.on("error", error => settle(() => reject(error instanceof Error ? error : new Error("Audio helper failed to start."))));
    child.on("exit", code => settle(() => resolve({ code, stdout: Buffer.concat(chunks), stderr: errors.join("\n") })));
    const stdin = child.stdin;
    stdin?.on("error", () => { /* EPIPE surfaces through exit; timeouts handled above */ });
    if (options.stdin && stdin) {
      const data = options.stdin;
      let offset = 0;
      const feed = () => {
        while (offset < data.length) {
          const chunk = data.subarray(offset, offset + 65536);
          offset += chunk.length;
          if (!stdin.write(chunk)) { stdin.once("drain", feed); return; }
        }
        stdin.end();
      };
      feed();
    } else stdin?.end();
  });
}

const detail = (stderr: string) => stderr.split("\n").slice(-3).join(" | ");

/** The system default input/output (Sound settings) the session will use. */
export async function currentRoute(helper: string): Promise<Route> {
  const { code, stdout, stderr } = await runHelper(helper, ["devices"], { timeoutMs: 5000 });
  if (code !== 0) throw new Error(`Device query failed${stderr ? `: ${detail(stderr)}` : ""}.`);
  return parseRoute(stdout.toString("utf8"));
}

// ---------- local diagnostics: tone, level stats, mic burst ----------

export type MicStats = { peakDbfs: number; rmsDbfs: number };

export function pcmStats(pcm: Buffer): MicStats {
  const count = Math.floor(pcm.length / 2);
  let peak = 0, sumSquares = 0;
  for (let i = 0; i < count; i++) {
    const sample = pcm.readInt16LE(i * 2) / 32768;
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
    sumSquares += sample * sample;
  }
  const dbfs = (value: number) => value > 0 ? Math.round(20 * Math.log10(value) * 10) / 10 : -Infinity;
  return { peakDbfs: dbfs(peak), rmsDbfs: dbfs(Math.sqrt(sumSquares / count)) };
}

/** Records a bounded clip through the same voice-processing path a session uses. Nothing leaves the machine. */
export async function recordBurst(helper: string, seconds: number, rate = 24000): Promise<{ pcm: Buffer; stats: MicStats }> {
  const { code, stdout, stderr } = await runHelper(helper, ["record", "--rate", String(rate), "--seconds", String(seconds), ...aecArgs()], { timeoutMs: seconds * 1000 + 15000 });
  if (code !== 0 || stdout.length === 0) {
    throw new Error(`Microphone capture failed${stderr ? `: ${detail(stderr)}` : ""}. Check macOS microphone permission and the input in Sound settings.`);
  }
  return { pcm: stdout, stats: pcmStats(stdout) };
}

/** Plays raw PCM16 on the default output; no microphone involved. */
export async function playPcm(helper: string, pcm: Buffer, rate: number): Promise<void> {
  const { code, stderr } = await runHelper(helper, ["play", "--rate", String(rate)], { stdin: pcm, timeoutMs: Math.ceil((pcm.length / (rate * 2)) * 1000) + 10000 });
  if (code !== 0) {
    throw new Error(`Local playback failed${stderr ? `: ${detail(stderr)}` : ` (exit ${code})`}. Check the output in Sound settings.`);
  }
}

export async function playTone(helper: string, freq = 440, seconds = 2, rate = 24000): Promise<void> {
  const samples = Math.floor(rate * seconds);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000), i * 2);
  }
  await playPcm(helper, pcm, rate);
}

// ---------- session audio (live conversation) ----------

/** One helper process: paced stdin -> speaker, mic -> stdout, flush/mute over fd 3, playout reports on fd 4. */
export class AudioPipes {
  private helper?: ChildProcess;
  private tick?: ReturnType<typeof setInterval>;
  private micTimeout?: ReturnType<typeof setTimeout>;
  private queue: Buffer[] = [];
  private framer?: PcmFramer;
  private inputRate = 0;
  private outputRate = 0;
  private stopped = false;
  private blockedSince = 0;
  private lastTickAt = 0;
  private carryMs = 0;
  private helperPath: string;
  private onInput: (frame: Buffer) => void;
  private onOutput: (frame: Buffer, audible: boolean) => void;
  private onError: (message: string) => void;
  private onRoute?: (route: Route) => void;
  private onPlayed?: (frame: Buffer) => void;
  // Real frames awaiting the device's playout report: entries carry their byte
  // offset within everything written since the last flush, and settle in order.
  private pendingPlayed: { end: number; frame: Buffer; at: number }[] = [];
  private writtenBytes = 0; // bytes sent to the helper since the last flush, padding included
  private playedGen = 0;    // flush generation; playout reports carry the helper's own

  /** helperPath: compiled VoiceIO binary (see native.ts). */
  constructor(callbacks: {
    input: (frame: Buffer) => void;
    output: (frame: Buffer, audible: boolean) => void;
    error: (message: string) => void;
    route?: (route: Route) => void;
    /** A real frame the speaker finished rendering (the device clock, not write time). */
    played?: (frame: Buffer) => void;
  }, helperPath: string) {
    this.onInput = callbacks.input;
    this.onOutput = callbacks.output;
    this.onError = callbacks.error;
    this.onRoute = callbacks.route;
    this.onPlayed = callbacks.played;
    this.helperPath = helperPath;
  }

  start(inputRate: number, outputRate: number) {
    this.inputRate = inputRate;
    this.outputRate = outputRate;
    this.framer = new PcmFramer(outputRate);
    this.startHelper();
    // Wall-clock pacing: write the 20ms frames that are owed, so TUI-side
    // event-loop jitter does not punch audible gaps into the stream.
    this.tick = setInterval(() => {
      const sink = this.helper?.stdin;
      this.sweepStale();
      if (!sink || sink.destroyed) return;
      const now = Date.now();
      const elapsed = this.lastTickAt ? Math.min(250, now - this.lastTickAt) : 20;
      this.lastTickAt = now;
      this.carryMs = Math.min(this.carryMs + elapsed, 2000);
      const frames = Math.floor(this.carryMs / 20);
      this.carryMs -= frames * 20;
      for (let i = 0; i < frames; i++) {
        if (sink.writableNeedDrain) {
          this.blockedSince ||= Date.now();
          if (Date.now() - this.blockedSince > 3000) this.onError("Playback device stopped consuming audio; voice stopped.");
          this.carryMs = 0; // do not burst after a stall
          return;
        }
        this.blockedSince = 0;
        const frame = this.queue.shift();
        const data = frame ?? Buffer.alloc(this.framer!.bytes); // keep the device fed during silence
        if (this.onPlayed) {
          this.writtenBytes += data.length; // silence padding advances the device position too
          if (frame) this.pendingPlayed.push({ end: this.writtenBytes, frame, at: Date.now() });
        }
        sink.write(data);
        this.onOutput(data, !!frame);
      }
    }, 20);
    this.tick.unref();
  }

  private startHelper() {
    const child = spawn(this.helperPath, [
      "session", "--in-rate", String(this.inputRate), "--out-rate", String(this.outputRate), ...aecArgs(),
    ], { stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] });
    this.helper = child;
    const tail = watchStderr(child, line => {
      if (line === "ready") return true;
      if (!line.startsWith("route ")) return false;
      try { this.onRoute?.(parseRoute(line.slice(6))); } catch { /* status only */ }
      return true;
    });
    const failed = () => {
      if (this.helper === child && !this.stopped) {
        this.onError(`Audio failed${tail() ? `: ${tail()}` : ""}. Check macOS microphone permission and the devices in Sound settings.`);
      }
    };
    child.on("error", failed);
    child.on("exit", failed);
    child.stdin?.on("error", failed);
    (child.stdio[3] as NodeJS.WritableStream | null)?.on("error", failed);
    (child.stdio[4] as NodeJS.ReadableStream | null)?.on("error", failed);

    const framer = new PcmFramer(this.inputRate);
    const watchdog = () => {
      clearTimeout(this.micTimeout);
      this.micTimeout = setTimeout(() => {
        if (this.helper === child && !this.stopped) this.onError("No microphone audio received. Check macOS microphone permission and the input in Sound settings.");
      }, 15000);
      this.micTimeout.unref();
    };
    watchdog();
    // Muted sessions keep streaming silence, so the watchdog stays meaningful.
    child.stdout?.on("data", (chunk: Buffer) => {
      if (this.helper !== child || this.stopped) return;
      watchdog();
      for (const frame of framer.push(chunk)) this.onInput(frame);
    });

    // Playout reports on fd 4: the device's own position in what was written, so
    // captions can advance on the speaker's clock. Reports lag writes by whatever
    // the helper still has buffered, which is exactly the lag captions must have.
    const reports = child.stdio[4] as NodeJS.ReadableStream | null;
    let reportLine = "";
    reports?.setEncoding("utf8");
    reports?.on("data", (chunk: string) => {
      if (this.helper !== child || this.stopped) return;
      reportLine += chunk;
      let index: number;
      while ((index = reportLine.indexOf("\n")) !== -1) {
        const match = /^played (\d+) (\d+)$/.exec(reportLine.slice(0, index));
        reportLine = reportLine.slice(index + 1);
        if (match) this.settle(Number(match[1]), Number(match[2]));
      }
    });
  }

  private control(line: string) {
    (this.helper?.stdio[3] as NodeJS.WritableStream | null | undefined)?.write(`${line}\n`);
  }

  /** Mutes inside the voice unit; the mic stays open (macOS indicator stays on). */
  mute(muted: boolean) {
    this.control(`mute ${muted ? 1 : 0}`);
  }

  enqueue(pcm: Buffer) {
    if (!this.framer || this.stopped) return;
    if (pcm.length > this.outputRate * 2 * 30 || pcm.length % 2) throw new Error("Invalid or oversized output audio.");
    this.queue.push(...this.framer.push(pcm));
    // Responses can arrive faster than realtime playback; 90s is a hard ceiling.
    if (this.queue.length > 4500) throw new Error("Playback backlog exceeded 90 seconds; voice stopped.");
  }

  finish() {
    const frame = this.framer?.flush();
    if (frame) this.queue.push(frame);
  }

  /** Drops queued audio here and in the helper; the mic keeps running. */
  interrupt() {
    this.queue = [];
    this.blockedSince = 0;
    this.carryMs = 0;
    this.lastTickAt = 0;
    this.framer = new PcmFramer(this.outputRate);
    // Frames flushed from the helper never play, so they never settle: renumber
    // offsets from zero and let reports of the old generation fall on deaf ears.
    this.pendingPlayed = [];
    this.writtenBytes = 0;
    this.playedGen += 1;
    this.control("flush");
  }

  /** Settles every real frame the device reported finishing, in write order. */
  private settle(gen: number, bytes: number) {
    if (gen !== this.playedGen) return; // a report from before our last flush
    while (this.pendingPlayed.length && this.pendingPlayed[0].end <= bytes) {
      const entry = this.pendingPlayed.shift()!;
      this.onPlayed?.(entry.frame);
    }
  }

  /** Drops frames the device can no longer confirm: audio lost without our flush, or a helper that never reports. */
  private sweepStale() {
    if (!this.pendingPlayed.length) return;
    const now = Date.now();
    // Real settles arrive within the helper's ~2.4 s of combined buffering; anything older is lost.
    while (this.pendingPlayed.length && now - this.pendingPlayed[0].at > 4000) this.pendingPlayed.shift();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.tick);
    clearTimeout(this.micTimeout);
    const helper = this.helper;
    this.helper = undefined;
    this.queue = [];
    this.pendingPlayed = [];
    terminate(helper);
  }
}
