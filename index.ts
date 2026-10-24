import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { mixColors, Text, visibleWidth, type KeyId } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { userConfigDir } from "./config.ts";
import { AudioPipes, currentRoute, playPcm, playTone, recordBurst } from "./audio.ts";
import { aecEnabled, ensureHelper, helperBuilt } from "./native.ts";
import { apiKeyStatus, resolveApiKey } from "./keys.ts";
import { SPOKEN_ENTRY, spokenPart, VOICE_PROMPT, VOICE_REQUEST, type SpokenEntry } from "./pi-bridge.ts";
import { describePause, pauseAfterFromSettings, TalkSession } from "./talk.ts";
import { currentSettings, envName, SETTINGS_KEY, useSettings, type VoiceSettings } from "./settings.ts";
import { PROVIDER } from "./providers.ts";
import { dominantFrequency, FlapBoard, formatCaption, type CaptionLine } from "./protocol.ts";
import { keybindingsPath, loadShortcuts, parseTalk, shortcutLines, talkCompletions, talkHelp, type ShortcutAction, type TalkCommand } from "./commands.ts";

const states = ["idle", "listening", "thinking", "speaking", "error"] as const;
// The caption keeps the last phrase on screen this long after the agent stops talking.
const CAPTION_HOLD_MS = 2500;
const PREVIEW_CAPTIONS: CaptionLine[] = [
  { phrase: "Twenty-two pass,", spoken: 0, continues: false, open: true },
  { phrase: "none fail.", spoken: 0, continues: true, open: false },
  { phrase: "Pi is still on the migration;", spoken: 0, continues: false, open: true },
  { phrase: "two files to go.", spoken: 0, continues: true, open: false },
];
const PREVIEW_HEARD: CaptionLine = { phrase: "what's left on the migration", spoken: 28, continues: false, open: true, role: "user" };
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

/** One centered line; a phrase wider than the bar shows the word chunk being spoken. */
/** The Pi session's current model, as shown in /talk check and the consent prompt. */
function modelName(ctx: ExtensionContext): string {
  const model = ctx.model as { provider?: string; id?: string; name?: string } | undefined;
  return model ? `${model.provider ? `${model.provider}/` : ""}${model.id ?? model.name ?? "model"}` : "no model selected";
}

function centered(caption: CaptionLine | undefined, width: number, paint: (text: string) => string): string {
  const line = caption && width >= 4 ? formatCaption(caption, width, visibleWidth) : "";
  return " ".repeat(Math.max(0, Math.floor((width - visibleWidth(line)) / 2))) + paint(line);
}

