import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Hermetic provider config: never pick up the developer's own overrides.
process.env.PI_VOICE_CONFIG_DIR = join(tmpdir(), 'pi-voice-test-no-overrides');
import { PcmFramer, waveform, dominantFrequency, clipTokens, phraseAt, formatCaption, voicedMs, Captions, FlapBoard, FLAP_SETTLE_MS, FLAP_GLOW_MS, wrapWords } from '../protocol.ts';
import { PiBridge, describeTool, forSpeech, VOICE_REQUEST, VOICE_REMARK, isSpoken, spokenPart, CONVERSATION_MARK, sessionBriefing, SPOKEN_ENTRY, SPOKEN_MESSAGE, SPOKEN_TURN, SPOKEN_READOUT, spokenContent } from '../pi-bridge.ts';
import { resolveApiKey, apiKeyStatus, provisionCommand, OPENAI_KEY } from '../keys.ts';
// A neutral short key for the keychain tests (OpenAI keys are the long kind).
const TEST_KEY = { service: 'test-api-key', env: 'PI_VOICE_TEST_API_KEY', label: 'Test API key' };
import { LiveVoice, liveSessionConfig, audibleFrame, describeStatus, conversationContext, heardPart, LATE_WORDS } from '../live.ts';
import { GptLiveWire } from '../openai-live-wire.ts';
// Scripted exchanges happen in no time; the late-words window gets its own test.
LATE_WORDS.ms = 0;
import { PROVIDER } from '../providers.ts';
import { TalkSession, describePause } from '../talk.ts';
import { resolveSettings, DEFAULT_SETTINGS } from '../settings.ts';
import { providerFiles, userConfigDir } from '../config.ts';
import { AudioPipes, parseRoute, pcmStats } from '../audio.ts';
import { aecEnabled, helperPath } from '../native.ts';
import { SpokenChat, answerBlocks, answerHash, speakable } from '../chat.ts';
import { BarMotion, Meter, barState, transitionMs, DRIFT, STATES, EVENTS, BREATH_MS, ERROR_MS, PAUSE_PULSE_MS, STORY, STORY_MS, storyAt, liveFacts, HEARD_HOLD_MS } from '../motion.ts';
// What a turn kept (a turn that keeps nothing still closes, with "").
const kept = transcripts => transcripts.filter(([, text]) => text);
// Hook calls as recorded: a trailing `answer` only when there is one.
const trim = args => args.at(-1) === undefined ? args.slice(0, -1) : args;
import { parseTalk, talkCompletions, talkHelp, TALK_COMMANDS, resolveShortcuts, loadShortcuts, keybindingsPath, DEFAULT_SHORTCUTS } from '../commands.ts';

// No real credentials, network, microphone, speakers, or shell execution in tests.
const originalKeyEnv = process.env.PI_VOICE_TEST_API_KEY;
const originalAec = process.env.PI_VOICE_AEC;
after(() => {
  if (originalKeyEnv === undefined) delete process.env.PI_VOICE_TEST_API_KEY;
  else process.env.PI_VOICE_TEST_API_KEY = originalKeyEnv;
  if (originalAec === undefined) delete process.env.PI_VOICE_AEC;
  else process.env.PI_VOICE_AEC = originalAec;
});
const signal = new AbortController().signal;
const liveSource = readFileSync(new URL('../live.ts', import.meta.url), 'utf8');

test('PCM chunks preserve split sample bytes and pad final frame', () => {
  const f = new PcmFramer(16000);
  const b = Buffer.alloc(1000, 7);
  assert.equal(f.push(b.subarray(0, 3)).length, 0);
  const frames = f.push(b.subarray(3));
  assert.equal(frames.length, 1);
  const tail = f.flush();
  assert.deepEqual(Buffer.concat([frames[0], tail]).subarray(0, 1000), b);
  assert.equal(tail[639], 0);
  assert.equal(f.flush(), undefined);
});
test('dominant frequency finds the strongest tone in a 20 ms frame', () => {
  const tone = (hz, n = 480, rate = 24000) => Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * hz * i / rate));
  for (const hz of [150, 440, 1200, 3000]) {
    const found = dominantFrequency(tone(hz), 24000);
    assert.ok(Math.abs(Math.log2(found / hz)) < 0.15, `${hz} Hz -> ${found}`);
  }
  const mixed = tone(220).map((v, i) => 0.3 * v + tone(900)[i]);
  assert.ok(Math.abs(dominantFrequency(mixed, 24000) - 900) < 90);
  assert.equal(dominantFrequency(new Array(480).fill(0), 24000), undefined);
  assert.equal(dominantFrequency([0.1, 0.2], 24000), undefined);
});

