// Shared setup and fakes for the test files. Importing it makes a test file hermetic:
// no developer overrides, no real credentials, and the late-words window off.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PiBridge } from '../pi-bridge.ts';
import { LiveVoice, LATE_WORDS } from '../live.ts';
import { GptLiveWire } from '../openai-live-wire.ts';
import { TalkSession } from '../talk.ts';
// Hermetic provider config: never pick up the developer's own overrides.
process.env.PI_VOICE_CONFIG_DIR = join(tmpdir(), 'pi-voice-test-no-overrides');
// Scripted exchanges happen in no time; the late-words window gets its own test.
LATE_WORDS.ms = 0;
// A neutral short key for the keychain tests (OpenAI keys are the long kind).
export const TEST_KEY = { service: 'test-api-key', env: 'PI_VOICE_TEST_API_KEY', label: 'Test API key' };
// What a turn kept (a turn that keeps nothing still closes, with "").
export const kept = transcripts => transcripts.filter(([, text]) => text);
// Hook calls as recorded: a trailing `answer` only when there is one.
export const trim = args => args.at(-1) === undefined ? args.slice(0, -1) : args;

// No real credentials, network, microphone, speakers, or shell execution in tests.
const originalKeyEnv = process.env.PI_VOICE_TEST_API_KEY;
const originalAec = process.env.PI_VOICE_AEC;
after(() => {
  if (originalKeyEnv === undefined) delete process.env.PI_VOICE_TEST_API_KEY;
  else process.env.PI_VOICE_TEST_API_KEY = originalKeyEnv;
  if (originalAec === undefined) delete process.env.PI_VOICE_AEC;
  else process.env.PI_VOICE_AEC = originalAec;
});
export const signal = new AbortController().signal;
export const liveSource = readFileSync(new URL('../live.ts', import.meta.url), 'utf8');

export class FakeSocket extends EventTarget {
  static OPEN = 1;
  static last;
  readyState = 1; bufferedAmount = 0; sent = [];
  constructor(url, protocols) { super(); FakeSocket.last = this; this.url = url; this.protocols = protocols; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; }
  event(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
  types() { return this.sent.map(e => e.type); }
}

// ---------- OpenAI GPT-Live session (fake socket, no network or audio) ----------

export async function startLive({ tool = () => ({ ok: true }), busy = () => false, transcripts = [], lives = [], events = [] } = {}) {
  const audio = { enqueued: [], interrupts: 0, muted: [], stopped: 0 };
  const errors = [], captions = [];
  let audioHooks;
  globalThis.WebSocket = FakeSocket;
  const voice = new LiveVoice({ state() {}, samples() {}, error: e => errors.push(e), caption: l => captions.push(l.phrase), live: (...l) => lives.push(trim(l)), transcript: (...t) => transcripts.push(trim(t)), event: e => events.push(e), closed() {}, tool, busy }, hooks => {
    audioHooks = hooks;
    return { start: (i, o) => assert.deepEqual([i, o], [24000, 24000]), enqueue: b => audio.enqueued.push(b), finish() {},
      interrupt: () => audio.interrupts++, mute: v => audio.muted.push(v), stop: () => audio.stopped++ };
  });
  const started = voice.start(() => 'test-not-a-real-key');
  await new Promise(r => setImmediate(r));
  const socket = FakeSocket.last;
  socket.dispatchEvent(new Event('open'));
  socket.event({ type: 'session.started', session: { id: 'sess_1' } });
  await started;
  return { voice, socket, audio, errors, captions, input: f => audioHooks.input(f), output: (f, a) => audioHooks.output(f, a), played: f => audioHooks.played(f) };
}

// Voiced PCM16 (a square wave well above the voice threshold), `frames` x 20 ms at 24 kHz.
export const voiced = frames => { const b = Buffer.alloc(960 * frames); for (let i = 0; i < b.length; i += 2) b.writeInt16LE(i % 96 < 48 ? 4000 : -4000, i); return b; };

export async function startWire() {
  const calls = [];
  globalThis.WebSocket = FakeSocket;
  const on = name => (...args) => calls.push([name, ...args]);
  const wire = new GptLiveWire({ started: on('started'), audio: on('audio'), outputText: on('outputText'), inputText: on('inputText'), delegation: on('delegation'), closed: on('closed'), lost: on('lost'), error: on('error') });
  const started = wire.start('test-not-a-real-key', { model: 'gpt-live-1' });
  const socket = FakeSocket.last;
  socket.dispatchEvent(new Event('open'));
  socket.event({ type: 'session.started', session: { id: 'sess_1' } });
  await started;
  return { wire, socket, calls };
}

export const settle = () => new Promise(r => setTimeout(r, 400)); // trailing transcript fragments get 350 ms

export const lastOf = (socket, type) => socket.sent.filter(e => e.type === type).at(-1);

export function fakePi({ idle = true } = {}) {
  const sent = [], notices = [];
  let clock = 1_000_000;
  const control = { idle, aborted: 0, pending: false, isIdle() { return this.idle; }, abort() { this.aborted++; }, hasPendingMessages() { return this.pending; } };
  const bridge = new PiBridge({ sendUserMessage: (c, o) => sent.push([c, o]) }, control, text => notices.push(text), () => clock);
  return { bridge, sent, notices, control, tick: ms => { clock += ms; } };
}

export function fakeTalk({ idle = false, branch = [], changed } = {}) {
  let clock = 0;
  const voices = [], toasts = [], sent = [];
  const control = { idle, isIdle() { return this.idle; }, abort() {}, hasPendingMessages() { return false; } };
  const talk = new TalkSession({
    pi: { sendUserMessage: (text, options) => sent.push([text, options]) },
    control,
    branch: () => branch,
    cwd: () => '/repo',
    createVoice: hooks => {
      let resolveStart;
      const voice = { hooks, said: [], context: [], stopped: 0, started: new Promise(r => { resolveStart = r; }),
        start(getKey) { return getKey(new AbortController().signal).then(() => voice.started); },
        notify(text) { voice.said.push(text); }, context(text) { voice.context.push(text); }, mute() {}, stop() { voice.stopped++; },
        ready() { resolveStart(); return new Promise(r => setImmediate(r)); } };
      voices.push(voice);
      return voice;
    },
    getKey: async () => 'test-key',
    notify: (message, level) => toasts.push([level, message]),
    pauseAfter: () => ({ busy: 15, idle: 60 }),
    changed,
    now: () => clock,
  });
  return { talk, voices, toasts, sent, control, tick: ms => { clock += ms; talk.checkIdle(); } };
}
