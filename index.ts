import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { mixColors, truncateToWidth, type KeyId } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { userConfigDir } from "./config.ts";
import { AudioPipes, currentRoute, playPcm, playTone, recordBurst } from "./audio.ts";
import { aecEnabled, ensureHelper, helperBuilt } from "./native.ts";
import { apiKeyStatus, resolveApiKey } from "./keys.ts";
import { SPOKEN_ENTRY, SPOKEN_READOUT, SPOKEN_TURN, spokenPart, VOICE_PROMPT, VOICE_REQUEST, type SpokenEntry, type SpokenReadout, type SpokenTurn } from "./pi-bridge.ts";
import { answerBlocks, speakable, SpokenChat, spokenLines } from "./chat.ts";
import { describePause, pauseAfterFromSettings, TalkSession } from "./talk.ts";
import { currentSettings, envName, SETTINGS_KEY, useSettings, type VoiceSettings } from "./settings.ts";
import { PROVIDER } from "./providers.ts";
import type { VoiceState } from "./protocol.ts";
import { BarMotion, HEARD_LEVEL, liveFacts, Meter, storyAt, syntheticVoice, type BarFacts } from "./motion.ts";
import { keybindingsPath, loadShortcuts, parseTalk, shortcutLines, talkCompletions, talkHelp, type ShortcutAction, type TalkCommand } from "./commands.ts";

// The voice bar draws motion.ts's beam. What it shows follows from facts (the
// connection, who is talking, Pi's work); events add impulses; it redraws only
// while something moves. Previews play the story, cycle the states, or hold one.
const CYCLE: PreviewStep[] = ["connecting", "listening", "hearing", "working", "speaking", "muted", "error", "paused"];
type PreviewStep = "connecting" | "listening" | "hearing" | "working" | "speaking" | "muted" | "error" | "paused" | "off";
const open: BarFacts = { connection: "open", paused: false, busy: false, speaking: false, hearing: false };
const PREVIEW: Record<PreviewStep, { facts: BarFacts; muted?: boolean; voice?: "input" | "output" }> = {
  connecting: { facts: { ...open, connection: "connecting" } },
  listening: { facts: open },
  hearing: { facts: { ...open, hearing: true }, voice: "input" },
  working: { facts: { ...open, busy: true } },
  speaking: { facts: { ...open, speaking: true }, voice: "output" },
  muted: { facts: open, muted: true },
  error: { facts: open },
  paused: { facts: { ...open, connection: "closed", paused: true } },
  off: { facts: { ...open, connection: "closed" } },
};

/** The Pi session's current model, as shown in /talk check and the consent prompt. */
function modelName(ctx: ExtensionContext): string {
  const model = ctx.model as { provider?: string; id?: string; name?: string } | undefined;
  return model ? `${model.provider ? `${model.provider}/` : ""}${model.id ?? model.name ?? "model"}` : "no model selected";
}

