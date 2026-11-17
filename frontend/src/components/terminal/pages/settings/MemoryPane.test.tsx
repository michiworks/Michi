import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MemoryChangedEvent, MemoryProfileCitation, MemoryRecord, MemoryScope, MemoryStatus } from 'michi-shared';
import type { MemoryChangeSubscription, MemoryExtractionStatus, MemoryListQuery, MemoryProfileView } from '../../../../services/api/memories';
import { MemoryApiError } from '../../../../services/api/memories';
import { API_BASE_URL } from '../../../../config/env';
import { resetMemoryNotifications, useMemoryNotifications } from '../../../../state/memory/memoryNotifications';
import { noteMemoryOn } from '../../../../state/memory/conversationMemory';
import { confirmDialog } from '../../../ui/ConfirmDialog';
import { MemoryPane } from './MemoryPane';
import { requestMemoryReveal } from './memoryReveal';

/** A small stand-in for the backend's memory store and routes. */
const backend = vi.hoisted(() => ({
  records: [] as MemoryRecord[],
  mode: 'auto' as 'off' | 'explicit' | 'auto',
  extraction: null as MemoryExtractionStatus | null,
  settingsError: null as Error | null,
  subscriptions: [] as MemoryChangeSubscription[],
  /** The profile of the user; null: a backend without one. */
  profile: null as MemoryProfileView | null,
  /** What the user answers in the confirmation dialog. */
  confirm: true,
}));
const nav = vi.hoisted(() => ({
  revealNode: vi.fn(),
  projects: [] as Array<Record<string, unknown>>,
  activeProjectId: 'ws-1' as string | null,
}));

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }) }));
vi.mock('../../../ui/ConfirmDialog', () => ({ confirmDialog: vi.fn(async () => backend.confirm) }));
vi.mock('../../../../state/memory/conversationMemory', () => ({ noteMemoryOn: vi.fn() }));
vi.mock('../../../../state/chatStore', () => ({
  useChatProjects: () => ({
    projects: nav.projects,
    activeProjectId: nav.activeProjectId,
    activeProject: nav.projects.find((project) => project.id === nav.activeProjectId) ?? null,
  }),
  useChatActions: () => ({ revealNode: nav.revealNode }),
}));
vi.mock('../../../../services/api/memories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../services/api/memories')>();
  const find = (id: string) => {
    const record = backend.records.find((item) => item.id === id);
    if (!record) throw new actual.MemoryApiError(404, 'Memory not found', { code: 'not_found' });
    return record;
  };
  const matches = (record: MemoryRecord, query: MemoryListQuery) => {
    const statuses: readonly MemoryStatus[] = query.status ?? ['active', 'pending'];
    return statuses.includes(record.status);
  };
  let next = 100;
  return {
    ...actual,
    listMemories: vi.fn(async (query: MemoryListQuery = {}) => {
      const items = backend.records.filter((record) => matches(record, query)).sort((a, b) => b.createdAt - a.createdAt);
      const start = query.cursor ? Number(query.cursor) : 0;
      const limit = query.limit ?? 50;
      return { items: items.slice(start, start + limit).map((item) => ({ ...item })), nextCursor: start + limit < items.length ? String(start + limit) : null };
    }),
    updateMemory: vi.fn(async (id: string, patch: { body?: string; scope?: MemoryScope; kind?: MemoryRecord['kind']; topic?: string | null; validUntil?: number | null; expectedVersion: number }) => {
      const record = find(id);
      if (record.version !== patch.expectedVersion) {
        throw new actual.MemoryApiError(409, 'The memory changed since it was read', { code: 'version_conflict', currentVersion: record.version });
      }
      for (const key of ['body', 'scope', 'kind', 'topic', 'validUntil'] as const) if (patch[key] !== undefined) Object.assign(record, { [key]: patch[key] });
      record.version += 1;
      record.updatedAt = Date.now();
      return { ...record };
    }),
    deleteMemory: vi.fn(async (id: string) => { find(id); backend.records = backend.records.filter((item) => item.id !== id); }),
    createMemory: vi.fn(async (input: { scope: MemoryScope; kind: MemoryRecord['kind']; body: string; topic?: string }) => {
      if (backend.mode === 'off') throw new actual.MemoryApiError(409, 'Memory is turned off', { code: 'memory_disabled' });
      const record = memory(`mem-new-${next}`, input.body, { scope: input.scope, kind: input.kind, topic: input.topic ?? null, createdAt: next++, updatedAt: Date.now() });
      backend.records.push(record);
      return { ...record };
    }),
    fetchMemorySettings: vi.fn(async () => {
      if (backend.settingsError) throw backend.settingsError;
      return { mode: backend.mode };
    }),
    saveMemorySettings: vi.fn(async (mode: typeof backend.mode) => { backend.mode = mode; return { mode }; }),
    fetchMemoryExtractionStatus: vi.fn(async () => backend.extraction),
    setMemoryExtractionPaused: vi.fn(async (paused: boolean) => {
      backend.extraction = backend.extraction ? { ...backend.extraction, paused } : null;
      return backend.extraction;
    }),
    subscribeMemoryChanges: (options: MemoryChangeSubscription) => { backend.subscriptions.push(options); return () => {}; },
    fetchMemoryProfile: vi.fn(async () => backend.profile && structuredClone(backend.profile)),
    // Guesses have their own tests (MemoryGuesses.test.tsx): this backend has none.
    fetchMemoryGuesses: vi.fn(async () => []),
    rebuildMemoryProfile: vi.fn(async () => {
      backend.profile = { ...backend.profile!, rebuildRequested: true };
      return structuredClone(backend.profile);
    }),
    resetMemories: vi.fn(async () => {
      const removed = backend.records.length;
      backend.records = [];
      if (backend.profile) backend.profile = { ...backend.profile, lines: [] };
      return { removed };
    }),
  };
});

