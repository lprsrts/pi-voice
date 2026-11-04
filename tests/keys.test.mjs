import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveApiKey, apiKeyStatus, provisionCommand, chatgptLoginHint, OPENAI_KEY } from '../keys.ts';
import { PROVIDER } from '../providers.ts';
import { signal, TEST_KEY } from './helpers.mjs';

test('key resolution reads the convention item, trims the secret, and forwards the abort signal', async () => {
  delete process.env.PI_VOICE_TEST_API_KEY;
  const key = await resolveApiKey(TEST_KEY, signal, { platform: 'darwin', call: async (args, opts) => {
    assert.deepEqual(args, ['find-generic-password', '-s', 'test-api-key', '-w']);
    assert.equal(opts.signal, signal);
    assert.ok(opts.timeout > 0);
    return { stdout: 'sk_test\n', stderr: '' };
  }});
  assert.equal(key, 'sk_test');
});

test('missing keychain item maps to the provisioning command', async () => {
  delete process.env.PI_VOICE_TEST_API_KEY;
  const failure = Object.assign(new Error('not found'), { code: 44, stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' });
  await assert.rejects(
    () => resolveApiKey(TEST_KEY, signal, { platform: 'darwin', call: async () => { throw failure; } }),
    /add-generic-password -U -s "test-api-key" -a "\$USER"/
  );
});

test('denied or headless keychain reads fail with a clear reason', async () => {
  delete process.env.PI_VOICE_TEST_API_KEY;
  await assert.rejects(
    () => resolveApiKey(TEST_KEY, signal, { platform: 'darwin', call: async () => { throw Object.assign(new Error('x'), { stderr: 'security: SecKeychainSearchCopyNext: User interaction is not allowed.' }); } }),
    /denied|GUI terminal/
  );
});

test('corrupted or empty keychain secrets are rejected', async () => {
  delete process.env.PI_VOICE_TEST_API_KEY;
  for (const stdout of ['\n', 'sk bad\n']) {
    await assert.rejects(
      () => resolveApiKey(TEST_KEY, signal, { platform: 'darwin', call: async () => ({ stdout, stderr: '' }) }),
      /empty or malformed/
    );
  }
});

test('non-darwin platforms fail closed without the env override', async () => {
  delete process.env.PI_VOICE_TEST_API_KEY;
  await assert.rejects(() => resolveApiKey(TEST_KEY, signal, { platform: 'linux', call: async () => ({ stdout: '', stderr: '' }) }), /PI_VOICE_TEST_API_KEY/);
  assert.match(await apiKeyStatus(TEST_KEY, { platform: 'linux' }), /missing/);
});

test('status reports the source without ever reading the secret', async () => {
  process.env.PI_VOICE_TEST_API_KEY = 'sk_env_override';
  assert.match(await apiKeyStatus(TEST_KEY), /env override/);
  delete process.env.PI_VOICE_TEST_API_KEY;
  assert.match(await apiKeyStatus(TEST_KEY, { platform: 'darwin', call: async args => {
    assert.ok(!args.includes('-w')); // presence check only
    return { stdout: '', stderr: '' };
  }}), /present/);
  assert.match(await apiKeyStatus(TEST_KEY, { platform: 'darwin', call: async () => { throw Object.assign(new Error('nf'), { code: 44 }); } }), /add-generic-password/);
});

// Pi's Sign in with ChatGPT login (provider openai, OAuth) is refused by GPT-Live (ADR-0007):
// it is never used, but a missing key says why it is not.
test('a Pi ChatGPT login is named when the key is missing, and never read', async () => {
  const asked = [];
  const registry = { isUsingOAuth: model => { asked.push(model.provider); return model.provider === 'openai'; }, getProviderAuth: () => { throw new Error('the token must not be read'); } };
  const hint = chatgptLoginHint(registry);
  assert.deepEqual(asked, ['openai']);
  assert.match(hint, /Sign in with ChatGPT.*API key/);
  assert.equal(chatgptLoginHint({ isUsingOAuth: () => false }), undefined); // API-key login or none
  assert.equal(chatgptLoginHint(undefined), undefined);
  assert.equal(chatgptLoginHint({ isUsingOAuth: () => { throw new Error('older Pi'); } }), undefined);
  delete process.env.PI_VOICE_TEST_API_KEY;
  const missing = async () => { throw Object.assign(new Error('nf'), { code: 44 }); };
  await assert.rejects(() => resolveApiKey(TEST_KEY, signal, { platform: 'darwin', call: missing, hint }), error => /add-generic-password/.test(error.message) && error.message.endsWith(hint));
  await assert.rejects(() => resolveApiKey(TEST_KEY, signal, { platform: 'linux', hint }), error => error.message.endsWith(hint));
  assert.match(await apiKeyStatus(TEST_KEY, { platform: 'darwin', call: missing, hint }), /missing[\s\S]*Sign in with ChatGPT/);
  // A key that is present wins; the hint is not shown.
  assert.doesNotMatch(await apiKeyStatus(TEST_KEY, { platform: 'darwin', call: async () => ({ stdout: '', stderr: '' }), hint }), /ChatGPT/);
  process.env.PI_VOICE_TEST_API_KEY = 'sk_env_override';
  assert.equal(await resolveApiKey(TEST_KEY, signal, { platform: 'darwin', call: missing, hint }), 'sk_env_override');
  delete process.env.PI_VOICE_TEST_API_KEY;
  // A denied keychain read is not a missing key: no hint.
  await assert.rejects(() => resolveApiKey(TEST_KEY, signal, { platform: 'darwin', call: async () => { throw Object.assign(new Error('x'), { stderr: 'User interaction is not allowed.' }); }, hint }), error => !error.message.includes('ChatGPT'));
});

test('long keys provision through the clipboard and a 128-character key is reported as truncated', async () => {
  assert.match(provisionCommand(OPENAI_KEY), /-w "\$\(pbpaste\)" && pbcopy <\/dev\/null/);
  assert.doesNotMatch(provisionCommand(TEST_KEY), /pbpaste/);
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(
    () => resolveApiKey(OPENAI_KEY, signal, { platform: 'darwin', call: async args => { assert.deepEqual(args.slice(0, 3), ['find-generic-password', '-s', 'openai-api-key']); return { stdout: 'sk-proj-' + 'x'.repeat(120) + '\n', stderr: '' }; } }),
    /truncated/
  );
  assert.equal(await resolveApiKey(OPENAI_KEY, signal, { platform: 'darwin', call: async () => ({ stdout: 'sk-proj-' + 'x'.repeat(156), stderr: '' }) }), 'sk-proj-' + 'x'.repeat(156));
});

test('the one provider is GPT-Live with the OpenAI key', () => {
  assert.equal(PROVIDER.name, 'openai-live');
  assert.equal(PROVIDER.key.service, 'openai-api-key');
});
