import type { MemoryRecord, MemoryScope } from 'michi-shared';
import type { MemoryProfileLine } from '../../../../services/api/memories';

/**
 * How Settings › Memory › Your memories arranges the memories: by where they
 * apply (everywhere, then each workspace), and within that by topic. A topic
 * is the name its memories carry, compared without case; memories with none
 * share one group, listed last. Its summary is the lines of About the user
 * that rest on its memories.
 */

export const scopeKey = (scope: MemoryScope) => scope.kind === 'user' ? 'user' : `workspace:${scope.workspaceId}`;
export const sameScope = (a: MemoryScope, b: MemoryScope) => scopeKey(a) === scopeKey(b);

const fold = (name: string) => name.trim().toLocaleLowerCase();

/** A memory's topic, trimmed; '' when it has none. */
export const topicOf = (record: MemoryRecord) => record.topic?.trim() ?? '';

export const topicKey = (scope: MemoryScope, name: string) => `${scopeKey(scope)}\u0000${fold(name)}`;

export interface MemoryTopic {
  key: string;
  scope: MemoryScope;
  /** As its newest memory spells it; '' for the memories without a topic. */
  name: string;
  /** Newest change first. */
  memories: MemoryRecord[];
  updatedAt: number;
}

export interface MemoryShelf {
  key: string;
  scope: MemoryScope;
  /** Newest change first; the memories without a topic last. */
  topics: MemoryTopic[];
  count: number;
  updatedAt: number;
}

const newestFirst = (a: { updatedAt: number }, b: { updatedAt: number }) => b.updatedAt - a.updatedAt;

/** Everywhere first, then each workspace, the one changed last first. */
export function shelvesOf(records: readonly MemoryRecord[]): MemoryShelf[] {
  const shelves = new Map<string, { scope: MemoryScope; topics: Map<string, MemoryRecord[]> }>();
  for (const record of [...records].sort(newestFirst)) {
    const shelfKey = scopeKey(record.scope);
    let shelf = shelves.get(shelfKey);
    if (!shelf) shelves.set(shelfKey, shelf = { scope: record.scope, topics: new Map() });
    const key = topicKey(record.scope, topicOf(record));
    const group = shelf.topics.get(key);
    if (group) group.push(record);
    else shelf.topics.set(key, [record]);
  }
  const result = [...shelves.entries()].map(([key, shelf]): MemoryShelf => {
    const topics = [...shelf.topics.entries()].map(([topic, memories]): MemoryTopic => ({
      key: topic, scope: shelf.scope, name: topicOf(memories[0]), memories, updatedAt: memories[0].updatedAt,
    })).sort((a, b) => Number(!a.name) - Number(!b.name) || newestFirst(a, b));
    return {
      key, scope: shelf.scope, topics,
      count: topics.reduce((sum, topic) => sum + topic.memories.length, 0),
      updatedAt: Math.max(...topics.map((topic) => topic.updatedAt)),
    };
  });
  return result.sort((a, b) => Number(b.scope.kind === 'user') - Number(a.scope.kind === 'user') || newestFirst(a, b));
}

export function findTopic(shelves: readonly MemoryShelf[], key: string): MemoryTopic | null {
  for (const shelf of shelves) {
    const topic = shelf.topics.find((candidate) => candidate.key === key);
    if (topic) return topic;
  }
  return null;
}

/**
 * The lines of About the user a topic's page shows as its summary: those
 * resting on one of its memories, and, for a topic that applies everywhere,
 * those About the user files under the same name.
 */
export function summaryOf(topic: MemoryTopic, lines: readonly MemoryProfileLine[]): MemoryProfileLine[] {
  const ids = new Set(topic.memories.map((memory) => memory.id));
  const name = fold(topic.name);
  return lines.filter((line) => line.refs.some((ref) => ids.has(ref.id))
    || (topic.scope.kind === 'user' && !!name && fold(line.topic) === name));
}

/** Every word of the search is in the memory's text, topic or search words. */
export function memoryMatches(record: MemoryRecord, query: string): boolean {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [record.body, record.topic ?? '', ...(record.keywords ?? [])].join('\n').toLocaleLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** The topics in use in a scope, most used first: what a memory's Topic suggests. */
export function topicNamesIn(records: readonly MemoryRecord[], scope: MemoryScope): string[] {
  const counts = new Map<string, { name: string; count: number }>();
  for (const record of [...records].sort(newestFirst)) {
    const name = topicOf(record);
    if (!name || !sameScope(record.scope, scope)) continue;
    const entry = counts.get(fold(name));
    if (entry) entry.count += 1;
    else counts.set(fold(name), { name, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).map((entry) => entry.name);
}