test('waveform samples are signed and bounded', () => {
  const b = Buffer.alloc(4); b.writeInt16LE(-32768, 0); b.writeInt16LE(32767, 2);
  assert.deepEqual(waveform(b), [-1, 32767 / 32768]);
});
// Keychain convention: env override first, then the
// login-keychain item <provider>-api-key, service-only lookup.
test('key resolution prefers the env override without touching the keychain', async () => {
  process.env.PI_VOICE_TEST_API_KEY = 'sk_env_override';
  const key = await resolveApiKey(TEST_KEY, signal, { platform: 'darwin', call: async () => { throw new Error('keychain must not be queried'); } });
  assert.equal(key, 'sk_env_override');
});
test('key resolution reads the convention item, trims the secret, and forwards the abort signal', async () => {
  delete process.env.PI_VOICE_TEST_API_KEY;
  const key = await resolveApiKey(TEST_KEY, signal, { platform: 'darwin', call: async (args, opts) => {
    assert.deepEqual(args, ['find-generic-password', '-s', 'test-api-key', '-w']);
    assert.equal(opts.signal, signal);
    assert.ok(opts.timeout > 0);
    return { stdout: 'sk_test\n', stderr: '' };
  }});
  assert.equal(key, 'sk_test');
});
test('missing keychain item maps to the provisioning command', async () => {
  delete process.env.PI_VOICE_TEST_API_KEY;
  const failure = Object.assign(new Error('not found'), { code: 44, stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' });
  await assert.rejects(
    () => resolveApiKey(TEST_KEY, signal, { platform: 'darwin', call: async () => { throw failure; } }),
    /add-generic-password -U -s "test-api-key" -a "\$USER"/
  );
});
test('denied or headless keychain reads fail with a clear reason', async () => {
  delete process.env.PI_VOICE_TEST_API_KEY;
  await assert.rejects(
    () => resolveApiKey(TEST_KEY, signal, { platform: 'darwin', call: async () => { throw Object.assign(new Error('x'), { stderr: 'security: SecKeychainSearchCopyNext: User interaction is not allowed.' }); } }),
    /denied|GUI terminal/
  );
});
test('corrupted or empty keychain secrets are rejected', async () => {
  delete process.env.PI_VOICE_TEST_API_KEY;
  for (const stdout of ['\n', 'sk bad\n']) {
    await assert.rejects(
      () => resolveApiKey(TEST_KEY, signal, { platform: 'darwin', call: async () => ({ stdout, stderr: '' }) }),
      /empty or malformed/
    );
  }
});
test('non-darwin platforms fail closed without the env override', async () => {
  delete process.env.PI_VOICE_TEST_API_KEY;
  await assert.rejects(() => resolveApiKey(TEST_KEY, signal, { platform: 'linux', call: async () => ({ stdout: '', stderr: '' }) }), /PI_VOICE_TEST_API_KEY/);
  assert.match(await apiKeyStatus(TEST_KEY, { platform: 'linux' }), /missing/);
});
test('status reports the source without ever reading the secret', async () => {
  process.env.PI_VOICE_TEST_API_KEY = 'sk_env_override';
  assert.match(await apiKeyStatus(TEST_KEY), /env override/);
  delete process.env.PI_VOICE_TEST_API_KEY;
  assert.match(await apiKeyStatus(TEST_KEY, { platform: 'darwin', call: async args => {
    assert.ok(!args.includes('-w')); // presence check only
    return { stdout: '', stderr: '' };
  }}), /present/);
  assert.match(await apiKeyStatus(TEST_KEY, { platform: 'darwin', call: async () => { throw Object.assign(new Error('nf'), { code: 44 }); } }), /add-generic-password/);
});

test('long keys provision through the clipboard and a 128-character key is reported as truncated', async () => {
  assert.match(provisionCommand(OPENAI_KEY), /-w "\$\(pbpaste\)" && pbcopy <\/dev\/null/);
  assert.doesNotMatch(provisionCommand(TEST_KEY), /pbpaste/);
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(
    () => resolveApiKey(OPENAI_KEY, signal, { platform: 'darwin', call: async args => { assert.deepEqual(args.slice(0, 3), ['find-generic-password', '-s', 'openai-api-key']); return { stdout: 'sk-proj-' + 'x'.repeat(120) + '\n', stderr: '' }; } }),
    /truncated/
  );
  assert.equal(await resolveApiKey(OPENAI_KEY, signal, { platform: 'darwin', call: async () => ({ stdout: 'sk-proj-' + 'x'.repeat(156), stderr: '' }) }), 'sk-proj-' + 'x'.repeat(156));
});

test('the one provider is GPT-Live with the OpenAI key', () => {
  assert.equal(PROVIDER.name, 'openai-live');
  assert.equal(PROVIDER.key.service, 'openai-api-key');
});

test('device route parses from the helper and rejects malformed output', () => {
  assert.deepEqual(parseRoute('{"input":"MacBook Pro Microphone","output":"Sam’s AirPods"}\n'),
    { input: 'MacBook Pro Microphone', output: 'Sam’s AirPods' });
  for (const bad of ['{}', '{"input":1,"output":"x"}', 'not json']) assert.throws(() => parseRoute(bad));
});
test('pcm level stats compute dBFS for signal, silence, and empty input', () => {
  const loud = Buffer.alloc(4);
  loud.writeInt16LE(16384, 0); loud.writeInt16LE(-16384, 2);
  assert.deepEqual(pcmStats(loud), { peakDbfs: -6, rmsDbfs: -6 });
  assert.deepEqual(pcmStats(Buffer.alloc(2000)), { peakDbfs: -Infinity, rmsDbfs: -Infinity });
  assert.deepEqual(pcmStats(Buffer.alloc(1)), { peakDbfs: -Infinity, rmsDbfs: -Infinity });
});
class FakeSocket extends EventTarget {
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

async function startLive({ tool = () => ({ ok: true }), busy = () => false, transcripts = [], lives = [], events = [] } = {}) {
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
const voiced = frames => { const b = Buffer.alloc(960 * frames); for (let i = 0; i < b.length; i += 2) b.writeInt16LE(i % 96 < 48 ? 4000 : -4000, i); return b; };

test('GPT-Live captions follow the session clock and restart after the user speaks', async () => {
  const originalWS = globalThis.WebSocket;
  try {
    const { voice, socket, captions, output, played } = await startLive();
    // Fragments arrive with their start_ms/end_ms range on the session timeline.
    socket.event({ type: 'session.output_transcript.delta', delta: 'All tests pass, ', start_ms: 0, end_ms: 200 });
    socket.event({ type: 'session.output_audio.delta', delta: voiced(10).toString('base64') });
    socket.event({ type: 'session.output_audio.delta', delta: Buffer.alloc(960 * 10).toString('base64') }); // a breath
    socket.event({ type: 'session.output_transcript.delta', delta: 'nothing else changed.', start_ms: 400, end_ms: 600 });
    socket.event({ type: 'session.output_audio.delta', delta: voiced(10).toString('base64') });
    // Each frame is written to the speaker (output: waveform state), then the device reports it played (played: captions).
    const frame = (pcm = voiced(1)) => { output(pcm, true); played(pcm); };
    frame();
    assert.deepEqual(captions.at(-1), 'All tests pass,');
    for (let i = 0; i < 9; i++) frame();
    assert.deepEqual(captions.at(-1), 'All tests pass,', 'the fragment completes as its range is played');
    for (let i = 0; i < 10; i++) frame(Buffer.alloc(960)); // the breath: the next range has not started
    assert.deepEqual(captions.at(-1), 'All tests pass,');
    frame();
    assert.deepEqual(captions.at(-1), 'nothing else changed.');
    socket.event({ type: 'session.input_transcript.delta', delta: 'and', start_ms: 420, end_ms: 440 });
    socket.event({ type: 'session.output_transcript.delta', delta: 'Stopping.', start_ms: 500, end_ms: 600 });
    socket.event({ type: 'session.output_audio.delta', delta: voiced(5).toString('base64') });
    for (let i = 0; i < 5; i++) frame();
    assert.deepEqual(captions.at(-1), 'Stopping.');
    voice.stop();
  } finally { globalThis.WebSocket = originalWS; }
});

test('captions split at commas, semicolons, colons, dashes, and sentence ends', () => {
  const text = 'Twenty pass, two fail; both in the parser: one fixed — the other needs you. Done.';
  const at = cursor => phraseAt(text, cursor).phrase;
  assert.equal(at(0), '');
  assert.equal(at(1), 'Twenty pass,');
  assert.equal(at(20), 'two fail;');
  assert.equal(at(30), 'both in the parser:');
  assert.equal(at(50), 'one fixed —');
  assert.equal(at(70), 'the other needs you.');
  assert.equal(at(text.length), 'Done.');
  assert.deepEqual(phraseAt('Twenty pass, two', 15), { phrase: 'two', spoken: 2, continues: true, open: true });
  assert.deepEqual(phraseAt('Done. Next one', 8), { phrase: 'Next one', spoken: 2, continues: false, open: true });
});

test('mid-sentence breaks show as ellipses on both sides', () => {
  const line = (phrase, continues, open, spoken = 0) => ({ phrase, spoken, continues, open });
  assert.equal(formatCaption(line('Twenty pass,', false, true), 80), 'Twenty pass…');
  assert.equal(formatCaption(line('two fail;', true, true), 80), '…two fail…');
  assert.equal(formatCaption(line('one fixed —', true, true), 80), '…one fixed…');
  assert.equal(formatCaption(line('both in the parser.', true, false), 80), '…both in the parser.');
  assert.equal(formatCaption(line('Done.', false, false), 80), 'Done.');
  assert.equal(formatCaption(line('', false, false), 80), '');
});

test('a phrase wider than the bar shows the spoken word chunk, with ellipses where it continues', () => {
  const phrase = 'The migration touched every handler in the payments service.';
  const at = spoken => formatCaption({ phrase, spoken, continues: false, open: false }, 24);
  assert.equal(at(0), 'The migration touched…');
  assert.equal(at(30), '…every handler in the…');
  assert.equal(at(phrase.length), '…payments service.');
  for (let spoken = 0; spoken <= phrase.length; spoken++) assert.ok(at(spoken).length <= 24, at(spoken));
});

test('voiced time ignores silence and breaths', () => {
  assert.equal(voicedMs(voiced(5), 24000), 100);
  assert.equal(voicedMs(Buffer.alloc(960 * 5), 24000), 0);
  assert.equal(voicedMs(Buffer.concat([voiced(2), Buffer.alloc(960 * 3)]), 24000), 40);
});

test('a streaming response keeps the caption with the voice, not the delivery', () => {
  const shown = [];
  const captions = new Captions(line => shown.push(line.phrase));
  // The whole sentence arrives ahead of its audio, and the audio streams in about
  // as fast as it plays: how much is queued says nothing about the sentence's length.
  captions.text('Twenty pass, ');
  captions.text('two fail; ');
  captions.text('one is flaky.');
  const step = () => { captions.queued(voiced(10), 24000); for (let i = 0; i < 10; i++) captions.played(voiced(1), 24000); };
  step();
  assert.equal(shown.at(-1), 'Twenty pass,');
  for (let i = 0; i < 4; i++) step(); // 1000 ms heard
  assert.equal(shown.at(-1), 'two fail;');
  for (let i = 0; i < 4; i++) step(); // 1800 ms heard
  assert.equal(shown.at(-1), 'one is flaky.');
  assert.ok(!shown.slice(0, 5).includes('one is flaky.'), 'the last sentence never jumps ahead of the voice');
});

test('GPT-Live fragments pace by their server ranges against played output audio', () => {
  const shown = [];
  const captions = new Captions(line => shown.push(line.phrase));
  // Every played frame advances the session clock, silence or not.
  captions.text('All tests pass, ', 0, 200);
  captions.text('nothing else changed.', 400, 600);
  captions.played(Buffer.concat([voiced(10), Buffer.alloc(960 * 10)]), 24000); // 400 ms played, breath included
  assert.equal(shown.at(-1), 'All tests pass,');
  captions.played(voiced(1), 24000); // 20 ms into the second range
  assert.equal(shown.at(-1), 'nothing else changed.');
  captions.userSpeech();
  captions.turn(800);                 // the user spoke; the next turn starts at session 800
  captions.text('Stopping.', 800, 900);
  captions.played(Buffer.alloc(960 * 19), 24000); // the clock runs through silence to exactly 800
  assert.equal(shown.at(-1), 'nothing else changed.', 'the next turn waits for its session position');
  captions.played(voiced(2), 24000);   // 840 ms: inside "Stopping."
  assert.equal(shown.at(-1), 'Stopping.');
});

test('GPT-Live captions anchor to speech onset when the session clock is ahead of played audio', () => {
  const shown = [];
  const captions = new Captions(line => shown.push(line.phrase));
  // The first output audio sits 1500 ms into the session timeline; locally it starts at 0.
  captions.turn(1500);
  captions.text('Here.', 1500, 1700);
  captions.played(voiced(1), 24000); // the greeting's first voiced frame
  assert.equal(shown.at(-1), 'Here.', 'shown at its onset, not 1.5 s later');
  captions.played(Buffer.alloc(960 * 40), 24000);
  // Frames dropped or flushed on barge-in: the timeline moves on by 2000 ms that never play.
  captions.userSpeech();
  captions.turn(5000);
  captions.text('Checking, ', 5000, 5400);
  captions.text('one moment.', 5400, 5800);
  captions.played(Buffer.alloc(960 * 10), 24000);
  assert.equal(shown.at(-1), 'Here.', 'the new turn waits for its own onset');
  captions.played(voiced(1), 24000);
  assert.equal(shown.at(-1), 'Checking,');
  for (let i = 0; i < 20; i++) captions.played(voiced(1), 24000); // 420 ms into the turn
  assert.equal(shown.at(-1), 'one moment.');
});

test('GPT-Live anchoring ignores onsets from before the user spoke', () => {
  const shown = [];
  const captions = new Captions(line => shown.push(line.phrase));
  captions.turn(0);
  captions.text('First.', 0, 200);
  // Frames arrive from the device one 20 ms frame at a time.
  for (let i = 0; i < 10; i++) captions.played(voiced(1), 24000);
  for (let i = 0; i < 20; i++) captions.played(Buffer.alloc(960), 24000);
  captions.userSpeech();
  // The reply's text arrives before its audio; the old onset at 0 must not anchor it.
  captions.turn(3000);
  captions.text('Second.', 3000, 3200);
  captions.played(Buffer.alloc(960 * 5), 24000);
  assert.equal(shown.at(-1), 'First.');
  captions.played(voiced(1), 24000);
  assert.equal(shown.at(-1), 'Second.');
});

test('GPT-Live appends are clipped by a pessimistic token estimate, not characters', () => {
  assert.equal(clipTokens('Published 0.1.3.', 400), 'Published 0.1.3.');
  // 1800 characters of a publish log is ~800 real tokens: well over the 500-token limit.
  const log = 'npm notice 13.3kB README.md sha512-XosJ7wfxiYZWi9a3 /Users/alper/dev/pi-voice/audio.ts:384 '.repeat(40);
  const clipped = clipTokens(log, 400);
  assert.ok(clipped.endsWith(' …'));
  assert.ok(clipped.length < 900, `kept ${clipped.length} chars`);
  assert.ok(log.startsWith(clipped.slice(0, -2)));
  // Every digit and symbol counts as a token: dense text keeps proportionally less.
  assert.ok(clipTokens('1234567890'.repeat(100), 400).length <= 401);
});

test('GPT-Live config comes from providers/openai-live/ and delegates to the Pi session', () => {
  const config = liveSessionConfig();
  assert.equal(config.model, 'gpt-live-1');
  assert.match(config.instructions, /<\|SpawnThinking\|>/);
  assert.deepEqual(config.audio, { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: 'vesper' } });
  assert.doesNotMatch(config.instructions, /\n\nVoice: /);
  assert.deepEqual(config.delegation, { type: 'client' });
});

test('GPT-Live authenticates with a header, starts the session, and streams audio both ways', async () => {
  const originalWS = globalThis.WebSocket;
  try {
    const { voice, socket, audio, input, output } = await startLive();
    assert.equal(socket.url, 'wss://api.openai.com/v1/live/sessions');
    assert.deepEqual(socket.protocols, { headers: { Authorization: 'Bearer test-not-a-real-key' } });
    assert.equal(socket.sent[0].type, 'session.start');
    assert.equal(socket.sent[0].session.model, 'gpt-live-1');
    const frame = Buffer.alloc(960, 5);
    input(frame);
    assert.equal(socket.sent.at(-1).type, 'session.input_audio.append');
    assert.equal(socket.sent.at(-1).audio, frame.toString('base64'));
    socket.event({ type: 'session.output_audio.delta', delta: Buffer.alloc(960).toString('base64') });
    assert.equal(audio.enqueued.length, 1);
    const spoken = Buffer.alloc(960); spoken.writeInt16LE(5000, 100);
    output(spoken, true); // the agent is audibly speaking
    socket.event({ type: 'session.input_transcript.delta', delta: 'wait', start_ms: 0, end_ms: 200 });
    assert.equal(audio.interrupts, 1, 'user speech drops locally queued playback');
    voice.mute(true);
    assert.deepEqual([audio.muted, socket.sent.at(-1).type], [[true], 'session.input_audio.mute']);
    const n = socket.sent.length; input(frame);
    assert.equal(socket.sent.length, n, 'muted mic sends nothing');
    voice.stop();
    assert.equal(socket.sent.at(-1).type, 'session.close', 'graceful close finalizes usage');
    assert.equal(audio.stopped, 1);
  } finally { globalThis.WebSocket = originalWS; }
});

// ---------- GPT-Live wire alone: server events in, neutral callbacks out ----------

async function startWire() {
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

test('the GPT-Live wire turns server events into callbacks that keep the session clock', async () => {
  const originalWS = globalThis.WebSocket;
  try {
    const { wire, socket, calls } = await startWire();
    assert.deepEqual(socket.sent[0], { event_id: 'pi_1', type: 'session.start', session: { model: 'gpt-live-1' } });
    socket.event({ type: 'session.output_audio.delta', delta: Buffer.from([1, 2]).toString('base64') });
    socket.event({ type: 'session.output_audio.delta', delta: '' }); // empty audio is not passed on
    socket.event({ type: 'session.output_transcript.delta', delta: 'On it.', start_ms: 100, end_ms: 300 });
    socket.event({ type: 'session.input_transcript.delta', delta: 'run tests', start_ms: 50 }); // half-timed stays half-timed
    socket.event({ type: 'session.delegation.created', offset_ms: 400, delegation: { id: 'd1' } });
    socket.event({ type: 'session.delegation.created', delegation: {} });
    socket.event({ type: 'error', error: { code: 'bad_voice' } });
    socket.event({ type: 'session.closed' });
    assert.deepEqual(calls, [['started'], ['audio', Buffer.from([1, 2])], ['outputText', 'On it.', 100, 300], ['inputText', 'run tests', 50, undefined],
      ['delegation', 'd1', 400], ['delegation', undefined, undefined], ['error', 'OpenAI GPT-Live: bad_voice', false], ['closed']]);
    socket.dispatchEvent(new MessageEvent('message', { data: 'not json' }));
    assert.equal(calls.at(-1)[0], 'error');
    assert.equal(calls.at(-1)[2], true, 'a malformed frame is fatal');
    wire.close();
  } finally { globalThis.WebSocket = originalWS; }
});

test('the GPT-Live wire tags appends with their delegation, clips them, and closes gracefully', async () => {
  const originalWS = globalThis.WebSocket;
  try {
    const { wire, socket, calls } = await startWire();
    wire.say('47 pass.', 'd1', 'result');
    assert.deepEqual(socket.sent.at(-1), { event_id: 'pi_2', type: 'session.commentary.append', delegation_id: 'd1', content: '47 pass.' });
    const log = 'npm notice 13.3kB README.md sha512-XosJ7wfxiYZWi9a3 '.repeat(80);
    wire.say(log, null, 'context');
    assert.deepEqual([socket.sent.at(-1).type, socket.sent.at(-1).delegation_id, socket.sent.at(-1).content], ['session.thinking.append', null, clipTokens(log, 400)]);
    assert.ok(socket.sent.at(-1).content.endsWith(' …'));
    wire.appendAudio(Buffer.from([7]));
    wire.mute(true);
    assert.deepEqual(socket.types().slice(-2), ['session.input_audio.append', 'session.input_audio.mute']);
    socket.bufferedAmount = 600_000;
    wire.mute(false);
    assert.deepEqual(calls.at(-1), ['lost', 'OpenAI GPT-Live connection lost (upload stalled).'], 'a live session whose upload stalls is lost, not misconfigured');
    socket.bufferedAmount = 0;
    wire.close();
    assert.equal(socket.sent.at(-1).type, 'session.close');
    assert.equal(socket.readyState, 1, 'the socket stays open for session.closed');
    const n = socket.sent.length;
    wire.say('late', 'd1', 'result');
    socket.event({ type: 'session.closed' });
    assert.equal(socket.sent.length, n, 'nothing is sent after close');
    assert.notDeepEqual(calls.at(-1), ['closed'], 'nothing is reported after close');
  } finally { globalThis.WebSocket = originalWS; }
});

test('the GPT-Live wire reports a close before the session started, and close() ends a pending start', async () => {
  const originalWS = globalThis.WebSocket;
  try {
    globalThis.WebSocket = FakeSocket;
    const errors = [];
    const early = new GptLiveWire({ started() {}, audio() {}, outputText() {}, inputText() {}, delegation() {}, closed() {}, error: (...e) => errors.push(e) });
    early.start('k', {}).catch(() => {});
    FakeSocket.last.dispatchEvent(Object.assign(new Event('close'), { code: 1008, reason: 'bad key' }));
    assert.deepEqual(errors, [['OpenAI closed the connection before the session started (1008: bad key).', true]]);
    early.close();
    const pending = new GptLiveWire({ started() {}, audio() {}, outputText() {}, inputText() {}, delegation() {}, closed() {}, error() {} });
    const started = pending.start('k', {});
    const socket = FakeSocket.last;
    pending.close();
    await assert.rejects(started, /Voice stopped/);
    assert.equal(socket.readyState, 3, 'not live: the socket closes at once, without session.close');
    assert.equal(socket.sent.length, 0);
  } finally { globalThis.WebSocket = originalWS; }
});

test('the GPT-Live wire tells a lost session (drop, hangup, duration limit) from a closed or refused one', async () => {
  const originalWS = globalThis.WebSocket;
  try {
    for (const [event, expected] of [
      [Object.assign(new Event('close'), { code: 1006, reason: '' }), ['lost', 'OpenAI GPT-Live connection lost (1006).']],
      [new Event('error'), ['lost', 'OpenAI GPT-Live connection lost.']],
      [Object.assign(new Event('close'), { code: 1008, reason: 'policy' }), ['error', 'OpenAI GPT-Live connection closed (1008: policy).', true]],
      [Object.assign(new Event('close'), { code: 1000, reason: '' }), ['closed']],
    ]) {
      const { wire, socket, calls } = await startWire();
      socket.dispatchEvent(event);
      assert.deepEqual(calls.at(-1), expected);
      wire.close();
    }
    for (const [reason, expected] of [['expired', 'lost'], ['connection_lost', 'lost'], ['close_requested', 'closed'], ['content', 'closed']]) {
      const { wire, socket, calls } = await startWire();
      socket.event({ type: 'session.closed', reason });
      assert.equal(calls.at(-1)[0], expected, reason);
      wire.close();
    }
  } finally { globalThis.WebSocket = originalWS; }
});

test('the GPT-Live wire declares a live session lost after 10 s without a frame, even with no close', async t => {
  const originalWS = globalThis.WebSocket;
  try {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const { wire, socket, calls } = await startWire();
    for (let i = 0; i < 8; i++) { t.mock.timers.tick(900); socket.event({ type: 'session.output_audio.delta', delta: 'AA==' }); }
    t.mock.timers.tick(6000);
    socket.event({ type: 'session.usage.updated' }); // a server stall of 6 s is not a dead link
    assert.equal(calls.some(c => c[0] === 'lost'), false, 'frames keep it alive');
    t.mock.timers.tick(11000);
    assert.deepEqual(calls.find(c => c[0] === 'lost'), ['lost', 'OpenAI GPT-Live connection lost (no data for 10 s).']);
    wire.close();
    const n = calls.length;
    t.mock.timers.tick(10000);
    assert.equal(calls.length, n, 'the watchdog stops with the session');
    // Muted, GPT-Live goes quiet: that is not a dead link, and unmuting starts the count afresh.
    const muted = await startWire();
    muted.wire.mute(true);
    t.mock.timers.tick(30000);
    assert.equal(muted.calls.some(c => c[0] === 'lost'), false, 'quiet while muted');
    muted.wire.mute(false);
    t.mock.timers.tick(9000);
    assert.equal(muted.calls.some(c => c[0] === 'lost'), false, 'a fresh count after unmuting');
    t.mock.timers.tick(2000);
    assert.equal(muted.calls.at(-1)[0], 'lost');
    muted.wire.close();
  } finally { globalThis.WebSocket = originalWS; }
});

const settle = () => new Promise(r => setTimeout(r, 400)); // trailing transcript fragments get 350 ms
const lastOf = (socket, type) => socket.sent.filter(e => e.type === type).at(-1);

test('a delegation hands the user\'s words since the last one to Pi, and Pi\'s result answers it', async () => {
  const originalWS = globalThis.WebSocket;
  try {
    const calls = [];
    const { voice, socket, audio, output } = await startLive({ tool: (name, args) => { calls.push([name, args]); return { status: 'started' }; } });
    socket.event({ type: 'session.input_transcript.delta', delta: 'Run the tests ', start_ms: 1000, end_ms: 1800 });
    socket.event({ type: 'session.output_transcript.delta', delta: 'On it.', start_ms: 1850, end_ms: 2000 }); // the voice acknowledges
    const spoken = Buffer.alloc(960); spoken.writeInt16LE(5000, 100);
    output(spoken, true); // and is audibly playing
    socket.event({ type: 'session.delegation.created', offset_ms: 1900, delegation: { id: 'd1', type: 'delegation', target: 'client' } });
    socket.event({ type: 'session.input_transcript.delta', delta: 'in the voice repo.', start_ms: 1800, end_ms: 2400 }); // trails the delegation
    assert.equal(calls.length, 1, 'the fragment reaching the delegation offset releases it without waiting');
    assert.equal(audio.interrupts, 0, 'a straggling fragment of the request does not cut off the acknowledgement');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'ask_pi');
    assert.equal(calls[0][1].when, 'now');
    assert.match(calls[0][1].request, /^Voice request \(speech transcript; may contain recognition errors\): Run the tests in the voice repo\.$/);
    assert.deepEqual([lastOf(socket, 'session.thinking.append').delegation_id], ['d1'], 'GPT-Live learns that Pi took it');
    // Pi's progress and result go back on the same delegation.
    voice.context('Progress on my task "run the tests": I just ran bash: npm test.');
    assert.equal(lastOf(socket, 'session.thinking.append').delegation_id, 'd1');
    voice.notify('I finished the task. My answer: 47 pass, none fail.');
    assert.deepEqual([lastOf(socket, 'session.commentary.append').delegation_id, lastOf(socket, 'session.commentary.append').content], ['d1', 'I finished the task. My answer: 47 pass, none fail.']);
    // The next delegation takes only what was said after the first one.
    socket.event({ type: 'session.input_transcript.delta', delta: 'Then commit.', start_ms: 5000, end_ms: 5600 });
    socket.event({ type: 'session.delegation.created', offset_ms: 5700, delegation: { id: 'd2', type: 'delegation', target: 'client' } });
    await settle();
    // It carries what was said since the first request, which itself is not repeated.
    assert.match(calls[1][1].request, /: Then commit\.\n\nWhat we said since my last request, oldest first:\n- You \(voice\): On it\.$/);
    assert.ok(socket.sent.every(e => typeof e.event_id === 'string'), 'every client event carries an event_id');
    voice.stop();
  } finally { globalThis.WebSocket = originalWS; }
});

test('Pi status and notices name the spoken words, not the voice framing', () => {
  const { bridge, sent, notices, control } = fakePi();
  bridge.call('ask_pi', { request: `${VOICE_REQUEST}Yes, do it.${CONVERSATION_MARK}- You (voice): Shall I fix it?` });
  assert.equal(sent[0][0].startsWith(VOICE_REQUEST), true, 'Pi itself gets the framing');
  control.idle = false;
  assert.equal(bridge.status().task, 'Yes, do it.');
  bridge.settled(false);
  assert.match(notices[0], /^I finished the task "Yes, do it"/);
});

test('a complete request goes to Pi at once; an incomplete one waits briefly for its last words', async () => {
  const originalWS = globalThis.WebSocket;
  try {
    const calls = [];
    const { voice, socket } = await startLive({ tool: (name, args) => { calls.push(args.request); return { status: 'started' }; } });
    socket.event({ type: 'session.input_transcript.delta', delta: 'List the files.', start_ms: 1000, end_ms: 2000 });
    socket.event({ type: 'session.delegation.created', offset_ms: 2000, delegation: { id: 'd1' } });
    assert.equal(calls.length, 1, 'no settle delay when the last fragment already reaches offset_ms');
    socket.event({ type: 'session.input_transcript.delta', delta: 'Then the', start_ms: 4000, end_ms: 4400 });
    socket.event({ type: 'session.delegation.created', offset_ms: 5000, delegation: { id: 'd2' } });
    assert.equal(calls.length, 1, 'waits while the request is incomplete');
    await settle(); // nothing more arrives: it goes with what was heard
    assert.equal(calls.length, 2);
    assert.match(calls[1], /: Then the/);
    voice.stop();
  } finally { globalThis.WebSocket = originalWS; }
});

test('an explanation over several turns is in Pi\'s conversation before the question that refers to it', async () => {
  const originalWS = globalThis.WebSocket;
  try {
    const calls = [], transcripts = [];
    const { voice, socket } = await startLive({ transcripts, tool: (name, args) => { calls.push(args.request); return { status: 'started' }; } });
    // Reported live: a long explanation with pauses, the voice answering in between, then the question.
    const user = (delta, start) => socket.event({ type: 'session.input_transcript.delta', delta, start_ms: start, end_ms: start + 1000 });
    const voiceSays = (delta, start) => socket.event({ type: 'session.output_transcript.delta', delta, start_ms: start, end_ms: start + 800 });
    user('In live.ts the delegate method should also log the delegation id', 1000);
    voiceSays('Got it, logging the id.', 2500);
    user('Just one line, next to where the thinking update is sent', 4000);
    voiceSays('Mm-hm.', 5500);
    user('. Does that single line addition work in this current structure? Do we need anything else?', 7000);
    socket.event({ type: 'session.delegation.created', offset_ms: 8000, delegation: { id: 'd1' } });
    assert.equal(calls.length, 1);
    // The explanation joined Pi's conversation as it went; the request is just the question.
    assert.deepEqual(kept(transcripts), [
      ['user', 'In live.ts the delegate method should also log the delegation id', false],
      ['voice', 'Got it, logging the id.', false],
      ['user', 'Just one line, next to where the thinking update is sent', false],
      ['voice', 'Mm-hm.', false],
    ]);
    assert.match(calls[0], /: \. Does that single line addition work in this current structure\? Do we need anything else\?$/);
    assert.ok(!calls[0].includes(CONVERSATION_MARK), 'nothing repeated');
    voice.stop();
  } finally { globalThis.WebSocket = originalWS; }
});

test('conversation context keeps the newest lines within its budget', () => {
  assert.equal(conversationContext([]), '');
  const long = Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'voice' : 'user', text: `line ${i} ${'x'.repeat(80)}` }));
  const text = conversationContext(long);
  assert.ok(text.length < 3200, `bounded (${text.length})`);
  assert.match(text, /line 99/);
  assert.doesNotMatch(text, /line 0 /);
});

