import { describe, expect, it } from 'vitest';
import { mergeMetaAgentTurnContexts, withCarriedRefs } from '../../services/api/assistant';
import { buildCompanionTurnContext } from './companionTurnContext';

describe('what a message to the agent carries (DESIGN-v2 §1.3)', () => {
  it('sends the Scheduled context in Scheduled even with a target still set; the target rides as a ref (F1a-review #9)', () => {
    const context = buildCompanionTurnContext({
      area: 'scheduled', spaces: null, scheduleWorkspaceId: 'ws-work',
      target: { pageId: 'p1', blockId: 'b1' }, attachments: [], replyTo: null,
    });
    expect(context).toEqual({ schedule: { workspaceId: 'ws-work' }, refs: [{ kind: 'page', pageId: 'p1', blockId: 'b1' }] });
    expect(context).not.toHaveProperty('pageId');
  });

  it('keeps a target as the Spaces block fields in Conversations', () => {
    expect(buildCompanionTurnContext({ area: 'conversations', spaces: null, target: { pageId: 'p1', blockId: 'b1' }, attachments: [], replyTo: null }))
      .toEqual({ pageId: 'p1', blockId: 'b1', refs: [{ kind: 'page', pageId: 'p1', blockId: 'b1' }] });
  });

  it('names the database row an Ask targets, never with an item, and refers to the row for its taint', () => {
    const row = { databaseId: 'database-1', rowId: 'row-7', text: 'F-8 change history' };
    const target = { pageId: 'page-1', blockId: 'db', title: 'F-8 change history', row };
    const refs = [{ kind: 'page', pageId: 'page-1', blockId: 'db' }, { kind: 'rows', databaseId: 'database-1', rowIds: ['row-7'] }];
    const onPage = buildCompanionTurnContext({
      area: 'spaces',
      spaces: { view: { kind: 'page', backendConnectionId: 'local', workspaceId: 'ws-1', pageId: 'page-1' }, workspaces: [], remoteWorkspaces: [] },
      target, attachments: [], replyTo: null,
    });
    expect(onPage).toMatchObject({ pageId: 'page-1', blockId: 'db', blockRow: row, refs });
    expect(onPage).not.toHaveProperty('blockItem');
    expect(buildCompanionTurnContext({ area: 'conversations', spaces: null, target, attachments: [], replyTo: null }))
      .toEqual({ pageId: 'page-1', blockId: 'db', blockRow: row, refs });
    expect(buildCompanionTurnContext({ area: 'conversations', spaces: null, target: { ...target, itemIndex: 0, itemText: 'Ship it' }, attachments: [], replyTo: null }))
      .not.toHaveProperty('blockRow');
  });
});

describe('queued sends combined, and a retry (F1a-review #1)', () => {
  it('keeps every queued send’s refs once, and the area of the last one that had any', () => {
    expect(mergeMetaAgentTurnContexts([undefined, undefined])).toBeUndefined();
    expect(mergeMetaAgentTurnContexts([null, undefined])).toBeNull();
    expect(mergeMetaAgentTurnContexts([
      { schedule: { workspaceId: 'w1' }, refs: [{ kind: 'companion_item', itemId: 'i1' }] },
      null,
      { refs: [{ kind: 'companion_item', itemId: 'i1' }, { kind: 'post', messageId: 'cmp-post-r1' }] },
    ])).toEqual({ schedule: { workspaceId: 'w1' }, refs: [{ kind: 'companion_item', itemId: 'i1' }, { kind: 'post', messageId: 'cmp-post-r1' }] });
  });

  it('adds the original message’s refs to what a retry reads now', () => {
    expect(withCarriedRefs(null, [{ kind: 'post', messageId: 'cmp-post-r1' }])).toEqual({ refs: [{ kind: 'post', messageId: 'cmp-post-r1' }] });
    expect(withCarriedRefs({ pageId: 'p1', blockId: null }, undefined)).toEqual({ pageId: 'p1', blockId: null });
  });
});
