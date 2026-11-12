import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  COMPANION_TURN_REF_LIMITS,
  MetaAgentChatContextError,
  hasSpacesTurnContext,
  parseCompanionTurnRefs,
  parseMetaAgentChatTurnContext,
  type CompanionTurnRef,
} from '../src/index';

describe('metaAgentContext.refs (DESIGN-v2 §1.3, W0 review #2)', () => {
  const refs: CompanionTurnRef[] = [{ kind: 'post', messageId: 'cmp-post-cmr-1' }, { kind: 'companion_item', itemId: 'cmi-1' }];

  test('is accepted with the Spaces fields, with the Scheduled context, or alone', () => {
    const target: CompanionTurnRef[] = [{ kind: 'page', pageId: 'p1', blockId: 'b1' }];
    assert.deepEqual(parseMetaAgentChatTurnContext({ pageId: 'p1', blockId: 'b1', refs: target }), { pageId: 'p1', blockId: 'b1', refs: target });
    assert.deepEqual(parseMetaAgentChatTurnContext({ schedule: { workspaceId: 'w1' }, refs }), { schedule: { workspaceId: 'w1' }, refs });
    assert.deepEqual(parseMetaAgentChatTurnContext({ refs }), { refs });
    assert.deepEqual(parseMetaAgentChatTurnContext({ refs: [] }), { refs: [] });
    assert.deepEqual(parseMetaAgentChatTurnContext({}), {});
  });

  test('is not one of the Spaces fields', () => {
    assert.equal(hasSpacesTurnContext(parseMetaAgentChatTurnContext({ refs })), false);
    assert.equal(hasSpacesTurnContext(parseMetaAgentChatTurnContext({ schedule: { workspaceId: null }, refs })), false);
    assert.equal(hasSpacesTurnContext(parseMetaAgentChatTurnContext({ pageId: 'p1', refs: [] })), true);
  });

  test('answers a bad reference, and any other unknown field as before, with the error the route turns into 400', () => {
    assert.throws(() => parseMetaAgentChatTurnContext({ refs: [{ kind: 'thread', id: 'n1' }] }), MetaAgentChatContextError);
    assert.throws(() => parseMetaAgentChatTurnContext({ refs: 'cmp-post-cmr-1' }), MetaAgentChatContextError);
    assert.throws(() => parseMetaAgentChatTurnContext({ refs: null }), MetaAgentChatContextError);
    assert.throws(() => parseMetaAgentChatTurnContext({ ref: [] }), /unknown field: ref/);
  });

  test('a rows reference may leave its rows out, as a hand-off of many rows does (W0 review #18)', () => {
    assert.deepEqual(parseCompanionTurnRefs([{ kind: 'rows', databaseId: 'd1' }]), [{ kind: 'rows', databaseId: 'd1' }]);
    const rowIds = Array.from({ length: COMPANION_TURN_REF_LIMITS.rowIds }, (_, index) => `r${index}`);
    assert.deepEqual(parseCompanionTurnRefs([{ kind: 'rows', databaseId: 'd1', rowIds }]), [{ kind: 'rows', databaseId: 'd1', rowIds }]);
    assert.throws(() => parseCompanionTurnRefs([{ kind: 'rows', databaseId: 'd1', rowIds: [...rowIds, 'one-more'] }]), /leave it out/);
    assert.throws(() => parseCompanionTurnRefs([{ kind: 'rows', databaseId: 'd1', rowIds: null }]), MetaAgentChatContextError);
    assert.throws(() => parseCompanionTurnRefs([{ kind: 'rows' }]), MetaAgentChatContextError);
  });
});