test('a short reply reaches Pi with what the voice had just said, when Pi\'s conversation lacks it', async () => {
  const originalWS = globalThis.WebSocket;
  try {
    let busy = false;
    const calls = [];
    const { voice, socket } = await startLive({ busy: () => busy, tool: (name, args) => { calls.push([name, args]); return { status: 'started' }; } });
    // Said while Pi is idle: the question is already in Pi's conversation, so the reply goes alone.
    socket.event({ type: 'session.output_transcript.delta', delta: 'The build fails on a missing import. Shall I fix it?', start_ms: 0, end_ms: 2000 });
    socket.event({ type: 'session.input_transcript.delta', delta: 'Yes, do it.', start_ms: 2500, end_ms: 3000 });
    socket.event({ type: 'session.delegation.created', offset_ms: 3100, delegation: { id: 'd1' } });
    await settle();
    assert.match(calls[0][1].request, /: Yes, do it\.$/);
    // Said while Pi works (not kept): the reply carries it.
    busy = true;
    socket.event({ type: 'session.output_transcript.delta', delta: 'Want me to run the linter as well?', start_ms: 4000, end_ms: 5000 });
    socket.event({ type: 'session.input_transcript.delta', delta: 'Sure.', start_ms: 5500, end_ms: 6000 });
    socket.event({ type: 'session.delegation.created', offset_ms: 6100, delegation: { id: 'd2' } });
    await settle();
    assert.match(calls[1][1].request, /Sure\.\n\nWhat we said since my last request, oldest first:\n- You \(voice\): Want me to run the linter as well\?$/);
    voice.stop();
  } finally { globalThis.WebSocket = originalWS; }
});

test('words GPT-Live does not delegate while Pi works are noted once with the result, so it is not read out as if they were done', async t => {
  const originalWS = globalThis.WebSocket;
  try {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let busy = false;
    const calls = [];
    const { voice, socket } = await startLive({ busy: () => busy, tool: (name, args) => { calls.push([name, args]); busy = true; return { status: 'started' }; } });
    socket.event({ type: 'session.input_transcript.delta', delta: 'List the providers folder.', start_ms: 0, end_ms: 1000 });
    socket.event({ type: 'session.delegation.created', offset_ms: 900, delegation: { id: 'd1' } });
    const sent = socket.sent.length;
    socket.event({ type: 'session.input_transcript.delta', delta: 'Actually, list the tests folder instead.', start_ms: 2500, end_ms: 4000 });
    t.mock.timers.tick(10000);
    assert.equal(socket.sent.length, sent, 'nothing is sent for them before the result');
    voice.notify('I finished the task "List the providers folder". My answer: one directory, openai-live.');
    const [note, result] = socket.sent.slice(-2);
    assert.equal(note.type, 'session.thinking.append');
    assert.match(note.content, /^While I worked the user said "Actually, list the tests folder instead\.", and it did not reach this task/);
    assert.equal(note.delegation_id, 'd1');
    assert.deepEqual([result.type, result.content], ['session.commentary.append', 'I finished the task "List the providers folder". My answer: one directory, openai-live.']);
    voice.notify('A second update.');
    assert.equal(socket.sent.at(-1).type, 'session.commentary.append', 'noted once');
    assert.equal(socket.sent.at(-2).type, 'session.commentary.append');
    voice.stop();
  } finally { globalThis.WebSocket = originalWS; }
});

test('a reply is not a hand-off: undelegated words go to Pi once as a remark; delegated, idle, stop and status words do not', async t => {
  const originalWS = globalThis.WebSocket;
  try {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let busy = true;
    const asked = [];
    const { voice, socket } = await startLive({ busy: () => busy, tool: (name, args) => { if (name === 'ask_pi') asked.push(args.request); return { status: 'steered' }; } });
    socket.event({ type: 'session.input_transcript.delta', delta: 'Use the tests folder instead.', start_ms: 0, end_ms: 1000 });
    socket.event({ type: 'session.output_transcript.delta', delta: "I'll pivot to that.", start_ms: 1500, end_ms: 1800 });
    t.mock.timers.tick(3400);
    assert.equal(asked.length, 0, 'GPT-Live gets its usual time to delegate');
    t.mock.timers.tick(200);
    assert.equal(asked.length, 1);
    assert.equal(asked[0], `${VOICE_REMARK}Use the tests folder instead.`);
    assert.match(VOICE_REMARK, /apply it\. Otherwise ignore it completely: no tools and no reply/);
    assert.match(socket.sent.at(-1).content, /went to the running task as a remark/);
    // GPT-Live delegates the same words late: they are not sent again.
    socket.event({ type: 'session.delegation.created', offset_ms: 1000, delegation: { id: 'd2' } });
    t.mock.timers.tick(400);
    assert.equal(asked.length, 1, 'no double steer');
    assert.deepEqual([socket.sent.at(-1).content, socket.sent.at(-1).delegation_id], ['Already added to the running task.', 'd2']);
    // Delegated words, stop and status (GPT-Live's to handle), and words while Pi is idle are not remarked.
    socket.event({ type: 'session.input_transcript.delta', delta: ' Also run the linter.', start_ms: 6000, end_ms: 7000 });
    socket.event({ type: 'session.delegation.created', offset_ms: 7000, delegation: { id: 'd3' } });
    t.mock.timers.tick(400);
    socket.event({ type: 'session.output_transcript.delta', delta: 'Sure.', start_ms: 7500, end_ms: 7800 });
    socket.event({ type: 'session.input_transcript.delta', delta: 'Stop that.', start_ms: 9000, end_ms: 9500 });
    t.mock.timers.tick(5000);
    busy = false;
    socket.event({ type: 'session.output_transcript.delta', delta: 'Okay.', start_ms: 15000, end_ms: 15300 });
    socket.event({ type: 'session.input_transcript.delta', delta: 'What a day.', start_ms: 16000, end_ms: 17000 });
    t.mock.timers.tick(5000);
    assert.deepEqual(asked.map(q => q.slice(0, 20)), ['Said while you worke', 'Voice request (speec']);
    voice.notify('I finished the task. My answer: done.');
    assert.match(socket.sent.at(-2).content, /^While I worked the user said "Stop that\.", and it did not reach this task/, 'only the unhandled stop is noted');
    voice.stop();
  } finally { globalThis.WebSocket = originalWS; }
});

test('remark edge cases: Pi finishing first, a status question after a correction, and no stale "already added"', async t => {
  const originalWS = globalThis.WebSocket;
  try {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let busy = true;
    const asked = [];
    const tool = (name, args) => {
      if (name === 'pi_status') return { state: 'working', task: 'list providers', elapsed_s: 5 };
      if (name === 'ask_pi') { asked.push(args.request); return { status: busy ? 'steered' : 'started' }; }
      return {};
    };
    const { voice, socket } = await startLive({ busy: () => busy, tool });
    // A correction, then a status question that GPT-Live delegates: the correction still goes to Pi.
    socket.event({ type: 'session.input_transcript.delta', delta: 'Use the tests folder instead.', start_ms: 0, end_ms: 1000 });
    socket.event({ type: 'session.output_transcript.delta', delta: 'Noted.', start_ms: 1200, end_ms: 1500 });
    socket.event({ type: 'session.input_transcript.delta', delta: "How's it going?", start_ms: 2000, end_ms: 2600 });
    socket.event({ type: 'session.delegation.created', offset_ms: 2600, delegation: { id: 'd1' } });
    t.mock.timers.tick(4000);
    assert.equal(asked.length, 1);
    assert.equal(spokenPart(asked[0]), 'Use the tests folder instead.', 'the status question is not part of the remark');
    // The result ends the remark: a later empty delegation with Pi idle is not swallowed.
    voice.notify('I finished the task. My answer: one file.');
    busy = false;
    socket.event({ type: 'session.delegation.created', offset_ms: 2600, delegation: { id: 'd2' } });
    t.mock.timers.tick(400);
    assert.equal(asked.length, 2, 'the empty delegation is handled as before, not as "already added"');
    // Pi finishes within the wait: the words are noted with the result, not lost silently.
    busy = true;
    socket.event({ type: 'session.input_transcript.delta', delta: ' And skip the docs folder.', start_ms: 9000, end_ms: 10000 });
    busy = false;
    t.mock.timers.tick(500);
    voice.notify('I finished the task. My answer: done.');
    assert.match(socket.sent.at(-2).content, /^While I worked the user said "And skip the docs folder\.", and it did not reach this task/);
    t.mock.timers.tick(5000);
    assert.equal(asked.length, 2, 'nothing is sent once Pi is idle');
    voice.stop();
  } finally { globalThis.WebSocket = originalWS; }
});

test('a remark shows in the chat and the briefing as what was said', () => {
  const remark = `${VOICE_REMARK}Use the tests folder instead.`;
  assert.equal(isSpoken(remark), true);
  assert.equal(isSpoken(`${VOICE_REQUEST}List it.`), true);
  assert.equal(isSpoken('typed text'), false);
  assert.equal(spokenPart(remark), 'Use the tests folder instead.');
});

test('while Pi works, "stop" aborts it and a status question is answered without disturbing it', async () => {
  const originalWS = globalThis.WebSocket;
  try {
    const calls = [];
    const tool = (name, args) => {
      calls.push(name);
      if (name === 'cancel_pi') return { status: 'cancelled' };
      if (name === 'pi_status') return { state: 'working', task: 'run the tests', elapsed_s: 42, last_tool: 'bash: npm test' };
      return { status: 'steered' };
    };
    const { voice, socket } = await startLive({ tool, busy: () => true });
    socket.event({ type: 'session.input_transcript.delta', delta: 'What is Pi doing?', start_ms: 0, end_ms: 800 });
    socket.event({ type: 'session.delegation.created', delegation: { id: 'd1' } });
    await settle();
    assert.deepEqual(calls, ['pi_status']);
    assert.equal(lastOf(socket, 'session.commentary.append').content, 'I\'m working on "run the tests" for 42 seconds; last step: bash: npm test.');
    socket.event({ type: 'session.input_transcript.delta', delta: 'Stop that.', start_ms: 1000, end_ms: 1500 });
    socket.event({ type: 'session.delegation.created', delegation: { id: 'd2' } });
    await settle();
    assert.deepEqual(calls, ['pi_status', 'cancel_pi']);
    assert.deepEqual([lastOf(socket, 'session.commentary.append').delegation_id, lastOf(socket, 'session.commentary.append').content], ['d2', 'I stopped the task.']);
    // Anything else while Pi works steers the running task.
    socket.event({ type: 'session.input_transcript.delta', delta: 'Also run the linter.', start_ms: 2000, end_ms: 2800 });
    socket.event({ type: 'session.delegation.created', delegation: { id: 'd3' } });
    await settle();
    assert.deepEqual(calls, ['pi_status', 'cancel_pi', 'ask_pi']);
    voice.stop();
  } finally { globalThis.WebSocket = originalWS; }
});