/** Realtime voice front end for Pi, plus a visual preview. Nothing starts automatically. */
export default function voicePreview(pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let owner: ExtensionContext | undefined;
  let choice = "cycle"; // "live", or a preview: "story", "cycle", or a state
  let talk: TalkSession | undefined; // from the first /talk start until the Pi session ends
  let liveState: VoiceState = "idle";
  let inputSamples: number[] = [], outputSamples: number[] = [];
  let inputTime = 0, outputTime = 0;
  // Settings come from Pi's settings.json ("pi-voice"), overridable by env (settings.ts).
  useSettings(() => pi.getSettings());
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

  const motion = new BarMotion({ reducedMotion: () => currentSettings().values.reducedMotion });
  const input = new Meter(), output = new Meter();
  let facts: BarFacts & { muted?: boolean } = { ...PREVIEW.off.facts };
  let lastHeardAt = -Infinity;
  // After the voice speaks, its echo can linger in the mic: your voice counts again from a fresh onset.
  let echoTail = false;
  let previewFrom = 0, previewClock = 0, previewLabel = "", previewErrorAt = -Infinity;

  /** Live facts from the talk session. */
  const sessionFacts = (now: number) => liveFacts({
    connected: !!talk?.connected, ready: !!talk?.isReady, talking, idle: !owner || owner.isIdle(),
    voiceState: liveState, lastHeardAt, now, muted,
  });

  /** A preview's facts, synthetic voice, and events at `now`. */
  function previewTick(now: number, dt: number) {
    const ms = now - previewFrom;
    let step: (typeof PREVIEW)[PreviewStep];
    if (choice === "story") {
      const { step: s, events } = storyAt(ms, previewClock);
      for (const event of events) { motion.event(event, now); if (event === "interrupt") output.cut(now); }
      step = s;
      previewLabel = `story · ${s.label}: ${s.meaning}`;
    } else {
      const name = (choice === "cycle" ? CYCLE[Math.floor(ms / 3000) % CYCLE.length] : choice) as PreviewStep;
      // An error flinches as it starts, and again every three seconds while held.
      if (name === "error" && ms - previewErrorAt >= 3000) { motion.event("error", now); previewErrorAt = ms; }
      if (name !== "error") previewErrorAt = -Infinity;
      step = PREVIEW[name];
      previewLabel = choice === "cycle" ? `cycle · ${name}` : name;
    }
    previewClock = ms;
    const voice = (source: "input" | "output") => step.voice === source ? syntheticVoice(ms / 1000, source) : { level: 0, hz: 200 };
    input.set(voice("input").level, voice("input").hz, dt, now);
    output.set(voice("output").level, voice("output").hz, dt, now);
    facts = { ...step.facts, muted: step.muted };
  }

  function show(ctx: ExtensionContext, requested: string) {
      if (ctx.mode !== "tui") return;
      if (requested === "off") { stop(); return; }
      choice = requested;
      previewFrom = Date.now();
      previewClock = 0;
      previewErrorAt = -Infinity;
      // Keep the mounted component and the beam when changing preview state.
      if (timer && owner) return;
      owner = ctx;
      ctx.ui.setWidget("voice-preview", (tui, theme) => {
        let lastTick = Date.now(), drawing = true;
        // A new mount starts from rest, not from the last session's bar.
        motion.reset();
        lastHeardAt = -Infinity;
        echoTail = false;
        timer = setInterval(() => {
          const now = Date.now(), dt = Math.min(0.25, (now - lastTick) / 1000);
          lastTick = now;
          if (choice === "live") {
            input.update(inputSamples, now - inputTime <= 200, dt, now);
            output.update(outputSamples, now - outputTime <= 200, dt, now);
            // Your voice, not the voice's echo (an interruption counts: see the event hook).
            if (liveState === "speaking") echoTail = true;
            else if (input.level <= HEARD_LEVEL) echoTail = false;
            else if (!echoTail) lastHeardAt = now;
            facts = sessionFacts(now);
          } else previewTick(now, dt);
          // Redraw only while something moves: the beam, a voice (unless shapes are still), or words playing into the chat.
          const voices = !currentSettings().values.reducedMotion && (input.level > 0.02 || output.level > 0.02);
          const moving = choice !== "live" || motion.moving(now, facts) || voices || chat.animating(now);
          if (moving || drawing) tui.requestRender(); // one more frame to come to rest
          drawing = moving;
        }, 33);
        timer.unref();
        return {
          invalidate() {}, // No cached output; theme and width are read on each render.
          render(width: number): string[] {
            const frame = motion.frame(Date.now(), Math.max(0, Math.floor(width)), facts, input, output);
            let tint = theme.colors[frame.tint[0]?.[0] ?? "dim"], total = frame.tint[0]?.[1] ?? 1;
            for (const [token, weight] of frame.tint.slice(1)) { total += weight; tint = mixColors(tint, theme.colors[token], weight / total); }
            if (frame.muted > 0) tint = mixColors(tint, theme.colors.dim, 0.6 * frame.muted);
            // Foreground only: no background fill, and no labels in a live session.
            const rows = frame.rows.map(row => theme.style(row.map(mask => mask ? String.fromCharCode(0x2800 + mask) : " ").join(""), { fg: tint }));
            // The preview's label, cut to the width (Pi rejects lines wider than the terminal).
            return choice === "live" ? rows : [...rows, truncateToWidth(` ${theme.style(previewLabel, { fg: theme.colors.dim })}`, Math.max(0, Math.floor(width)))];
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
      show("echoCancellation", values.echoCancellation ? "on" : "off (headphones only)"),
      show("reducedMotion", values.reducedMotion ? "on (still shapes, no flipping text)" : "off"),
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
    inputSamples = []; outputSamples = [];
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

  // What is said aloud plays in the chat as it is said and settles into the
  // conversation (chat.ts): your words and the voice's replies, while Pi is idle.
  const chat = new SpokenChat({
    // A turn can settle as the session shuts down; a closed session just drops it.
    append: turn => { try { pi.appendEntry<SpokenTurn>(SPOKEN_TURN, turn); } catch {} },
    send: message => { try { pi.sendMessage(message, { triggerTurn: false }); } catch {} },
    save: readout => { try { pi.appendEntry<SpokenReadout>(SPOKEN_READOUT, readout); } catch {} },
    speaking: () => !!talk?.connected,
    still: () => currentSettings().values.reducedMotion,
  });
  pi.registerEntryRenderer<SpokenTurn>(SPOKEN_TURN, (entry, options, theme) => chat.component(entry.data?.id, theme, options.expanded));
  pi.on("session_start", (_event, ctx) => { chat.load(ctx.sessionManager.getEntries()); });

  // Spoken turns as 0.3.0 saved them (shown, never sent to the model).
  pi.registerEntryRenderer<SpokenEntry>(SPOKEN_ENTRY, (entry, _options, theme) => {
    const spoken = entry.data;
    if (!spoken?.text) return undefined;
    const text = spoken.text;
    return { invalidate() {}, render: (width: number) => spokenLines(text, spoken.role === "user", width, theme) };
  });

  // A spoken request Pi received shows as what was said; Pi's model still gets the
  // transcript framing. Pi's answer to it is read out, and the read-out stands in
  // for it (chat.ts): its text is hidden, and so is a voice run's text while it
  // streams (an answer that turns out to stay shows when it is finished).
  pi.registerMarkdownTransformer((markdown, context) => {
    if (context.messageType === "user" && markdown.startsWith(VOICE_REQUEST)) return spokenPart(markdown).trim();
    if (context.messageType === "assistant" && (chat.hidden(markdown) || (context.isStreaming && talk?.bridge.voiceRun))) return "";
    return markdown;
  });
  // The voice run's answer waiting for its read-out: Pi's last message so far, if speakable.
  let answerBlocksPending: string[] | undefined;

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
        muted = false; liveState = "idle"; inputSamples = []; outputSamples = [];
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
        state: state => { liveState = state; if (state === "error") motion.event("error", Date.now()); },
        event: event => {
          const now = Date.now();
          motion.event(event, now);
          // The voice yields: its audio drops at once, and the server heard you, so the bar is yours.
          if (event === "interrupt") { output.cut(now); lastHeardAt = now; echoTail = false; }
        },
        samples: (source, samples) => {
          if (source === "input") { inputSamples = samples; inputTime = Date.now(); }
          else { outputSamples = samples; outputTime = Date.now(); }
        },
        // A voice-side clear never wipes the words the user is saying.
        live: (role, text, answer) => chat.live(role, text, answer),
        transcript: (role, text, interrupted, answer) => {
          chat.settle(role, text, interrupted, answer);
          if (text) motion.event("settled", Date.now()); // a ripple as the turn lands in the chat
        },
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
  pi.on("tool_execution_start", event => {
    talk?.bridge.toolStart(event.toolName, event.args);
    if (choice === "live" && talk?.connected) motion.event("tool", Date.now()); // a beat of Pi's work on the bar
  });
  pi.on("message_end", event => {
    talk?.bridge.messageEnd(event.message);
    // Extensions hear this before Pi draws the finished message: hide a voice
    // run's speakable answer now. A later message means it was not the last one:
    // it keeps a placeholder that shows its text.
    if (event.message.role !== "assistant" || !talk?.bridge.voiceRun) return;
    if (answerBlocksPending) chat.answer(answerBlocksPending, false);
    const blocks = answerBlocks(event.message);
    answerBlocksPending = blocks && speakable(blocks.join("\n\n")) ? blocks : undefined;
    if (answerBlocksPending) chat.hide(answerBlocksPending);
  });
  pi.on("ui_prompt_start", event => { talk?.bridge.promptStart(event.title); });
  pi.on("ui_prompt_end", () => { talk?.bridge.promptEnd(); });
  pi.on("agent_settled", event => {
    const blocks = answerBlocksPending;
    answerBlocksPending = undefined;
    // The answer's place in the chat, where its read-out plays (or Pi's text shows, if aborted).
    const answer = blocks ? chat.answer(blocks, !event.aborted) : undefined;
    talk?.bridge.settled(event.aborted, event.aborted ? undefined : answer);
  });
  pi.on("session_shutdown", () => { talk?.end(); talk = undefined; talking = false; consented = false; stop(); statusOwner?.ui.setStatus("pi-voice", undefined); statusOwner = undefined; });
}
