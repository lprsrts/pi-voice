import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Hermetic provider config: never pick up the developer's own overrides.
process.env.PI_VOICE_CONFIG_DIR = join(tmpdir(), 'pi-voice-test-no-overrides');
import { PcmFramer, waveform, dominantFrequency, clipTokens, phraseAt, formatCaption, voicedMs, Captions } from '../protocol.ts';
import { PiBridge, describeTool, VOICE_REQUEST } from '../pi-bridge.ts';
import { resolveApiKey, apiKeyStatus, provisionCommand, OPENAI_KEY } from '../keys.ts';
// A neutral short key for the keychain tests (OpenAI keys are the long kind).
const TEST_KEY = { service: 'test-api-key', env: 'PI_VOICE_TEST_API_KEY', label: 'Test API key' };
import { LiveVoice, liveSessionConfig, audibleFrame, describeStatus } from '../live.ts';
import { PROVIDER } from '../providers.ts';
import { providerFiles, userConfigDir } from '../config.ts';
import { AudioPipes, parseRoute, pcmStats } from '../audio.ts';
import { aecEnabled, helperPath } from '../native.ts';

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

async function startLive({ tool = () => ({ ok: true }), busy = () => false } = {}) {
  const audio = { enqueued: [], interrupts: 0, muted: [], stopped: 0 };
  const errors = [], captions = [];
  let audioHooks;
  globalThis.WebSocket = FakeSocket;
  const voice = new LiveVoice({ state() {}, samples() {}, error: e => errors.push(e), caption: l => captions.push(l.phrase), closed() {}, tool, busy }, hooks => {
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
    voice.context('Pi is working on "run the tests"; it just ran bash: npm test.');
    assert.equal(lastOf(socket, 'session.thinking.append').delegation_id, 'd1');
    voice.notify('Pi finished the task. Pi\'s answer: 47 pass, none fail.');
    assert.deepEqual([lastOf(socket, 'session.commentary.append').delegation_id, lastOf(socket, 'session.commentary.append').content], ['d1', 'Pi finished the task. Pi\'s answer: 47 pass, none fail.']);
    // The next delegation takes only what was said after the first one.
    socket.event({ type: 'session.input_transcript.delta', delta: 'Then commit.', start_ms: 5000, end_ms: 5600 });
    socket.event({ type: 'session.delegation.created', offset_ms: 5700, delegation: { id: 'd2', type: 'delegation', target: 'client' } });
    await settle();
    // It is short, so it carries what the voice said before it (not after).
    assert.match(calls[1][1].request, /: Then commit\.\n\(Just before, the user said: "Run the tests in the voice repo\.", then the voice assistant said: "On it\."\)$/);
    assert.ok(socket.sent.every(e => typeof e.event_id === 'string'), 'every client event carries an event_id');
    voice.stop();
  } finally { globalThis.WebSocket = originalWS; }
});

test('Pi status and notices name the spoken words, not the voice framing', () => {
  const { bridge, sent, notices, control } = fakePi();
  bridge.call('ask_pi', { request: `${VOICE_REQUEST}Yes, do it.\n(Just before, the voice assistant said: "Shall Pi fix it?")` });
  assert.equal(sent[0][0].startsWith(VOICE_REQUEST), true, 'Pi itself gets the framing');
  control.idle = false;
  assert.equal(bridge.status().task, 'Yes, do it.');
  bridge.settled(false);
  assert.match(notices[0], /^Pi finished the task "Yes, do it"/);
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

test('a short reply reaches Pi with what the voice had just said', async () => {
  const originalWS = globalThis.WebSocket;
  try {
    const calls = [];
    const { voice, socket } = await startLive({ tool: (name, args) => { calls.push([name, args]); return { status: 'started' }; } });
    socket.event({ type: 'session.output_transcript.delta', delta: 'The build fails on a missing import. Shall Pi fix it?', start_ms: 0, end_ms: 2000 });
    socket.event({ type: 'session.input_transcript.delta', delta: 'Yes, do it.', start_ms: 2500, end_ms: 3000 });
    socket.event({ type: 'session.delegation.created', offset_ms: 3100, delegation: { id: 'd1' } });
    await settle();
    assert.match(calls[0][1].request, /Yes, do it\.\n\(Just before, the voice assistant said: "The build fails on a missing import\. Shall Pi fix it\?"\)$/);
    voice.stop();
  } finally { globalThis.WebSocket = originalWS; }
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
    assert.equal(lastOf(socket, 'session.commentary.append').content, 'Pi is working on "run the tests" for 42 seconds; last step: bash: npm test.');
    socket.event({ type: 'session.input_transcript.delta', delta: 'Stop that.', start_ms: 1000, end_ms: 1500 });
    socket.event({ type: 'session.delegation.created', delegation: { id: 'd2' } });
    await settle();
    assert.deepEqual(calls, ['pi_status', 'cancel_pi']);
    assert.deepEqual([lastOf(socket, 'session.commentary.append').delegation_id, lastOf(socket, 'session.commentary.append').content], ['d2', "Pi's task is cancelled."]);
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

test('stop and status phrases are matched narrowly', () => {
  const stop = ['stop', 'Stop that.', 'cancel it', 'never mind', 'please stop', 'abort the task!'];
  const notStop = ['stop the server and restart it', 'cancel my 3pm meeting in the calendar file', 'stop using tabs in config.ts'];
  const status = ['What is Pi doing?', "how's it going", 'is it done?', 'any progress', 'status'];
  const notStatus = ['what is Pi doing wrong in the parser? fix it', 'show the git status and commit everything that changed today'];
  const re = name => new RegExp(String(liveSource.match(new RegExp(`const ${name} = /(.*)/i;`))[1]), 'i');
  for (const text of stop) assert.ok(re('STOP_REQUEST').test(text), text);
  for (const text of notStop) assert.ok(!re('STOP_REQUEST').test(text), text);
  for (const text of status) assert.ok(re('STATUS_REQUEST').test(text), text);
  for (const text of notStatus) assert.ok(!re('STATUS_REQUEST').test(text), text);
});

test('Pi status reads as one sentence for the voice', () => {
  assert.equal(describeStatus({ state: 'idle' }), 'Pi is idle.');
  assert.equal(describeStatus({ state: 'waiting_for_approval', task: 'deploy' }), 'Pi is waiting for the user to answer a prompt in the terminal on "deploy".');
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
  assert.deepEqual(notices, ['Pi is waiting for the user to answer a prompt in the terminal: Allow edit?']);
  bridge.toolStart('edit', { path: 'audio.ts' });
  assert.equal(notices.length, 1);
  bridge.messageEnd({ role: 'assistant', content: [{ type: 'text', text: 'Fixed the off-by-one; 18 tests pass.' }] });
  bridge.settled(false);
  assert.equal(notices.at(-1), 'Pi finished the task "fix the failing test". Pi\'s answer: Fixed the off-by-one; 18 tests pass.');
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
  assert.match(notices.at(-1), /^Pi stopped the task "rebuild everything" before finishing/);
  // After the voice session ends, nothing more is emitted.
  bridge.detach();
  bridge.ask('one more', 'after');
  bridge.settled(false);
  assert.match(notices.at(-1), /^Pi stopped/);
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
  assert.deepEqual(progress, ['Pi is working on "run the tests"; it just ran bash: npm test.', 'Pi is working on "run the tests"; it just ran edit: b.ts.']);
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
