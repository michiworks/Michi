import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MemoryChangedEvent, MemoryProfileCitation, MemoryRecord, MemoryScope, MemoryStatus } from 'michi-shared';
import type { MemoryChangeSubscription, MemoryExtractionStatus, MemoryListQuery, MemoryProfileView } from '../../../../services/api/memories';
import { MemoryApiError } from '../../../../services/api/memories';
import { API_BASE_URL } from '../../../../config/env';
import { resetMemoryNotifications, useMemoryNotifications } from '../../../../state/memory/memoryNotifications';
import { noteMemoryOn } from '../../../../state/memory/conversationMemory';
import { resetCompanionStoreForTests } from '../../../../state/companion/companionStore';
import { companionSnapshot } from '../../../../test/companionFixtures';
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
  calls: [] as string[],
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
    if (!statuses.includes(record.status)) return false;
    if (query.scope === 'user' && record.scope.kind !== 'user') return false;
    if (query.scope === 'workspace' && (record.scope.kind !== 'workspace' || (query.workspaceId && record.scope.workspaceId !== query.workspaceId))) return false;
    return !query.q || query.q.split(/\s+/).every((term) => record.body.includes(term));
  };
  let next = 100;
  return {
    ...actual,
    listMemories: vi.fn(async (query: MemoryListQuery = {}) => {
      backend.calls.push(`list ${JSON.stringify({ ...query, signal: undefined })}`);
      const items = backend.records.filter((record) => matches(record, query)).sort((a, b) => b.createdAt - a.createdAt);
      const start = query.cursor ? Number(query.cursor) : 0;
      const limit = query.limit ?? 50;
      return { items: items.slice(start, start + limit), nextCursor: start + limit < items.length ? String(start + limit) : null };
    }),
    updateMemory: vi.fn(async (id: string, patch: { body?: string; scope?: MemoryScope; expectedVersion: number }) => {
      const record = find(id);
      if (record.version !== patch.expectedVersion) {
        throw new actual.MemoryApiError(409, 'The memory changed since it was read', { code: 'version_conflict', currentVersion: record.version });
      }
      Object.assign(record, patch.body !== undefined ? { body: patch.body } : {}, patch.scope ? { scope: patch.scope } : {});
      record.version += 1;
      record.updatedAt = Date.now();
      return { ...record };
    }),
    deleteMemory: vi.fn(async (id: string) => { find(id); backend.records = backend.records.filter((item) => item.id !== id); }),
    createMemory: vi.fn(async (input: { scope: MemoryScope; kind: MemoryRecord['kind']; body: string }) => {
      if (backend.mode === 'off') throw new actual.MemoryApiError(409, 'Memory is turned off', { code: 'memory_disabled' });
      const record = memory(`mem-new-${next}`, input.body, { scope: input.scope, kind: input.kind, createdAt: next++ });
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
    rebuildMemoryProfile: vi.fn(async () => {
      backend.profile = { ...backend.profile!, rebuildRequested: true };
      return structuredClone(backend.profile);
    }),
    // As the backend: by the line's place, at the version read; its memories go, and the line with them.
    removeMemoryProfileLine: vi.fn(async (index: number, version: number) => {
      const profile = backend.profile!;
      if (version !== profile.version) throw new actual.MemoryApiError(409, 'The profile changed since it was read', { code: 'version_conflict' });
      const line = profile.lines.find((candidate) => candidate.index === index);
      if (!line) throw new actual.MemoryApiError(404, 'Profile line not found', { code: 'not_found' });
      const cited = new Set(line.refs.map((ref) => ref.id));
      backend.records = backend.records.filter((record) => !cited.has(record.id));
      backend.profile = { ...profile, lines: profile.lines.filter((candidate) => candidate !== line).map((candidate, place) => ({ ...candidate, index: place })) };
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

const list = (name: string) => screen.getByRole('list', { name });
const item = (listName: string, text: string) => within(list(listName)).getByRole('listitem', { name: text });
const savedBodies = () => within(list('Saved memories')).getAllByRole('listitem').map((row) => row.querySelector('.memory-item__body')?.textContent);

const cite = (id: string): MemoryProfileCitation => ({ ref: `m:${id}v1`, id, body: backend.records.find((record) => record.id === id)!.body });
function profile(lines: Array<{ topic: string; text: string; refs: string[] }>, overrides: Partial<MemoryProfileView> = {}): MemoryProfileView {
  return {
    lines: lines.map((line, index) => ({ index, topic: line.topic, text: line.text, refs: line.refs.map(cite) })),
    builtAt: Date.now() - 2 * 3600_000, version: 3, rebuildRequested: false, ...overrides,
  };
}
const aboutSection = () => screen.findByRole('region', { name: 'About the user' });
const profileLine = (section: HTMLElement, text: string) => within(section).getByText(text).closest('li')!;

beforeEach(() => {
  vi.clearAllMocks();
  resetMemoryNotifications();
  backend.mode = 'auto';
  backend.extraction = null;
  backend.settingsError = null;
  backend.subscriptions = [];
  backend.calls = [];
  backend.profile = null;
  backend.confirm = true;
  backend.records = [
    memory('mem-user', 'Answer in Chinese', { createdAt: 3, origin: 'explicit' }),
    memory('mem-ws', 'Use 2 spaces in this repo', { createdAt: 2, kind: 'convention', origin: 'extracted', scope: { kind: 'workspace', workspaceId: 'ws-1' }, source: { nodeId: 'n-1' } }),
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

describe('Settings › Memory, opened from under a reply (Edit)', () => {
  it('takes a reveal waiting when it mounts, and one that comes while it is open: the memory is found and marked', async () => {
    requestMemoryReveal({ id: 'mem-other', body: 'Beta deploys on Fridays' });
    render(<MemoryPane />);
    await waitFor(() => expect(item('Saved memories', 'Beta deploys on Fridays').getAttribute('data-marked')).toBe('true'));
    await waitFor(() => expect(document.activeElement).toBe(item('Saved memories', 'Beta deploys on Fridays')));
    act(() => requestMemoryReveal({ id: 'mem-user', body: 'Answer in Chinese' }));
    await waitFor(() => expect(item('Saved memories', 'Answer in Chinese').getAttribute('data-marked')).toBe('true'));
  });
});

describe('Settings › Memory', () => {
  it('lists saved memories with kind, scope, origin and update time, and filters by scope and search', async () => {
    render(<MemoryPane />);
    await waitFor(() => expect(savedBodies()).toEqual(['Answer in Chinese', 'Use 2 spaces in this repo', 'Beta deploys on Fridays']));
    // This backend has no profile of the user: no About the user.
    expect(screen.queryByRole('region', { name: 'About the user' })).toBeNull();
    const ws = item('Saved memories', 'Use 2 spaces in this repo');
    expect(ws.querySelector('.memory-item__meta')?.textContent).toBe('ConventionAlphaAutomaticUpdated 5m agoOpen conversation');
    expect(item('Saved memories', 'Answer in Chinese').querySelector('.memory-item__meta')?.textContent).toContain('PreferenceGlobalExplicit');
    expect(item('Saved memories', 'Beta deploys on Fridays').textContent).toContain('Beta');

    const filter = screen.getByRole('combobox', { name: 'Show memories' });
    expect(within(filter).getAllByRole('option').map((option) => option.textContent)).toEqual(['All memories', 'Global only', 'Alpha only']);
    fireEvent.change(filter, { target: { value: 'user' } });
    await waitFor(() => expect(savedBodies()).toEqual(['Answer in Chinese']));
    fireEvent.change(filter, { target: { value: 'workspace' } });
    await waitFor(() => expect(savedBodies()).toEqual(['Use 2 spaces in this repo']));
    expect(backend.calls).toContain(`list ${JSON.stringify({ status: ['active'], scope: 'workspace', workspaceId: 'ws-1', limit: 50 })}`);

    fireEvent.change(filter, { target: { value: 'all' } });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search memories' }), { target: { value: 'Fridays' } });
    await waitFor(() => expect(savedBodies()).toEqual(['Beta deploys on Fridays']));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search memories' }), { target: { value: 'nothing like it' } });
    expect(await screen.findByText('No memories match “nothing like it”.')).toBeTruthy();
  });

  it('offers no workspace filter while the open workspace is on another machine', async () => {
    nav.projects = [{ id: 'remote:dd:ws-9', name: 'Remote', chatIds: [], backendConnectionId: 'dd' }];
    nav.activeProjectId = 'remote:dd:ws-9';
    render(<MemoryPane />);
    await waitFor(() => expect(savedBodies()).toHaveLength(3));
    expect(within(screen.getByRole('combobox', { name: 'Show memories' })).getAllByRole('option').map((option) => option.textContent))
      .toEqual(['All memories', 'Global only']);
  });

  it('offers Show more only for the list it would continue', async () => {
    backend.records = Array.from({ length: 60 }, (_, index) => memory(`mem-${index}`, `Memory ${index}`, { createdAt: index }));
    render(<MemoryPane />);
    expect(await screen.findByRole('button', { name: 'Show more' })).toBeTruthy();
    const read = vi.mocked(api.listMemories).getMockImplementation()!;
    let answer!: () => void;
    vi.mocked(api.listMemories).mockImplementationOnce((query) => new Promise((resolve) => { answer = () => resolve(read(query)); }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Show memories' }), { target: { value: 'user' } });
    await waitFor(() => expect(vi.mocked(api.listMemories).mock.calls.some(([query]) => query?.scope === 'user')).toBe(true));
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();

    await act(async () => { answer(); });
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(within(list('Saved memories')).getAllByRole('listitem')).toHaveLength(60));
    expect(vi.mocked(api.listMemories).mock.calls.at(-1)?.[0]).toMatchObject({ scope: 'user', cursor: '50' });
  });

  it('edits a memory inline', async () => {
    render(<MemoryPane />);
    const row = await waitFor(() => item('Saved memories', 'Answer in Chinese'));
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(row).getByRole('textbox', { name: 'Edit memory' }), { target: { value: 'Answer in Chinese, code in English' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(savedBodies()[0]).toBe('Answer in Chinese, code in English'));
    expect(api.updateMemory).toHaveBeenCalledWith('mem-user', { body: 'Answer in Chinese, code in English', expectedVersion: 1 });
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])('keeps an edit and a new memory on the Esc that ends an IME composition (%o)', async (ime) => {
    render(<MemoryPane />);
    const row = await waitFor(() => item('Saved memories', 'Answer in Chinese'));
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    const editor = within(row).getByRole('textbox', { name: 'Edit memory' });
    fireEvent.change(editor, { target: { value: '用中文回答' } });
    fireEvent.keyDown(editor, { key: 'Escape', ...ime });
    expect(within(row).getByRole('textbox', { name: 'Edit memory' })).toHaveProperty('value', '用中文回答');

    fireEvent.click(screen.getByRole('button', { name: 'Add memory' }));
    const body = within(screen.getByRole('group', { name: 'Add memory' })).getByRole('textbox', { name: 'New memory' });
    fireEvent.change(body, { target: { value: '小提交' } });
    fireEvent.keyDown(body, { key: 'Escape', ...ime });
    expect(within(screen.getByRole('group', { name: 'Add memory' })).getByRole('textbox', { name: 'New memory' })).toHaveProperty('value', '小提交');
  });

  it('on a conflict, reloads and shows the current text instead of overwriting it', async () => {
    render(<MemoryPane />);
    const row = await waitFor(() => item('Saved memories', 'Answer in Chinese'));
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    // Meanwhile an agent corrects the same memory.
    Object.assign(backend.records[0], { body: 'Answer in Japanese', version: 2 });
    fireEvent.change(within(row).getByRole('textbox', { name: 'Edit memory' }), { target: { value: 'Answer in French' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    expect((await within(row).findByRole('alert')).textContent).toBe('This memory changed somewhere else, so your edit wasn’t saved. Its current text is shown.');
    expect((within(row).getByRole('textbox', { name: 'Edit memory' }) as HTMLTextAreaElement).value).toBe('Answer in Japanese');
    expect(backend.records[0].body).toBe('Answer in Japanese');
    // Saving again applies to the version now shown.
    fireEvent.change(within(row).getByRole('textbox', { name: 'Edit memory' }), { target: { value: 'Answer in French' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(backend.records[0].body).toBe('Answer in French'));
    expect(api.updateMemory).toHaveBeenLastCalledWith('mem-user', { body: 'Answer in French', expectedVersion: 2 });
  });

  it('says so when the memory being edited was deleted elsewhere', async () => {
    render(<MemoryPane />);
    const row = await waitFor(() => item('Saved memories', 'Answer in Chinese'));
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    backend.records = backend.records.filter((record) => record.id !== 'mem-user');
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(savedBodies()).not.toContain('Answer in Chinese'));
  });

  it('deletes a memory after a confirmation', async () => {
    render(<MemoryPane />);
    const row = await waitFor(() => item('Saved memories', 'Beta deploys on Fridays'));
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    expect(api.deleteMemory).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByRole('button', { name: 'Keep' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(savedBodies()).toEqual(['Answer in Chinese', 'Use 2 spaces in this repo']));
    expect(api.deleteMemory).toHaveBeenCalledExactlyOnceWith('mem-other');
  });

  it('changes a memory’s scope between global and the open workspace', async () => {
    render(<MemoryPane />);
    const row = await waitFor(() => item('Saved memories', 'Use 2 spaces in this repo'));
    const scope = within(row).getByRole('combobox', { name: 'Scope' });
    expect(within(scope).getAllByRole('option').map((option) => option.textContent)).toEqual(['Global', 'Alpha']);
    fireEvent.change(scope, { target: { value: 'user' } });
    await waitFor(() => expect(item('Saved memories', 'Use 2 spaces in this repo').querySelector('.memory-item__meta')?.textContent).toContain('ConventionGlobal'));
    expect(api.updateMemory).toHaveBeenCalledWith('mem-ws', { scope: { kind: 'user' }, expectedVersion: 1 });
    // Another workspace's memory keeps its own workspace as a choice.
    const other = within(item('Saved memories', 'Beta deploys on Fridays')).getByRole('combobox', { name: 'Scope' });
    expect(within(other).getAllByRole('option').map((option) => option.textContent)).toEqual(['Global', 'Alpha', 'Beta']);
  });

  it('opens the source conversation on request', async () => {
    const onNav = vi.fn();
    render(<MemoryPane onNav={onNav} />);
    const row = await waitFor(() => item('Saved memories', 'Use 2 spaces in this repo'));
    expect(within(item('Saved memories', 'Answer in Chinese')).queryByRole('button', { name: 'Open conversation' })).toBeNull();
    expect(nav.revealNode).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByRole('button', { name: 'Open conversation' }));
    expect(nav.revealNode).toHaveBeenCalledWith('n-1');
    expect(onNav).toHaveBeenCalledWith('dashboard');
  });

  it('adds a memory by hand, and not while memory is off', async () => {
    render(<MemoryPane />);
    await waitFor(() => expect(savedBodies()).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: 'Add memory' }));
    const form = screen.getByRole('group', { name: 'Add memory' });
    fireEvent.change(within(form).getByRole('textbox', { name: 'New memory' }), { target: { value: 'Prefer small commits' } });
    fireEvent.change(within(form).getByRole('combobox', { name: 'Kind' }), { target: { value: 'convention' } });
    fireEvent.change(within(form).getByRole('combobox', { name: 'New memory scope' }), { target: { value: 'workspace:ws-1' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save memory' }));
    await waitFor(() => expect(savedBodies()[0]).toBe('Prefer small commits'));
    expect(api.createMemory).toHaveBeenCalledWith({ scope: { kind: 'workspace', workspaceId: 'ws-1' }, kind: 'convention', body: 'Prefer small commits' });

    fireEvent.click(screen.getByRole('switch', { name: 'Use memory' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Add memory' }) as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText('Turn memory on to add memories.')).toBeTruthy();
  });

  it('is one switch: on by default (an older backend’s explicit mode too), and off keeps saved memories listed', async () => {
    backend.mode = 'explicit';
    render(<MemoryPane />);
    const toggle = await screen.findByRole('switch', { name: 'Use memory' }) as HTMLButtonElement;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByText('Turning memory off doesn’t delete chat history. Conversations are kept as before.')).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.disabled).toBe(false));
    expect(api.saveMemorySettings).toHaveBeenCalledWith('off');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Agents don’t read or save memories. Saved memories stay here until you delete them.')).toBeTruthy();
    expect(savedBodies()).toHaveLength(3);
    // Each chat's memory control in this window follows.
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

  it('keeps automatic memory’s status under a collapsed Details, read only once opened, with pause and resume', async () => {
    backend.extraction = { enabled: true, paused: false, lastRunAt: Date.now() - 2 * 3600_000, lastError: 'model timed out', todayTokens: 1200, dailyTokenLimit: 50000 };
    render(<MemoryPane />);
    const details = await screen.findByRole('button', { name: 'Details' });
    expect(details.getAttribute('aria-expanded')).toBe('false');
    expect(api.fetchMemoryExtractionStatus).not.toHaveBeenCalled();
    fireEvent.click(details);
    const section = screen.getByRole('region', { name: 'Memory' });
    await waitFor(() => expect(within(section).getByText('Running')).toBeTruthy());
    expect(details.getAttribute('aria-expanded')).toBe('true');
    expect(within(section).getByText('2h ago')).toBeTruthy();
    expect(within(section).getByRole('alert').textContent).toBe('Last error: model timed out');
    expect(within(section).getByText('1,200 of 50,000 tokens')).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Pause automatic memory' }));
    await waitFor(() => expect(within(section).getByText('Paused')).toBeTruthy());
    expect(api.setMemoryExtractionPaused).toHaveBeenCalledWith(true);
    fireEvent.click(within(section).getByRole('button', { name: 'Resume automatic memory' }));
    await waitFor(() => expect(within(section).getByText('Running')).toBeTruthy());
    expect(api.setMemoryExtractionPaused).toHaveBeenLastCalledWith(false);
    fireEvent.click(details);
    expect(within(section).queryByText('Running')).toBeNull();
  });

  it('explains under Details why automatic memory is held, and offers resume only where it helps', async () => {
    const base = { enabled: true, paused: false, lastRunAt: null, lastError: null, todayTokens: 0, dailyTokenLimit: 1000 };
    backend.extraction = { ...base, state: 'stopped', stateReason: 'Runs stopped after 5 failures in “Docs”.' };
    const { unmount } = render(<MemoryPane />);
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }));
    await waitFor(() => expect(screen.getByText('Stopped')).toBeTruthy());
    expect(screen.getByText('Runs stopped after 5 failures in “Docs”.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resume automatic memory' }));
    expect(api.setMemoryExtractionPaused).toHaveBeenLastCalledWith(false);
    unmount();

    backend.extraction = { ...base, state: 'unsupported', supported: false, stateReason: 'Kiro Crew can’t run the Meta agent.' };
    render(<MemoryPane />);
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }));
    await waitFor(() => expect(screen.getByText('Unsupported')).toBeTruthy());
    expect(screen.getByText('Kiro Crew can’t run the Meta agent.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /automatic memory/ })).toBeNull();
  });

  it('says under Details that automatic memory waits for Pages upkeep under Settings › <name>, not the Meta agent', async () => {
    const base = { enabled: true, paused: false, lastRunAt: null, lastError: null, todayTokens: 0, dailyTokenLimit: 1000 };
    backend.extraction = { ...base, state: 'maintenance_paused' };
    const named = companionSnapshot();
    resetCompanionStoreForTests({ snapshot: { ...named, settings: { ...named.settings, displayName: 'Robin' } } });
    try {
      render(<MemoryPane />);
      fireEvent.click(await screen.findByRole('button', { name: 'Details' }));
      const section = screen.getByRole('region', { name: 'Memory' });
      await waitFor(() => expect(within(section).getByText('Paused with Pages upkeep, under Settings › Robin › Pages upkeep.')).toBeTruthy());
      expect(section.textContent).not.toMatch(/meta agent/i);
      expect(within(section).queryByRole('button', { name: /automatic memory/ })).toBeNull();
    } finally {
      resetCompanionStoreForTests();
    }
  });

  it('says so under Details on a backend without automatic memory, and hides Details while memory is off', async () => {
    backend.extraction = null;
    render(<MemoryPane />);
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }));
    expect(await screen.findByText('This Michi backend can’t save memories in the background yet. Agents still save memories when you ask.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /automatic memory/ })).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Use memory' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Details' })).toBeNull());
  });

  it('says so when this backend has no Memory at all', async () => {
    backend.settingsError = new MemoryApiError(404, 'Not found');
    render(<MemoryPane />);
    expect(await screen.findByText('This Michi backend doesn’t support Memory yet. Its settings appear here once it does.')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });
});

describe('Settings › Memory: About the user, imported memories and deleting everything', () => {
  it('shows About the user by topic, each line with the memories it rests on; one opens under Saved memories', async () => {
    backend.profile = profile([
      { topic: 'Work', text: 'Two-space indents in Alpha', refs: ['mem-ws'] },
      { topic: 'Work', text: 'Answers in Chinese', refs: ['mem-user'] },
      { topic: 'Home', text: 'Deploys Beta on Fridays', refs: ['mem-other'] },
    ]);
    render(<MemoryPane />);
    const about = await aboutSection();
    await waitFor(() => expect(within(about).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(['Work', 'Home']));
    expect(within(about).getByText('Built 2h ago').tagName).toBe('TIME');
    expect(within(within(about).getByRole('list', { name: 'Work' })).getAllByRole('listitem').map((row) => row.querySelector('.memory-profile__text')?.textContent))
      .toEqual(['Two-space indents in Alpha', 'Answers in Chinese']);

    // A memory the list does not hold as filtered is looked up by its text, then focused.
    await waitFor(() => expect(savedBodies()).toHaveLength(3));
    fireEvent.change(screen.getByRole('combobox', { name: 'Show memories' }), { target: { value: 'user' } });
    await waitFor(() => expect(savedBodies()).toEqual(['Answer in Chinese']));
    const line = profileLine(about, 'Deploys Beta on Fridays');
    const toggle = within(line).getByRole('button', { name: 'Based on 1 memory' });
    expect(within(line).queryByRole('list')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(within(within(line).getByRole('list', { name: 'Memories it’s based on' })).getByRole('button', { name: 'Beta deploys on Fridays' }));
    await waitFor(() => expect(document.activeElement).toBe(item('Saved memories', 'Beta deploys on Fridays')));
    expect(item('Saved memories', 'Beta deploys on Fridays').getAttribute('data-marked')).toBe('true');
    expect((screen.getByRole('combobox', { name: 'Show memories' }) as HTMLSelectElement).value).toBe('all');
    expect((screen.getByRole('searchbox', { name: 'Search memories' }) as HTMLInputElement).value).toBe('Beta deploys on Fridays');
  });

  it('Remove asks first, then deletes the memories a line rests on; a profile that changed meanwhile stops it', async () => {
    backend.profile = profile([
      { topic: 'Work', text: 'Two-space indents in Alpha', refs: ['mem-ws'] },
      { topic: 'Work', text: 'Answers in Chinese', refs: ['mem-user'] },
    ]);
    render(<MemoryPane />);
    const about = await aboutSection();
    const line = await waitFor(() => profileLine(about, 'Answers in Chinese'));
    fireEvent.click(within(line).getByRole('button', { name: 'Remove' }));
    expect(line.textContent).toContain('Deletes the 1 memory it’s based on.');
    fireEvent.click(within(line).getByRole('button', { name: 'Keep' }));
    fireEvent.click(within(line).getByRole('button', { name: 'Remove' }));
    expect(api.removeMemoryProfileLine).not.toHaveBeenCalled();
    fireEvent.click(within(line).getByRole('button', { name: 'Confirm remove' }));
    await waitFor(() => expect(within(about).queryByText('Answers in Chinese')).toBeNull());
    expect(api.removeMemoryProfileLine).toHaveBeenCalledExactlyOnceWith(1, 3);
    expect(backend.records.map((record) => record.id)).toEqual(['mem-ws', 'mem-other']);

    // Meanwhile the line went (a memory it cites was deleted elsewhere): what is now there is not removed.
    const other = profileLine(about, 'Two-space indents in Alpha');
    backend.profile = { ...backend.profile!, lines: [] };
    fireEvent.click(within(other).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(other).getByRole('button', { name: 'Confirm remove' }));
    expect((await within(about).findByRole('alert')).textContent).toBe('About the user changed meanwhile, so nothing was removed. Check it and try again.');
    expect(api.removeMemoryProfileLine).toHaveBeenCalledOnce();
    expect(within(about).getByText('Nothing here right now. Michi writes it again as it learns more.')).toBeTruthy();
  });

  it('Rebuild asks automatic memory to write it again and checks back until it has; not while memory is off', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    backend.profile = profile([{ topic: 'Work', text: 'Answers in Chinese', refs: ['mem-user'] }]);
    const { unmount } = render(<MemoryPane />);
    const about = await aboutSection();
    const rebuild = await within(about).findByRole('button', { name: 'Rebuild' }) as HTMLButtonElement;
    fireEvent.click(rebuild);
    await waitFor(() => expect(within(about).getByText('Rebuilding with automatic memory. This can take a minute.')).toBeTruthy());
    expect(rebuild.disabled).toBe(true);
    // Automatic memory rebuilds it; the next check shows the new lines.
    backend.profile = profile([{ topic: 'Work', text: 'Answers in Chinese, code in English', refs: ['mem-user'] }], { version: 4, builtAt: Date.now() });
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    await waitFor(() => expect(within(about).getByText('Answers in Chinese, code in English')).toBeTruthy());
    expect(within(about).getByText('Built just now')).toBeTruthy();
    expect(rebuild.disabled).toBe(false);
    unmount();

    backend.mode = 'off';
    render(<MemoryPane />);
    const off = await aboutSection();
    expect(((await within(off).findByRole('button', { name: 'Rebuild' })) as HTMLButtonElement).disabled).toBe(true);
    expect(within(off).getByText('Turn memory on to rebuild it.')).toBeTruthy();
  });

  it('Delete all memories asks first, then deletes every memory and About the user', async () => {
    backend.profile = profile([{ topic: 'Work', text: 'Answers in Chinese', refs: ['mem-user'] }]);
    render(<MemoryPane />);
    await waitFor(() => expect(savedBodies()).toHaveLength(3));
    const row = screen.getByText('Delete all memories').closest('.settings-row') as HTMLElement;
    backend.confirm = false;
    fireEvent.click(within(row).getByRole('button', { name: 'Delete all…' }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledOnce());
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'Delete all memories?', confirmLabel: 'Delete all memories', danger: true }));
    expect(api.resetMemories).not.toHaveBeenCalled();

    backend.confirm = true;
    fireEvent.click(within(row).getByRole('button', { name: 'Delete all…' }));
    expect((await within(row).findByRole('status')).textContent).toBe('Deleted 3 memories.');
    expect(api.resetMemories).toHaveBeenCalledOnce();
    expect(await screen.findByText('No memories yet.')).toBeTruthy();
    expect(await within(await aboutSection()).findByText('Nothing here right now. Michi writes it again as it learns more.')).toBeTruthy();
  });

  it('names where an imported memory came from, and says deleting a conversation keeps what Michi learned', async () => {
    backend.records.push(memory('mem-claude', 'Prefers pnpm over npm', { createdAt: 4, origin: 'extracted', importSource: 'claude', importRef: 'michi/feedback.md' }));
    render(<MemoryPane />);
    const row = await waitFor(() => item('Saved memories', 'Prefers pnpm over npm'));
    expect(row.querySelector('.memory-item__meta')?.textContent).toContain('PreferenceGlobalFrom Claude Code');
    expect(within(row).getByText('From Claude Code').getAttribute('title')).toBe('Imported from Claude Code’s memory: michi/feedback.md');
    expect(screen.getByText('Deleting a conversation doesn’t delete what Michi learned from it. Delete those memories here.')).toBeTruthy();
  });
});

describe('Settings › Memory: changes made elsewhere', () => {
  function Feed() {
    useMemoryNotifications(() => {});
    return null;
  }
  const announce = (event: Partial<MemoryChangedEvent>) => act(() => backend.subscriptions[0].onEvent({
    ownerUserId: 'local', workspaceId: null, memoryId: 'x', action: 'created', status: 'active', body: '', origin: 'explicit', supersedesId: null, ...event,
  }));

  it('refreshes the list when automatic memory saves a memory, without moving focus', async () => {
    render(<><Feed /><MemoryPane /></>);
    const search = await screen.findByRole('searchbox', { name: 'Search memories' });
    await waitFor(() => expect(savedBodies()).toHaveLength(3));
    search.focus();
    backend.records.push(memory('mem-auto', 'Use Vitest, not Jest', { createdAt: 20, origin: 'extracted' }));
    announce({ memoryId: 'mem-auto', body: 'Use Vitest, not Jest', origin: 'extracted' });
    await waitFor(() => expect(savedBodies()[0]).toBe('Use Vitest, not Jest'));
    expect(document.activeElement).toBe(search);
  });
});
