import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { mixColors } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { userConfigDir } from "./config.ts";
import { AudioPipes, currentRoute, playPcm, playTone, recordBurst } from "./audio.ts";
import { aecEnabled, ensureHelper, helperBuilt } from "./native.ts";
import { apiKeyStatus, resolveApiKey } from "./keys.ts";
import { PiBridge } from "./pi-bridge.ts";
import { PROVIDERS, selectProvider, type VoiceSession } from "./providers.ts";

const states = ["idle", "listening", "thinking", "speaking", "error"] as const;
type State = (typeof states)[number];

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
        let weights = states.map(state => state === "idle" ? 1 : 0);
        let peakInput = 0, peakOutput = 0;
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
            const blend = 1 - Math.exp(-Math.max(0, now - lastFrame) / 250);
            lastFrame = now;
            weights = weights.map((weight, i) => weight + ((states[i] === state ? 1 : 0) - weight) * blend);
            const color = { idle: "dim", listening: "accent", thinking: "warning", speaking: "success", error: "error" } as const;
            const columns = Math.max(0, Math.floor(width));
            const time = seconds;
            // Three braille rows give a 12-pixel-high oscilloscope trace: live PCM
            // samples in voice mode, synthetic animation in preview mode.
            const envelope = (0.12 + 0.88 * Math.pow(0.5 + 0.5 * Math.sin(time * 4.3 + Math.sin(time * 1.7)), 2))
              * (weights[1] * 0.7 + weights[3]);
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
            const sampleMax = (samples: number[]) => {
              let peak = 0;
              for (const value of samples) {
                const magnitude = Math.abs(value);
                if (magnitude > peak) peak = magnitude;
              }
              return peak;
            };
            // Adaptive gain for live audio: normalize by the recent peak so quiet
            // microphones still deflect; the floor keeps silence from amplifying noise.
            if (choice === "live") {
              peakInput = Math.max(peakInput * 0.985, sampleMax(inputSamples));
              peakOutput = Math.max(peakOutput * 0.985, sampleMax(outputSamples));
            }
            let previousY: number | undefined;
            for (let sample = 0; sample < columns * 2; sample++) {
              const x = sample / Math.max(1, columns * 2 - 1);
              // A phase-anchored fundamental avoids a scrolling appearance. Harmonic
              // weights and phase change over time, like successive audio snapshots.
              const phase = x * Math.PI * 2 * (5 + 0.7 * Math.sin(time * 0.8));
              const signal = (
                Math.sin(phase) +
                0.36 * Math.sin(phase * 2.1 + Math.sin(time * 2)) +
                0.18 * Math.sin(phase * 3.7 + Math.sin(time * 3.1))
              ) / 1.54;
              const localEnvelope = 0.65 + 0.35 * Math.sin(x * 9 + time * 1.2) ** 2;
              // Fixed Gaussian beam waist: its envelope never travels or widens.
              // Only the carrier phase evolves inside the stationary envelope.
              const centered = x - 0.5;
              const gaussian = Math.exp(-0.5 * (centered / 0.16) ** 2);
              const thinking = 0.85 * gaussian * Math.cos(centered * Math.PI * 16 - time * 3.5);
              const readSample = (samples: number[], timestamp: number, peak: number) => {
                if (!samples.length || now - timestamp > 200) return 0;
                const raw = samples[Math.min(samples.length - 1, Math.floor(x * samples.length))];
                return Math.max(-1, Math.min(1, raw / Math.max(peak, 0.06)));
              };
              const audio = choice === "live"
                ? readSample(inputSamples, inputTime, peakInput) * weights[1] + readSample(outputSamples, outputTime, peakOutput) * weights[3]
                : signal * envelope * localEnvelope;
              const amplitude = audio + weights[2] * thinking;
              const y = Math.round(5.5 - amplitude * 5.4);
              // Join neighboring samples so steep peaks remain a continuous trace.
              const from = previousY === undefined ? y : previousY;
              for (let pixel = Math.min(from, y); pixel <= Math.max(from, y); pixel++) {
                plot(sample, pixel);
              }
              previousY = y;
            }
            // Foreground only: no background fill or textual state labels.
            return dots.map(row => theme.style(row.map(mask => mask ? String.fromCharCode(0x2800 + mask) : " ").join(""), { fg: tint }));
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
        liveState = "idle"; inputSamples = []; outputSamples = [];
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
      muted = false; liveState = "thinking"; inputSamples = []; outputSamples = [];
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
        closed: () => {
          currentBridge.detach();
          if (conversation === current) { conversation = undefined; bridge = undefined; }
          liveState = "idle"; inputSamples = []; outputSamples = [];
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
