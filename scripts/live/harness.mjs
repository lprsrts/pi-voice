// Live test harness: real GPT-Live, a real Pi agent session as the backend, and
// scripted speech. It wires the Pi session exactly as index.ts does (PiBridge,
// run adoption, the session briefing, the voice prompt section) so scenarios
// exercise the shipped code paths. Costs real money (GPT-Live minutes, TTS, and
// your Pi model's tokens); the OpenAI key comes from pi-voice's keys.ts and is
// never printed.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RATE = 24000;
const FRAME = 960; // 20 ms of PCM16 at 24 kHz

const { resolveApiKey, OPENAI_KEY } = await import(`${REPO}/keys.ts`);
const { LiveVoice, audibleFrame } = await import(`${REPO}/live.ts`);
const { PiBridge, VOICE_PROMPT, sessionBriefing, assistantText } = await import(`${REPO}/pi-bridge.ts`);
const { AudioPipes } = await import(`${REPO}/audio.ts`);
const { ensureHelper } = await import(`${REPO}/native.ts`);

/** The installed Pi package (PI_SDK_DIR, else found from the `pi` on PATH). */
export function findPiSdk() {
  if (process.env.PI_SDK_DIR) return process.env.PI_SDK_DIR;
  const isPi = dir => {
    try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name === "@earendil-works/pi-coding-agent"; } catch { return false; }
  };
  let bin;
  try { bin = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()); }
  catch { throw new Error("pi is not on PATH; set PI_SDK_DIR to the @earendil-works/pi-coding-agent package directory."); }
  for (let dir = dirname(bin); dir !== dirname(dir); dir = dirname(dir)) {
    if (isPi(dir)) return dir;
    for (const candidate of ["libexec/lib/node_modules", "lib/node_modules", "node_modules"]) {
      const path = join(dir, candidate, "@earendil-works/pi-coding-agent");
      if (isPi(path)) return path;
    }
  }
  throw new Error(`Could not find Pi's package from ${bin}; set PI_SDK_DIR.`);
}

/** A disposable copy of a project, so Pi can change files freely. */
export function scratchCopy(source) {
  const dir = mkdtempSync(join(tmpdir(), "pi-voice-live-"));
  cpSync(source, dir, { recursive: true, filter: path => !/\/node_modules(\/|$)/.test(path) });
  return dir;
}

const ttsDir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi-voice", "live-tts");

/** Speech for a line, PCM16 24 kHz mono, cached on disk by text. */
async function speech(key, text) {
  mkdirSync(ttsDir, { recursive: true });
  const path = join(ttsDir, `${createHash("sha256").update(`alloy:${text}`).digest("hex").slice(0, 16)}.pcm`);
  if (existsSync(path)) return readFileSync(path);
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "alloy", input: text, response_format: "pcm" }),
  });
  if (!response.ok) throw new Error(`Text-to-speech failed (HTTP ${response.status}).`);
  const pcm = Buffer.from(await response.arrayBuffer());
  writeFileSync(path, pcm);
  return pcm;
}

function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Runs one scenario: one Pi session, one or more consecutive voice sessions,
 * each with scripted turns ({ at: seconds after the voice starts, say }).
 * audio: "inject" (default: real helper with voice processing and speaker
 * playback, scripted mic samples), "acoustic" (turns played aloud and heard by
 * the real mic; voice processing off), or "silent" (no audio devices).
 */
