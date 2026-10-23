import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { mixColors, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { userConfigDir } from "./config.ts";
import { AudioPipes, currentRoute, playPcm, playTone, recordBurst } from "./audio.ts";
import { aecEnabled, ensureHelper, helperBuilt } from "./native.ts";
import { apiKeyStatus, resolveApiKey } from "./keys.ts";
import { PiBridge } from "./pi-bridge.ts";
import { PROVIDERS, selectProvider, type VoiceSession } from "./providers.ts";
import { dominantFrequency } from "./protocol.ts";

const states = ["idle", "listening", "thinking", "speaking", "error"] as const;
// The caption keeps the last phrase on screen this long after the agent stops talking.
const CAPTION_HOLD_MS = 2500;
const PREVIEW_CAPTIONS = ["Twenty-two pass, none fail.", "The build is green.", "Pi is still on the migration.", "Done. Three files changed."];
type State = (typeof states)[number];

// Listening and speaking draw the same Gaussian beam as thinking. Loudness sets
// the beam height; the frame's dominant frequency (80 Hz-4 kHz, log scale) sets
// the carrier from 4 to 20 cycles across the bar. Thinking sits at 8 cycles.
const RATE = 24000;
const LOW_HZ = 80, HIGH_HZ = 4000;
const BEAM_WAIST = 0.16;
const THINKING_CYCLES = 8, THINKING_SPEED = 3.5; // rad/s of carrier phase at 8 cycles

type Beam = { level: number; logHz: number; phase: number; peak: number; frame?: number[]; target: number; targetLogHz: number };
const newBeam = (hz: number): Beam => ({ level: 0, logHz: Math.log(hz), phase: 0, peak: 0, target: 0, targetLogHz: Math.log(hz) });
const beamCycles = (beam: Beam) => 4 + 16 * Math.max(0, Math.min(1, Math.log(Math.exp(beam.logHz) / LOW_HZ) / Math.log(HIGH_HZ / LOW_HZ)));

/** Eases a beam toward its targets: fast attack, slower release, ~90 ms frequency glide. */
function advanceBeam(beam: Beam, dt: number) {
  beam.level += (beam.target - beam.level) * (1 - Math.exp(-dt / (beam.target > beam.level ? 0.04 : 0.18)));
  beam.logHz += (beam.targetLogHz - beam.logHz) * (1 - Math.exp(-dt / 0.09));
  beam.phase += dt * THINKING_SPEED * beamCycles(beam) / THINKING_CYCLES;
}

/** Sets a beam's targets from the newest live frame (analysed once per frame). */
function measureBeam(beam: Beam, samples: number[], fresh: boolean, dt: number) {
  // Adaptive gain: normalize by the recent peak so quiet microphones still
  // deflect; the floor keeps silence from amplifying noise.
  beam.peak *= Math.pow(0.985, dt * 30);
  if (!fresh || !samples.length) { beam.target = 0; return; }
  if (samples === beam.frame) return;
  beam.frame = samples;
  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value));
  beam.peak = Math.max(beam.peak, peak);
  beam.target = Math.min(1, peak / Math.max(beam.peak, 0.06));
  const hz = beam.target > 0.15 ? dominantFrequency(samples, RATE, LOW_HZ, HIGH_HZ) : undefined;
  if (hz) beam.targetLogHz = Math.log(hz);
}

/** One line, centered; long phrases keep their end (the words being spoken) behind an ellipsis. */
function centered(text: string, width: number, style: (text: string) => string): string {
  if (!text || width < 4) return "";
  let line = text;
  if (visibleWidth(line) > width) {
    const words = line.split(" ");
    while (words.length > 1 && visibleWidth("… " + words.join(" ")) > width) words.shift();
    line = truncateToWidth("… " + words.join(" "), width, "");
  }
  return " ".repeat(Math.floor((width - visibleWidth(line)) / 2)) + style(line);
}

