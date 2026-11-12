import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSecretFieldName, parseJsonValue } from '../src/agentRuns';

// [field name, isSecretFieldName, rejected by the exact-name write gate (parseJsonValue)]
const cases: Array<[string, boolean, boolean]> = [
  ['API_KEY', true, true],
  ['PASSWORD', true, true],
  ['SECRET', true, true],
  ['apikey', true, true],
  ['APIKey', true, true],
  ['authorization', true, true],
  ['nativeResumeToken', true, true],
  ['githubToken', true, false],
  ['clientSecret', true, false],
  ['client_secret', true, false],
  ['sessionToken', true, false],
  ['authToken', true, false],
  ['privateKey', true, false],
  ['secretKey', true, false],
  ['credentials', true, false],
  ['token', true, false],
  ['x-api-key', true, false],
  ['GITHUB_TOKEN', true, false],
  ['OPENAI_API_KEY', true, false],
  ['AWS_SECRET_ACCESS_KEY', true, false],
  // Contract fields with a secret-sounding segment; backups exempt credentialBindingIds when empty.
  ['credentialBindingIds', true, false],
  ['authMode', true, false],
  ['tokenCount', true, false],
  ['inputTokens', false, false],
  ['maxTokens', false, false],
  ['author', false, false],
  ['oauth', false, false],
  ['workspacePath', false, false],
];

test('secret field names: the shared classifier and the write gate', () => {
  for (const [key, secret, gateRejects] of cases) {
    assert.equal(isSecretFieldName(key), secret, `isSecretFieldName(${key})`);
    assert.equal((() => { try { parseJsonValue({ [key]: 'value' }); return false; } catch { return true; } })(),
      gateRejects, `write gate on ${key}`);
  }
});
