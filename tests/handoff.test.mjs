import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { PiBridge, describeTool, VOICE_REQUEST, VOICE_REMARK, isSpoken, spokenPart, CONVERSATION_MARK, sessionBriefing } from '../pi-bridge.ts';
import { LiveVoice, audibleFrame, describeStatus, conversationContext } from '../live.ts';
import { kept, liveSource, FakeSocket, startLive, settle, lastOf, fakePi } from './helpers.mjs';

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
    const cancels = [];
    const { voice, socket } = await startLive({ busy: () => busy, tool: (name, args) => { if (name === 'ask_pi') asked.push(args.request); if (name === 'cancel_pi') { cancels.push(1); return { status: 'cancelled' }; } return { status: 'steered' }; } });
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
    assert.equal(cancels.length, 0, 'a stop GPT-Live did not delegate is not carried out here');
    assert.match(socket.sent.filter(e => e.type === 'session.commentary.append').at(-1).content, /^The user said "Stop that\.", but it did not reach the task/);
    const before = socket.sent.length;
    voice.notify('I finished the task. My answer: done.');
    assert.deepEqual(socket.sent.slice(before).map(e => e.type), ['session.commentary.append'], 'nothing left to note');
    voice.stop();
  } finally { globalThis.WebSocket = originalWS; }
});

test('a stop GPT-Live acknowledges but does not delegate is not carried out here: the voice says it has not stopped, and a late delegation still stops it', async t => {
  const originalWS = globalThis.WebSocket;
  try {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const calls = [];
    const { voice, socket } = await startLive({ busy: () => true, tool: name => { calls.push(name); return { status: name === 'cancel_pi' ? 'cancelled' : 'steered' }; } });
    t.mock.timers.tick(1000);
    socket.event({ type: 'session.input_transcript.delta', delta: 'Stop that.', start_ms: 1000, end_ms: 1600 });
    socket.event({ type: 'session.output_transcript.delta', delta: 'Stopping it.', start_ms: 1800, end_ms: 2400 });
    t.mock.timers.tick(3400);
    const before = socket.sent.length;
    t.mock.timers.tick(200);
    assert.deepEqual(calls, [], 'nothing is cancelled without GPT-Live');
    assert.deepEqual(socket.sent.slice(before).map(e => [e.type, e.content]), [['session.commentary.append', 'The user said "Stop that.", but it did not reach the task: it is still running. Tell them plainly that it has not stopped, and to say stop again.']]);
    socket.event({ type: 'session.delegation.created', offset_ms: 1600, delegation: { id: 'd9' } });
    t.mock.timers.tick(400);
    assert.deepEqual(calls, ['cancel_pi'], 'a late delegation of the stop still stops the work');
    voice.notify('I stopped the task.');
    assert.equal(socket.sent.at(-2).content.startsWith('While I worked'), false, 'the stop is not noted again');
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
