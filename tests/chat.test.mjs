import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clipTokens, FlapBoard, FLAP_SETTLE_MS, FLAP_GLOW_MS, wrapWords } from '../protocol.ts';
import { PiBridge, forSpeech, VOICE_REQUEST, sessionBriefing, SPOKEN_ENTRY, SPOKEN_MESSAGE, SPOKEN_TURN, SPOKEN_READOUT, spokenContent } from '../pi-bridge.ts';
import { heardPart, LATE_WORDS } from '../live.ts';
import { SpokenChat, answerBlocks, answerHash, speakable } from '../chat.ts';
import { kept, startLive, voiced, settle, fakeTalk } from './helpers.mjs';

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

test("hosts that draw Pi's chat themselves get settled turns as visible messages", () => {
  const sent = [];
  const shown = new SpokenChat({ append() {}, send: m => sent.push(m), shown: () => true }, () => 1);
  shown.live('user', 'what is next');
  shown.settle('user', 'what is next', false);
  assert.equal(sent[0].display, true, 'visible where the host renders the chat');
  const terminal = new SpokenChat({ append() {}, send: m => sent.push(m) }, () => 1);
  terminal.live('user', 'make it four');
  terminal.settle('user', 'make it four', false);
  assert.equal(sent.at(-1).display, false, 'the terminal shows placeholder turns and hides the copy');
});
