import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnMetadataState } from '../src/agents/turnMetadataState';

test('the overview trims, and an empty one is none', () => {
  const state = new TurnMetadataState();
  state.begin();
  assert.deepEqual(state.setOverview(' Current state. '), { overview: 'Current state.', beforeSentinelsComplete: true });
  assert.equal(state.setOverview('  '), null);
});

test('sentinel mode recognizes split final markers before suppressing overview tail', () => {
  const state = new TurnMetadataState();
  state.begin();
  assert.equal(state.setOverview('Earlier overview.')?.beforeSentinelsComplete, true);
  assert.equal(state.suppressOutput('chunk'), false);
  state.observeChunk('answer\n[FOLLOW-UP 3/', true);
  state.observeChunk('3: last?]', true);
  assert.equal(state.setOverview('Final overview.')?.beforeSentinelsComplete, false);
  assert.equal(state.suppressOutput('chunk'), true);
  assert.equal(state.suppressOutput('thought'), true);
  assert.equal(state.suppressOutput('tool_call'), false);
  assert.deepEqual(state.finish(), { chunks: 1, thoughts: 1 });
  assert.equal(state.suppressOutput('chunk'), false, 'finish resets the turn');
});

test('sentinel detection is bounded and disabled follow-ups do not hide the answer tail', () => {
  const state = new TurnMetadataState();
  state.begin();
  state.observeChunk('[FOLLOW-UP 3/3:', true);
  state.observeChunk('x'.repeat(12_000) + ' last?]', true);
  assert.equal(state.setOverview('No complete marker in the bounded tail.')?.beforeSentinelsComplete, true);
  assert.equal(state.suppressOutput('chunk'), false);
  state.finish();
  state.begin();
  state.observeChunk('[FOLLOW-UP 3/3: last?]', false);
  state.setOverview('No follow-ups requested.');
  assert.equal(state.suppressOutput('chunk'), false);
});

for (const [label, chunks, complete] of [
  ['a third follow-up without /3', ['answer\n[FOLLOW-UP 2/3: b?]\n[FOLLOW-UP 3: c?]'], true],
  ['a third follow-up closed by a line break', ['[FOLLOW-UP 3/3: c?', '\n'], true],
  ['a third follow-up left open before another on its line', ['[FOLLOW-UP 3/3: c? [FOLLOW-UP 1/3: a?]'], false],
  ['a third follow-up still being written', ['[FOLLOW-UP 3/3: c'], false],
  ['a third follow-up without /3 still being written', ['[FOLLOW-UP 3: c?'], false],
  ['an empty third follow-up', ['answer\n[FOLLOW-UP 1/3: a?]\n[FOLLOW-UP 2/3: b?]\n[FOLLOW-UP 3/3: ]', '\n'], false],
  ['an empty third follow-up after unclosed ones on its line', ['answer [FOLLOW-UP 1/3: a? [FOLLOW-UP 2/3: b? ', '[FOLLOW-UP 3/3: ]'], false],
] as const) {
  test(`sentinel mode reads ${label} as the renderers do`, () => {
    const state = new TurnMetadataState();
    state.begin();
    for (const chunk of chunks) state.observeChunk(chunk, true);
    assert.equal(state.setOverview('Final overview.')?.beforeSentinelsComplete, !complete);
    assert.equal(state.suppressOutput('thought'), complete, 'the reasoning after the overview is hidden once the sentinels are complete');
  });
}
