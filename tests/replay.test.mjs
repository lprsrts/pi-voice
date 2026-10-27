// Recorded live sessions replayed offline: GPT-Live's frames as they arrived
// (scripts/live/run.mjs --record), at their recorded times on a mocked clock, into
// a LiveVoice with a scripted Pi. The client's decisions (what goes to Pi, and how)
// must come out as they did live. Audio in the tapes is only its length.
// The tapes stay out of the public repo: they are read from docs/rnd/fixtures
// (local only), and the tests skip when it is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { LiveVoice, LATE_WORDS } from '../live.ts';

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static last;
  readyState = 1; bufferedAmount = 0; sent = [];
  constructor() { super(); FakeSocket.last = this; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; }
  event(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
}

const tapeFile = name => new URL(`../docs/rnd/fixtures/${name}.jsonl`, import.meta.url);
const tape = name => readFileSync(tapeFile(name), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const skip = name => existsSync(tapeFile(name)) ? false : `no local tape docs/rnd/fixtures/${name}.jsonl`;
const silence = bytes => Buffer.alloc(bytes).toString('base64');

async function replay(name, t) {
  const entries = tape(name);
  const originalWS = globalThis.WebSocket;
  const late = { ...LATE_WORDS };
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  globalThis.WebSocket = FakeSocket;
  try {
    let busy = false;
    const toPi = [];
    const voice = new LiveVoice({ state() {}, samples() {}, error() {}, closed() {}, busy: () => busy, tool: (name, args) => {
      if (name !== 'ask_pi') return { state: busy ? 'working' : 'idle' };
      toPi.push(`${busy ? 'steer' : 'prompt'}: ${args.request}`);
      const status = busy ? 'steered' : 'started';
      busy = true;
      return { status };
    } }, () => ({ start() {}, enqueue() {}, finish() {}, interrupt() {}, mute() {}, stop() {} }));
    const started = voice.start(() => 'test-not-a-real-key');
    await new Promise(r => setImmediate(r));
    const socket = FakeSocket.last;
    socket.dispatchEvent(new Event('open'));
    let now = 0;
    for (const entry of entries) {
      if (entry.t > now) { t.mock.timers.tick(entry.t - now); now = entry.t; }
      if (entry.dir === 'in') {
        const event = { ...entry.event };
        if (event.delta?.bytes !== undefined) event.delta = silence(event.delta.bytes);
        socket.event(event);
        if (event.type === 'session.started') await started;
      } else if (entry.dir === 'mark' && entry.kind === 'pi.settled') busy = false;
      else if (entry.dir === 'mark' && entry.kind === 'result') voice.notify(entry.data);
      else if (entry.dir === 'mark' && entry.kind === 'talk.stop') break;
    }
    voice.stop();
    const recorded = entries.filter(e => e.dir === 'mark' && /^pi\.(prompt|steer)$/.test(e.kind)).map(e => `${e.kind.slice(3)}: ${e.data}`);
    // Pi's progress comes from the bridge, which the replay does not run.
    const appends = list => list.filter(e => /^session\.(commentary|thinking)\.append$/.test(e.type) && !e.content.startsWith('Progress on my task')).map(e => `${e.type.split('.')[1]}: ${e.content.slice(0, 40)}`);
    return { toPi, recorded, sent: appends(socket.sent), recordedSent: appends(entries.filter(e => e.dir === 'out').map(e => e.event)) };
  } finally {
    globalThis.WebSocket = originalWS;
    Object.assign(LATE_WORDS, late);
  }
}

const head = list => list.map(line => line.slice(0, 150)); // the harness keeps 400 characters of a mark

test('replay: a correction GPT-Live did not delegate reaches Pi as a remark, as it did live', { skip: skip('live-correction-mid-task-2') }, async t => {
  const { toPi, recorded, sent, recordedSent } = await replay('live-correction-mid-task-2', t);
  assert.deepEqual(head(toPi), head(recorded));
  assert.equal(toPi.length, 2);
  assert.match(toPi[1], /^steer: Said while you worked .*Actually, list the files in the tests folder instead/);
  assert.deepEqual(sent, recordedSent, 'the same updates and context went to GPT-Live');
});

test('replay: small talk while Pi works goes to Pi only as a remark, as it did live', { skip: skip('live-chitchat-while-busy-1') }, async t => {
  const { toPi, recorded, sent, recordedSent } = await replay('live-chitchat-while-busy-1', t);
  assert.deepEqual(head(toPi), head(recorded));
  assert.equal(toPi.filter(line => line.startsWith('prompt:')).length, 1, 'one task');
  assert.ok(toPi.slice(1).every(line => line.startsWith('steer: Said while you worked')), 'small talk only as a remark');
  assert.deepEqual(sent, recordedSent);
});
