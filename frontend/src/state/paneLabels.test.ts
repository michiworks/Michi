import { describe, expect, it } from 'vitest';
import type { ChatNodeState } from './chatTypes';
import type { PaneItem } from './paneItems';
import { paneTitle } from './paneLabels';

function chat(patch: Partial<ChatNodeState> = {}): ChatNodeState {
  return { nodeId: 'n', kind: 'chat', chatId: null, projectId: 'ws', title: '', messages: [], followUps: [], status: 'idle', ...patch } as ChatNodeState;
}
const asked = chat({ messages: [{ id: 'u', role: 'user', text: 'Why does the build fail?', toolCalls: [] }] });
const files = { id: 'f', kind: 'files', projectId: 'ws', treeId: 't', title: '', createdAt: 1 } as PaneItem;

describe('paneTitle', () => {
  it.each([
    ['a titled chat', chat({ title: 'Fix login' }), undefined, undefined, 'Fix login'],
    ['an untitled chat, by its first message', asked, undefined, undefined, 'Why does the build fail?'],
    ['an untitled chat with no message yet', chat(), undefined, undefined, 'New thread'],
    ['a chat in the Assistant workspace', chat({ title: 'Generated' }), undefined, 'Assistant', 'Assistant'],
    ['a titled pane item', undefined, { ...files, title: 'Notes' }, 'Assistant', 'Notes'],
    ['a pane item with an empty title, by its kind', undefined, files, undefined, 'Files'],
    ['a pane whose node is gone', undefined, undefined, undefined, ''],
  ] as const)('names %s', (_case, node, item, override, expected) => {
    expect(paneTitle(node, item, { override })).toBe(expected);
  });
});