/** Realtime voice front end for Pi, plus a visual preview. Nothing starts automatically. */
export default function voicePreview(pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let owner: ExtensionContext | undefined;
  let choice = "cycle";
  let cycleStarted = Date.now();
  let conversation: VoiceSession | undefined;
  let bridge: PiBridge | undefined;
  let liveState: State = "idle";
  let inputSamples: number[] = [], outputSamples: number[] = [];
  let inputTime = 0, outputTime = 0;
  let caption = "", captionAt = 0;
  let muted = false;

  function stop() {
    if (timer) clearInterval(timer);
    timer = undefined;
    owner?.ui.setWidget("voice-preview", undefined);
    owner = undefined;
  }

  function show(ctx: ExtensionContext, requested: string) {
      if (ctx.mode !== "tui") return;
      if (requested === "off") { stop(); return; }
      if (requested !== "live" && requested !== "cycle" && !states.includes(requested as State)) {
        ctx.ui.notify("Use /talk-preview [cycle|idle|listening|thinking|speaking|error|off]", "warning");
        return;
      }
      choice = requested;
      cycleStarted = Date.now();
      // Keep the mounted component and phase clock when changing preview state.
      if (timer && owner) return;
      owner = ctx;
      const started = Date.now();
      ctx.ui.setWidget("voice-preview", (tui, theme) => {
        let lastFrame = Date.now();
        let lastSpoke = 0;
        let weights = states.map(state => state === "idle" ? 1 : 0);
        const input = newBeam(200), output = newBeam(200);
        timer = setInterval(() => tui.requestRender(), 33);
        timer.unref();
        return {
          invalidate() {}, // No cached output; theme and width are read on each render.
          render(width: number): string[] {
            const seconds = (Date.now() - started) / 1000;
            const now = Date.now();
            const state = choice === "live" ? liveState : choice === "cycle" ? states[Math.floor((now - cycleStarted) / 4000) % states.length] : choice as State;
            // Time-based easing: ~95% settled after 0.75s. Preserves continuity
            // even when a new state arrives before the previous blend finishes.
            const dt = Math.min(0.25, Math.max(0, now - lastFrame) / 1000);
            const blend = 1 - Math.exp(-dt / 0.25);
            lastFrame = now;
            weights = weights.map((weight, i) => weight + ((states[i] === state ? 1 : 0) - weight) * blend);
            const color = { idle: "dim", listening: "accent", thinking: "warning", speaking: "success", error: "error" } as const;
            const columns = Math.max(0, Math.floor(width));
            const time = seconds;
            // Three braille rows give a 12-pixel-high trace: live frames in voice
            // mode, a synthetic voice (syllable envelope, gliding pitch) in preview.
            if (choice === "live") {
              measureBeam(input, inputSamples, now - inputTime <= 200, dt);
              measureBeam(output, outputSamples, now - outputTime <= 200, dt);
            } else {
              const syllables = 0.12 + 0.88 * Math.pow(0.5 + 0.5 * Math.sin(time * 4.3 + Math.sin(time * 1.7)), 2);
              input.target = 0.7 * syllables;
              output.target = syllables;
              input.targetLogHz = Math.log(260 * Math.pow(2, 1.2 * Math.sin(time * 1.3) + 0.6 * Math.sin(time * 3.1)));
              output.targetLogHz = Math.log(180 * Math.pow(2, 1.0 * Math.sin(time * 0.9 + 1) + 0.8 * Math.sin(time * 2.3)));
            }
            advanceBeam(input, dt);
            advanceBeam(output, dt);
            const inputCycles = beamCycles(input), outputCycles = beamCycles(output);
            let tint = theme.colors[color.idle];
            let accumulated = weights[0];
            for (let i = 1; i < states.length; i++) {
              const total = accumulated + weights[i];
              if (total > 0) tint = mixColors(tint, theme.colors[color[states[i]]], weights[i] / total);
              accumulated = total;
            }
            const dots = Array.from({ length: 3 }, () => new Array<number>(columns).fill(0));
            const leftBits = [1, 2, 4, 64];
            const rightBits = [8, 16, 32, 128];
            function plot(sample: number, y: number) {
              const row = Math.max(0, Math.min(11, Math.round(y)));
              const col = Math.floor(sample / 2);
              dots[Math.floor(row / 4)][col] |= (sample % 2 ? rightBits : leftBits)[row % 4];
            }
            let previousY: number | undefined;
            for (let sample = 0; sample < columns * 2; sample++) {
              const x = sample / Math.max(1, columns * 2 - 1);
              // Fixed Gaussian beam waist: the envelope never travels or widens;
              // only the carrier inside it changes (phase, and for audio, density).
              const centered = x - 0.5;
              const gaussian = Math.exp(-0.5 * (centered / BEAM_WAIST) ** 2);
              const carrier = (cycles: number, phase: number) => Math.cos(centered * Math.PI * 2 * cycles - phase);
              const amplitude = 0.85 * gaussian * (
                weights[1] * input.level * carrier(inputCycles, input.phase) +
                weights[2] * carrier(THINKING_CYCLES, time * THINKING_SPEED) +
                weights[3] * output.level * carrier(outputCycles, output.phase)
              );
              const y = Math.round(5.5 - amplitude * 5.4);
              // Join neighboring samples so steep peaks remain a continuous trace.
              const from = previousY === undefined ? y : previousY;
              for (let pixel = Math.min(from, y); pixel <= Math.max(from, y); pixel++) {
                plot(sample, pixel);
              }
              previousY = y;
            }
            // Foreground only: no background fill or textual state labels. Below the
            // bar, the agent's current phrase, centered; the row stays to avoid layout jumps.
            const bar = dots.map(row => theme.style(row.map(mask => mask ? String.fromCharCode(0x2800 + mask) : " ").join(""), { fg: tint }));
            if (state === "speaking") lastSpoke = now;
            const line = choice === "live"
              ? (now - Math.max(captionAt, lastSpoke) < CAPTION_HOLD_MS ? caption : "")
              : weights[3] > 0.5 ? PREVIEW_CAPTIONS[Math.floor(seconds / 2.2) % PREVIEW_CAPTIONS.length] : "";
            return [...bar, centered(line, columns, text => theme.style(text, { fg: theme.colors.muted }))];
          },
          dispose() {
            if (timer) clearInterval(timer);
            timer = undefined;
          },
        };
      }, { placement: "belowEditor" });
  }

  pi.registerCommand("talk-preview", {
    description: "Visual-only preview: cycle, idle, listening, thinking, speaking, error, off",
    handler: async (args, ctx) => {
      if (conversation) { ctx.ui.notify("Stop voice before entering preview mode.", "warning"); return; }
      show(ctx, args.trim() || "cycle");
    },
  });

  /** Builds the native audio helper on first use, telling the user why the first command is slow. */
  async function nativeHelper(ctx: ExtensionContext, signal?: AbortSignal): Promise<string> {
    if (!helperBuilt()) ctx.ui.notify("Building the native audio helper (first run only, up to ~40s)…", "info");
    return ensureHelper(signal);
  }
  const aecLine = () => aecEnabled() ? "echo cancellation: on (PI_VOICE_AEC=0 bypasses it)" : "echo cancellation: off (PI_VOICE_AEC=0; headphones only)";

  pi.registerCommand("talk", {
    description: "Realtime voice for Pi: start, stop, mute, unmute, check, devices, tone, mic-test",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;
      const command = args.trim();
      if (command === "stop") {
        conversation?.stop(); conversation = undefined;
        bridge?.detach(); bridge = undefined;
        liveState = "idle"; inputSamples = []; outputSamples = []; caption = "";
        stop(); return;
      }
      if (command === "check") {
        const lines = [aecLine(), `native helper: ${helperBuilt() ? "built" : "builds on first use"}`];
        try { const r = await pi.exec("swiftc", ["-version"], { timeout: 5000 }); lines.push(`swiftc: ${r.code === 0 ? "OK" : "failed"}`); }
        catch { lines.push("swiftc: unavailable (xcode-select --install)"); }
        if (helperBuilt()) {
          try { const route = await currentRoute(await ensureHelper()); lines.push(`input: ${route.input}`, `output: ${route.output}`); }
          catch { lines.push("devices: query failed"); }
        }
        ctx.ui.notify([...lines, `WebSocket: ${typeof WebSocket === "function" ? "OK" : "unavailable"}`, `provider: ${(() => { try { return selectProvider().name; } catch (error) { return error instanceof Error ? error.message : "invalid"; } })()} (PI_VOICE_PROVIDER or /talk start <name>; available: ${Object.keys(PROVIDERS).join(", ")})`, ...(await Promise.all(Object.values(PROVIDERS).map(async p => `${p.name} api key: ${await apiKeyStatus(p.key)}`))), `config overrides: ${userConfigDir()}`, `platform: ${process.platform}`, `session: ${conversation ? (muted ? "muted" : "active/connecting") : "off"}`].join("\n"), "info");
        return;
      }
      if (command === "devices") {
        try {
          const route = await currentRoute(await nativeHelper(ctx));
          ctx.ui.notify([
            `Input:  ${route.input}`,
            `Output: ${route.output}`,
            "These are the macOS defaults; change them in Sound settings or the menu-bar Sound control.",
            "A running session follows the switch automatically.",
            aecLine(),
          ].join("\n"), "info");
        } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Device query failed.", "error"); }
        return;
      }
      if (command.startsWith("tone")) {
        const freq = Number(command.slice(4).trim()) || 440;
        if (!Number.isFinite(freq) || freq < 20 || freq > 20000) { ctx.ui.notify("Use /talk tone [20-20000]", "warning"); return; }
        try {
          const helper = await nativeHelper(ctx);
          await playTone(helper, freq, 2);
          ctx.ui.notify(`Played ${freq} Hz for 2s through ${(await currentRoute(helper)).output}. If you heard nothing, check the output in Sound settings.`, "info");
        } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Tone playback failed.", "error"); }
        return;
      }
      if (command.startsWith("mic-test")) {
        if (conversation) { ctx.ui.notify("Stop the session first: /talk stop", "warning"); return; }
        const seconds = Math.min(10, Math.max(1, Number(command.slice(8).trim()) || 3));
        let helper: string, route: Awaited<ReturnType<typeof currentRoute>>;
        try { helper = await nativeHelper(ctx); route = await currentRoute(helper); }
        catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Audio helper unavailable.", "error"); return; }
        ctx.ui.notify(`Recording ${seconds}s from ${route.input} (${aecEnabled() ? "voice processing on" : "raw"}) — speak now. Audio stays on this Mac.`, "info");
        let recording: Awaited<ReturnType<typeof recordBurst>>;
        try { recording = await recordBurst(helper, seconds); }
        catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Capture failed.", "error"); return; }
        const db = (value: number) => value === -Infinity ? "-inf" : `${value}`;
        const { peakDbfs, rmsDbfs } = recording.stats;
        const verdict = peakDbfs === -Infinity ? "No signal: wrong input device or missing microphone permission."
          : peakDbfs < -40 ? "Very low level: wrong input device, missing permission, or muted input."
          : peakDbfs < -25 ? "Quiet but usable; speak closer or select the intended device."
          : peakDbfs <= -1 ? "Healthy level."
          : "Clipping: reduce input gain.";
        try {
          await playPcm(helper, recording.pcm, 24000);
          ctx.ui.notify(`Peak ${db(peakDbfs)} dBFS, RMS ${db(rmsDbfs)} dBFS. ${verdict}\nPlayed back through ${route.output} — you should have heard yourself.`, "info");
        } catch (error) {
          ctx.ui.notify(`Peak ${db(peakDbfs)} dBFS, RMS ${db(rmsDbfs)} dBFS. ${verdict}\nPlayback failed: ${error instanceof Error ? error.message : "unknown"}`, "error");
        }
        return;
      }
      if (command === "mute" || command === "unmute") {
        if (!conversation) { ctx.ui.notify("Voice is not running.", "warning"); return; }
        muted = command === "mute";
        conversation.mute(muted);
        ctx.ui.notify(muted ? "Microphone stopped." : "Microphone resumed.", "info");
        return;
      }
      const [verb, providerArg] = command.split(/\s+/);
      if (verb !== "start") { ctx.ui.notify(`Use /talk start [${Object.keys(PROVIDERS).join("|")}]|stop|mute|unmute|check|devices|tone|mic-test`, "info"); return; }
      if (conversation) { ctx.ui.notify("Voice is already running or connecting.", "info"); return; }
      let provider: ReturnType<typeof selectProvider>;
      try { provider = selectProvider(providerArg); }
      catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Unknown provider.", "error"); return; }
      const consent = await ctx.ui.confirm(`Start ${provider.label} voice?`, `Your microphone audio will be sent to ${provider.label} (model, voice, and instructions from providers/${provider.name}/ in this package, overridden by ${join(userConfigDir(), provider.name)}/ if present). The voice model hands real work to Pi in this session; Pi's own permission prompts still apply here in the terminal. Audio uses the macOS default input/output and follows device switches. ${aecEnabled() ? "Echo cancellation is on, so speakers work." : "Echo cancellation is off (PI_VOICE_AEC=0): use headphones, or the agent may hear itself and loop."} The API key comes from ${provider.key.env} or your login keychain (${provider.key.service}). /talk stop ends the session; Pi keeps any running task.`);
      if (!consent || conversation) return;
      muted = false; liveState = "thinking"; inputSamples = []; outputSamples = []; caption = "";
      show(ctx, "live");
      let helper: string | undefined;
      const currentBridge = new PiBridge(pi, ctx, text => current.notify(text), undefined, text => current.context?.(text));
      const current: VoiceSession = provider.create({
        state: state => { liveState = state; },
        samples: (source, samples) => {
          if (source === "input") { inputSamples = samples; inputTime = Date.now(); }
          else { outputSamples = samples; outputTime = Date.now(); }
        },
        error: message => ctx.ui.notify(message, "error"),
        caption: line => { caption = line; captionAt = Date.now(); },
        closed: () => {
          currentBridge.detach();
          if (conversation === current) { conversation = undefined; bridge = undefined; }
          liveState = "idle"; inputSamples = []; outputSamples = []; caption = "";
        },
        tool: (name, args) => currentBridge.call(name, args),
        busy: () => !ctx.isIdle(),
      }, callbacks => new AudioPipes({
        ...callbacks,
        route: route => ctx.ui.notify(`Audio switched: input ${route.input}, output ${route.output}`, "info"),
      }, helper!));
      conversation = current;
      bridge = currentBridge;
      // Do not hold the command handler open: /talk stop must work during startup.
      // The helper build runs before the network deadline, like the keychain read.
      void current.start(async signal => {
        helper = await nativeHelper(ctx, signal);
        return resolveApiKey(provider.key, signal);
      }).catch(error => {
        current.stop();
        if (conversation !== current) return; // already stopped by the user; no error banner
        liveState = "error";
        ctx.ui.notify(error instanceof Error ? error.message : "Voice failed to start.", "error");
      });
    },
  });
  // Pi's agent activity feeds the bridge (status, approvals, results) while voice runs.
  pi.on("agent_start", () => { bridge?.agentStart(); });
  pi.on("tool_execution_start", event => { bridge?.toolStart(event.toolName, event.args); });
  pi.on("message_end", event => { bridge?.messageEnd(event.message); });
  pi.on("ui_prompt_start", event => { bridge?.promptStart(event.title); });
  pi.on("ui_prompt_end", () => { bridge?.promptEnd(); });
  pi.on("agent_settled", event => { bridge?.settled(event.aborted); });
  pi.on("session_shutdown", () => { conversation?.stop(); conversation = undefined; bridge?.detach(); bridge = undefined; stop(); });
}
