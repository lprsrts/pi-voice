import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { clipTokens } from '../protocol.ts';
import { GptLiveWire } from '../openai-live-wire.ts';
import { FakeSocket, startWire } from './helpers.mjs';

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

test('the GPT-Live wire declares a session lost when an update goes unacknowledged for 8 s', async t => {
  const originalWS = globalThis.WebSocket;
  try {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const { wire, socket, calls } = await startWire();
    wire.say('started', 'd1', 'context');
    t.mock.timers.tick(700);
    socket.event({ type: 'session.thinking.appended', delegation_id: 'd1' });
    for (let i = 0; i < 12; i++) { t.mock.timers.tick(900); socket.event({ type: 'session.output_audio.delta', delta: 'AA==' }); }
    assert.equal(calls.some(c => c[0] === 'lost'), false, 'acknowledged: fine');
    wire.say('I finished the task.', 'd1', 'result');
    for (let i = 0; i < 8; i++) { t.mock.timers.tick(900); socket.event({ type: 'session.output_audio.delta', delta: 'AA==' }); }
    assert.equal(calls.some(c => c[0] === 'lost'), false, 'not yet');
    for (let i = 0; i < 2; i++) { t.mock.timers.tick(900); socket.event({ type: 'session.output_audio.delta', delta: 'AA==' }); }
    assert.deepEqual(calls.find(c => c[0] === 'lost'), ['lost', 'OpenAI GPT-Live stopped taking updates (none acknowledged for 8 s).'], 'frames still arrive, but nothing is taken in');
    wire.close();
  } finally { globalThis.WebSocket = originalWS; }
});