test('a delegation takes only the latest turn: a question the voice answered itself does not leak in', async () => {
  const originalWS = globalThis.WebSocket;
  try {
    const calls = [];
    const { voice, socket } = await startLive({ tool: name => { calls.push(name); return name === 'cancel_pi' ? { status: 'cancelled' } : { state: 'working' }; }, busy: () => true });
    // Measured live: a status question the voice answered from Pi's progress, then "Stop that".
    for (const [delta, start] of [[' What is', 10400], [' pi', 10800], [' doing', 11200], [' right', 11600], [' now', 11800]]) socket.event({ type: 'session.input_transcript.delta', delta, start_ms: start, end_ms: start + 200 });
    socket.event({ type: 'session.output_transcript.delta', delta: 'It is in the middle of that sleep command.', start_ms: 12500, end_ms: 15000 });
    socket.event({ type: 'session.input_transcript.delta', delta: 'Stop', start_ms: 17200, end_ms: 17400 });
    socket.event({ type: 'session.input_transcript.delta', delta: ' that', start_ms: 17600, end_ms: 17800 });
    socket.event({ type: 'session.delegation.created', offset_ms: 17600, delegation: { id: 'd1' } });
    assert.deepEqual(calls, ['cancel_pi']);
    voice.stop();
  } finally { globalThis.WebSocket = originalWS; }
});

test('a new voice session is briefed from the Pi session, in the first person', async () => {
  const originalWS = globalThis.WebSocket;
  try {
    globalThis.WebSocket = FakeSocket;
    const voice = new LiveVoice({ state() {}, samples() {}, error() {}, closed() {}, tool: () => ({}), busy: () => false, briefing: () => 'What I know about this session: I fixed the parser.' }, () => ({ start() {}, enqueue() {}, finish() {}, interrupt() {}, mute() {}, stop() {} }));
    const started = voice.start(() => 'test-not-a-real-key');
    await new Promise(r => setImmediate(r));
    FakeSocket.last.dispatchEvent(new Event('open'));
    const instructions = FakeSocket.last.sent[0].session.instructions;
    assert.match(instructions, /^You are Pi, the coding agent/);
    assert.match(instructions, /first person/);
    assert.match(instructions, /\n\nWhat I know about this session: I fixed the parser\.$/);
    FakeSocket.last.event({ type: 'session.started', session: {} });
    await started;
    voice.stop();
  } finally { globalThis.WebSocket = originalWS; }
});

test('the briefing keeps the newest turns, marks spoken requests, and says what is running', () => {
  const message = (role, text) => ({ type: 'message', message: role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] } });
  const entries = [
    message('user', 'an old request that the compaction summary replaces'),
    { type: 'compaction', summary: 'Set up the repo and fixed lint.' },
    message('user', 'fix the parser'), message('assistant', 'Fixed the off-by-one in the parser.'),
    message('user', `${VOICE_REQUEST}run the tests${CONVERSATION_MARK}- You (voice): Done.`),
    { type: 'model_change' },
  ];
  const text = sessionBriefing(entries, { cwd: '/repo', status: { state: 'working', task: 'run the tests', last_tool: 'bash: npm test' } });
  assert.doesNotMatch(text, /an old request/);
  assert.match(text, /Earlier in this session \(summary\): Set up the repo and fixed lint\./);
  assert.match(text, /- The user \(typed\): fix the parser\n- Me: Fixed the off-by-one in the parser\.\n- The user \(spoken\): run the tests\n/);
  assert.match(text, /Right now I'm still working on "run the tests"; last step: bash: npm test\. Its result will arrive as an update\.$/);
  assert.match(sessionBriefing([], {}), /Nothing has been said in this session yet\.\nRight now nothing is running\.$/);
  const long = Array.from({ length: 200 }, (_, i) => message('user', `request ${i} ${'x'.repeat(200)}`));
  const trimmed = sessionBriefing(long, {});
  assert.ok(trimmed.length < 4600, `briefing is bounded (${trimmed.length})`);
  assert.match(trimmed, /request 199/, 'the newest turns are kept');
});

test('a voice session started mid-task adopts it, so its result is still announced', () => {
  const { bridge, notices, control } = fakePi({ idle: false });
  bridge.adopt(`${VOICE_REQUEST}deploy the site`, 'Built it.');
  assert.equal(bridge.status().task, 'deploy the site');
  bridge.messageEnd({ role: 'assistant', content: [{ type: 'text', text: 'Deployed.' }] });
  control.idle = true;
  bridge.settled(false);
  assert.equal(notices.at(-1), 'I finished the task "deploy the site". My answer: Deployed.');
  const idle = fakePi();
  idle.bridge.adopt('old request', 'Last answer.');
  assert.equal(idle.bridge.status().last_result, 'Last answer.', 'an idle session only remembers the last answer');
  idle.bridge.settled(false);
  assert.equal(idle.notices.length, 0, 'nothing to announce');
});

test('stop and status phrases are matched narrowly', () => {
  const stop = ['stop', 'Stop that.', 'cancel it', 'never mind', 'please stop', 'abort the task!'];
  const notStop = ['stop the server and restart it', 'cancel my 3pm meeting in the calendar file', 'stop using tabs in config.ts'];
  const status = ['What is Pi doing?', 'what are you working on', "what're you up to?", "how's it going", 'is it done?', 'any progress', 'status'];
  const notStatus = ['what is Pi doing wrong in the parser? fix it', 'show the git status and commit everything that changed today'];
  const re = name => new RegExp(String(liveSource.match(new RegExp(`const ${name} = /(.*)/i;`))[1]), 'i');
  for (const text of stop) assert.ok(re('STOP_REQUEST').test(text), text);
  for (const text of notStop) assert.ok(!re('STOP_REQUEST').test(text), text);
  for (const text of status) assert.ok(re('STATUS_REQUEST').test(text), text);
  for (const text of notStatus) assert.ok(!re('STATUS_REQUEST').test(text), text);
});

test('Pi status reads as one sentence for the voice', () => {
  assert.equal(describeStatus({ state: 'idle' }), 'Nothing is running.');
  assert.equal(describeStatus({ state: 'idle', last_result: '9 files.' }), 'Nothing is running. My last answer: 9 files.');
  assert.equal(describeStatus({ state: 'waiting_for_approval', task: 'deploy' }), 'I\'m waiting for the user to answer a prompt in the terminal on "deploy".');
});

test('GPT-Live silence frames do not count as speech', () => {
  const quiet = Buffer.alloc(960); quiet.writeInt16LE(120, 10);
  const speech = Buffer.alloc(960); speech.writeInt16LE(-4000, 300);
  assert.equal(audibleFrame(quiet), false);
  assert.equal(audibleFrame(speech), true);
});

// ---------- Pi bridge (fake Pi host and context) ----------

function fakePi({ idle = true } = {}) {
  const sent = [], notices = [];
  let clock = 1_000_000;
  const control = { idle, aborted: 0, pending: false, isIdle() { return this.idle; }, abort() { this.aborted++; }, hasPendingMessages() { return this.pending; } };
  const bridge = new PiBridge({ sendUserMessage: (c, o) => sent.push([c, o]) }, control, text => notices.push(text), () => clock);
  return { bridge, sent, notices, control, tick: ms => { clock += ms; } };
}

test('ask_pi starts, steers, or queues depending on whether Pi is busy', () => {
  const { bridge, sent, control } = fakePi();
  assert.equal(bridge.call('ask_pi', { request: '  run the tests  ' }).status, 'started');
  assert.deepEqual(sent[0], ['run the tests', undefined]);
  control.idle = false;
  assert.equal(bridge.call('ask_pi', { request: 'only the voice tests', when: 'now' }).status, 'steered');
  assert.deepEqual(sent[1], ['only the voice tests', { deliverAs: 'steer' }]);
  const queued = bridge.call('ask_pi', { request: 'then update the README' });
  assert.deepEqual([queued.status, queued.position], ['queued', 1]);
  assert.deepEqual(sent[2], ['then update the README', { deliverAs: 'followUp' }]);
  assert.match(bridge.call('ask_pi', { request: '   ' }).error, /Empty/);
  assert.match(bridge.call('nope', {}).error, /Unknown tool/);
});

test('pi_status reports task, last tool, elapsed time, queue, and approval', () => {
  const { bridge, control, tick } = fakePi();
  assert.equal(bridge.status().state, 'idle');
  bridge.ask('run the tests', 'after');
  control.idle = false;
  bridge.agentStart();
  bridge.toolStart('bash', { command: 'npm   test' });
  bridge.messageEnd({ role: 'assistant', content: [{ type: 'text', text: 'Running the suite.' }, { type: 'toolCall' }] });
  bridge.ask('then lint', 'after');
  tick(42000);
  bridge.promptStart('Allow bash: npm test?');
  assert.deepEqual(bridge.status(), {
    state: 'waiting_for_approval', task: 'run the tests', elapsed_s: 42, last_tool: 'bash: npm test',
    latest_text: 'Running the suite.', queued: ['then lint'], approval: 'Allow bash: npm test?',
  });
  bridge.promptEnd();
  assert.equal(bridge.status().state, 'working');
});

test('Pi outcomes are announced for voice runs only', () => {
  const { bridge, notices, control } = fakePi();
  // A run started from the terminal is never announced.
  control.idle = false;
  bridge.agentStart();
  bridge.toolStart('read', { path: 'README.md' });
  bridge.settled(false);
  control.idle = true;
  assert.deepEqual(notices, []);
  // A voice run: the approval wait and the result are announced; tool activity is not.
  bridge.ask('fix the failing test.', 'after');
  control.idle = false;
  bridge.promptStart('Allow edit?');
  assert.deepEqual(notices, ['I\'m blocked until the user answers a prompt in the terminal: Allow edit?']);
  bridge.toolStart('edit', { path: 'audio.ts' });
  assert.equal(notices.length, 1);
  bridge.messageEnd({ role: 'assistant', content: [{ type: 'text', text: 'Fixed the off-by-one; 18 tests pass.' }] });
  bridge.settled(false);
  assert.equal(notices.at(-1), 'I finished the task "fix the failing test". My answer: Fixed the off-by-one; 18 tests pass.');
  control.idle = true;
  // Cancellation by voice aborts Pi; the voice model confirms it, so it is not announced again.
  bridge.ask('rebuild everything', 'after');
  control.idle = false;
  bridge.agentStart();
  control.pending = true;
  assert.deepEqual(bridge.cancel(), { status: 'cancelled', still_queued: true });
  assert.equal(control.aborted, 1);
  const before = notices.length;
  bridge.settled(true);
  assert.equal(notices.length, before);
  // An abort from the terminal (Escape) during a voice run is announced.
  control.idle = true;
  bridge.ask('rebuild everything', 'after');
  control.idle = false;
  bridge.agentStart();
  bridge.settled(true);
  assert.match(notices.at(-1), /^I stopped the task "rebuild everything" before finishing/);
  // After the voice session ends, nothing more is emitted.
  bridge.detach();
  bridge.ask('one more', 'after');
  bridge.settled(false);
  assert.match(notices.at(-1), /^I stopped/);
});

test('progress goes to the silent channel for voice runs only, at most every 3 s', () => {
  let clock = 1_000_000;
  const progress = [], control = { idle: true, isIdle() { return this.idle; }, abort() {}, hasPendingMessages: () => false };
  const bridge = new PiBridge({ sendUserMessage() {} }, control, () => {}, () => clock, text => progress.push(text));
  control.idle = false; bridge.agentStart(); bridge.toolStart('read', { path: 'x' });
  assert.deepEqual(progress, [], 'terminal-started runs stay private');
  bridge.settled(false); control.idle = true;
  bridge.ask('run the tests', 'after'); control.idle = false; bridge.agentStart();
  bridge.toolStart('bash', { command: 'npm test' });
  bridge.toolStart('read', { path: 'a.ts' });
  clock += 3000; bridge.toolStart('edit', { path: 'b.ts' });
  assert.deepEqual(progress, ['Progress on my task "run the tests": I just ran bash: npm test.', 'Progress on my task "run the tests": I just ran edit: b.ts.']);
});

test('tool descriptions are one bounded line', () => {
  assert.equal(describeTool('bash', { command: 'git\n  status' }), 'bash: git status');
  assert.equal(describeTool('custom', {}), 'custom');
  assert.ok(describeTool('bash', { command: 'x'.repeat(500) }).length <= 160);
});

test('echo cancellation defaults on and the helper binary is cached by source hash', () => {
  for (const [value, expected] of [[undefined, true], ['1', true], ['on', true], ['0', false], ['off', false], ['FALSE', false]]) {
    if (value === undefined) delete process.env.PI_VOICE_AEC; else process.env.PI_VOICE_AEC = value;
    assert.equal(aecEnabled(), expected);
  }
  assert.match(helperPath('/cache'), /^\/cache\/pi-voice\/voice-io-[0-9a-f]{12}$/);
});