import * as api from '../../../../services/api/memories';

function memory(id: string, body: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id, ownerUserId: 'local', scope: { kind: 'user' }, kind: 'preference', body, source: null, status: 'active',
    origin: 'explicit', version: 1, supersedesId: null, sourceRisk: null, createdAt: 1, updatedAt: Date.now() - 5 * 60_000, ...overrides,
  };
}

const cite = (id: string): MemoryProfileCitation => ({ ref: `m:${id}v1`, id, body: backend.records.find((record) => record.id === id)!.body });
function profile(lines: Array<{ topic: string; text: string; refs: string[] }>): MemoryProfileView {
  return { lines: lines.map((line, index) => ({ index, topic: line.topic, text: line.text, refs: line.refs.map(cite) })), builtAt: Date.now() - 2 * 3600_000, version: 3, rebuildRequested: false };
}

const titles = (root: HTMLElement = document.body) => Array.from(root.querySelectorAll('.settings-history__title')).map((title) => title.textContent);
const group = (name: RegExp) => screen.getByRole('region', { name });
const heading = (name: string) => screen.findByRole('heading', { level: 1, name });
async function openManage() {
  fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
  await heading('Your memories');
  await waitFor(() => expect(titles().length).toBeGreaterThan(0));
}
const open = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

beforeEach(() => {
  vi.clearAllMocks();
  resetMemoryNotifications();
  backend.mode = 'auto';
  backend.extraction = null;
  backend.settingsError = null;
  backend.subscriptions = [];
  backend.profile = null;
  backend.confirm = true;
  backend.records = [
    memory('mem-short', 'Short answers', { createdAt: 4, topic: 'answers', origin: 'extracted' }),
    memory('mem-user', 'Answer in Chinese', { createdAt: 3, topic: 'Answers', updatedAt: Date.now() - 60_000 }),
    memory('mem-ws', 'Use 2 spaces in this repo', { createdAt: 2, topic: 'Code style', kind: 'convention', origin: 'extracted', scope: { kind: 'workspace', workspaceId: 'ws-1' }, source: { nodeId: 'n-1' } }),
    memory('mem-other', 'Beta deploys on Fridays', { createdAt: 1, kind: 'fact', scope: { kind: 'workspace', workspaceId: 'ws-2' } }),
  ];
  nav.projects = [
    { id: 'ws-1', name: 'Alpha', chatIds: ['n-1'], trees: [{ id: 't-1', rootNodeId: 'n-1' }], edges: [], activeTreeId: 't-1' },
    { id: 'ws-2', name: 'Beta', chatIds: [], trees: [], edges: [], activeTreeId: null },
  ];
  nav.activeProjectId = 'ws-1';
  nav.revealNode.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetMemoryNotifications();
});

