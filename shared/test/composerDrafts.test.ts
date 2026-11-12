import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  clearSpawnPromptFromComposerDraft,
  composerDraftHasPendingSpawnPrompt,
  mergeWindowComposerDraft,
  readPendingSpawnPrompt,
  selectWindowComposerDraft,
  spawnOutboxComposerDraft,
} from '../src/index';

describe('agent-spawn outbox in composer_draft', () => {
  test('reads back the prompt it wrote, beside window drafts too', () => {
    const outbox = spawnOutboxComposerDraft('Go');
    assert.equal(outbox, JSON.stringify({ __michiPendingSpawnPrompt: 'Go' }));
    assert.equal(readPendingSpawnPrompt(outbox), 'Go');
    assert.equal(readPendingSpawnPrompt(mergeWindowComposerDraft(outbox, 'w', null)), 'Go');
  });

  test('a blank outbox is cleared but never read', () => {
    const blank = spawnOutboxComposerDraft('  ');
    assert.equal(readPendingSpawnPrompt(blank), undefined);
    assert.equal(composerDraftHasPendingSpawnPrompt(blank), false);
    assert.equal(clearSpawnPromptFromComposerDraft(blank), null);
    const draft = JSON.stringify({ value: 'kept', mentions: [] });
    const cleared = clearSpawnPromptFromComposerDraft(mergeWindowComposerDraft(blank, 'w', draft));
    assert.equal(selectWindowComposerDraft(cleared, 'w'), draft);
    assert.equal(readPendingSpawnPrompt(cleared), undefined);
  });

  test('a draft without an outbox has nothing to clear', () => {
    for (const raw of ['', '{"value":"x"}', '{"__michiPendingSpawnPrompt":7}', '[]', 'null', '{"__michiPendingSpawnPrompt":']) {
      assert.equal(clearSpawnPromptFromComposerDraft(raw), undefined, raw);
      assert.equal(readPendingSpawnPrompt(raw), undefined, raw);
    }
    assert.equal(readPendingSpawnPrompt({ __michiPendingSpawnPrompt: 'Go' }), undefined);
  });
});