test('session runs one helper: args, mic from stdout, route notices, flush/mute over fd 3, playout reports on fd 4', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-voice-io-'));
  const log = join(root, 'control.log');
  const helper = join(root, 'fake-voice-io');
  // Stand-in for VoiceIO: logs args, emits one 20ms 16 kHz frame and a route switch,
  // echoes its playout position on fd 4 (generation bumps on flush), logs control lines.
  await writeFile(helper, `#!/usr/bin/env node
const fs = require('node:fs');
const log = ${JSON.stringify(log)};
fs.appendFileSync(log, 'args ' + process.argv.slice(2).join(' ') + '\\n');
process.stderr.write('ready\\nroute {"input":"MacBook Pro Microphone","output":"AirPods"}\\n');
process.stdout.write(Buffer.alloc(640, 1));
let gen = 0, played = 0;
process.stdin.on('data', d => { played += d.length; fs.writeSync(4, 'played ' + gen + ' ' + played + '\\n'); });
fs.createReadStream(null, { fd: 3 }).on('data', d => {
  fs.appendFileSync(log, d);
  if (d.toString().includes('flush')) { gen += 1; played = 0; }
});
`);
  await chmod(helper, 0o755);
  delete process.env.PI_VOICE_AEC;
  const inputs = [], routes = [], settled = [];
  const pipes = new AudioPipes({
    input: f => inputs.push(f), output: () => {}, error: m => assert.fail(m), route: r => routes.push(r),
    played: f => settled.push(f),
  }, helper);
  // Synchronize on what the helper reports, not on wall-clock beats: under load its
  // startup can outlast any fixed timeout.
  const waitFor = async (check, what, ms = 5000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
      await new Promise(r => setTimeout(r, 20));
    }
  };
  try {
    pipes.start(16000, 24000);
    await waitFor(() => routes.length === 1 && inputs.length === 1, 'the helper to come up');
    await new Promise(r => setTimeout(r, 60)); // silence padding flows the whole session
    assert.equal(settled.length, 0, 'padding keeps the device fed but never settles');
    pipes.enqueue(Buffer.alloc(1920, 7)); // two real 20 ms frames
    assert.equal(settled.length, 0, 'nothing settles at write time');
    await waitFor(() => settled.length === 2, 'the device to report playing both frames');
    assert.ok(settled.every(f => f.length === 960));
    pipes.mute(true);
    pipes.interrupt(); // flush: audio dropped in the helper never settles
    pipes.mute(false);
    assert.equal(settled.length, 2, 'the flush settles nothing');
    pipes.enqueue(Buffer.alloc(960, 7));
    assert.equal(settled.length, 2, 'write time still settles nothing');
    await waitFor(() => settled.length === 3, 'the post-flush frame to settle against the new generation');
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].length, 640);
    assert.deepEqual(routes, [{ input: 'MacBook Pro Microphone', output: 'AirPods' }]);
    assert.equal(await readFile(log, 'utf8'), 'args session --in-rate 16000 --out-rate 24000 --aec on\nmute 1\nflush\nmute 0\n');
  } finally {
    pipes.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('user overrides merge into session.json and replace Markdown files', async () => {
  const user = await mkdtemp(join(tmpdir(), 'pi-voice-overrides-'));
  try {
    await writeFile(join(user, 'session.json'), JSON.stringify({ voice: { id: 'voice_custom', description: 'Calm baritone.' } }));
    const config = liveSessionConfig(providerFiles('openai-live', { user }));
    assert.equal(config.model, 'gpt-live-1'); // untouched keys keep the packaged default
    assert.deepEqual(config.audio.output, { voice: { id: 'voice_custom' } });
    assert.match(config.instructions, /<\|SpawnThinking\|>[\s\S]*\n\nVoice: Calm baritone\.$/);
  } finally { await rm(user, { recursive: true, force: true }); }
});

test('override directory follows PI_VOICE_CONFIG_DIR, then Pi\'s agent directory', () => {
  assert.equal(userConfigDir({ PI_VOICE_CONFIG_DIR: '/x/voice' }), '/x/voice');
  assert.equal(userConfigDir({ PI_CODING_AGENT_DIR: '/x/pi' }), '/x/pi/pi-voice');
  assert.match(userConfigDir({}), /\.pi\/agent\/pi-voice$/);
});

// ---------- Talk session: auto-pause and results across voice connections ----------

function fakeTalk({ idle = false, branch = [], changed } = {}) {
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

test('auto-pause closes voice after silence while Pi works, and Pi\'s result brings it back to say it', async () => {
  const { talk, voices, toasts, control, tick } = fakeTalk({ idle: false });
  talk.open();
  await voices[0].ready();
  tick(14_000);
  assert.equal(talk.connected, true, 'not yet');
  voices[0].hooks.activity(); // the user said something
  tick(14_000);
  assert.equal(talk.connected, true, 'activity resets the silence timer');
  tick(1_500);
  assert.deepEqual([talk.connected, talk.isPaused, voices[0].stopped], [false, true, 1]);
  assert.match(toasts.at(-1)[1], /paused while I work/);
  // Pi finishes: a new connection opens and says the result once it is ready.
  control.idle = true;
  talk.deliver('I finished the task "run the tests". My answer: 47 pass.');
  assert.equal(voices.length, 2);
  assert.deepEqual(voices[1].said, [], 'not before the session has started');
  await voices[1].ready();
  assert.deepEqual(voices[1].said, ['I finished the task "run the tests". My answer: 47 pass.']);
  talk.end();
});

test('while the voice speaks it is never paused; with nothing running the limit is longer', async () => {
  const { talk, voices, tick } = fakeTalk({ idle: true });
  talk.open();
  await voices[0].ready();
  voices[0].hooks.state('speaking');
  tick(120_000);
  assert.equal(talk.connected, true, 'speaking holds the connection');
  voices[0].hooks.state('listening');
  tick(59_000);
  assert.equal(talk.connected, true);
  tick(2_000);
  assert.deepEqual([talk.connected, talk.isPaused], [false, false], 'idle pause does not come back by itself');
  talk.end();
});

test('a lost connection while Pi works pauses voice, and Pi\'s result brings it back; with nothing running it stays closed', async () => {
  const { talk, voices, toasts, control } = fakeTalk({ idle: false });
  talk.open();
  await voices[0].ready();
  voices[0].hooks.dropped('OpenAI GPT-Live connection lost (1006).');
  assert.deepEqual([talk.connected, talk.isPaused, voices[0].stopped], [false, true, 1]);
  assert.deepEqual(toasts.at(-1), ['warning', 'OpenAI GPT-Live connection lost (1006). Voice comes back with the result. /talk start to speak sooner.']);
  control.idle = true;
  talk.deliver('I finished the task "sleep 15". My answer: done.');
  assert.equal(voices.length, 2);
  await voices[1].ready();
  assert.deepEqual(voices[1].said, ['I finished the task "sleep 15". My answer: done.']);
  voices[1].hooks.state('speaking'); // the result was said
  voices[1].hooks.dropped('OpenAI GPT-Live connection lost (1006).');
  assert.deepEqual([talk.connected, talk.isPaused], [false, false], 'nothing to wait for: no reconnect');
  assert.match(toasts.at(-1)[1], /\/talk start to talk again/);
  voices[0].hooks.dropped('stale');
  assert.equal(toasts.at(-1)[1].includes('stale'), false, 'an old connection is ignored');
  talk.end();
});

test('after /talk stop, a result waits and is said when voice opens again', async () => {
  const { talk, voices } = fakeTalk({ idle: false });
  talk.open();
  await voices[0].ready();
  talk.close();
  talk.deliver('I finished the deploy. My answer: it is live.');
  assert.equal(voices.length, 1, 'a user stop is not undone by a result');
  assert.equal(talk.waiting, 1);
  talk.open();
  await voices[1].ready();
  assert.deepEqual(voices[1].said, ['I finished the deploy. My answer: it is live.']);
  assert.equal(talk.waiting, 0);
  talk.end();
});

test('a talk session adopts a task already running and briefs each connection', async () => {
  const branch = [{ type: 'message', message: { role: 'user', content: `${VOICE_REQUEST}deploy the site` } }];
  const { talk, voices } = fakeTalk({ idle: false, branch });
  assert.equal(talk.bridge.status().task, 'deploy the site');
  talk.open();
  assert.match(voices[0].hooks.briefing(), /Right now I'm still working on "deploy the site"/);
  talk.end();
});

test('settings: env over "pi-voice" in Pi settings over defaults, with invalid values reported', () => {
  assert.deepEqual(resolveSettings(undefined, {}).values, DEFAULT_SETTINGS);
  assert.deepEqual(DEFAULT_SETTINGS, { autoPause: 15, idlePause: 60, echoCancellation: true, reducedMotion: false });
  const settings = { 'pi-voice': { autoPause: 30, idlePause: 0, echoCancellation: 'nope' }, defaultModel: 'x' };
  const fromSettings = resolveSettings(settings, {});
  assert.deepEqual(fromSettings.values, { autoPause: 30, idlePause: 0, echoCancellation: true, reducedMotion: false });
  assert.deepEqual(fromSettings.sources, { autoPause: 'settings', idlePause: 'settings', echoCancellation: 'default', reducedMotion: 'default' });
  assert.deepEqual(fromSettings.invalid, ['"pi-voice".echoCancellation: "nope"']);
  const fromEnv = resolveSettings(settings, { PI_VOICE_AUTOPAUSE: '5', PI_VOICE_AEC: '0', PI_VOICE_IDLE_PAUSE: 'soon', PI_VOICE_REDUCED_MOTION: 'on' });
  assert.deepEqual(fromEnv.values, { autoPause: 5, idlePause: 0, echoCancellation: false, reducedMotion: true });
  assert.deepEqual(fromEnv.sources, { autoPause: 'env', idlePause: 'settings', echoCancellation: 'env', reducedMotion: 'env' });
  assert.deepEqual(fromEnv.invalid, ['PI_VOICE_IDLE_PAUSE=soon', '"pi-voice".echoCancellation: "nope"']);
  assert.equal(resolveSettings({ 'pi-voice': { autoPause: -3 } }, {}).values.autoPause, 15, 'negative seconds fall back');
  assert.equal(describePause({ busy: 0, idle: 0 }), 'never (auto-pause is off)');
  assert.equal(describePause({ busy: 20, idle: 0 }), '20 s of silence while I work');
});

// ---------- /talk command surface ----------

test('/talk parses subcommands strictly and toggles with no argument', () => {
  assert.deepEqual(parseTalk(''), { name: 'toggle' });
  assert.deepEqual(parseTalk('  Start '), { name: 'start' });
  assert.deepEqual(parseTalk('mute'), { name: 'mute', value: undefined });
  assert.deepEqual(parseTalk('mute on'), { name: 'mute', value: true });
  assert.deepEqual(parseTalk('tone'), { name: 'tone', hz: 440 });
  assert.deepEqual(parseTalk('tone 1000'), { name: 'tone', hz: 1000 });
  assert.deepEqual(parseTalk('mic-test'), { name: 'mic-test', seconds: 3 });
  assert.deepEqual(parseTalk('preview'), { name: 'preview', state: 'story' });
  assert.deepEqual(parseTalk('preview speaking'), { name: 'preview', state: 'speaking' });
  assert.deepEqual(parseTalk('preview hearing'), { name: 'preview', state: 'hearing' });
  // Bad values are rejected with the usage, never silently replaced.
  for (const bad of ['tone abc', 'tone 0', 'tone 440.5', 'tones', 'mic-test 99', 'mic-test 2.5', 'mute maybe', 'stop now', 'preview loud', 'captions', 'mute on off']) {
    assert.equal(parseTalk(bad).name, 'error', bad);
  }
  assert.match(parseTalk('tone 0').message, /Use \/talk tone \[20-20000\]/);
  assert.match(parseTalk('strat').message, /Did you mean \/talk start\?/);
  assert.match(parseTalk('xyzzy').message, /See \/talk help/);
});

test('/talk completes subcommands, then their values', () => {
  assert.deepEqual(talkCompletions('').map(item => item.label), TALK_COMMANDS.map(command => command.name));
  assert.deepEqual(talkCompletions('m').map(item => item.value), ['mute ', 'mic-test ']);
  assert.deepEqual(talkCompletions('st').map(item => item.value), ['start', 'stop']);
  assert.deepEqual(talkCompletions('mute ').map(item => item.value), ['mute on', 'mute off']);
  assert.deepEqual(talkCompletions('preview sp').map(item => item.value), ['preview speaking']);
  assert.equal(talkCompletions('stop '), null);
  assert.equal(talkCompletions('zz'), null);
});

test('shortcuts come from pi-voice actions in Pi\'s keybindings.json', async () => {
  assert.deepEqual(resolveShortcuts(undefined), DEFAULT_SHORTCUTS);
  assert.deepEqual(resolveShortcuts({ 'pi-voice.toggle': 'Ctrl+Shift+V', 'pi-voice.mute': [] }), { toggle: ['ctrl+shift+v'], mute: [] });
  assert.deepEqual(resolveShortcuts({ 'pi-voice.toggle': ['alt+v', 'f5'], 'pi-voice.mute': 7 }), { toggle: ['alt+v', 'f5'], mute: DEFAULT_SHORTCUTS.mute });
  assert.equal(keybindingsPath({ PI_CODING_AGENT_DIR: '/x/pi' }), '/x/pi/keybindings.json');
  const dir = await mkdtemp(join(tmpdir(), 'pi-voice-keys-'));
  try {
    await writeFile(join(dir, 'keybindings.json'), '﻿{"app.model.select": "ctrl+l", "pi-voice.mute": "alt+shift+m"}');
    assert.deepEqual(loadShortcuts(join(dir, 'keybindings.json')), { toggle: DEFAULT_SHORTCUTS.toggle, mute: ['alt+shift+m'] });
    await writeFile(join(dir, 'broken.json'), '{');
    assert.deepEqual(loadShortcuts(join(dir, 'broken.json')), DEFAULT_SHORTCUTS);
    assert.match(talkHelp(DEFAULT_SHORTCUTS), /alt\+v: start or stop voice \(pi-voice\.toggle\)/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the talk session reports connection, pause, and results to say', async () => {
  let changes = 0;
  const { talk, voices, control, tick } = fakeTalk({ idle: false, changed: () => changes++ });
  talk.open();
  assert.equal(changes, 1, 'opened');
  await voices[0].ready();
  tick(15_000);
  assert.equal(talk.isPaused, true);
  const paused = changes;
  assert.ok(paused >= 2, 'closed and paused');
  control.idle = true;
  talk.close();
  talk.deliver('done');
  assert.ok(changes > paused, 'a result waiting');
  talk.end();
});

// ---------- Spoken history and the caption board ----------

test('each finished exchange is written once: the user\'s words, then the reply as far as it was heard', async () => {
  const originalWS = globalThis.WebSocket;
  try {
    const transcripts = [];
    const { voice, socket, output, played } = await startLive({ transcripts });
    const frame = (pcm = voiced(1)) => { output(pcm, true); played(pcm); };
    socket.event({ type: 'session.input_transcript.delta', delta: 'run the', start_ms: 0, end_ms: 100 });
    socket.event({ type: 'session.input_transcript.delta', delta: ' tests', start_ms: 100, end_ms: 200 });
    socket.event({ type: 'session.output_transcript.delta', delta: '[warm] On it.', start_ms: 300, end_ms: 500 });
    socket.event({ type: 'session.output_audio.delta', delta: voiced(10).toString('base64') });
    for (let i = 0; i < 10; i++) frame();
    assert.deepEqual(transcripts, [], 'nothing before the exchange is over');
    // The user talks again: the finished exchange is written before the new turn.
    socket.event({ type: 'session.input_transcript.delta', delta: 'and lint', start_ms: 900, end_ms: 1000 });
    assert.deepEqual(transcripts, [['user', 'run the tests', false], ['voice', 'On it.', false]]);
    // A long reply cut off a quarter of the way in keeps only what was heard.
    socket.event({ type: 'session.output_transcript.delta', delta: 'The migration touched every handler in the payments service.', start_ms: 1100, end_ms: 1900 });
    socket.event({ type: 'session.output_audio.delta', delta: voiced(20).toString('base64') });
    for (let i = 0; i < 5; i++) frame();
    socket.event({ type: 'session.input_transcript.delta', delta: 'wait', start_ms: 1300, end_ms: 1400 });
    assert.deepEqual(transcripts.slice(2), [['user', 'and lint', false], ['voice', 'The migration…', true]]);
    // Stopping writes what is left.
    voice.stop();
    assert.deepEqual(transcripts.slice(4), [['user', 'wait', false]]);
  } finally { globalThis.WebSocket = originalWS; }
});

test('a quiet moment after the voice speaks writes the exchange; a handoff and its acknowledgement are not', async () => {
  const originalWS = globalThis.WebSocket;
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const transcripts = [];
    const live = startLive({ transcripts });
    mock.timers.tick(0);
    const { voice, socket, output, played } = await live;
    // Thinking aloud (no handoff), answered by the voice, then a request it hands to Pi.
    socket.event({ type: 'session.input_transcript.delta', delta: 'the parser is slow', start_ms: 0, end_ms: 300 });
    socket.event({ type: 'session.output_transcript.delta', delta: 'Want me to profile it?', start_ms: 400, end_ms: 600 });
    socket.event({ type: 'session.input_transcript.delta', delta: 'yes profile it', start_ms: 800, end_ms: 1000 });
    assert.deepEqual(transcripts, [['user', 'the parser is slow', false], ['voice', 'Want me to profile it?', false]]);
    socket.event({ type: 'session.delegation.created', delegation: { id: 'del_1' }, offset_ms: 1000 });
    assert.deepEqual(transcripts.at(-1), ['user', '', false], 'the request\'s live line closes as Pi\'s message takes over');
    mock.timers.tick(1300);
    assert.equal(kept(transcripts).length, 2, 'Pi\'s message shows the request; it is not written again');
    socket.event({ type: 'session.output_transcript.delta', delta: 'Fixing it now.', start_ms: 1100, end_ms: 1400 });
    socket.event({ type: 'session.output_audio.delta', delta: voiced(5).toString('base64') });
    for (let i = 0; i < 5; i++) { output(voiced(1), true); played(voiced(1)); }
    mock.timers.tick(300);
    output(Buffer.alloc(960), true); // silence: playback has drained
    mock.timers.tick(1300);
    assert.equal(kept(transcripts).length, 2, 'the acknowledgement of a handoff is not kept');
    voice.stop();
    assert.equal(kept(transcripts).length, 2, 'nothing is kept later either');
  } finally { mock.timers.reset(); globalThis.WebSocket = originalWS; }
});

test('a cut-off reply keeps whole words', () => {
  assert.equal(heardPart('All tests pass.', 1), 'All tests pass.');
  assert.equal(heardPart('All tests pass, nothing else changed.', 0.5), 'All tests pass…');
  assert.equal(heardPart('All tests pass.', 0.1), '');
});

test('the caption board flips new letters, then settles them with a glow; unchanged letters stay still', () => {
  const board = new FlapBoard();
  const at = (text, now) => board.tiles(text, now);
  const text = tiles => tiles.map(t => t.text).join('');
  const first = at('Done.', 1000);
  assert.equal(text(first).length, 5);
  assert.equal(first[0].state, 'flip');
  const flipping = at('Done.', 1100);
  assert.notEqual(text(flipping).slice(0, 4), 'Done', 'letters show other glyphs while flipping');
  assert.deepEqual(at('Done.', 1000 + FLAP_SETTLE_MS + 60), [{ text: 'Done.', state: 'glow' }]);
  assert.deepEqual(at('Done.', 1000 + FLAP_SETTLE_MS + FLAP_GLOW_MS + 60), [{ text: 'Done.', state: 'still' }]);
  // A longer line keeps the shared start still; only the new letters flip.
  const grown = at('Done. Next', 2000);
  assert.deepEqual(grown[0], { text: 'Done. ', state: 'still' });
  assert.ok(grown.slice(1).some(t => t.state === 'flip'));
  assert.deepEqual(at('', 2100), []);
  // A line wider than the bar slides along: carried-over words stay still, only the new word flips.
  at('…testing the synchronisation between…', 3000);
  const line = '…the synchronisation between voices…';
  const slid = at(line, 3000 + 500 + FLAP_SETTLE_MS + FLAP_GLOW_MS + 60); // after the first line's stagger
  const states = slid.flatMap(t => [...t.text].map(() => t.state));
  const state = word => states[line.indexOf(word)];
  assert.deepEqual([state('the'), state('synchronisation'), state('between')], ['still', 'still', 'still'], 'carried-over words stay still');
  assert.equal(state('voices'), 'flip', 'only the new word flips');
});

test('the briefing includes what was said aloud, without repeating requests Pi already has', () => {
  const spoken = (role, text) => ({ type: 'custom', customType: SPOKEN_ENTRY, data: { role, text } });
  const text = sessionBriefing([
    spoken('user', 'what does the parser do with tabs?'), spoken('voice', 'It expands them to two spaces.'),
    { type: 'message', message: { role: 'user', content: `${VOICE_REQUEST}make it four` } },
    spoken('user', 'make it four'), spoken('voice', 'On it.'),
  ], {});
  assert.match(text, /- The user \(said to me\): what does the parser do with tabs\?\n- Me \(said aloud\): It expands them to two spaces\.\n- The user \(spoken\): make it four\n- Me \(said aloud\): On it\.\n/);
});

test('the voice reading out Pi\'s result is not written again under Pi\'s answer', async () => {
  const originalWS = globalThis.WebSocket;
  try {
    const transcripts = [];
    const { voice, socket, output, played } = await startLive({ transcripts });
    const say = (text, from) => {
      socket.event({ type: 'session.output_transcript.delta', delta: text, start_ms: from, end_ms: from + 100 });
      socket.event({ type: 'session.output_audio.delta', delta: voiced(5).toString('base64') });
      for (let i = 0; i < 5; i++) { output(voiced(1), true); played(voiced(1)); }
    };
    voice.notify('I finished the task "check the repo". My answer: four packages, no algorithms yet.');
    say('Four packages, no algorithms yet.', 0);
    socket.event({ type: 'session.input_transcript.delta', delta: 'what next', start_ms: 500, end_ms: 600 });
    assert.deepEqual(transcripts, [['voice', '', false]], 'the read-out is not kept');
    say('A small working example.', 700);
    socket.event({ type: 'session.input_transcript.delta', delta: 'ok', start_ms: 1000, end_ms: 1100 });
    assert.deepEqual(transcripts.slice(1), [['user', 'what next', false], ['voice', 'A small working example.', false]], 'later replies are kept');
    voice.stop();
  } finally { globalThis.WebSocket = originalWS; }
});

test('the user\'s words play in the chat as they are heard; nothing said while Pi works is shown or kept', async () => {
  const originalWS = globalThis.WebSocket;
  try {
    let busy = false;
    const transcripts = [], lives = [];
    const { voice, socket, output, played } = await startLive({ transcripts, lives, busy: () => busy });
    socket.event({ type: 'session.input_transcript.delta', delta: 'how is it', start_ms: 0, end_ms: 100 });
    socket.event({ type: 'session.input_transcript.delta', delta: ' going', start_ms: 100, end_ms: 200 });
    assert.deepEqual(lives, [['user', 'how is it'], ['user', 'how is it going']]);
    // The voice's reply plays in as its audio does.
    socket.event({ type: 'session.output_transcript.delta', delta: 'Fine.', start_ms: 300, end_ms: 400 });
    socket.event({ type: 'session.output_audio.delta', delta: voiced(5).toString('base64') });
    for (let i = 0; i < 5; i++) { output(voiced(1), true); played(voiced(1)); }
    assert.deepEqual(lives.at(-1), ['voice', 'Fine.']);
    // Pi starts working: nothing more plays in the chat, and nothing more is kept.
    busy = true;
    lives.length = 0;
    socket.event({ type: 'session.input_transcript.delta', delta: 'status?', start_ms: 700, end_ms: 800 });
    socket.event({ type: 'session.output_transcript.delta', delta: 'Still on the tests.', start_ms: 900, end_ms: 1100 });
    socket.event({ type: 'session.output_audio.delta', delta: voiced(5).toString('base64') });
    for (let i = 0; i < 5; i++) { output(voiced(1), true); played(voiced(1)); }
    voice.stop();
    assert.deepEqual(lives, []);
    assert.deepEqual(kept(transcripts), [['user', 'how is it going', false], ['voice', 'Fine.', false]]);
  } finally { globalThis.WebSocket = originalWS; }
});

test('the chat transcript: a turn plays in, settles, joins Pi\'s conversation, and redraws on resume', () => {
  let clock = 1000;
  const appended = [], sent = [];
  const chat = new SpokenChat({ append: t => appended.push(t), send: m => sent.push(m) }, () => clock);
  const theme = { fg: (_c, t) => t, bg: (_c, t) => t, italic: t => t };
  chat.live('user', 'what is');
  chat.live('user', 'what is next');
  assert.equal(appended.length, 1, 'one placeholder per turn');
  const placeholder = appended[0];
  assert.equal(placeholder.role, 'user');
  const live = chat.component(placeholder.id, theme);
  assert.notEqual(live.render(40)[1].trimEnd(), ' what is next', 'new letters flip in first');
  clock += 2000;
  assert.deepEqual(live.render(40).map(l => l.trimEnd()), ['', ' what is next', ''], 'then settle, on the typed-message band');
  chat.settle('user', 'what is next', false);
  assert.deepEqual(sent, [{ customType: SPOKEN_MESSAGE, content: spokenContent('user', 'what is next'), display: false, details: { id: placeholder.id, role: 'user', text: 'what is next' } }]);
  assert.match(sent[0].content, /^Voice conversation \(context, not a request\), the user said: what is next$/);
  // A voice turn cut off by the user, wrapped to the width.
  chat.live('voice', 'Start with a small working example');
  chat.settle('voice', 'Start with a small…', true);
  const voiceLines = chat.component(appended[1].id, theme).render(16);
  assert.deepEqual(voiceLines, [' Start with a', ' small…'], 'like assistant text');
  // A turn that keeps nothing (a request handed to Pi) is not drawn again and not sent.
  chat.live('user', 'make it four');
  chat.settle('user', '', false);
  assert.equal(chat.component(appended[2].id, theme), undefined);
  assert.equal(sent.length, 2);
  // Resumed: placeholders redraw from their messages.
  const resumed = new SpokenChat({ append() {}, send() {} });
  resumed.load([{ type: 'custom_message', customType: SPOKEN_MESSAGE, details: sent[1].details }]);
  assert.deepEqual(resumed.component(appended[1].id, theme).render(16), voiceLines);
  assert.equal(resumed.component(appended[2].id, theme), undefined, 'a dropped turn stays hidden');
});

test('words wrap at spaces, and a word longer than the width is split', () => {
  const text = 'the rhythm of the voice and the pace';
  assert.deepEqual(wrapWords(text, 12).map(([a, b]) => text.slice(a, b)), ['the rhythm', 'of the voice', 'and the pace']);
  assert.deepEqual(wrapWords('abcdefgh', 3).map(([a, b]) => 'abcdefgh'.slice(a, b)), ['abc', 'def', 'gh']);
});

test('the briefing reads spoken turns saved in Pi\'s conversation', () => {
  const said = (role, text) => ({ type: 'custom_message', customType: SPOKEN_MESSAGE, details: { id: role + text, role, text } });
  const text = sessionBriefing([said('user', 'is the parser slow?'), said('voice', 'A little, on big files.')], {});
  assert.match(text, /- The user \(said to me\): is the parser slow\?\n- Me \(said aloud\): A little, on big files\./);
});

test('the user\'s last word arriving after the reply began joins the user\'s turn instead of splitting it', async () => {
  const originalWS = globalThis.WebSocket;
  LATE_WORDS.ms = 1500;
  try {
    const transcripts = [];
    const { voice, socket, output, played } = await startLive({ transcripts });
    // Timing that does not show the word as late on the session clock (as seen live).
    socket.event({ type: 'session.input_transcript.delta', delta: "How's it", start_ms: 0, end_ms: 300 });
    socket.event({ type: 'session.output_transcript.delta', delta: 'Quite well', start_ms: 100, end_ms: 400 });
    socket.event({ type: 'session.output_audio.delta', delta: voiced(10).toString('base64') });
    output(voiced(1), true); played(voiced(1));
    socket.event({ type: 'session.input_transcript.delta', delta: ' going', start_ms: 350, end_ms: 500 });
    socket.event({ type: 'session.output_transcript.delta', delta: ', thank you.', start_ms: 400, end_ms: 700 });
    for (let i = 0; i < 9; i++) { output(voiced(1), true); played(voiced(1)); }
    voice.stop();
    assert.deepEqual(transcripts, [['user', "How's it going", false], ['voice', 'Quite well, thank you.', false]]);
  } finally { LATE_WORDS.ms = 0; globalThis.WebSocket = originalWS; }
});

test('a read-out of Pi\'s result that pauses mid-way stays hidden to the end; a reply that pauses settles once, whole', async () => {
  const originalWS = globalThis.WebSocket;
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const transcripts = [], lives = [];
    const live = startLive({ transcripts, lives });
    mock.timers.tick(0);
    const { voice, socket, output, played } = await live;
    let at = 0;
    const say = (text, frames = 5) => {
      socket.event({ type: 'session.output_transcript.delta', delta: text, start_ms: at, end_ms: at + 100 * frames });
      socket.event({ type: 'session.output_audio.delta', delta: voiced(frames).toString('base64') });
      for (let i = 0; i < frames; i++) { output(voiced(1), true); played(voiced(1)); }
      at += 100 * frames;
    };
    // A pause plays silence (the speaker keeps reporting frames), then nothing for a while.
    const pause = ms => { for (let i = 0; i < 15; i++) { mock.timers.tick(20); output(Buffer.alloc(960), true); played(Buffer.alloc(960)); } mock.timers.tick(ms); };
    voice.notify('I finished the task "check the repo". My answer: lots in motion.');
    say('A lot is in motion,');
    pause(1300); // a quiet stretch mid-read-out: the part so far closes, kept as nothing
    say(' with spoken turns going into the app.');
    pause(1300);
    assert.deepEqual(lives.filter(([role]) => role === 'voice'), [], 'no part of the read-out plays in the chat');
    assert.deepEqual(kept(transcripts), []);
    // The user speaks: the next reply is shown again. Its transcript runs ahead of the audio over a pause.
    socket.event({ type: 'session.input_transcript.delta', delta: 'give me a long sentence', start_ms: at, end_ms: at + 300 });
    at += 400;
    socket.event({ type: 'session.output_transcript.delta', delta: 'As the words arrive, one after another, you may notice the rhythm.', start_ms: at, end_ms: at + 600 });
    socket.event({ type: 'session.output_audio.delta', delta: voiced(5).toString('base64') });
    for (let i = 0; i < 5; i++) { output(voiced(1), true); played(voiced(1)); }
    pause(1300);
    assert.equal(kept(transcripts).length, 0, 'the exchange waits: the reply is not over');
    socket.event({ type: 'session.output_audio.delta', delta: voiced(25).toString('base64') });
    for (let i = 0; i < 25; i++) { output(voiced(1), true); played(voiced(1)); }
    pause(1300);
    assert.deepEqual(kept(transcripts), [['user', 'give me a long sentence', false], ['voice', 'As the words arrive, one after another, you may notice the rhythm.', false]]);
    voice.stop();
  } finally { mock.timers.reset(); globalThis.WebSocket = originalWS; }
});

// ---------- The read-out stands in for Pi's answer ----------

test('a short answer without code, lists, tables, or headings can be read out in its place', () => {
  assert.equal(speakable('All 22 parser tests pass; tabs are four spaces now.'), true);
  assert.equal(speakable('Changed `parser.ts`: tabs are **four** spaces.'), true);
  for (const text of ['Run:\n```sh\nnpm test\n```', 'Two things:\n- the parser\n- the lexer', '| a | b |\n|---|---|', '## Summary\nDone.', 'x'.repeat(601), '']) {
    assert.equal(speakable(text), false, JSON.stringify(text.slice(0, 20)));
  }
  const message = text => ({ role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text }] });
  assert.deepEqual(answerBlocks(message(' Done. ')), ['Done.']);
  assert.equal(answerBlocks({ ...message('Checking.'), stopReason: 'toolUse' }), undefined, 'not while it calls tools');
  assert.equal(answerBlocks({ role: 'user', content: 'hi' }), undefined);
});

test('the read-out plays in where Pi\'s answer was, under Pi\'s written answer collapsed like a thinking block', () => {
  let clock = 1000, speaking = true;
  const appended = [], saved = [], sent = [];
  const chat = new SpokenChat({ append: t => appended.push(t), send: m => sent.push(m), save: r => saved.push(r), speaking: () => speaking }, () => clock);
  const theme = { fg: (_c, t) => t, bg: (_c, t) => t, italic: t => t };
  const blocks = ['Tabs are **four** spaces now; all 22 parser tests pass.'];
  chat.hide(blocks);
  assert.equal(chat.hidden(blocks[0]), true, 'Pi\'s text is hidden');
  assert.equal(chat.hidden('Something else.'), false);
  const id = chat.answer(blocks);
  assert.deepEqual(appended, [{ id, role: 'voice', answer: [answerHash(blocks[0])] }]);
  const component = chat.component(id, theme);
  assert.deepEqual(component.render(80), [], 'the voice is about to say it');
  clock += 9000;
  assert.deepEqual(component.render(80), [' Tabs are four spaces now; all 22 parser tests pass.'], 'no read-out in time: Pi\'s text');
  // The read-out plays in, pauses, goes on, and settles: saved for the chat only.
  chat.live('voice', 'Tabs are four spaces now,', id);
  chat.settle('voice', 'Tabs are four spaces now,', false, id);
  chat.live('voice', 'and the tests pass.', id);
  component.render(80); // the new words start flipping in
  clock += 2000;
  const readout = ' Tabs are four spaces now, and the tests pass.', written = ' Tabs are four spaces now; all 22 parser tests pass.';
  assert.deepEqual(component.render(80), [' Written answer', '', readout]);
  chat.settle('voice', 'and the tests pass.', false, id);
  assert.deepEqual(saved.at(-1), { id, text: 'Tabs are four spaces now, and the tests pass.' });
  assert.deepEqual(sent, [], 'not sent to Pi: it has its answer');
  // A click on the label opens Pi's written answer; another closes it. Ctrl+O opens it too.
  const click = y => component.handleMouse({ type: 'click', button: 'left', x: 2, y, screenX: 2, screenY: y, width: 80, height: 3, shift: false, alt: false, ctrl: false });
  click(0);
  assert.deepEqual(component.render(80), [written, '', readout]);
  click(0);
  assert.deepEqual(component.render(80), [' Written answer', '', readout]);
  assert.deepEqual(chat.component(id, theme, true).render(80), [written, '', readout], 'Ctrl+O');
  // An answer no read-out will come for (voice stopped) shows Pi's text.
  speaking = false;
  const unread = chat.answer(['Done.']);
  assert.deepEqual(chat.component(unread, theme).render(80), [' Done.']);
  // Resumed: the read-out redraws, Pi's text stays hidden; an answer never read shows Pi's text.
  const resumed = new SpokenChat({ append() {}, send() {}, save() {}, speaking: () => false });
  resumed.load([
    { type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: blocks[0] }] } },
    { type: 'custom', customType: SPOKEN_TURN, data: appended[0] },
    { type: 'custom', customType: SPOKEN_READOUT, data: saved.at(-1) },
    { type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Done.' }] } },
    { type: 'custom', customType: SPOKEN_TURN, data: appended[1] },
  ]);
  assert.equal(resumed.hidden(blocks[0]), true);
  assert.deepEqual(resumed.component(id, theme).render(80), [' Written answer', '', ' Tabs are four spaces now, and the tests pass.']);
  assert.deepEqual(resumed.component(unread, theme).render(80), [' Done.']);
});