export async function runScenario(scenario, { audio = "inject", cwd, model, log = () => {} } = {}) {
  const sdkDir = findPiSdk();
  const sdk = await import(join(sdkDir, "dist/index.js"));
  const key = await resolveApiKey(OPENAI_KEY, AbortSignal.timeout(60000));
  if (audio === "acoustic") process.env.PI_VOICE_AEC = "0"; // voice processing cancels speaker-played speech
  const helper = audio === "silent" ? undefined : await ensureHelper();

  const loader = new sdk.DefaultResourceLoader({
    cwd, agentDir: sdk.getAgentDir(),
    extensionFactories: [pi => pi.on("before_agent_start", event => { event.systemPromptOptions.sections.voice = VOICE_PROMPT; })],
  });
  await loader.reload?.();
  const { session } = await sdk.createAgentSession({ cwd, agentDir: sdk.getAgentDir(), sessionManager: sdk.SessionManager.inMemory(), resourceLoader: loader });
  if (model) {
    const [provider, ...id] = model.split("/");
    const chosen = session.modelRuntime.getModel(provider, id.join("/"));
    if (!chosen) throw new Error(`Unknown model ${model}.`);
    await session.setModel(chosen);
  }

  const t0 = Date.now();
  const r = {
    model: session.model ? `${session.model.provider}/${session.model.id}` : "none",
    events: [], piRequests: [], piTools: [], bridgeCalls: [], voiceLines: [], heard: [], errors: [], briefings: [],
    aborted: false, results: [], turns: [], voiceSeconds: 0,
  };
  const mark = (kind, data = "") => { const t = (Date.now() - t0) / 1000; r.events.push({ t, kind, data }); log(t, kind, data); return t; };

  let bridge;
  session.subscribe(event => {
    if (event.type === "agent_start") bridge?.agentStart();
    if (event.type === "tool_execution_start") { r.piTools.push(`${event.toolName} ${JSON.stringify(event.args)}`); mark("pi.tool", `${event.toolName} ${JSON.stringify(event.args).slice(0, 80)}`); bridge?.toolStart(event.toolName, event.args); }
    if (event.type === "message_end") { bridge?.messageEnd(event.message); const text = assistantText(event.message); if (text) mark("pi.text", text.slice(0, 160)); }
    if (event.type === "agent_settled") { if (event.aborted) r.aborted = true; mark("pi.settled", event.aborted ? "aborted" : ""); bridge?.settled(!!event.aborted); }
  });

  for (const [index, voiceSession] of scenario.sessions.entries()) {
    mark("voice.session", `${index + 1}/${scenario.sessions.length}`);
    for (const turn of voiceSession.turns) turn.pcm = await speech(key, turn.say);
    let voice;
    const b = bridge = new PiBridge(
      { sendUserMessage: (text, options) => {
          r.piRequests.push(text);
          mark(`pi.${options?.deliverAs ?? "prompt"}`, text);
          if (options?.deliverAs === "steer") session.steer(text);
          else if (options?.deliverAs === "followUp") session.followUp(text);
          else session.prompt(text).catch(error => mark("pi.error", error.message));
        } },
      { isIdle: () => session.isIdle, abort: () => { mark("pi.abort"); session.abort(); }, hasPendingMessages: () => session.pendingMessageCount > 0 },
      text => { r.results.push(text); mark("result", text.slice(0, 160)); voice.notify(text); },
      undefined,
      text => voice.context?.(text),
    );
    // As index.ts does on /talk start.
    const branch = session.sessionManager.getBranch();
    const lastOf = pick => { for (let i = branch.length - 1; i >= 0; i--) { const e = branch[i]; const t = e.type === "message" ? pick(e.message) : ""; if (t) return t; } };
    b.adopt(lastOf(m => m?.role === "user" ? (typeof m.content === "string" ? m.content : assistantText({ role: "assistant", content: m.content })) : ""), lastOf(assistantText));
    const briefing = sessionBriefing(session.sessionManager.getBranch(), { cwd, status: b.status() });
    r.briefings.push(briefing);

    // Watch GPT-Live's own events next to pi-voice's handling.
    const OrigWS = globalThis.WebSocket;
    globalThis.WebSocket = class extends OrigWS {
      constructor(...args) {
        super(...args);
        let line = "";
        this.addEventListener("message", message => {
          const e = JSON.parse(message.data);
          if (e.type === "session.output_transcript.delta") {
            line += e.delta;
            if (/[.!?]["”’)]*\s*$/.test(line)) { r.voiceLines.push(line.trim()); mark("voice.says", line.trim()); line = ""; }
          }
          if (e.type === "session.input_transcript.delta") { r.heard.push(e.delta); }
          if (e.type === "session.delegation.created") mark("delegation", `offset_ms ${e.offset_ms}`);
          if (e.type === "error") { r.errors.push(JSON.stringify(e.error)); mark("gpt-live.error", JSON.stringify(e.error)); }
        });
      }
    };

    // Audio: playback is observed where the speaker reports it (device clock).
    let mic, speechEnd = 0, resultAt = 0;
    const heardFrame = frame => {
      if (!audibleFrame(frame)) return;
      if (speechEnd) { mark("voice.heard", `${((Date.now() - speechEnd) / 1000).toFixed(2)} s after speech end`); if (r.turns.length) r.turns.at(-1).replyHeard = (Date.now() - speechEnd) / 1000; speechEnd = 0; }
      if (resultAt) { mark("result.heard", `${((Date.now() - resultAt) / 1000).toFixed(2)} s after the result`); if (r.turns.length) r.turns.at(-1).resultHeard = (Date.now() - resultAt) / 1000; resultAt = 0; }
    };
    const factory = callbacks => {
      if (audio === "silent") {
        mic = callbacks.input;
        return { start() {}, enqueue(pcm) { for (let i = 0; i + FRAME <= pcm.length; i += FRAME) heardFrame(pcm.subarray(i, i + FRAME)); }, finish() {}, interrupt() {}, mute() {}, stop() {} };
      }
      if (audio === "inject") mic = callbacks.input;
      return new AudioPipes({
        ...callbacks,
        input: audio === "inject" ? () => {} : callbacks.input,
        route: route => mark("audio.route", JSON.stringify(route)),
        played: frame => { heardFrame(frame); callbacks.played?.(frame); },
      }, helper);
    };
    voice = new LiveVoice({
      state() {}, samples() {}, caption() {}, closed() {},
      error: e => { r.errors.push(e); mark("error", e); },
      tool: (name, args) => { r.bridgeCalls.push(name); mark(`bridge.${name}`); return b.call(name, args); },
      busy: () => !session.isIdle,
      briefing: () => briefing,
    }, factory);
    // Each new result starts a "result heard" measurement.
    let resultsSeen = r.results.length;
    const watchResults = setInterval(() => { if (r.results.length > resultsSeen) { resultsSeen = r.results.length; resultAt = Date.now(); } }, 20);
    const started = Date.now();
    await voice.start(() => key);
    mark("voice.started");

    // Scripted turns.
    const timers = [];
    let frameIndex = 0, feeding;
    if (audio === "acoustic") {
      const dir = mkdtempSync(join(tmpdir(), "pi-voice-wav-"));
      for (const [i, turn] of voiceSession.turns.entries()) {
        const file = join(dir, `${i}.wav`);
        writeFileSync(file, wav(turn.pcm));
        timers.push(setTimeout(() => {
          mark("user.says", turn.say);
          r.turns.push({ say: turn.say });
          execFile("afplay", [file], () => { speechEnd = Date.now(); r.turns.at(-1).end = mark("user.end"); });
        }, turn.at * 1000));
      }
    } else {
      const schedule = voiceSession.turns.map(turn => ({ start: Math.round(turn.at * 50), turn }));
      feeding = setInterval(() => {
        let out = Buffer.alloc(FRAME);
        for (const s of schedule) {
          const offset = (frameIndex - s.start) * FRAME;
          if (offset === 0) { mark("user.says", s.turn.say); r.turns.push({ say: s.turn.say }); }
          if (offset >= 0 && offset + FRAME <= s.turn.pcm.length) out = s.turn.pcm.subarray(offset, offset + FRAME);
          if (offset + FRAME <= s.turn.pcm.length && offset + 2 * FRAME > s.turn.pcm.length) { speechEnd = Date.now(); r.turns.at(-1).end = mark("user.end"); }
        }
        frameIndex++;
        mic?.(out);
      }, 20);
    }

    await new Promise(done => setTimeout(done, voiceSession.seconds * 1000));
    for (const timer of timers) clearTimeout(timer);
    clearInterval(feeding);
    clearInterval(watchResults);
    voice.stop();
    b.detach();
    globalThis.WebSocket = OrigWS;
    r.voiceSeconds += (Date.now() - started) / 1000;
    mark("voice.stopped", session.isIdle ? "Pi idle" : "Pi still working");
    await new Promise(done => setTimeout(done, voiceSession.pauseAfter ? voiceSession.pauseAfter * 1000 : 1500));
  }
  if (!session.isIdle) { await session.abort(); mark("pi.abort", "end of scenario"); }
  session.dispose();
  return r;
}