/** Realtime voice front end for Pi, plus a visual preview. Nothing starts automatically. */
export default function voicePreview(pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let owner: ExtensionContext | undefined;
  let choice = "cycle";
  let cycleStarted = Date.now();
  let talk: TalkSession | undefined; // from the first /talk start until the Pi session ends
  let liveState: State = "idle";
  let inputSamples: number[] = [], outputSamples: number[] = [];
  let inputTime = 0, outputTime = 0;
  let caption: CaptionLine | undefined, captionAt = 0;
  // Settings come from Pi's settings.json ("pi-voice"), overridable by env (settings.ts).
  useSettings(() => pi.getSettings());
  // Caption row under the bar: the "captions" setting, unless /talk captions changed it this session.
  let captionsChoice: boolean | undefined;
  const captionsOn = () => captionsChoice ?? currentSettings().values.captions;
  let muted = false;
  let talking = false;   // between /talk start and /talk stop: Pi is told its answers are spoken
  let consented = false; // the consent prompt is shown once per Pi session
  let statusOwner: ExtensionContext | undefined; // where the footer status is shown

  function stop() {
    if (timer) clearInterval(timer);
    timer = undefined;
    owner?.ui.setWidget("voice-preview", undefined);
    owner = undefined;
  }

  function show(ctx: ExtensionContext, requested: string) {
      if (ctx.mode !== "tui") return;
      if (requested === "off") { stop(); return; }
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
        const board = new FlapBoard();
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
            // bar, the live line: what the user is saying or the voice's current phrase,
            // centered, flipping in like a split-flap board; the row stays to avoid layout jumps.
            const bar = dots.map(row => theme.style(row.map(mask => mask ? String.fromCharCode(0x2800 + mask) : " ").join(""), { fg: tint }));
            if (state === "speaking") lastSpoke = now;
            const line = choice === "live"
              ? (now - Math.max(captionAt, lastSpoke) < CAPTION_HOLD_MS ? caption : undefined)
              : weights[3] > 0.5 ? PREVIEW_CAPTIONS[Math.floor(seconds / 1.6) % PREVIEW_CAPTIONS.length]
              : weights[1] > 0.5 ? PREVIEW_HEARD : undefined;
            if (!captionsOn()) return bar;
            const fg = line?.role === "user"
              ? { flip: theme.colors.dim, glow: theme.colors.accent, still: theme.colors.text }
              : { flip: theme.colors.dim, glow: theme.colors.success, still: theme.colors.muted };
            return [...bar, centered(line, columns, text => board.tiles(text, now).map(tile => theme.style(tile.text, { fg: fg[tile.state] })).join(""))];
          },
          dispose() {
            if (timer) clearInterval(timer);
            timer = undefined;
          },
        };
      }, { placement: "aboveEditor" });
  }

  /** Builds the native audio helper on first use, telling the user why the first command is slow. */
  async function nativeHelper(ctx: ExtensionContext, signal?: AbortSignal): Promise<string> {
    if (!helperBuilt()) ctx.ui.notify("Building the native audio helper (first run only, up to ~40s)…", "info");
    return ensureHelper(signal);
  }
  const aecLine = () => aecEnabled() ? "echo cancellation: on" : "echo cancellation: off (headphones only)";

  /** Each setting with its value and source, for /talk check. */
  function settingsLines(): string[] {
    const { values, sources, invalid } = currentSettings();
    const show = (key: keyof VoiceSettings, value: string) => `  ${key}: ${value} (${sources[key] === "env" ? `env ${envName(key)}` : sources[key] === "settings" ? `settings "${SETTINGS_KEY}"` : "default"})`;
    return [
      `settings ("${SETTINGS_KEY}" in Pi's settings.json; env variables override):`,
      show("autoPause", values.autoPause ? `${values.autoPause} s of silence while I work` : "never"),
      show("idlePause", values.idlePause ? `${values.idlePause} s of silence when nothing runs` : "never"),
      show("captions", `${values.captions ? "on" : "off"}${captionsChoice !== undefined ? ` (now ${captionsChoice ? "on" : "off"} via /talk captions)` : ""}`),
      show("echoCancellation", values.echoCancellation ? "on" : "off (headphones only)"),
      ...invalid.map(entry => `  ignored invalid value: ${entry}`),
    ];
  }

  /** Footer indicator while voice is in use: on, muted, or paused, and results still to say. */
  function refreshStatus() {
    const state = talk?.connected ? (muted ? "voice muted" : "voice on") : talking ? "voice paused" : talk?.waiting ? "voice off" : undefined;
    statusOwner?.ui.setStatus("pi-voice", state && (talk?.waiting ? `${state} · ${talk.waiting} to say` : state));
  }

  function stopVoice(ctx: ExtensionContext) {
    if (!talk?.connected && !talking) { ctx.ui.notify("Voice is not running.", "info"); return; }
    // Pi keeps working; a result that arrives before the next /talk start is said then.
    talk?.close(); talking = false;
    inputSamples = []; outputSamples = []; caption = undefined;
    stop(); refreshStatus();
    ctx.ui.notify(ctx.isIdle() ? "Voice stopped." : "Voice stopped. I keep working; /talk start to hear the result.", "info");
  }

  async function startVoice(ctx: ExtensionContext) {
    if (talk?.connected) { ctx.ui.notify("Voice is already running or connecting.", "info"); return; }
    if (!consented) {
      const provider = PROVIDER;
      const consent = await ctx.ui.confirm(`Start ${provider.label} voice?`, `Your microphone audio will be sent to ${provider.label} (model, voice, and instructions from providers/${provider.name}/ in this package, overridden by ${join(userConfigDir(), provider.name)}/ if present). This Pi session is the backend: what you ask goes to Pi as a message, and Pi works with its current model (${modelName(ctx)}), tools, and permission prompts here in the terminal. Audio uses the macOS default input/output and follows device switches. ${aecEnabled() ? "Echo cancellation is on, so speakers work." : "Echo cancellation is off (the echoCancellation setting): use headphones, or the agent may hear itself and loop."} Voice is billed while connected; it pauses by itself after ${describePause()}, and comes back to say results. The API key comes from ${provider.key.env} or your login keychain (${provider.key.service}). /talk stop ends the session; Pi keeps any running task.`);
      if (!consent || talk?.connected) return;
      consented = true;
    }
    talking = true;
    talkSession(ctx).open();
  }

  async function check(ctx: ExtensionContext) {
    const lines = [aecLine(), `native helper: ${helperBuilt() ? "built" : "builds on first use"}`];
    try { const r = await pi.exec("swiftc", ["-version"], { timeout: 5000 }); lines.push(`swiftc: ${r.code === 0 ? "OK" : "failed"}`); }
    catch { lines.push("swiftc: unavailable (xcode-select --install)"); }
    if (helperBuilt()) {
      try { const route = await currentRoute(await ensureHelper()); lines.push(`input: ${route.input}`, `output: ${route.output}`); }
      catch { lines.push("devices: query failed"); }
    }
    const session = talk?.connected ? (muted ? "on, microphone muted" : "on") : talk?.isPaused ? "paused (comes back with the result)" : talking ? "paused" : "off";
    ctx.ui.notify([
      ...lines,
      `WebSocket: ${typeof WebSocket === "function" ? "OK" : "unavailable"}`,
      `voice: ${PROVIDER.label}`,
      `backend: this Pi session (${modelName(ctx)}; change it with /model)`,
      `${PROVIDER.name} api key: ${await apiKeyStatus(PROVIDER.key)}`,
      ...settingsLines(),
      `shortcuts (${keybindingsPath()}):`,
      ...shortcutLines(shortcuts),
      `config overrides: ${userConfigDir()}`,
      `platform: ${process.platform}`,
      `session: ${session}${talk?.waiting ? `; ${talk.waiting} result(s) to say` : ""}`,
    ].join("\n"), "info");
  }

  async function devices(ctx: ExtensionContext) {
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
  }

  async function tone(ctx: ExtensionContext, hz: number) {
    try {
      const helper = await nativeHelper(ctx);
      await playTone(helper, hz, 2);
      ctx.ui.notify(`Played ${hz} Hz for 2s through ${(await currentRoute(helper)).output}. If you heard nothing, check the output in Sound settings.`, "info");
    } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Tone playback failed.", "error"); }
  }

  async function micTest(ctx: ExtensionContext, seconds: number) {
    if (talk?.connected) { ctx.ui.notify("Stop voice first: /talk stop", "warning"); return; }
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
  }

  /** Runs a parsed /talk command; the keyboard shortcuts run "toggle" and "mute". */
  async function run(command: TalkCommand, ctx: ExtensionContext) {
    switch (command.name) {
      case "error": ctx.ui.notify(command.message, "warning"); return;
      case "help": ctx.ui.notify(talkHelp(shortcuts), "info"); return;
      case "toggle": return talk?.connected ? stopVoice(ctx) : startVoice(ctx);
      case "start": return startVoice(ctx);
      case "stop": return stopVoice(ctx);
      case "mute": case "unmute": {
        if (!talk?.connected) { ctx.ui.notify("Voice is not running.", "warning"); return; }
        const value = command.name === "mute" ? command.value ?? !muted : false;
        if (value === muted) { ctx.ui.notify(muted ? "Microphone is already muted." : "Microphone is already on.", "info"); return; }
        muted = value;
        talk.mute(muted);
        refreshStatus();
        ctx.ui.notify(muted ? "Microphone muted." : "Microphone on.", "info");
        return;
      }
      case "captions":
        captionsChoice = command.value ?? !captionsOn();
        ctx.ui.notify(`Captions ${captionsOn() ? "on" : "off"} for this session (the "captions" setting sets the default).`, "info");
        return;
      case "check": return check(ctx);
      case "devices": return devices(ctx);
      case "tone": return tone(ctx, command.hz);
      case "mic-test": return micTest(ctx, command.seconds);
      case "preview":
        if (talk?.connected) { ctx.ui.notify("Stop voice before previewing the bar: /talk stop", "warning"); return; }
        show(ctx, command.state);
        return;
    }
  }

  // The spoken history: what was said aloud stays in the chat (and the session file)
  // without reaching Pi's model, which gets each request as its own message.
  pi.registerEntryRenderer<SpokenEntry>(SPOKEN_ENTRY, (entry, _options, theme) => {
    const spoken = entry.data;
    if (!spoken?.text) return undefined;
    if (spoken.role === "user") {
      return new Text(`${theme.fg("accent", "›")} ${theme.fg("userMessageText", spoken.text)}`, 1, 1, text => theme.bg("userMessageBg", text));
    }
    return new Text(`${theme.fg("success", "•")} ${theme.italic(theme.fg("muted", spoken.text))}${spoken.interrupted ? theme.fg("dim", " (interrupted)") : ""}`, 1, 0);
  });

  // A spoken request Pi received shows as what was said; Pi's model still gets the
  // transcript framing and the conversation it refers to (shown as spoken entries).
  pi.registerMarkdownTransformer((markdown, context) =>
    context.messageType === "user" && markdown.startsWith(VOICE_REQUEST) ? `› ${spokenPart(markdown).trim()}` : markdown);

  pi.registerCommand("talk", {
    description: "Realtime voice for Pi: no argument starts or stops it; /talk help lists the rest",
    getArgumentCompletions: talkCompletions,
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;
      await run(parseTalk(args), ctx);
    },
  });

  // Shortcuts are pi-voice actions in Pi's keybindings.json, read at load (/reload rereads them).
  const shortcuts = loadShortcuts();
  const actions: Record<ShortcutAction, TalkCommand> = { toggle: { name: "toggle" }, mute: { name: "mute" } };
  for (const action of Object.keys(actions) as ShortcutAction[]) {
    for (const key of shortcuts[action]) {
      pi.registerShortcut(key as KeyId, {
        description: action === "toggle" ? "Voice: start or stop" : "Voice: mute or unmute the microphone",
        handler: async ctx => { if (ctx.mode === "tui") await run(actions[action], ctx); },
      });
    }
  }

  /** The talk session for this Pi session: one bridge, voice connections under it. */
  function talkSession(ctx: ExtensionContext): TalkSession {
    if (talk) return talk;
    statusOwner = ctx;
    let helper: string | undefined;
    talk = new TalkSession({
      pi,
      control: ctx,
      branch: () => ctx.sessionManager.getBranch(),
      cwd: () => ctx.sessionManager.getCwd(),
      createVoice: hooks => {
        muted = false; liveState = "thinking"; inputSamples = []; outputSamples = []; caption = undefined;
        show(ctx, "live");
        return PROVIDER.create(hooks, callbacks => new AudioPipes({
          ...callbacks,
          route: route => ctx.ui.notify(`Audio switched: input ${route.input}, output ${route.output}`, "info"),
        }, helper!));
      },
      // The helper build runs before the network deadline, like the keychain read.
      getKey: async signal => { helper = await nativeHelper(ctx, signal); return resolveApiKey(PROVIDER.key, signal); },
      notify: (message, level) => ctx.ui.notify(message, level),
      view: {
        state: state => { liveState = state; },
        samples: (source, samples) => {
          if (source === "input") { inputSamples = samples; inputTime = Date.now(); }
          else { outputSamples = samples; outputTime = Date.now(); }
        },
        // A voice-side clear never wipes the words the user is saying.
        caption: line => { if (!line.phrase && caption?.role === "user") return; caption = line; captionAt = Date.now(); },
        transcript: (role, text, interrupted) => pi.appendEntry<SpokenEntry>(SPOKEN_ENTRY, interrupted ? { role, text, interrupted } : { role, text }),
      },
      pauseAfter: () => pauseAfterFromSettings(),
      changed: refreshStatus,
    });
    return talk;
  }

  // Pi's agent activity feeds the bridge (status, approvals, results) while voice runs.
  pi.on("before_agent_start", event => {
    if (talking) event.systemPromptOptions.sections.voice = VOICE_PROMPT;
  });
  pi.on("agent_start", () => { talk?.bridge.agentStart(); });
  pi.on("tool_execution_start", event => { talk?.bridge.toolStart(event.toolName, event.args); });
  pi.on("message_end", event => { talk?.bridge.messageEnd(event.message); });
  pi.on("ui_prompt_start", event => { talk?.bridge.promptStart(event.title); });
  pi.on("ui_prompt_end", () => { talk?.bridge.promptEnd(); });
  pi.on("agent_settled", event => { talk?.bridge.settled(event.aborted); });
  pi.on("session_shutdown", () => { talk?.end(); talk = undefined; talking = false; consented = false; stop(); statusOwner?.ui.setStatus("pi-voice", undefined); statusOwner = undefined; });
}