test('a read-out of Pi\'s answer plays in its placeholder and is not kept in Pi\'s conversation; other read-outs stay hidden', async () => {
  const originalWS = globalThis.WebSocket;
  try {
    const transcripts = [], lives = [];
    const { voice, socket, output, played } = await startLive({ transcripts, lives });
    const say = (text, from) => {
      socket.event({ type: 'session.output_transcript.delta', delta: text, start_ms: from, end_ms: from + 100 });
      socket.event({ type: 'session.output_audio.delta', delta: voiced(5).toString('base64') });
      for (let i = 0; i < 5; i++) { output(voiced(1), true); played(voiced(1)); }
    };
    voice.notify('I finished the task "check". My answer: all good.', 'answer-1');
    say('All good.', 0);
    socket.event({ type: 'session.input_transcript.delta', delta: 'thanks', start_ms: 500, end_ms: 600 });
    assert.deepEqual(lives.filter(([role]) => role === 'voice').at(-1), ['voice', 'All good.', 'answer-1']);
    assert.deepEqual(transcripts, [['voice', 'All good.', false, 'answer-1']]);
    // A notice without an answer (e.g. a stopped task) is still not shown.
    voice.notify('I stopped the task before finishing.');
    say('I stopped it.', 700);
    socket.event({ type: 'session.input_transcript.delta', delta: 'ok', start_ms: 1000, end_ms: 1100 });
    assert.ok(lives.every(([, text]) => !text.includes('stopped')), 'not shown');
    voice.stop();
  } finally { globalThis.WebSocket = originalWS; }
});

