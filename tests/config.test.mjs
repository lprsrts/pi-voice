import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveSessionConfig } from '../live.ts';
import { providerFiles, userConfigDir } from '../config.ts';
import './helpers.mjs';

test('user overrides merge into session.json and replace Markdown files', async () => {
  const user = await mkdtemp(join(tmpdir(), 'pi-voice-overrides-'));
  try {
    await writeFile(join(user, 'session.json'), JSON.stringify({ voice: { id: 'voice_custom', description: 'Calm baritone.' } }));
    const config = liveSessionConfig(providerFiles('openai-live', { user }));
    assert.equal(config.model, 'gpt-live-1'); // untouched keys keep the packaged default
    assert.deepEqual(config.audio.output, { voice: { id: 'voice_custom' } });
    assert.match(config.instructions, /<\|SpawnThinking\|>[\s\S]*\n\nVoice: Calm baritone\.$/);
  } finally { await rm(user, { recursive: true, force: true }); }
});

test('override directory follows PI_VOICE_CONFIG_DIR, then Pi\'s agent directory', () => {
  assert.equal(userConfigDir({ PI_VOICE_CONFIG_DIR: '/x/voice' }), '/x/voice');
  assert.equal(userConfigDir({ PI_CODING_AGENT_DIR: '/x/pi' }), '/x/pi/pi-voice');
  assert.match(userConfigDir({}), /\.pi\/agent\/pi-voice$/);
});

// ---------- Talk session: auto-pause and results across voice connections ----------
