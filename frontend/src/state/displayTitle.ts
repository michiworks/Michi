import { deriveTitleFromUserText } from './assistantParsing';
import type { ChatNodeState, Project, Tree } from './chatTypes';

/** What a label reads from a node: its title and, when loaded, its messages. */
type TitledNode = Pick<ChatNodeState, 'title'> & Partial<Pick<ChatNodeState, 'messages'>>;

/**
 * nodeDisplayTitle's text and where it came from: `excerpt` when there is no
 * title yet and the text is cut from the first user message (at `max`
 * characters, default the shared title length).
 */
export function nodeDisplayLabel(node: TitledNode | null | undefined, fallback: string, max?: number): { text: string; excerpt: boolean } {
  const title = node?.title?.trim();
  if (title) return { text: title, excerpt: false };
  const excerpt = deriveTitleFromUserText(node?.messages?.find((message) => message.role === 'user')?.text, max);
  return excerpt ? { text: excerpt, excerpt: true } : { text: fallback, excerpt: false };
}

/** A conversation's label: its title, else its first user message, else the caller's word for an untitled one. */
export function nodeDisplayTitle(node: TitledNode | undefined, fallback: string): string {
  return nodeDisplayLabel(node, fallback).text;
}

/**
 * A thread's label: the name the user gave it (Tree.name), else its root's
 * label. The root title is set after the first turn, so reading it first
 * hides a rename.
 */
export function threadDisplayTitle(tree: Pick<Tree, 'name'> | undefined, root: TitledNode | undefined, fallback: string): string {
  return tree?.name?.trim() || nodeDisplayTitle(root, fallback);
}

/** The thread a node is the root of, if it is one. */
export function treeOfRoot(project: Pick<Project, 'trees'>, rootNodeId: string): Tree | undefined {
  return project.trees.find((tree) => tree.rootNodeId === rootNodeId);
}