test('the bridge hands the answer\'s placeholder to the read-out of a finished voice run, not a stopped one', () => {
  const notices = [];
  const bridge = new PiBridge({ sendUserMessage() {} }, { isIdle: () => true, abort() {}, hasPendingMessages: () => false }, (text, answer) => notices.push([text, answer]));
  bridge.call('ask_pi', { request: `${VOICE_REQUEST}check the repo`, when: 'now' });
  bridge.agentStart();
  assert.equal(bridge.voiceRun, true);
  bridge.messageEnd({ role: 'assistant', content: [{ type: 'text', text: 'All good.' }] });
  bridge.settled(false, 'answer-1');
  assert.equal(notices.at(-1)[1], 'answer-1');
  assert.equal(bridge.voiceRun, false);
  bridge.call('ask_pi', { request: `${VOICE_REQUEST}again`, when: 'now' });
  bridge.settled(true, 'answer-2');
  assert.equal(notices.at(-1)[1], undefined, 'a stopped run reads out no answer');
});

test('Pi\'s result reaches the voice without URLs, and IDs count as the dense tokens they are', () => {
  const answer = 'Storm Luise: [ka-news reports disruptions](https://news.google.com/rss/articles/CBMi0gFBVV95cUx0OcDNFaE9jTF9HTWxNZnRyWEp0ZnZFT?oc=5); see https://ka-news.de/x and <https://bnn.de/y>.';
  assert.equal(forSpeech(answer), 'Storm Luise: ka-news reports disruptions; see (link) and (link).');
  const id = 'CBMi0gFBVV95cUx0OcDNFaE9jTF9HTWxNZnRyWEp0ZnZFTEhfNHFmZVN0TGdRdXpLeEFVTnJmNFdnOTB1Uk9ONkJVTzRHV0VGWXVOeldfZTVPTmZjbzFWZGhPYTE0dlB'.repeat(20);
  assert.ok(clipTokens(id, 400).length < 1000, 'base64 is clipped long before 1,600 characters');
  assert.equal(clipTokens('plain words stay cheap', 400), 'plain words stay cheap');
});

