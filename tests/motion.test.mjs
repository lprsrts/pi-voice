import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { LiveVoice } from '../live.ts';
import { SpokenChat } from '../chat.ts';
import { BarMotion, Meter, barState, transitionMs, DRIFT, STATES, EVENTS, BREATH_MS, ERROR_MS, PAUSE_PULSE_MS, STORY, STORY_MS, storyAt, liveFacts, HEARD_HOLD_MS, hostStrip } from '../motion.ts';
import { startLive, voiced, settle } from './helpers.mjs';

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

test("host strip: the bar's state in words for hosts that draw Pi's chat", () => {
  const state = { connected: false, ready: false, muted: false, live: 'idle', talking: false, paused: false, waiting: 0 };
  assert.equal(hostStrip(state), undefined, 'no trace once voice is off');
  assert.deepEqual(hostStrip({ ...state, connected: true, ready: false }), ['voice: connecting']);
  assert.deepEqual(hostStrip({ ...state, connected: true, ready: true }), ['voice: listening']);
  assert.deepEqual(hostStrip({ ...state, connected: true, ready: true, live: 'speaking' }), ['voice: speaking']);
  assert.deepEqual(hostStrip({ ...state, connected: true, ready: true, live: 'thinking', waiting: 2 }), ['voice: working; 2 results to say']);
  assert.deepEqual(hostStrip({ ...state, connected: true, ready: true, muted: true, live: 'speaking' }), ['voice: muted']);
  assert.deepEqual(hostStrip({ ...state, talking: true }), ['voice: paused; /talk start to speak sooner']);
  assert.deepEqual(hostStrip({ ...state, paused: true }), ['voice: paused while I work; comes back with the result']);
  assert.deepEqual(hostStrip({ ...state, waiting: 1 }), ['voice: off; 1 result to say']);
});