describe('Settings › Memory › Your memories', () => {
  it('counts memories and topics on Settings, then lists topics where they apply, a topic named in any case once', async () => {
    render(<MemoryPane />);
    expect(await screen.findByText('4 memories · 2 topics')).toBeTruthy();
    await openManage();
    expect(titles(group(/^Everywhere/))).toEqual(['Answers']);
    expect(titles(group(/^Alpha/))).toEqual(['Code style']);
    // A memory without a topic is under Other.
    expect(titles(group(/^Beta/))).toEqual(['Other']);
    expect(screen.getByRole('button', { name: 'Answers' }).getAttribute('aria-describedby')).toBeTruthy();
    expect(group(/^Everywhere/).textContent).toContain('2 memories');
    // Escape goes back to Settings › Memory, to the button that opened it.
    fireEvent.keyDown(screen.getByRole('heading', { level: 1, name: 'Your memories' }), { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Manage' })));
  });

  it('a search lists the memories themselves, by text, topic or search words, and says when nothing matches', async () => {
    backend.records.push(memory('mem-job', 'Works at Example Studio', { createdAt: 0, kind: 'fact', keywords: ['工作'] }));
    render(<MemoryPane />);
    await openManage();
    const search = screen.getByRole('searchbox', { name: 'Search memories' });
    fireEvent.change(search, { target: { value: '工作' } });
    expect(titles()).toEqual(['Works at Example Studio']);
    fireEvent.change(search, { target: { value: 'code style' } });
    expect(titles()).toEqual(['Use 2 spaces in this repo']);
    fireEvent.change(search, { target: { value: 'nothing like this' } });
    expect(screen.getByText('No matching memories')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show all memories' }));
    expect(titles()).toEqual(['Answers', 'Other', 'Code style', 'Other']);
  });

  it('a topic shows the About the user lines resting on its memories, then each memory; a memory says where it came from', async () => {
    backend.profile = profile([
      { topic: 'Answers', text: 'Wants answers in Chinese', refs: ['mem-user'] },
      { topic: 'Repo', text: 'Two-space indents', refs: ['mem-ws'] },
    ]);
    render(<MemoryPane />);
    await openManage();
    open('Answers');
    await heading('Answers');
    expect(within(screen.getByRole('region', { name: 'Summary' })).getAllByRole('listitem').map((line) => line.textContent)).toEqual(['Wants answers in Chinese']);
    expect(titles(screen.getByRole('region', { name: 'Memories' }))).toEqual(['Answer in Chinese', 'Short answers']);

    fireEvent.click(screen.getByRole('button', { name: 'Your memories' }));
    await heading('Your memories');
    // Back puts focus on the row it opened.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Answers' })));
    open('Code style');
    expect(within(await screen.findByRole('region', { name: 'Summary' })).getByText('Two-space indents')).toBeTruthy();
    open('Use 2 spaces in this repo');
    await heading('Use 2 spaces in this repo');
    const details = screen.getByRole('region', { name: 'Details' });
    expect((within(details).getByRole('combobox', { name: 'Kind' }) as HTMLSelectElement).value).toBe('convention');
    expect((within(details).getByRole('combobox', { name: 'Applies to' }) as HTMLSelectElement).selectedOptions[0].textContent).toBe('Alpha');
    expect(details.textContent).toContain('Automatically');
    fireEvent.click(within(details).getByRole('button', { name: 'Open conversation' }));
    expect(nav.revealNode).toHaveBeenCalledWith('n-1');
  });

  it('offers only Everywhere as a scope while the open workspace is on another machine', async () => {
    nav.projects = [{ id: 'remote:dd:ws-9', name: 'Remote', chatIds: [], backendConnectionId: 'dd' }];
    nav.activeProjectId = 'remote:dd:ws-9';
    render(<MemoryPane />);
    await openManage();
    open('Answers');
    open('Answer in Chinese');
    await heading('Answer in Chinese');
    expect(within(screen.getByRole('combobox', { name: 'Applies to' })).getAllByRole('option').map((option) => option.textContent)).toEqual(['Everywhere']);
  });

  it('edits a memory; on a conflict it shows the current text instead of overwriting it', async () => {
    render(<MemoryPane />);
    await openManage();
    open('Answers');
    open('Answer in Chinese');
    await heading('Answer in Chinese');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Memory' }), { target: { value: 'Answer in Chinese, code in English' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await heading('Answer in Chinese, code in English');
    expect(api.updateMemory).toHaveBeenLastCalledWith('mem-user', { body: 'Answer in Chinese, code in English', expectedVersion: 1 });
    // The editor closes back to Edit, with focus.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit' }));

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Memory' }), { target: { value: 'Mine' } });
    Object.assign(backend.records.find((record) => record.id === 'mem-user')!, { body: 'Theirs', version: 9 });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('This memory changed somewhere else, so your edit wasn’t saved. It shows its current version now.')).toBeTruthy();
    await heading('Theirs');
  });

  it('moves a memory to another topic; Back returns to the topic it came from, or to Your memories once that is empty', async () => {
    render(<MemoryPane />);
    await openManage();
    open('Answers');
    open('Answer in Chinese');
    const topic = await screen.findByRole('combobox', { name: 'Topic' });
    expect(Array.from(document.getElementById(topic.getAttribute('list')!)!.querySelectorAll('option')).map((option) => option.value)).toEqual(['Answers']);
    fireEvent.change(topic, { target: { value: 'Language' } });
    fireEvent.keyDown(topic, { key: 'Enter' });
    await waitFor(() => expect(api.updateMemory).toHaveBeenCalledWith('mem-user', { topic: 'Language', expectedVersion: 1 }));
    fireEvent.click(screen.getByRole('button', { name: 'answers' }));
    await heading('answers');
    expect(titles(screen.getByRole('region', { name: 'Memories' }))).toEqual(['Short answers']);

    open('Short answers');
    await heading('Short answers');
    fireEvent.change(screen.getByRole('combobox', { name: 'Topic' }), { target: { value: '' } });
    fireEvent.blur(screen.getByRole('combobox', { name: 'Topic' }));
    await waitFor(() => expect(api.updateMemory).toHaveBeenLastCalledWith('mem-short', { topic: null, expectedVersion: 1 }));
    fireEvent.click(screen.getByRole('button', { name: 'Your memories' }));
    await heading('Your memories');
    expect(titles(group(/^Everywhere/))).toEqual(['Language', 'Other']);
  });

  it('shows the last day a memory is true, and sets, changes and clears it on its page', async () => {
    const later = new Date();
    later.setHours(0, 0, 0, 0);
    later.setDate(later.getDate() + 6);
    const lastDay = new Date(later.getTime() - 1);
    const day = (date: Date) => date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    const pad = (value: number) => String(value).padStart(2, '0');
    Object.assign(backend.records.find((record) => record.id === 'mem-user')!, { validUntil: later.getTime() });
    Object.assign(backend.records.find((record) => record.id === 'mem-short')!, { validUntil: new Date(2020, 0, 2).getTime() });
    render(<MemoryPane />);
    await openManage();
    open('Answers');
    await heading('Answers');
    const meta = (name: string) => screen.getByRole('button', { name }).querySelector('.settings-history__meta')?.textContent;
    expect(meta('Answer in Chinese')).toContain(`Until ${day(lastDay)}`);
    expect(meta('Short answers')).toContain(`Ended ${day(new Date(2020, 0, 1))}`);

    open('Answer in Chinese');
    await heading('Answer in Chinese');
    const date = screen.getByLabelText('Last day it’s true') as HTMLInputElement;
    expect(date.value).toBe(`${lastDay.getFullYear()}-${pad(lastDay.getMonth() + 1)}-${pad(lastDay.getDate())}`);
    fireEvent.change(date, { target: { value: '2030-01-31' } });
    fireEvent.blur(date);
    await waitFor(() => expect(api.updateMemory).toHaveBeenLastCalledWith('mem-user', { validUntil: new Date(2030, 1, 1).getTime(), expectedVersion: 1 }));
    fireEvent.click(await screen.findByRole('button', { name: 'No end date' }));
    await waitFor(() => expect(api.updateMemory).toHaveBeenLastCalledWith('mem-user', { validUntil: null, expectedVersion: 2 }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'No end date' })).toBeNull());
    // The field takes the saved value in an effect after the render that drops No end date.
    await waitFor(() => expect((screen.getByLabelText('Last day it’s true') as HTMLInputElement).value).toBe(''));
  });

  it('deletes a memory after asking; a topic goes with its memories, and one deleted only in part says so', async () => {
    backend.records.push(memory('mem-third', 'Bullet points over prose', { createdAt: 0, topic: 'Answers' }));
    render(<MemoryPane />);
    await openManage();
    open('Answers');
    open('Short answers');
    backend.confirm = false;
    fireEvent.click(await screen.findByRole('button', { name: 'Delete…' }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(api.deleteMemory).not.toHaveBeenCalled();
    backend.confirm = true;
    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    await heading('Answers');
    expect(api.deleteMemory).toHaveBeenCalledWith('mem-short');

    vi.mocked(api.deleteMemory).mockImplementationOnce(async () => { backend.records = backend.records.filter((item) => item.id !== 'mem-user'); })
      .mockRejectedValueOnce(new Error('offline'));
    expect(titles(screen.getByRole('region', { name: 'Memories' }))).toEqual(['Answer in Chinese', 'Bullet points over prose']);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Answers…' }));
    expect(await screen.findByText('Deleted 1 of 2. Couldn’t delete the rest: offline')).toBeTruthy();
    await waitFor(() => expect(titles(screen.getByRole('region', { name: 'Memories' }))).toEqual(['Bullet points over prose']));
  });

  it('adds a memory with its topic from the topic’s page; Your memories offers no Add while memory is off', async () => {
    render(<MemoryPane />);
    await openManage();
    open('Answers');
    fireEvent.click(await screen.findByRole('button', { name: 'Add memory' }));
    const add = screen.getByRole('group', { name: 'Add memory' });
    expect((within(add).getByRole('combobox', { name: 'Topic' }) as HTMLInputElement).value).toBe('Answers');
    fireEvent.change(within(add).getByRole('textbox', { name: 'New memory' }), { target: { value: 'Use tables for comparisons' } });
    fireEvent.click(within(add).getByRole('button', { name: 'Save memory' }));
    await waitFor(() => expect(titles(screen.getByRole('region', { name: 'Memories' }))[0]).toBe('Use tables for comparisons'));
    expect(api.createMemory).toHaveBeenCalledWith({ scope: { kind: 'user' }, kind: 'preference', body: 'Use tables for comparisons', topic: 'Answers' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add memory' }));
    cleanup();

    backend.mode = 'off';
    render(<MemoryPane />);
    await openManage();
    expect(screen.queryByRole('button', { name: 'Add memory' })).toBeNull();
  });

  it('opens the memory a reply’s Edit names; one this machine doesn’t list is searched for by its text', async () => {
    requestMemoryReveal({ id: 'mem-other', body: 'Beta deploys on Fridays' });
    render(<MemoryPane />);
    await heading('Beta deploys on Fridays');
    act(() => requestMemoryReveal({ id: 'mem-elsewhere', body: 'Kept on another machine' }));
    await heading('Your memories');
    expect((screen.getByRole('searchbox', { name: 'Search memories' }) as HTMLInputElement).value).toBe('Kept on another machine');
    expect(screen.getByText('No matching memories')).toBeTruthy();
  });

  it('reads every page of memories, and reads them again when one changes elsewhere, without moving focus', async () => {
    function Feed() {
      useMemoryNotifications(() => {});
      return null;
    }
    backend.records = Array.from({ length: 250 }, (_, index) => memory(`mem-${index}`, `Memory ${index}`, { createdAt: index, topic: index < 200 ? 'Many' : 'Few' }));
    render(<><Feed /><MemoryPane /></>);
    expect(await screen.findByText('250 memories · 2 topics')).toBeTruthy();
    expect(api.listMemories).toHaveBeenCalledTimes(2);
    await openManage();
    const search = screen.getByRole('searchbox', { name: 'Search memories' });
    search.focus();
    backend.records.push(memory('mem-auto', 'Use Vitest, not Jest', { createdAt: 900, topic: 'Tests', origin: 'extracted', updatedAt: Date.now() }));
    act(() => backend.subscriptions[0].onEvent({
      ownerUserId: 'local', workspaceId: null, memoryId: 'mem-auto', action: 'created', status: 'active', body: 'Use Vitest, not Jest', origin: 'extracted', supersedesId: null,
    } satisfies MemoryChangedEvent));
    await waitFor(() => expect(titles(group(/^Everywhere/))[0]).toBe('Tests'));
    expect(document.activeElement).toBe(search);
  });

  it('Rebuild asks automatic memory to write About the user again', async () => {
    backend.profile = profile([{ topic: 'Answers', text: 'Wants answers in Chinese', refs: ['mem-user'] }]);
    render(<MemoryPane />);
    await openManage();
    expect(group(/^Everywhere/).textContent).toContain('Summaries written 2h ago');
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Rebuilding…' }) as HTMLButtonElement).disabled).toBe(true));
    expect(api.rebuildMemoryProfile).toHaveBeenCalledTimes(1);
  });

  it('Delete all memories asks first, then deletes every memory', async () => {
    render(<MemoryPane />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete all…' }));
    expect(await screen.findByText('Deleted 4 memories.')).toBeTruthy();
    expect(await screen.findByText('Nothing yet. See, add, edit or delete what Michi remembers.')).toBeTruthy();
  });
});

describe('Settings › Memory', () => {
  it('is one switch: on by default (an older backend’s explicit mode too), and off keeps saved memories', async () => {
    backend.mode = 'explicit';
    render(<MemoryPane />);
    const toggle = await screen.findByRole('switch', { name: 'Use memory' }) as HTMLButtonElement;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('radio')).toBeNull();
    // What it does is behind its “?”, not in paragraphs under it.
    expect(document.querySelector('.settings-section__intro')).toBeNull();
    const row = toggle.closest('.settings-row') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'More about this setting' }));
    expect(row.textContent).toContain('Agents read your memories and save what you tell them. Turning it off keeps saved memories and chat history. To keep one chat out of memory, start a temporary chat from Home.');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.disabled).toBe(false));
    expect(api.saveMemorySettings).toHaveBeenCalledWith('off');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('4 memories · 2 topics')).toBeTruthy();
    // What this window shows of memory under replies follows.
    expect(noteMemoryOn).toHaveBeenLastCalledWith(API_BASE_URL, false);
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    expect(api.saveMemorySettings).toHaveBeenLastCalledWith('auto');
    expect(noteMemoryOn).toHaveBeenLastCalledWith(API_BASE_URL, true);
  });

  it('puts the switch back when saving it fails', async () => {
    vi.mocked(api.saveMemorySettings).mockRejectedValueOnce(new Error('offline'));
    render(<MemoryPane />);
    const toggle = await screen.findByRole('switch', { name: 'Use memory' });
    fireEvent.click(toggle);
    expect(await screen.findByText('Couldn’t turn memory off: offline')).toBeTruthy();
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('turns Learn from conversations on and off with its own switch, off by default (Q28), with its state under it while on', async () => {
    backend.extraction = { enabled: true, paused: true, lastRunAt: Date.now() - 2 * 3600_000, lastError: null, todayTokens: 1200, dailyTokenLimit: 50000 };
    render(<MemoryPane />);
    const learn = await screen.findByRole('switch', { name: 'Learn from conversations' });
    expect(learn.getAttribute('aria-checked')).toBe('false');
    const row = learn.closest('.settings-row') as HTMLElement;
    expect(row.querySelector('.settings-row__desc')).toBeNull();
    // Q17: usage is recorded, not shown; no Details to open.
    expect(screen.queryByText(/tokens/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
    fireEvent.click(learn);
    await waitFor(() => expect(learn.getAttribute('aria-checked')).toBe('true'));
    expect(api.setMemoryExtractionPaused).toHaveBeenLastCalledWith(false);
    expect(row.querySelector('.settings-row__desc')?.textContent).toBe('Running · last run 2h ago');
    backend.extraction = { ...backend.extraction, lastError: 'model timed out' };
    fireEvent.click(learn);
    await waitFor(() => expect(learn.getAttribute('aria-checked')).toBe('false'));
    expect(api.setMemoryExtractionPaused).toHaveBeenLastCalledWith(true);
    // An error from before it was turned off is not news while it is off.
    expect(within(row).queryByRole('alert')).toBeNull();
  });

  it('says why learning is held, offers Try again only where it helps, and has no switch where the backend can’t learn', async () => {
    const base = { enabled: true, paused: false, lastRunAt: null, lastError: null, todayTokens: 0, dailyTokenLimit: 1000 };
    backend.extraction = { ...base, state: 'stopped', stateReason: 'Runs stopped after 5 failures in “Docs”.' };
    const { unmount } = render(<MemoryPane />);
    const learn = await screen.findByRole('switch', { name: 'Learn from conversations' });
    const row = learn.closest('.settings-row') as HTMLElement;
    await waitFor(() => expect(row.textContent).toContain('Stopped after repeated failures'));
    expect(row.textContent).toContain('Runs stopped after 5 failures in “Docs”.');
    fireEvent.click(within(row).getByRole('button', { name: 'Try again' }));
    expect(api.setMemoryExtractionPaused).toHaveBeenLastCalledWith(false);
    unmount();

    backend.extraction = { ...base, state: 'budget_exhausted' };
    const budget = render(<MemoryPane />);
    expect((await screen.findByRole('switch', { name: 'Learn from conversations' })).closest('.settings-row')!.textContent).toContain('Daily limit reached · resumes tomorrow');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    budget.unmount();

    backend.extraction = { ...base, state: 'unsupported', supported: false, stateReason: 'Kiro Crew can’t run the Meta agent.' };
    render(<MemoryPane />);
    expect(await screen.findByText('This backend can’t read conversations in the background.')).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'Learn from conversations' })).toBeNull();
  });

  it('says so on a backend without automatic memory, and hides Learn from conversations while memory is off', async () => {
    backend.extraction = null;
    render(<MemoryPane />);
    expect(await screen.findByText('This Michi backend can’t save memories in the background yet.')).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'Learn from conversations' })).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Use memory' }));
    await waitFor(() => expect(screen.queryByText('Learn from conversations')).toBeNull());
  });

  it('says so when this backend has no Memory at all', async () => {
    backend.settingsError = new MemoryApiError(404, 'Not found');
    render(<MemoryPane />);
    expect(await screen.findByText('This Michi backend doesn’t support Memory yet. Its settings appear here once it does.')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });
});
