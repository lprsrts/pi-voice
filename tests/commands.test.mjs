import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTalk, talkCompletions, talkHelp, TALK_COMMANDS, resolveShortcuts, loadShortcuts, keybindingsPath, DEFAULT_SHORTCUTS, voiceRunsIn, noticeText, consentBody } from '../commands.ts';
import { PROVIDER } from '../providers.ts';
import './helpers.mjs';

test('/talk parses subcommands strictly and toggles with no argument', () => {
  assert.deepEqual(parseTalk(''), { name: 'toggle' });
  assert.deepEqual(parseTalk('  Start '), { name: 'start' });
  assert.deepEqual(parseTalk('mute'), { name: 'mute', value: undefined });
  assert.deepEqual(parseTalk('mute on'), { name: 'mute', value: true });
  assert.deepEqual(parseTalk('tone'), { name: 'tone', hz: 440 });
  assert.deepEqual(parseTalk('tone 1000'), { name: 'tone', hz: 1000 });
  assert.deepEqual(parseTalk('mic-test'), { name: 'mic-test', seconds: 3 });
  assert.deepEqual(parseTalk('preview'), { name: 'preview', state: 'story' });
  assert.deepEqual(parseTalk('preview speaking'), { name: 'preview', state: 'speaking' });
  assert.deepEqual(parseTalk('preview hearing'), { name: 'preview', state: 'hearing' });
  // Bad values are rejected with the usage, never silently replaced.
  for (const bad of ['tone abc', 'tone 0', 'tone 440.5', 'tones', 'mic-test 99', 'mic-test 2.5', 'mute maybe', 'stop now', 'preview loud', 'captions', 'mute on off']) {
    assert.equal(parseTalk(bad).name, 'error', bad);
  }
  assert.match(parseTalk('tone 0').message, /Use \/talk tone \[20-20000\]/);
  assert.match(parseTalk('strat').message, /Did you mean \/talk start\?/);
  assert.match(parseTalk('xyzzy').message, /See \/talk help/);
});

test('/talk completes subcommands, then their values', () => {
  assert.deepEqual(talkCompletions('').map(item => item.label), TALK_COMMANDS.map(command => command.name));
  assert.deepEqual(talkCompletions('m').map(item => item.value), ['mute ', 'mic-test ']);
  assert.deepEqual(talkCompletions('st').map(item => item.value), ['start', 'stop']);
  assert.deepEqual(talkCompletions('mute ').map(item => item.value), ['mute on', 'mute off']);
  assert.deepEqual(talkCompletions('preview sp').map(item => item.value), ['preview speaking']);
  assert.equal(talkCompletions('stop '), null);
  assert.equal(talkCompletions('zz'), null);
});

