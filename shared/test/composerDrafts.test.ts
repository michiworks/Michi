import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  clearSpawnPromptFromComposerDraft,
  mergeWindowComposerDraft,
  selectWindowComposerDraft,
} from '../src/index';

describe('legacy agent-spawn outbox in composer_draft', () => {
  test('is cleared, blank included, and window drafts stay', () => {
    const outbox = JSON.stringify({ __michiPendingSpawnPrompt: 'Go' });
    assert.equal(clearSpawnPromptFromComposerDraft(outbox), null);
    assert.equal(clearSpawnPromptFromComposerDraft(JSON.stringify({ __michiPendingSpawnPrompt: '  ' })), null);
    const draft = JSON.stringify({ value: 'kept', mentions: [] });
    const cleared = clearSpawnPromptFromComposerDraft(mergeWindowComposerDraft(outbox, 'w', draft));
    assert.equal(selectWindowComposerDraft(cleared, 'w'), draft);
    assert.equal(cleared?.includes('__michiPendingSpawnPrompt'), false);
  });

  test('a draft without an outbox has nothing to clear', () => {
    for (const raw of ['', '{"value":"x"}', '{"__michiPendingSpawnPrompt":7}', '[]', 'null', '{"__michiPendingSpawnPrompt":']) {
      assert.equal(clearSpawnPromptFromComposerDraft(raw), undefined, raw);
    }
  });
});