test('a read-out reaches its placeholder through the talk session hooks', () => {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  assert.match(source, /live: \(role, text, answer\) => chat\.live\(role, text, answer\)/);
  assert.match(source, /transcript: \(role, text, interrupted, answer\) => \{\s*chat\.settle\(role, text, interrupted, answer\);/);
});

// ---------- The voice bar's motion ----------

const facts = (over = {}) => ({ connection: 'open', paused: false, busy: false, speaking: false, hearing: false, ...over });
// Runs a motion at 30 fps from `from` to `to` ms, returning the last frame.
function run(motion, from, to, f, input = new Meter(), output = new Meter()) {
  let frame;
  for (let now = from; now <= to; now += 1000 / 30) frame = motion.frame(now, 80, typeof f === 'function' ? f(now) : f, input, output);
  return frame;
}

test('the facts decide the bar: whoever talks owns it, the user over the voice, then Pi\'s work', () => {
  assert.equal(barState(facts({ connection: 'connecting', hearing: true })), 'connecting');
  assert.equal(barState(facts({ connection: 'closed' })), 'off');
  assert.equal(barState(facts({ connection: 'closed', paused: true, busy: true })), 'paused');
  assert.equal(barState(facts({ hearing: true, speaking: true, busy: true })), 'hearing', 'the voice yields');
  assert.equal(barState(facts({ speaking: true, busy: true })), 'speaking');
  assert.equal(barState(facts({ busy: true })), 'working');
  assert.equal(barState(facts()), 'listening');
});

test('each change takes its own time: reactions are fast, big changes slower', () => {
  assert.equal(transitionMs('speaking', 'hearing', ['interrupt']), 80);
  assert.equal(transitionMs('listening', 'hearing', []), 120);
  assert.equal(transitionMs('hearing', 'listening', []), 300);
  assert.equal(transitionMs('listening', 'working', ['handoff']), 500);
  assert.equal(transitionMs('working', 'speaking', []), 400);
  assert.equal(transitionMs('working', 'paused', []), 600);
  assert.equal(transitionMs('listening', 'error', []), 80);
  assert.equal(transitionMs('error', 'listening', []), 400);
  assert.equal(transitionMs('listening', 'speaking', []), 250);
});

test('drift profiles: constant flow, a sway with no net flow, ramps, flinches, and a breath that settles', () => {
  assert.equal(DRIFT.constant(0.1)(5, 0), 0.1);
  const sway = DRIFT.sine(0.05, 0.2);
  let x = 0;
  for (let t = 0; t < 5; t += 0.001) x += sway(t, 0) * 0.001;
  assert.ok(Math.abs(x) < 1e-3, 'a full sway period returns to where it started');
  assert.equal(DRIFT.ramp(0.08, 600)(0, 0), 0);
  assert.equal(DRIFT.ramp(0.08, 600)(1, 0), 0.08);
  assert.ok(Math.abs(DRIFT.damped(0.6, 3, 0.25)(2, 0)) < 0.001);
  assert.equal(DRIFT.fade(DRIFT.constant(1), 1000)(1.5, 0), 0);
  assert.equal(DRIFT.follow(0.05, 0.15)(0, 1), 0.2);
  assert.ok(STATES.hearing.drift(0, 1) < 0, 'your speech flows leftward, in');
  assert.ok(STATES.speaking.drift(0, 1) > 0, 'the voice flows rightward, out');
  assert.ok(STATES.working.drift(0, 0) > 0, 'Pi\'s work moves steadily rightward');
});

test('drift is a speed across the bar, whatever the carrier density', () => {
  const motion = new BarMotion();
  run(motion, 0, 2000, facts({ busy: true }));
  const { positions } = motion.snapshot();
  // 0.07 bar widths per second for ~1.6 s (after the 250 ms transition from off ramps the weight in).
  assert.ok(positions.working > 0.1 && positions.working < 0.16, String(positions.working));
});

test('changing state never makes the wave jump: weights ease over the transition, carriers keep their place', () => {
  const motion = new BarMotion();
  run(motion, 0, 1000, facts({ busy: true }));
  const before = motion.snapshot().positions.working;
  motion.event('tool', 1000);
  run(motion, 1000, 1010, facts({ speaking: true }));
  const mid = motion.snapshot();
  assert.ok(mid.weights.working > 0.9 && mid.weights.speaking < 0.1, 'the new state comes in gradually');
  assert.ok(mid.positions.working - before < 0.01, 'no jump in the old carrier');
  run(motion, 1010, 1500, facts({ speaking: true }));
  assert.equal(motion.snapshot().weights.speaking, 1);
});

test('events: a handoff sweeps the carriers toward the work, a tool call kicks them, a settled turn ripples', () => {
  const motion = new BarMotion();
  run(motion, 0, 1000, facts());
  const start = motion.snapshot().shared;
  motion.event('handoff', 1000);
  run(motion, 1000, 1500, facts({ busy: true }));
  const swept = motion.snapshot().shared - start;
  assert.ok(Math.abs(swept - 0.35) < 0.01, `sweep ${swept}`);
  motion.event('tool', 1500);
  run(motion, 1500, 3500, facts({ busy: true }));
  const kicked = motion.snapshot().shared - start - swept;
  assert.ok(Math.abs(kicked - 0.45 * 0.3) < 0.02, `kick ${kicked}`);
  // A ripple raises the trace at the centre for a moment.
  const quiet = new BarMotion(), rippled = new BarMotion();
  run(quiet, 0, 2000, facts()); run(rippled, 0, 2000, facts());
  rippled.event('settled', 2000);
  const dots = frame => frame.rows.flat().reduce((n, mask) => n + mask.toString(2).replace(/0/g, '').length, 0);
  assert.ok(dots(run(rippled, 2000, 2040, facts())) > dots(run(quiet, 2000, 2040, facts())));
});

test('muted dashes and dims the bar, and freezes its breath', () => {
  const motion = new BarMotion();
  const frame = run(motion, 0, 1500, facts({ muted: true }));
  assert.equal(frame.muted, 1);
  const filled = frame.rows[1].map(mask => mask !== 0);
  assert.ok(filled.slice(0, 40).some(x => !x) && filled.slice(0, 40).some(x => x), 'gaps in the trace');
  const at = motion.snapshot().positions.listening;
  run(motion, 1500, 3000, facts({ muted: true }));
  assert.equal(motion.snapshot().positions.listening, at, 'nothing flows while muted');
});

test('an error flinches red, then the bar returns to its state', () => {
  const motion = new BarMotion();
  run(motion, 0, 1000, facts());
  motion.event('error', 1000);
  assert.equal(run(motion, 1000, 1100, facts()).state, 'error');
  assert.equal(run(motion, 1100, 1000 + ERROR_MS + 50, facts()).state, 'listening');
});

test('the bar rests when nothing changes: the breath settles, a paused bar only pulses, reduced motion holds still', () => {
  const motion = new BarMotion();
  run(motion, 0, 1000, facts());
  assert.equal(motion.moving(1000, facts()), true, 'breathing');
  run(motion, 1000, BREATH_MS + 1000, facts());
  assert.equal(motion.moving(BREATH_MS + 1000, facts()), false, 'settled');
  assert.equal(motion.moving(BREATH_MS + 1000, facts({ busy: true })), true, 'a change of state moves');
  const paused = new BarMotion();
  run(paused, 0, 1000, facts({ connection: 'closed', paused: true }));
  assert.equal(paused.moving(PAUSE_PULSE_MS * 2 + 400, facts({ connection: 'closed', paused: true })), true, 'in a pulse');
  assert.equal(paused.moving(PAUSE_PULSE_MS * 2 + 2500, facts({ connection: 'closed', paused: true })), false, 'between pulses');
  const reduced = new BarMotion({ reducedMotion: () => true });
  run(reduced, 0, 1000, facts({ busy: true }));
  assert.equal(reduced.snapshot().positions.working, 0, 'no drift');
  assert.equal(reduced.moving(1000, facts({ busy: true })), false);
});

test('a meter drops to silence fast when the user talks over the voice', () => {
  const meter = new Meter();
  for (let i = 0; i < 30; i++) meter.set(1, 300, 1 / 30, i * 33);
  assert.ok(meter.level > 0.95);
  const slow = new Meter(); Object.assign(slow, { level: meter.level });
  meter.cut(1000);
  meter.set(0, 300, 0.05, 1000); slow.set(0, 300, 0.05, 1000);
  assert.ok(meter.level < 0.25 && slow.level > 0.7, `${meter.level} vs ${slow.level}`);
});

test('the story plays every state and fires its events once per loop', () => {
  const seen = new Set();
  const events = [];
  let previous = 0;
  for (let ms = 0; ms <= STORY_MS * 2; ms += 50) {
    const { step, events: fired } = storyAt(ms, previous);
    seen.add(barState(step.facts) + (step.muted ? '+muted' : ''));
    events.push(...fired);
    previous = ms;
  }
  for (const state of ['connecting', 'listening', 'hearing', 'working', 'speaking', 'paused', 'listening+muted']) assert.ok(seen.has(state), state);
  const count = name => events.filter(e => e === name).length;
  assert.deepEqual([count('handoff'), count('tool'), count('interrupt'), count('error'), count('settled')], [2, 4, 2, 2, 4], 'two loops');
});

test('the chat says when it is moving, so the bar can rest otherwise', () => {
  let clock = 0;
  const chat = new SpokenChat({ append() {}, send() {}, save() {}, speaking: () => true }, () => clock);
  assert.equal(chat.animating(), false);
  chat.live('user', 'hello');
  assert.equal(chat.animating(), true, 'words playing in');
  chat.settle('user', 'hello', false);
  assert.equal(chat.animating(), false);
  chat.answer(['Done.']);
  assert.equal(chat.animating(), true, 'an answer waiting for its read-out');
  clock += 9000;
  assert.equal(chat.animating(), false);
});

// ---------- The voice bar on screen: what the dots do ----------

// The trace's height (mean dot row, 0-11) at each half-column; -1 where nothing is drawn.
function trace(frame) {
  const columns = frame.rows[0].length, out = [];
  const left = [1, 2, 4, 64], right = [8, 16, 32, 128];
  for (let sample = 0; sample < columns * 2; sample++) {
    const bits = sample % 2 ? right : left, col = Math.floor(sample / 2), dots = [];
    for (let r = 0; r < 3; r++) bits.forEach((bit, k) => { if (frame.rows[r][col] & bit) dots.push(r * 4 + k); });
    out.push(dots.length ? dots.reduce((a, b) => a + b, 0) / dots.length : -1);
  }
  return out;
}
// The shift (in half-columns) that best carries trace `a` onto trace `b` within the beam (positive: rightward).
function shift(a, b) {
  const n = a.length, from = Math.round(n * 0.3), to = Math.round(n * 0.7);
  let best = 0, bestErr = Infinity;
  for (let k = -8; k <= 8; k++) {
    let err = 0;
    for (let i = from; i < to; i++) err += Math.abs(b[i] - a[i - k]);
    if (err < bestErr - 1e-9) { bestErr = err; best = k; }
  }
  return best;
}
// Holds a voice at a fixed level and pitch for `ms`, at 30 fps; returns the last frame.
function hold(motion, from, ms, f, { input = new Meter(), output = new Meter(), level = 0.8, hz = 200, source } = {}) {
  let frame;
  for (let now = from; now <= from + ms; now += 1000 / 30) {
    if (source === 'input') input.set(level, hz, 1 / 30, now);
    if (source === 'output') output.set(level, hz, 1 / 30, now);
    frame = motion.frame(now, 80, f, input, output);
  }
  return { frame, input, output };
}

test('on screen, the voice and Pi\'s work flow right, your voice flows left, and a handoff sweeps right', () => {
  const flow = (f, source, ms) => {
    const motion = new BarMotion();
    const { input, output } = hold(motion, 0, 2000, f, { source });
    const a = trace(hold(motion, 2000 + 1000 / 30, 0, f, { source, input, output }).frame);
    const b = trace(hold(motion, 2000 + 1000 / 30 + ms, 0, f, { source, input, output }).frame);
    return shift(a, b);
  };
  assert.ok(flow(facts({ speaking: true }), 'output', 100) > 0, 'speaking: right');
  assert.ok(flow(facts({ busy: true }), undefined, 300) > 0, 'working: right');
  assert.ok(flow(facts({ hearing: true }), 'input', 100) < 0, 'hearing: left');
  const motion = new BarMotion();
  hold(motion, 0, 2000, facts({ busy: true }));
  const before = trace(motion.frame(2000, 80, facts({ busy: true }), new Meter(), new Meter()));
  motion.event('handoff', 2000);
  motion.frame(2033, 80, facts({ busy: true }), new Meter(), new Meter());
  const after = trace(motion.frame(2066, 80, facts({ busy: true }), new Meter(), new Meter()));
  assert.ok(shift(before, after) > 0, 'handoff: right');
});

test('on screen, the drift is the same speed across the bar at a low and a high pitch', () => {
  const speed = hz => {
    const motion = new BarMotion();
    const { input, output } = hold(motion, 0, 2000, facts({ speaking: true }), { source: 'output', hz });
    const a = trace(hold(motion, 2033, 0, facts({ speaking: true }), { source: 'output', hz, input, output }).frame);
    const b = trace(hold(motion, 2133, 0, facts({ speaking: true }), { source: 'output', hz, input, output }).frame);
    return shift(a, b);
  };
  const low = speed(100), high = speed(1000);
  assert.ok(low > 0 && high > 0, `${low} ${high}`);
  assert.ok(Math.abs(low - high) <= 1, `${low} vs ${high} half-columns in 100 ms`);
});

test('a changing pitch zooms about the bar\'s centre: no flicker after a long reply and many handoffs', () => {
  const motion = new BarMotion(), output = new Meter();
  for (let k = 0; k < 6; k++) motion.event('handoff', k * 400);
  for (let k = 0; k < 20; k++) motion.event('tool', 2400 + k * 100);
  let previous, worst = 0, overall = 0;
  for (let now = 0; now <= 30000; now += 1000 / 30) {
    output.set(0.8, 150 * Math.pow(2, 2 * Math.sin(now / 700)), 1 / 30, now); // a voice gliding over two octaves
    motion.frame(now, 80, facts({ speaking: true }), new Meter(), output);
    const phase = motion.snapshot().phases.speaking;
    if (previous !== undefined) {
      const d = Math.abs(phase - previous), step = Math.min(d, 1 - d);
      overall = Math.max(overall, step);
      if (now > 8000) worst = Math.max(worst, step); // the kicks have died down
    }
    previous = phase;
  }
  assert.ok(motion.snapshot().shared > 3, 'carriers far from where they started');
  assert.ok(worst < 0.1, `centre phase moves at most ${worst.toFixed(3)} cycles a frame`);
  assert.ok(overall <= 0.41, `even during sweeps, at most ${overall.toFixed(3)} cycles a frame (one direction stays readable)`);
});

test('a state fading out keeps its own clock: leaving an error does not flare, leaving connecting does not collapse', () => {
  const height = frame => { const t = trace(frame).filter(y => y >= 0); return Math.max(...t) - Math.min(...t); };
  const motion = new BarMotion();
  hold(motion, 0, 1000, facts());
  motion.event('error', 1000);
  let peakAfter = 0, beforeExit = 0;
  for (let now = 1000; now <= 1000 + ERROR_MS + 450; now += 1000 / 30) {
    const h = height(motion.frame(now, 80, facts(), new Meter(), new Meter()));
    if (now < 1000 + ERROR_MS && now > 1000 + ERROR_MS - 100) beforeExit = h;
    if (now >= 1000 + ERROR_MS) peakAfter = Math.max(peakAfter, h);
  }
  assert.ok(peakAfter <= beforeExit + 1, `exit ${peakAfter} vs ${beforeExit} just before`);
  const connecting = new BarMotion();
  const plateau = height(hold(connecting, 0, 1500, facts({ connection: 'connecting' })).frame);
  const first = height(connecting.frame(1533, 80, facts(), new Meter(), new Meter()));
  assert.ok(first >= plateau - 1, `connecting fades out (${first} vs ${plateau}), it does not drop`);
});

test('reversing a transition mid-way starts from where the bar is', () => {
  const motion = new BarMotion();
  hold(motion, 0, 1000, facts({ busy: true }));
  hold(motion, 1000, 133, facts({ speaking: true }));
  const mid = motion.snapshot().weights;
  assert.ok(mid.speaking > 0 && mid.speaking < 1, 'mid-way');
  motion.frame(1166, 80, facts({ busy: true }), new Meter(), new Meter());
  const back = motion.snapshot().weights;
  assert.ok(Math.abs(back.speaking - mid.speaking) < 0.08 && Math.abs(back.working - mid.working) < 0.08, 'no jump on reversal');
});

test('when the bar says it is still, the next frame is the same; a pending mute is motion', () => {
  const motion = new BarMotion();
  hold(motion, 0, BREATH_MS + 1500, facts());
  const now = BREATH_MS + 1600;
  assert.equal(motion.moving(now, facts()), false);
  const a = motion.frame(now, 80, facts(), new Meter(), new Meter()).rows;
  const b = motion.frame(now + 33, 80, facts(), new Meter(), new Meter()).rows;
  assert.deepEqual(a, b);
  assert.equal(motion.moving(now + 33, facts({ muted: true })), true, 'muting moves the bar');
});

test('reduced motion holds still shapes: no drift, no pitch, no impulses', () => {
  const motion = new BarMotion({ reducedMotion: () => true });
  const input = new Meter();
  hold(motion, 0, 500, facts({ hearing: true }), { source: 'input', input });
  motion.event('handoff', 500); motion.event('tool', 520); motion.event('settled', 540);
  const frames = [];
  for (let now = 533; now < 1500; now += 1000 / 30) {
    input.set(0.3 + 0.6 * Math.abs(Math.sin(now / 90)), 150 + now, 1 / 30, now); // level and pitch sweeping
    frames.push(motion.frame(now, 80, facts({ hearing: true }), input, new Meter()).rows);
  }
  assert.ok(frames.every(rows => JSON.stringify(rows) === JSON.stringify(frames[0])), 'every frame the same');
  assert.equal(motion.snapshot().shared, 0);
});

test('a second error flinches again; the ripple stays at the centre; reset starts from rest', () => {
  const motion = new BarMotion();
  hold(motion, 0, 1000, facts());
  motion.event('error', 1000);
  hold(motion, 1000, 700, facts());
  const late = motion.snapshot();
  motion.event('error', 1700);
  motion.frame(1733, 80, facts(), new Meter(), new Meter());
  assert.equal(motion.snapshot().state, 'error');
  assert.ok(EVENTS.settled.swell.width < 0.1);
  const quiet = new BarMotion(), rippled = new BarMotion();
  hold(quiet, 0, 2000, facts()); hold(rippled, 0, 2000, facts());
  rippled.event('settled', 2000);
  const q = trace(quiet.frame(2033, 80, facts(), new Meter(), new Meter())), r = trace(rippled.frame(2033, 80, facts(), new Meter(), new Meter()));
  assert.deepEqual(r.slice(0, 40), q.slice(0, 40), 'the edges are untouched');
  assert.notDeepEqual(r.slice(70, 90), q.slice(70, 90), 'the centre ripples');
  motion.reset();
  assert.equal(motion.snapshot().state, 'off');
  assert.equal(motion.snapshot().weights.off, 1);
  assert.ok(late);
});

test('live facts: connecting, paused, Pi\'s work, and your voice but never the voice\'s own echo', () => {
  const base = { connected: true, ready: true, talking: true, idle: true, voiceState: 'listening', lastHeardAt: -Infinity, now: 10000, muted: false };
  const f = over => liveFacts({ ...base, ...over });
  assert.equal(barState(f({ ready: false })), 'connecting');
  assert.equal(barState(f({ connected: false })), 'paused');
  assert.equal(barState(f({ connected: false, talking: false })), 'off');
  assert.equal(barState(f({ idle: false })), 'working');
  assert.equal(barState(f({ voiceState: 'speaking' })), 'speaking');
  assert.equal(barState(f({ voiceState: 'speaking', lastHeardAt: 9990 })), 'speaking', 'echo while it speaks is not you');
  assert.equal(barState(f({ lastHeardAt: 10000 - HEARD_HOLD_MS + 1 })), 'hearing');
  assert.equal(barState(f({ lastHeardAt: 10000 - HEARD_HOLD_MS - 1 })), 'listening');
  assert.equal(f({ muted: true }).muted, true);
  assert.equal(f({ muted: true, connected: false }).muted, false, 'a closed connection shows paused, not dashes');
});

test('the voice marks a handoff and an interruption for the bar', async () => {
  const originalWS = globalThis.WebSocket;
  try {
    const events = [];
    const { voice, socket, output, played } = await startLive({ events, tool: () => ({ status: 'started' }) });
    socket.event({ type: 'session.input_transcript.delta', delta: 'run the tests', start_ms: 0, end_ms: 300 });
    socket.event({ type: 'session.delegation.created', delegation: { id: 'd1' }, offset_ms: 300 });
    assert.deepEqual(events, ['handoff']);
    socket.event({ type: 'session.output_transcript.delta', delta: 'On it, running them now.', start_ms: 400, end_ms: 900 });
    socket.event({ type: 'session.output_audio.delta', delta: voiced(10).toString('base64') });
    output(voiced(1), true); played(voiced(1));
    socket.event({ type: 'session.input_transcript.delta', delta: 'wait', start_ms: 1000, end_ms: 1100 });
    assert.deepEqual(events, ['handoff', 'interrupt']);
    voice.stop();
  } finally { globalThis.WebSocket = originalWS; }
});

test('a voice that cannot start (no API key) says why, instead of going quiet', async () => {
  const states = [], errors = [];
  let closed = 0;
  const voice = new LiveVoice({ state: s => states.push(s), samples() {}, error: e => errors.push(e), closed: () => closed++, tool: () => ({}), busy: () => false }, () => ({ start() {}, enqueue() {}, finish() {}, interrupt() {}, mute() {}, stop() {} }));
  await voice.start(() => { throw new Error('No OpenAI API key available.'); });
  assert.deepEqual(errors, ['No OpenAI API key available.']);
  assert.equal(states.at(-1), 'error');
  assert.equal(closed, 1);
});

test('with reduced motion the chat shows words without flipping them in', () => {
  const appended = [];
  const theme = { fg: (_c, t) => t, bg: (_c, t) => t, italic: t => t };
  const still = new SpokenChat({ append: t => appended.push(t), send() {}, save() {}, speaking: () => true, still: () => true }, () => 0);
  still.live('voice', 'Tabs are four spaces now.');
  assert.deepEqual(still.component(appended[0].id, theme).render(80), [' Tabs are four spaces now.'], 'the first frame already shows the words');
  const moving = new SpokenChat({ append: t => appended.push(t), send() {}, save() {}, speaking: () => true }, () => 0);
  moving.live('voice', 'Tabs are four spaces now.');
  assert.notDeepEqual(moving.component(appended[1].id, theme).render(80), [' Tabs are four spaces now.'], 'without it, they flip in');
});

test('an answer waits up to its limit for a read-out, then the chat stops animating for it', () => {
  let clock = 0;
  const chat = new SpokenChat({ append() {}, send() {}, save() {}, speaking: () => true }, () => clock);
  chat.answer(['Done.']);
  clock = 7900; assert.equal(chat.animating(), true);
  clock = 8150; assert.equal(chat.animating(), true, 'one last frame shows Pi\'s text');
  clock = 8300; assert.equal(chat.animating(), false);
});

test('story events fire at their step\'s offset', () => {
  let at = 0;
  const expected = [];
  for (const step of STORY) { for (const [event, offset] of step.events ?? []) expected.push([event, at + offset]); at += step.ms; }
  const fired = [];
  let previous = -1;
  for (let ms = 0; ms < STORY_MS; ms += 10) { for (const e of storyAt(ms, previous).events) fired.push([e, ms]); previous = ms; }
  assert.equal(fired.length, expected.length);
  fired.forEach(([event, ms], i) => { assert.equal(event, expected[i][0]); assert.ok(ms - expected[i][1] >= 0 && ms - expected[i][1] < 10, `${event} at ${ms}, due ${expected[i][1]}`); });
});

test('events never run backwards, even if the clock does or reduced motion turns on mid-sweep', () => {
  const motion = new BarMotion();
  hold(motion, 0, 1000, facts({ busy: true }));
  motion.event('handoff', 1000);
  hold(motion, 1000, 200, facts({ busy: true }));
  const mid = motion.snapshot().shared;
  motion.frame(900, 80, facts({ busy: true }), new Meter(), new Meter()); // the clock steps back
  assert.ok(motion.snapshot().shared >= mid, 'no rewind');
  let reduced = false;
  const switching = new BarMotion({ reducedMotion: () => reduced });
  hold(switching, 0, 1000, facts({ busy: true }));
  switching.event('handoff', 1000);
  hold(switching, 1000, 200, facts({ busy: true }));
  const before = switching.snapshot().shared;
  reduced = true;
  switching.frame(1233, 80, facts({ busy: true }), new Meter(), new Meter());
  assert.ok(Math.abs(switching.snapshot().shared - before) < 0.05, 'it stops where it is');
});

test('a pitch tracker jumping octaves changes the density gradually', () => {
  const meter = new Meter();
  for (let i = 0; i < 30; i++) meter.set(0.8, 100, 1 / 30, i * 33);
  const low = meter.cycles;
  meter.set(0.8, 3000, 1 / 30, 1000);
  assert.ok(meter.cycles - low <= 1.3, `${(meter.cycles - low).toFixed(2)} cycles in one frame`);
});