test('shortcuts come from pi-voice actions in Pi\'s keybindings.json', async () => {
  assert.deepEqual(resolveShortcuts(undefined), DEFAULT_SHORTCUTS);
  assert.deepEqual(resolveShortcuts({ 'pi-voice.toggle': 'Ctrl+Shift+V', 'pi-voice.mute': [] }), { toggle: ['ctrl+shift+v'], mute: [] });
  assert.deepEqual(resolveShortcuts({ 'pi-voice.toggle': ['alt+v', 'f5'], 'pi-voice.mute': 7 }), { toggle: ['alt+v', 'f5'], mute: DEFAULT_SHORTCUTS.mute });
  assert.equal(keybindingsPath({ PI_CODING_AGENT_DIR: '/x/pi' }), '/x/pi/keybindings.json');
  const dir = await mkdtemp(join(tmpdir(), 'pi-voice-keys-'));
  try {
    await writeFile(join(dir, 'keybindings.json'), '﻿{"app.model.select": "ctrl+l", "pi-voice.mute": "alt+shift+m"}');
    assert.deepEqual(loadShortcuts(join(dir, 'keybindings.json')), { toggle: DEFAULT_SHORTCUTS.toggle, mute: ['alt+shift+m'] });
    await writeFile(join(dir, 'broken.json'), '{');
    assert.deepEqual(loadShortcuts(join(dir, 'broken.json')), DEFAULT_SHORTCUTS);
    assert.match(talkHelp(DEFAULT_SHORTCUTS), /alt\+v: start or stop voice \(pi-voice\.toggle\)/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('/talk acts in the terminal UI and in hosts that bridge its dialogs', () => {
  assert.equal(voiceRunsIn('tui'), true);
  assert.equal(voiceRunsIn('rpc'), true); // ThinkRail runs its Pi sessions with mode "rpc"
  assert.equal(voiceRunsIn('print'), false);
  assert.equal(voiceRunsIn('json'), false);
});

// ThinkRail renders one notify as a single paragraph: newlines collapse into an
// unreadable run-on (/talk check arrived as one blob there).
test('a host notice joins its lines into one paragraph; the terminal keeps them', () => {
  const lines = [
    'echo cancellation: on',
    'WebSocket: OK',
    'settings ("pi-voice" in Pi\'s settings.json; env variables override):',
    '  autoPause: 15 s of silence while I work (default)',
    '  idlePause: 60 s of silence when nothing runs (default)',
    '  ignored invalid value: "pi-voice".autoPause: "x"',
    'session: off',
  ];
  assert.equal(noticeText(lines, false), lines.join('\n'));
  assert.equal(noticeText(lines, true),
    'echo cancellation: on · WebSocket: OK · '
    + 'settings ("pi-voice" in Pi\'s settings.json; env variables override): '
    + 'autoPause: 15 s of silence while I work (default), '
    + 'idlePause: 60 s of silence when nothing runs (default), '
    + 'ignored invalid value: "pi-voice".autoPause: "x" · session: off');
});

test('a host notice runs only its indented list behind the header, and a non-header item resets that', () => {
  // Items after the first run on with ", ", and a header whose line does not end
  // in ":" gets its own clause instead.
  const lines = ['devices:', '  input: Mic', '  output: Speakers', 'platform: darwin', '  extra: trimmed', 'next:'];
  assert.equal(noticeText(lines, true),
    'devices: input: Mic, output: Speakers · platform: darwin · extra: trimmed · next:');
  // An indented first line still lands at the start without its indent.
  assert.equal(noticeText(['  bare item', 'plain'], true), 'bare item · plain');
});

test('/talk help keeps the shortcuts in the terminal and leaves them out for hosts', () => {
  assert.match(talkHelp(DEFAULT_SHORTCUTS), /alt\+v: start or stop voice/);
  const help = talkHelp(DEFAULT_SHORTCUTS, true);
  assert.doesNotMatch(help, /keybindings|alt\+v/);
  assert.doesNotMatch(help, /\n/);
  assert.match(help, /\/talk mute \[on\|off\]\s+Stop or resume the microphone/);
});

// ThinkRail's dialog card cut the consent text mid-sentence ("…overridden by").
test('the consent dialog is said in full in the terminal and keeps only what is agreed to for hosts', () => {
  const model = 'openai/gpt-6-sol';
  const full = consentBody(PROVIDER, { tui: true, model, aec: true });
  // The full wording keeps everything: the provider config paths, the terminal
  // prompts, and where the key comes from.
  assert.match(full, /Your microphone audio will be sent to OpenAI GPT-Live \(model, voice, and instructions/);
  assert.match(full, /providers\/openai-live\/ in this package/);
  assert.match(full, /here in the terminal/);
  assert.match(full, /login keychain \(openai-api-key\)/);
  assert.match(full, /pauses by itself after 15 s of silence while I work or 60 s of silence when nothing runs/);
  const short = consentBody(PROVIDER, { tui: false, model, aec: true });
  assert.match(short, /Your microphone audio will be sent to OpenAI GPT-Live\./);
  assert.match(short, /in the host's chat/);
  assert.match(short, /pauses by itself after 15 s of silence while I work or 60 s of silence when nothing runs/);
  assert.doesNotMatch(short, /keychain|providers\/|Audio uses the macOS/);
  assert.ok(short.length < full.length * 0.6, `short consent stays short: ${short.length} vs ${full.length}`);
  // The echo-cancellation warning survives either way: speakers without it loop.
  assert.doesNotMatch(short, /headphones/);
  assert.match(consentBody(PROVIDER, { tui: false, model, aec: false }), /use headphones, or the agent may hear itself and loop/);
  assert.match(full, /speakers work/);
  assert.match(consentBody(PROVIDER, { tui: true, model, aec: false }), /use headphones, or the agent may hear itself and loop/);
});
