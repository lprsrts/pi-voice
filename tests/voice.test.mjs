import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Hermetic provider config: never pick up the developer's own overrides.
process.env.PI_VOICE_CONFIG_DIR = join(tmpdir(), 'pi-voice-test-no-overrides');
import { PcmFramer, waveform, dominantFrequency, phraseAt, formatCaption, voicedMs, Captions } from '../protocol.ts';
import { RealtimeVoice, sessionConfig } from '../realtime.ts';
import { PiBridge, PI_TOOLS, describeTool } from '../pi-bridge.ts';
import { resolveApiKey, apiKeyStatus, provisionCommand, ELEVENLABS_KEY, OPENAI_KEY } from '../keys.ts';
import { LiveVoice, liveSessionConfig, audibleFrame } from '../live.ts';
import { selectProvider, PROVIDERS } from '../providers.ts';
import { providerFiles, userConfigDir } from '../config.ts';
import { AudioPipes, parseRoute, pcmStats } from '../audio.ts';
import { aecEnabled, helperPath } from '../native.ts';

// No real credentials, network, microphone, speakers, or shell execution in tests.
const originalKeyEnv = process.env.ELEVENLABS_API_KEY;
const originalAec = process.env.PI_VOICE_AEC;
after(() => {
  if (originalKeyEnv === undefined) delete process.env.ELEVENLABS_API_KEY;
  else process.env.ELEVENLABS_API_KEY = originalKeyEnv;
  if (originalAec === undefined) delete process.env.PI_VOICE_AEC;
  else process.env.PI_VOICE_AEC = originalAec;
});
const signal = new AbortController().signal;

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
// login-keychain item elevenlabs-api-key, service-only lookup like ollama-api-key.
test('key resolution prefers the env override without touching the keychain', async () => {
  process.env.ELEVENLABS_API_KEY = 'sk_env_override';
  const key = await resolveApiKey(ELEVENLABS_KEY, signal, { platform: 'darwin', call: async () => { throw new Error('keychain must not be queried'); } });
  assert.equal(key, 'sk_env_override');
});
test('key resolution reads the convention item, trims the secret, and forwards the abort signal', async () => {
  delete process.env.ELEVENLABS_API_KEY;
  const key = await resolveApiKey(ELEVENLABS_KEY, signal, { platform: 'darwin', call: async (args, opts) => {
    assert.deepEqual(args, ['find-generic-password', '-s', 'elevenlabs-api-key', '-w']);
    assert.equal(opts.signal, signal);
    assert.ok(opts.timeout > 0);
    return { stdout: 'sk_test\n', stderr: '' };
  }});
  assert.equal(key, 'sk_test');
});
test('missing keychain item maps to the provisioning command', async () => {
  delete process.env.ELEVENLABS_API_KEY;
  const failure = Object.assign(new Error('not found'), { code: 44, stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' });
  await assert.rejects(
    () => resolveApiKey(ELEVENLABS_KEY, signal, { platform: 'darwin', call: async () => { throw failure; } }),
    /add-generic-password -U -s "elevenlabs-api-key" -a "\$USER"/
  );
});
test('denied or headless keychain reads fail with a clear reason', async () => {
  delete process.env.ELEVENLABS_API_KEY;
  await assert.rejects(
    () => resolveApiKey(ELEVENLABS_KEY, signal, { platform: 'darwin', call: async () => { throw Object.assign(new Error('x'), { stderr: 'security: SecKeychainSearchCopyNext: User interaction is not allowed.' }); } }),
    /denied|GUI terminal/
  );
});
test('corrupted or empty keychain secrets are rejected', async () => {
  delete process.env.ELEVENLABS_API_KEY;
  for (const stdout of ['\n', 'sk bad\n']) {
    await assert.rejects(
      () => resolveApiKey(ELEVENLABS_KEY, signal, { platform: 'darwin', call: async () => ({ stdout, stderr: '' }) }),
      /empty or malformed/
    );
  }
});
test('non-darwin platforms fail closed without the env override', async () => {
  delete process.env.ELEVENLABS_API_KEY;
  await assert.rejects(() => resolveApiKey(ELEVENLABS_KEY, signal, { platform: 'linux', call: async () => ({ stdout: '', stderr: '' }) }), /ELEVENLABS_API_KEY/);
  assert.match(await apiKeyStatus(ELEVENLABS_KEY, { platform: 'linux' }), /missing/);
});
test('status reports the source without ever reading the secret', async () => {
  process.env.ELEVENLABS_API_KEY = 'sk_env_override';
  assert.match(await apiKeyStatus(ELEVENLABS_KEY), /env override/);
  delete process.env.ELEVENLABS_API_KEY;
  assert.match(await apiKeyStatus(ELEVENLABS_KEY, { platform: 'darwin', call: async args => {
    assert.ok(!args.includes('-w')); // presence check only
    return { stdout: '', stderr: '' };
  }}), /present/);
  assert.match(await apiKeyStatus(ELEVENLABS_KEY, { platform: 'darwin', call: async () => { throw Object.assign(new Error('nf'), { code: 44 }); } }), /add-generic-password/);
});

test('long keys provision through the clipboard and a 128-character key is reported as truncated', async () => {
  assert.match(provisionCommand(OPENAI_KEY), /-w "\$\(pbpaste\)" && pbcopy <\/dev\/null/);
  assert.doesNotMatch(provisionCommand(ELEVENLABS_KEY), /pbpaste/);
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(
    () => resolveApiKey(OPENAI_KEY, signal, { platform: 'darwin', call: async args => { assert.deepEqual(args.slice(0, 3), ['find-generic-password', '-s', 'openai-api-key']); return { stdout: 'sk-proj-' + 'x'.repeat(120) + '\n', stderr: '' }; } }),
    /truncated/
  );
  assert.equal(await resolveApiKey(OPENAI_KEY, signal, { platform: 'darwin', call: async () => ({ stdout: 'sk-proj-' + 'x'.repeat(156), stderr: '' }) }), 'sk-proj-' + 'x'.repeat(156));
});

test('provider selection: argument over PI_VOICE_PROVIDER over the default', () => {
  const original = process.env.PI_VOICE_PROVIDER;
  try {
    delete process.env.PI_VOICE_PROVIDER;
    assert.equal(selectProvider().name, 'elevenlabs');
    process.env.PI_VOICE_PROVIDER = 'openai-live';
    assert.equal(selectProvider().name, 'openai-live');
    assert.equal(selectProvider('ElevenLabs').name, 'elevenlabs');
    assert.throws(() => selectProvider('gemini'), /Unknown voice provider "gemini". Available: elevenlabs, openai-live/);
    assert.deepEqual(Object.values(PROVIDERS).map(p => p.key.service), ['elevenlabs-api-key', 'openai-api-key']);
  } finally {
    if (original === undefined) delete process.env.PI_VOICE_PROVIDER; else process.env.PI_VOICE_PROVIDER = original;
  }
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
// ---------- Eleven Realtime session (fake socket, no network or audio) ----------

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

async function startVoice({ tool = () => ({ ok: true }), busy = () => false } = {}) {
  const audio = { enqueued: [], finishes: 0, interrupts: 0, muted: [], stopped: 0 };
  const errors = [], states = [], captions = [];
  let mint, audioHooks;
  globalThis.WebSocket = FakeSocket;
  globalThis.fetch = async (url, init) => { mint = { url, init }; return { ok: true, json: async () => ({ value: 'ek_test_secret' }) }; };
  const voice = new RealtimeVoice({ state: s => states.push(s), samples() {}, error: e => errors.push(e), caption: l => captions.push(l.phrase), closed() {}, tool, busy }, hooks => {
    audioHooks = hooks;
    return { start: (i, o) => assert.deepEqual([i, o], [24000, 24000]), enqueue: b => audio.enqueued.push(b), finish: () => audio.finishes++,
      interrupt: () => audio.interrupts++, mute: v => audio.muted.push(v), stop: () => audio.stopped++ };
  });
  const started = voice.start(() => 'test-not-a-real-key');
  await new Promise(r => setImmediate(r));
  const socket = FakeSocket.last;
  socket.event({ type: 'session.created', session: {} });
  await started;
  return { voice, socket, audio, errors, states, mint, captions, input: f => audioHooks.input(f), output: (f, a) => audioHooks.output(f, a), played: f => audioHooks.played(f) };
}

test('ElevenLabs session config comes from providers/elevenlabs/ with the Pi tools', () => {
  const config = sessionConfig();
  assert.equal(config.model, 'eleven_realtime_v1_max');
  assert.match(config.instructions, /ask_pi/);
  assert.deepEqual(config.tools.map(t => t.name), ['ask_pi', 'pi_status', 'cancel_pi']);
  assert.deepEqual(config.audio.input.format, { type: 'audio/pcm', rate: 24000 });
  assert.equal(config.audio.input.turn_detection.interrupt_response, true);
});

test('start mints a scoped client secret and authenticates the socket with it, not the API key', async () => {
  const originalFetch = globalThis.fetch, originalWS = globalThis.WebSocket;
  try {
    const { voice, socket, mint } = await startVoice();
    assert.equal(mint.url, 'https://api.elevenlabs.io/v1/convai/realtime/client_secrets');
    assert.equal(mint.init.headers['xi-api-key'], 'test-not-a-real-key');
    const body = JSON.parse(mint.init.body);
    assert.equal(body.session.model, 'eleven_realtime_v1_max');
    assert.equal(body.expires_after.seconds, 60);
    assert.equal(socket.url, 'wss://api.elevenlabs.io/v1/convai/realtime');
    assert.deepEqual(socket.protocols, ['realtime', 'openai-insecure-api-key.ek_test_secret']);
    assert.ok(!JSON.stringify(socket.protocols).includes('test-not-a-real-key'));
    voice.stop();
  } finally { globalThis.fetch = originalFetch; globalThis.WebSocket = originalWS; }
});

test('audio flows both ways; barge-in drops queued audio, truncates, and ignores late deltas', async () => {
  const originalFetch = globalThis.fetch, originalWS = globalThis.WebSocket;
  try {
    const { voice, socket, audio, input, output, played } = await startVoice();
    const frame = Buffer.alloc(960, 3);
    input(frame);
    assert.deepEqual(socket.sent.at(-1), { type: 'input_audio_buffer.append', audio: frame.toString('base64') });
    socket.event({ type: 'response.created', response: { id: 'r1' } });
    socket.event({ type: 'response.output_audio.delta', item_id: 'i1', delta: Buffer.alloc(960 * 3).toString('base64') });
    assert.equal(audio.enqueued.length, 1);
    for (let i = 0; i < 3; i++) output(Buffer.alloc(960), true); // 60 ms written to the helper,
    played(Buffer.alloc(960)); played(Buffer.alloc(960));          // of which the speaker played 40 ms
    socket.event({ type: 'input_audio_buffer.speech_started' });
    assert.equal(audio.interrupts, 1);
    assert.deepEqual(socket.sent.at(-1), { type: 'conversation.item.truncate', item_id: 'i1', content_index: 0, audio_end_ms: 40 });
    socket.event({ type: 'response.output_audio.delta', item_id: 'i1', delta: Buffer.alloc(960).toString('base64') });
    assert.equal(audio.enqueued.length, 1, 'late audio of the interrupted item is dropped');
    voice.mute(true);
    assert.deepEqual(audio.muted, [true]);
    const n = socket.sent.length; input(frame);
    assert.equal(socket.sent.length, n, 'muted mic sends nothing');
    voice.stop(); voice.stop();
    assert.equal(audio.stopped, 1);
  } finally { globalThis.fetch = originalFetch; globalThis.WebSocket = originalWS; }
});

test("truncation counts only the interrupted item's own heard audio, not the previous item's tail", async () => {
  const originalFetch = globalThis.fetch, originalWS = globalThis.WebSocket;
  try {
    const { voice, socket, played } = await startVoice();
    socket.event({ type: 'response.output_audio.delta', item_id: 'a', response_id: 'r1', delta: Buffer.alloc(960 * 2).toString('base64') });
    socket.event({ type: 'response.output_audio.delta', item_id: 'b', response_id: 'r2', delta: Buffer.alloc(960 * 4).toString('base64') });
    for (let i = 0; i < 3; i++) played(Buffer.alloc(960)); // a's 40 ms, then 20 ms of b
    socket.event({ type: 'input_audio_buffer.speech_started' });
    assert.deepEqual(socket.sent.at(-1), { type: 'conversation.item.truncate', item_id: 'b', content_index: 0, audio_end_ms: 20 });
    // After the flush the count restarts: the next item's heard audio is measured from zero.
    socket.event({ type: 'response.output_audio.delta', item_id: 'c', response_id: 'r3', delta: Buffer.alloc(960 * 2).toString('base64') });
    played(Buffer.alloc(960));
    socket.event({ type: 'input_audio_buffer.speech_started' });
    assert.deepEqual(socket.sent.at(-1), { type: 'conversation.item.truncate', item_id: 'c', content_index: 0, audio_end_ms: 20 });
    voice.stop();
  } finally { globalThis.fetch = originalFetch; globalThis.WebSocket = originalWS; }
});

test('function calls return immediately and a response follows only when nobody is talking', async () => {
  const originalFetch = globalThis.fetch, originalWS = globalThis.WebSocket;
  try {
    const calls = [];
    const { voice, socket, errors } = await startVoice({ tool: (name, args) => { calls.push([name, args]); return { status: 'started' }; } });
    socket.event({ type: 'response.created', response: { id: 'r1' } });
    socket.event({ type: 'response.done', response: { output: [{ type: 'function_call', call_id: 'c1', name: 'ask_pi', arguments: '{"request":"run the tests"}' }] } });
    assert.deepEqual(calls, [['ask_pi', { request: 'run the tests' }]]);
    const outputItem = socket.sent.find(e => e.type === 'conversation.item.create' && e.item.type === 'function_call_output');
    assert.deepEqual(JSON.parse(outputItem.item.output), { status: 'started' });
    assert.equal(socket.types().at(-1), 'response.create');
    // Duplicate delivery of the same call is ignored.
    socket.event({ type: 'response.done', response: { output: [{ type: 'function_call', call_id: 'c1', name: 'ask_pi', arguments: '{}' }] } });
    assert.equal(calls.length, 1);
    // A spoken notice while the user talks waits for the end of speech.
    socket.event({ type: 'response.created', response: { id: 'r2' } });
    socket.event({ type: 'response.done', response: { output: [] } });
    socket.event({ type: 'input_audio_buffer.speech_started' });
    voice.notify('Pi finished the task "run the tests". Pi\'s answer: all green');
    assert.equal(socket.types().at(-1), 'conversation.item.create');
    // Eleven Realtime ignores system items, so Pi updates are labelled user items.
    assert.equal(socket.sent.at(-1).item.role, 'user');
    assert.match(socket.sent.at(-1).item.content[0].text, /^\(Automatic update from Pi, not spoken by the user\.\) Pi finished/);
    socket.event({ type: 'input_audio_buffer.speech_stopped' });
    assert.equal(socket.types().at(-1), 'response.create');
    // Racing a server-created response: retried once that response is done.
    socket.event({ type: 'error', error: { code: 'conversation_already_has_active_response', message: 'Conversation already has an active response' } });
    socket.event({ type: 'response.created', response: { id: 'r3' } });
    const before = socket.types().filter(t => t === 'response.create').length;
    socket.event({ type: 'response.done', response: { output: [] } });
    assert.equal(socket.types().filter(t => t === 'response.create').length, before + 1);
    assert.deepEqual(errors, []);
    voice.stop();
  } finally { globalThis.fetch = originalFetch; globalThis.WebSocket = originalWS; }
});

test('ask_pi after a spoken preamble gets no second acknowledgement; pi_status always gets an answer', async () => {
  const originalFetch = globalThis.fetch, originalWS = globalThis.WebSocket;
  try {
    const { voice, socket, audio } = await startVoice({ tool: name => ({ name }) });
    const creates = () => socket.types().filter(t => t === 'response.create').length;
    const turn = (callId, name, spoken) => {
      socket.event({ type: 'input_audio_buffer.speech_started' });
      socket.event({ type: 'input_audio_buffer.speech_stopped' });
      socket.event({ type: 'response.created', response: { id: `pre-${callId}` } });
      if (spoken) socket.event({ type: 'response.output_audio.delta', item_id: `say-${callId}`, delta: Buffer.alloc(960).toString('base64') });
      socket.event({ type: 'response.done', response: { output: [] } });
      socket.event({ type: 'response.created', response: { id: `call-${callId}` } });
      socket.event({ type: 'response.done', response: { output: [{ type: 'function_call', call_id: callId, name, arguments: '{}' }] } });
    };
    let n = creates(); turn('a', 'ask_pi', true);
    assert.equal(creates(), n, '"Checking." already said: no second response');
    // The server's own follow-up response is cancelled and its audio dropped.
    socket.event({ type: 'response.created', response: { id: 'auto-a' } });
    assert.deepEqual(socket.sent.at(-1), { type: 'response.cancel', response_id: 'auto-a' });
    socket.event({ type: 'response.output_audio.delta', response_id: 'auto-a', item_id: 'x', delta: Buffer.alloc(960).toString('base64') });
    socket.event({ type: 'response.done', response: { id: 'auto-a', status: 'cancelled', output: [] } });
    n = creates(); turn('b', 'ask_pi', false);
    assert.equal(creates(), n + 1, 'silent tool call still gets an acknowledgement');
    socket.event({ type: 'response.created', response: { id: 'ack-b' } });
    socket.event({ type: 'response.done', response: { output: [] } });
    n = creates(); turn('c', 'pi_status', true);
    assert.equal(creates(), n + 1, 'status needs its answer');
    assert.equal(audio.enqueued.length, 2, 'only the two spoken preambles played; the cancelled auto-response did not');
    voice.stop();
  } finally { globalThis.fetch = originalFetch; globalThis.WebSocket = originalWS; }
});

test('start surfaces key-resolution failures and cleans up exactly once', async () => {
  let closed = 0;
  const voice = new RealtimeVoice({ state() {}, samples() {}, error() {}, closed() { closed++; }, tool: () => ({}), busy: () => false }, () => assert.fail('audio must not start'));
  await assert.rejects(
    voice.start(() => { throw new Error('No ElevenLabs API key: add Keychain item "elevenlabs-api-key".'); }),
    /elevenlabs-api-key/
  );
  assert.equal(closed, 1);
  voice.stop();
  assert.equal(closed, 1); // stop is idempotent
});

// ---------- OpenAI GPT-Live session (fake socket, no network or audio) ----------

async function startLive({ tool = () => ({ ok: true }) } = {}) {
  const audio = { enqueued: [], interrupts: 0, muted: [], stopped: 0 };
  const errors = [], captions = [];
  let audioHooks;
  globalThis.WebSocket = FakeSocket;
  const voice = new LiveVoice({ state() {}, samples() {}, error: e => errors.push(e), caption: l => captions.push(l.phrase), closed() {}, tool, busy: () => false }, hooks => {
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

test('ElevenLabs captions drop tags, split a sentence chunk into phrases, and skip barged-in text', async () => {
  const originalFetch = globalThis.fetch, originalWS = globalThis.WebSocket;
  try {
    const { voice, socket, captions, played } = await startVoice();
    // Eleven sends a whole sentence ahead of its audio; its phrases are spread over that audio.
    socket.event({ type: 'response.output_audio_transcript.delta', item_id: 'i1', response_id: 'r1', delta: '[Tone] Twenty pass, two fail.' });
    socket.event({ type: 'response.output_audio.delta', item_id: 'i1', response_id: 'r1', delta: voiced(20).toString('base64') });
    socket.event({ type: 'response.output_audio.done', item_id: 'i1', response_id: 'r1' }); // the span is now known
    played(voiced(1)); // the device reports finishing a frame; write time alone would not move the caption
    assert.deepEqual(captions.at(-1), 'Twenty pass,');
    for (let i = 0; i < 12; i++) played(voiced(1));
    assert.deepEqual(captions.at(-1), 'two fail.');
    socket.event({ type: 'response.output_audio_transcript.delta', item_id: 'i1', response_id: 'r1', delta: ' Never said.' });
    socket.event({ type: 'response.output_audio.delta', item_id: 'i1', response_id: 'r1', delta: voiced(10).toString('base64') });
    socket.event({ type: 'response.output_audio.done', item_id: 'i1', response_id: 'r1' });
    socket.event({ type: 'input_audio_buffer.speech_started' }); // barge-in before "Never said." plays
    for (let i = 0; i < 10; i++) played(voiced(1));
    assert.ok(!captions.includes('Never said.'));
    socket.event({ type: 'response.output_audio_transcript.delta', item_id: 'i2', response_id: 'r2', delta: 'Stopped.' });
    socket.event({ type: 'response.output_audio.delta', item_id: 'i2', response_id: 'r2', delta: voiced(5).toString('base64') });
    socket.event({ type: 'response.output_audio.done', item_id: 'i2', response_id: 'r2' });
    played(voiced(1));
    assert.deepEqual(captions.at(-1), 'Stopped.');
    voice.stop();
  } finally { globalThis.fetch = originalFetch; globalThis.WebSocket = originalWS; }
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

test('a transcript burst ahead of its audio paces every sentence in order', () => {
  const shown = [];
  const captions = new Captions(line => shown.push(line.phrase));
  // The whole paragraph arrives as several deltas before any audio: every stamp ties,
  // and the old pacing jumped straight into the last delta's text.
  captions.text('Twenty pass, ');
  captions.text('two fail; ');
  captions.text('one is flaky.');
  captions.queued(voiced(20), 24000); // 400 ms of the paragraph's audio, all at once
  captions.done();                     // the item's audio is fully queued: the span is known
  const hear = frames => { for (let i = 0; i < frames; i++) captions.played(voiced(1), 24000); };
  hear(1);
  assert.equal(shown.at(-1), 'Twenty pass,');
  hear(9); // 200 ms heard: halfway through the queued span
  assert.equal(shown.at(-1), 'two fail;');
  hear(8); // 360 ms heard
  assert.equal(shown.at(-1), 'one is flaky.');
  assert.ok(!shown.slice(0, 2).includes('one is flaky.'), 'the last sentence never jumps the queue');
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

test('closing a span never pulls the caption back', () => {
  const shown = [];
  const captions = new Captions(line => shown.push(line.phrase));
  captions.text('Twenty pass, two fail.');           // 22 chars
  captions.queued(voiced(154), 24000);               // 3080 ms: a slow voice, longer than the prior rate expects
  for (let i = 0; i < 50; i++) captions.played(voiced(1), 24000); // 1000 ms heard
  assert.equal(shown.at(-1), 'two fail.');           // the prior rate places the cursor ~14 chars in
  captions.done();                                    // the real span turns out much longer
  assert.equal(shown.at(-1), 'two fail.', 'the caption never snaps back');
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
  captions.turn(800);                 // the user spoke; the next turn starts at session 800
  captions.text('Stopping.', 800, 900);
  captions.played(Buffer.alloc(960 * 19), 24000); // the clock runs through silence to exactly 800
  assert.equal(shown.at(-1), 'nothing else changed.', 'the next turn waits for its session position');
  captions.played(voiced(2), 24000);   // 840 ms: inside "Stopping."
  assert.equal(shown.at(-1), 'Stopping.');
});

test('GPT-Live config comes from providers/openai-live/ with Responses delegation to the Pi tools', () => {
  const config = liveSessionConfig();
  assert.equal(config.model, 'gpt-live-1');
  assert.match(config.instructions, /<\|SpawnThinking\|>/);
  assert.deepEqual(config.audio, { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: 'vesper' } });
  assert.doesNotMatch(config.instructions, /\n\nVoice: /);
  assert.equal(config.delegation.type, 'responses');
  assert.deepEqual(config.delegation.responses.tools.map(t => t.name), ['ask_pi', 'pi_status', 'cancel_pi']);
  assert.match(config.delegation.responses.instructions, /pi_status/);
  assert.equal(config.delegation.responses.parallel_tool_calls, false);
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

test('GPT-Live silence frames do not count as speech', () => {
  const quiet = Buffer.alloc(960); quiet.writeInt16LE(120, 10);
  const speech = Buffer.alloc(960); speech.writeInt16LE(-4000, 300);
  assert.equal(audibleFrame(quiet), false);
  assert.equal(audibleFrame(speech), true);
});

test('GPT-Live backend function calls run the Pi tools and continue the response once', async () => {
  const originalWS = globalThis.WebSocket;
  try {
    const calls = [];
    const { voice, socket } = await startLive({ tool: (name, args) => { calls.push([name, args]); return { status: 'started' }; } });
    socket.event({ type: 'session.delegation.created', delegation: { id: 'd1', type: 'delegation', target: 'responses' } });
    const done = { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c1', name: 'ask_pi', arguments: '{"request":"run the tests"}' } };
    socket.event({ type: 'response.event', delegation_id: 'd1', event: done });
    socket.event({ type: 'response.event', delegation_id: 'd1', event: done }); // duplicate delivery
    assert.deepEqual(calls, [['ask_pi', { request: 'run the tests' }]]);
    const result = socket.sent.find(e => e.type === 'response.item.create');
    assert.deepEqual(result.item, { type: 'function_call_output', call_id: 'c1', output: '{"status":"started"}' });
    assert.equal(socket.sent.filter(e => e.type === 'response.create').length, 0, 'continue only after the response completes');
    socket.event({ type: 'response.event', delegation_id: 'd1', event: { type: 'response.completed', response: { output: [] } } });
    socket.event({ type: 'response.event', delegation_id: 'd1', event: { type: 'response.completed', response: { output: [] } } });
    assert.equal(socket.sent.filter(e => e.type === 'response.create').length, 1);
    // Pi updates: spoken commentary and silent thinking, both session-wide.
    voice.notify('Pi finished the task "run the tests". Pi\'s answer: 23 pass.');
    assert.deepEqual([socket.sent.at(-1).type, socket.sent.at(-1).delegation_id], ['session.commentary.append', null]);
    voice.context('Pi is working on "run the tests"; it just ran bash: npm test.');
    assert.equal(socket.sent.at(-1).type, 'session.thinking.append');
    assert.ok(socket.sent.every(e => typeof e.event_id === 'string'), 'every client event carries an event_id');
    voice.stop();
  } finally { globalThis.WebSocket = originalWS; }
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
  assert.deepEqual(PI_TOOLS.map(t => t.parameters.required), [['request'], [], []]);
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
    await writeFile(join(user, 'backend.md'), 'Custom backend.');
    const config = liveSessionConfig(providerFiles('openai-live', { user }));
    assert.equal(config.model, 'gpt-live-1'); // untouched keys keep the packaged default
    assert.deepEqual(config.audio.output, { voice: { id: 'voice_custom' } });
    assert.match(config.instructions, /<\|SpawnThinking\|>[\s\S]*\n\nVoice: Calm baritone\.$/);
    assert.equal(config.delegation.responses.instructions, 'Custom backend.');
  } finally { await rm(user, { recursive: true, force: true }); }
});

test('override directory follows PI_VOICE_CONFIG_DIR, then Pi\'s agent directory', () => {
  assert.equal(userConfigDir({ PI_VOICE_CONFIG_DIR: '/x/voice' }), '/x/voice');
  assert.equal(userConfigDir({ PI_CODING_AGENT_DIR: '/x/pi' }), '/x/pi/pi-voice');
  assert.match(userConfigDir({}), /\.pi\/agent\/pi-voice$/);
});
