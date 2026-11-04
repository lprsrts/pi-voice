import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTalk, talkCompletions, talkHelp, TALK_COMMANDS, resolveShortcuts, loadShortcuts, keybindingsPath, DEFAULT_SHORTCUTS } from '../commands.ts';
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
