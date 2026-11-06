import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_REQUEST } from '../pi-bridge.ts';
import { describePause, formatDuration } from '../talk.ts';
import { resolveSettings, DEFAULT_SETTINGS } from '../settings.ts';
import { fakeTalk } from './helpers.mjs';

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

test('a connection lost before its result was said reconnects once to say it', async () => {
  const { talk, voices, toasts, control } = fakeTalk({ idle: true });
  talk.open();
  await voices[0].ready();
  talk.deliver('I finished the task "count files". My answer: 15.');
  assert.deepEqual(voices[0].said, ['I finished the task "count files". My answer: 15.']);
  voices[0].hooks.dropped('OpenAI GPT-Live stopped taking updates (none acknowledged for 8 s).');
  assert.equal(voices.length, 2, 'reconnects at once, though Pi is idle');
  assert.match(toasts.at(-1)[1], /Reconnecting to say the result\.$/);
  await voices[1].ready();
  assert.deepEqual(voices[1].said, ['I finished the task "count files". My answer: 15.']);
  // Lost again before saying it: no second reconnect (a failing service must not loop or bill).
  voices[1].hooks.dropped('OpenAI GPT-Live stopped taking updates (none acknowledged for 8 s).');
  assert.deepEqual([voices.length, talk.connected], [2, false]);
  assert.match(toasts.at(-1)[1], /\/talk start to talk again/);
  // Once a result is heard, a later one gets its own retry.
  talk.open();
  await voices[2].ready();
  talk.deliver('A later result.');
  voices[2].hooks.state('speaking');
  talk.deliver('Another result.');
  voices[2].hooks.dropped('lost');
  assert.equal(voices.length, 4);
  control.idle = true;
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

test('connected time counts only open, started connections', async () => {
  const { talk, voices, tick } = fakeTalk();
  talk.open();
  await voices.at(-1).ready();
  tick(5000);
  talk.close();
  assert.equal(talk.connectedMs, 5000);
  tick(8000); // a pause between connections adds nothing
  talk.open();
  await voices.at(-1).ready();
  tick(2000);
  talk.close();
  assert.equal(talk.connectedMs, 7000);
});

test('a connection closed before it started is no connected time', () => {
  const { talk } = fakeTalk();
  talk.open();
  talk.close();
  assert.equal(talk.connectedMs, 0);
});

test('durations format compactly', () => {
  assert.equal(formatDuration(999), 'under a second');
  assert.equal(formatDuration(45_000), '45 s');
  assert.equal(formatDuration(60_000), '1 min');
  assert.equal(formatDuration(200_000), '3 min 20 s');
  assert.equal(formatDuration(3_600_000), '1 h');
  assert.equal(formatDuration(3_840_000), '1 h 4 min');
});
