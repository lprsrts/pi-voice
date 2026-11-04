import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PcmFramer, waveform, dominantFrequency } from '../protocol.ts';
import { resolveApiKey } from '../keys.ts';
import { AudioPipes, parseRoute, pcmStats } from '../audio.ts';
import { aecEnabled, helperPath } from '../native.ts';
import { signal, TEST_KEY, settle } from './helpers.mjs';

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
