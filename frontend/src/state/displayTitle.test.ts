import type { ChatNodeState } from './chatTypes';
import { nodeDisplayTitle, threadDisplayTitle } from './displayTitle';

const node = (title: string | undefined, userText?: string) => ({
  nodeId: 'n', title, messages: userText === undefined ? [] : [{ id: 'm', role: 'user', text: userText, toolCalls: [] }],
}) as unknown as ChatNodeState;

describe('display titles', () => {
  it.each([
    ['the name the user gave the thread', { name: 'Payment bug' }, node('Debugging foo'), 'Payment bug'],
    ['a blank name falls back to the root title', { name: '  ' }, node('Debugging foo'), 'Debugging foo'],
    ['no thread record', undefined, node('Debugging foo'), 'Debugging foo'],
    ['an untitled root: its first user message, without /btw', {}, node(undefined, '/btw why does foo fail?'), 'why does foo fail?'],
    ['a long first message is cut at 50 characters', {}, node('', 'x'.repeat(60)), `${'x'.repeat(50)}…`],
    ['no title and no loaded message: the caller fallback', {}, node(undefined), 'Untitled thread'],
    ['no root at all', undefined, undefined, 'Untitled thread'],
  ])('%s', (_label, tree, root, expected) => {
    expect(threadDisplayTitle(tree, root, 'Untitled thread')).toBe(expected);
  });

  it('labels a node by its own title, not its thread', () => {
    expect(nodeDisplayTitle(node(' Branch idea '), 'Untitled')).toBe('Branch idea');
    expect(nodeDisplayTitle(node(undefined, '> quoted\nreal question'), 'Untitled')).toBe('real question');
  });
});
