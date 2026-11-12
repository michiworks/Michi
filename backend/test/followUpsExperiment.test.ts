import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FOLLOW_UPS_SENTINEL_TURN_REMINDER, followUpsMetadataOutputMode, followUpsTurnReminder } from '../src/agents/followUpsExperiment';
import { followUpReminder } from '../src/agents/preamble';

test('a session that reports its overview through the tool gets the hybrid metadata mode', () => {
  assert.equal(followUpsMetadataOutputMode(true), 'sentinel-followups-tool-overview');
  assert.equal(followUpsMetadataOutputMode(false), 'sentinel');
});

test('the per-turn reminder: follow-up sentinels on every turn with the overview tool, else the periodic one', () => {
  for (const userTurnCount of [1, 2, 7]) {
    assert.equal(followUpsTurnReminder(userTurnCount, true), FOLLOW_UPS_SENTINEL_TURN_REMINDER);
    assert.equal(followUpsTurnReminder(userTurnCount, true, false), '');
    assert.equal(followUpsTurnReminder(userTurnCount, false, true), followUpReminder(userTurnCount, true));
    assert.equal(followUpsTurnReminder(userTurnCount, false, false), '');
  }
});
