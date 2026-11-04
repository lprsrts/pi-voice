import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { waveform, clipTokens, phraseAt, formatCaption, voicedMs, Captions } from '../protocol.ts';
import { liveSessionConfig } from '../live.ts';
import { kept, startLive, voiced } from './helpers.mjs';

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
