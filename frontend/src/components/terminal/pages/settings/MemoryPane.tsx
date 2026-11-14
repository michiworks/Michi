import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  MEMORY_BODY_MAX_CHARS,
  MEMORY_KINDS,
  type MemoryImportSource,
  type MemoryKind,
  type MemoryMode,
  type MemoryOrigin,
  type MemoryRecord,
  type MemoryScope,
} from 'michi-shared';
import type { PageId } from '../../../../state/commands';
import type { Project } from '../../../../state/chatTypes';
import { useChatActions, useChatProjects } from '../../../../state/chatStore';
import { isSystemWorkspace } from '../../../../state/assistant/systemWorkspace';
import { noteMemoryOn } from '../../../../state/memory/conversationMemory';
import { onMemoryChanged, runSelfCreate, runSelfMutation } from '../../../../state/memory/memoryNotifications';
import { backendConnectionIdForWorkspace, LOCAL_BACKEND_CONNECTION_ID } from '../../../../config/backendConnections';
import { API_BASE_URL } from '../../../../config/env';
import { prefersReducedMotion } from '../../../../hooks/useReducedMotion';
import { relativeTime } from '../../../../lib/relativeTime';
import { isImeComposing } from '../../../../lib/ime';
import {
  createMemory,
  deleteMemory,
  fetchMemoryExtractionStatus,
  fetchMemorySettings,
  isMemoryNotFound,
  isMemoryUnavailable,
  isMemoryVersionConflict,
  listMemories,
  resetMemories,
  saveMemorySettings,
  setMemoryExtractionPaused,
  updateMemory,
  type MemoryApiError,
  type MemoryExtractionStatus,
  type MemoryListQuery,
} from '../../../../services/api/memories';
import { confirmDialog } from '../../../ui/ConfirmDialog';
import { Button, Switch } from '../../../ui/controls';
import { AboutTheUser } from './AboutTheUser';
import { onMemoryReveal, takeMemoryReveal } from './memoryReveal';
import { SettingsRow, SettingsSection } from './SettingsSection';
import './memory.css';

/**
 * Settings › Memory, a page few people need: memory on or off, Learn from
 * conversations (automatic memory, off until turned on), what agents
 * remember (searchable, by scope; edit, delete, add) and About the user (the
 * profile Michi writes from its memories). Nothing here waits for the user: agents and automatic
 * memory save without asking. Everything is on this machine's backend; a
 * workspace on another machine keeps its memories there.
 */

const KIND_LABEL: Record<MemoryKind, string> = { preference: 'Preference', fact: 'Fact', decision: 'Decision', convention: 'Convention' };
const ORIGIN_LABEL: Record<MemoryOrigin, string> = { explicit: 'Explicit', extracted: 'Automatic' };
/** Where an imported memory was read from (a runtime's own memory, one way). */
const IMPORT_LABEL: Record<MemoryImportSource, string> = { claude: 'Claude Code', codex: 'Codex', kiro: 'Kiro' };
const LIST_PAGE = 50;
const LIST_MAX = 200;
const SEARCH_DEBOUNCE_MS = 250;
const RELOAD_DEBOUNCE_MS = 250;
/** How long a memory shown from About the user stays marked, and how long it may take to appear. */
const REVEAL_MARK_MS = 1_600;
const REVEAL_WAIT_MS = 5_000;

/** A memory About the user cites, to show under Saved memories; each click makes a new request. */
interface RevealRequest { id: string; body: string }

type Filter = 'all' | 'user' | 'workspace';

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function updatedText(updatedAt: number): string {
  const ago = relativeTime(updatedAt);
  return ago === 'now' ? 'Updated just now' : ago === 'yesterday' ? 'Updated yesterday' : `Updated ${ago} ago`;
}

function previewOf(body: string): string {
  const line = body.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

const scopeKey = (scope: MemoryScope) => scope.kind === 'user' ? 'user' : `workspace:${scope.workspaceId}`;
const sameScope = (a: MemoryScope, b: MemoryScope) => scopeKey(a) === scopeKey(b);

/** Workspace names, scopes the user can pick, and opening a memory's source conversation. */
interface MemoryContext {
  /** The open workspace, when it is on this machine (its memories are here). */
  workspace: Project | null;
  scopeLabel: (scope: MemoryScope) => string;
  scopeChoices: (current?: MemoryScope) => MemoryScope[];
  /** The source conversation when this machine has it loaded. */
  sourceNode: (record: MemoryRecord) => string | null;
  openSource: (nodeId: string) => void;
}

function useMemoryContext(onNav?: (page: PageId) => void): MemoryContext {
  const { projects, activeProject } = useChatProjects();
  const { revealNode } = useChatActions();
  const workspace = activeProject && !activeProject.deletedAt && !activeProject.archivedAt && !isSystemWorkspace(activeProject)
    && backendConnectionIdForWorkspace(activeProject.id) === LOCAL_BACKEND_CONNECTION_ID ? activeProject : null;
  return useMemo(() => {
    const workspaceName = (id: string) => projects.find((project) => project.id === id)?.name || 'Another workspace';
    return {
      workspace,
      scopeLabel: (scope) => scope.kind === 'user' ? 'Global' : workspaceName(scope.workspaceId),
      scopeChoices: (current) => {
        const choices: MemoryScope[] = [{ kind: 'user' }];
        if (workspace) choices.push({ kind: 'workspace', workspaceId: workspace.id });
        if (current && !choices.some((choice) => sameScope(choice, current))) choices.push(current);
        return choices;
      },
      sourceNode: (record) => {
        const nodeId = record.source?.nodeId;
        if (!nodeId) return null;
        return projects.some((project) => !project.deletedAt && project.chatIds.includes(nodeId)) ? nodeId : null;
      },
      // An explicit request: opens the conversation wherever it lives, then leaves Settings.
      openSource: (nodeId) => {
        revealNode(nodeId);
        onNav?.('dashboard');
      },
    };
  }, [projects, workspace, revealNode, onNav]);
}

// ── the pane ───────────────────────────────────────────────────────────────

type Load<T> = { status: 'loading' | 'ready' | 'error'; value: T; error: string | null };

export function MemoryPane({ onNav }: { onNav?: (page: PageId) => void }) {
  const context = useMemoryContext(onNav);
  const [settings, setSettings] = useState<{ status: 'loading' | 'ready' | 'unavailable' | 'error'; mode: MemoryMode | null; error: string | null }>(
    { status: 'loading', mode: null, error: null });
  const [modeSaving, setModeSaving] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<RevealRequest | null>(null);
  // Goes up once every memory was deleted: the profile and the list are read again.
  const [resets, setResets] = useState(0);
  // Edit under a reply (ReplyMemorySources): the memory it names is found and marked, whether this opened for it or was open.
  useEffect(() => {
    const waiting = takeMemoryReveal();
    if (waiting) setReveal(waiting);
    return onMemoryReveal(() => {
      const request = takeMemoryReveal();
      if (request) setReveal(request);
    });
  }, []);

  const loadSettings = useCallback(async () => {
    setSettings((current) => ({ ...current, status: current.mode ? current.status : 'loading', error: null }));
    try {
      const value = await fetchMemorySettings();
      setSettings({ status: 'ready', mode: value.mode, error: null });
    } catch (error) {
      if (isMemoryUnavailable(error)) setSettings({ status: 'unavailable', mode: null, error: null });
      else setSettings({ status: 'error', mode: null, error: errorText(error, 'unknown error') });
    }
  }, []);
  useEffect(() => { void loadSettings(); }, [loadSettings]);

  // On is 'auto'. Only an older backend still answers 'explicit', which is on too.
  const turn = async (on: boolean) => {
    const mode: MemoryMode = on ? 'auto' : 'off';
    if (modeSaving || mode === settings.mode) return;
    const previous = settings.mode;
    setModeSaving(true);
    setModeError(null);
    setSettings((current) => ({ ...current, mode }));
    try {
      const saved = await saveMemorySettings(mode);
      setSettings((current) => ({ ...current, mode: saved.mode }));
      // What this window shows of memory under replies follows.
      noteMemoryOn(API_BASE_URL, saved.mode !== 'off');
    } catch (error) {
      setSettings((current) => ({ ...current, mode: previous }));
      setModeError(`Couldn’t turn memory ${on ? 'on' : 'off'}: ${errorText(error, 'unknown error')}`);
    } finally {
      setModeSaving(false);
    }
  };

  if (settings.status === 'loading') return <p className="settings-section__status" role="status">Loading memory…</p>;
  if (settings.status === 'unavailable') {
    return <SettingsSection title="Memory" intro="This Michi backend doesn’t support Memory yet. Its settings appear here once it does." />;
  }
  if (settings.status === 'error' || !settings.mode) {
    return (
      <SettingsSection title="Memory">
        <p className="settings-section__error" role="alert">
          Couldn’t load Memory{settings.error ? `: ${settings.error}` : ''}.{' '}
          <button type="button" className="settings-row__link" onClick={() => { void loadSettings(); }}>Try again</button>
        </p>
      </SettingsSection>
    );
  }
  const on = settings.mode !== 'off';
  return (
    <>
      <SettingsSection title="Memory">
        <SettingsRow label="Use memory"
          tip="Agents read your memories and save what you tell them. Turning it off keeps saved memories and chat history. To keep one chat out of memory, start a temporary chat from Home."
          control={<Switch on={on} disabled={modeSaving} aria-label="Use memory" onChange={(next) => { void turn(next); }} />}>
          {modeSaving && <p className="settings-row__note" role="status">Saving…</p>}
          {modeError && <p className="settings-row__note" role="alert">{modeError}</p>}
        </SettingsRow>
        {on && <LearnFromConversations />}
        <DeleteAllMemories onDeleted={() => setResets((count) => count + 1)} />
      </SettingsSection>
      <AboutTheUser memoryOn={on} reloadKey={resets} onShowMemory={(memory) => setReveal({ id: memory.id, body: memory.body })} />
      <SavedMemories memoryOn={on} context={context} reveal={reveal} reloadKey={resets} />
    </>
  );
}

/** Deletes every memory and the profile (POST /api/memories/reset), after the user confirms. */
function DeleteAllMemories({ onDeleted }: { onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const run = async () => {
    if (busy) return;
    setNote(null);
    const confirmed = await confirmDialog({
      title: 'Delete all memories?',
      message: 'This deletes every saved memory, including the ones you added yourself, and About the user. Your conversations stay, but memory won’t bring them up again or learn from what they already say.\n\nThis can’t be undone.',
      confirmLabel: 'Delete all memories',
      danger: true,
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      const { removed } = await resetMemories();
      setNote({ tone: 'ok', text: removed === 1 ? 'Deleted 1 memory.' : `Deleted ${removed} memories.` });
      onDeleted();
    } catch (error) {
      setNote({ tone: 'error', text: `Couldn’t delete your memories: ${errorText(error, 'unknown error')}` });
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsRow label="Delete all memories"
      control={<Button size="sm" danger disabled={busy} onClick={() => { void run(); }}>{busy ? 'Deleting…' : 'Delete all…'}</Button>}>
      {note && <p className="settings-row__note" role={note.tone === 'error' ? 'alert' : 'status'} data-tone={note.tone === 'ok' ? 'ok' : undefined}>{note.text}</p>}
    </SettingsRow>
  );
}

// ── Learn from conversations: automatic memory ─────────────────────────────

/**
 * What automatic memory is doing, under "Learn from conversations" while it
 * is on, and whether its switch can act. Backends without `state` fall back
 * to `paused`. Turning Michi off does not pause it: only this switch does.
 */
function learningView(status: MemoryExtractionStatus): { on: boolean; supported: boolean; line: string | null } {
  if (status.supported === false || status.state === 'unsupported') {
    return { on: false, supported: false, line: 'This backend can’t read conversations in the background.' };
  }
  const last = status.lastRunAt ? ` · last run ${updatedText(status.lastRunAt).replace('Updated ', '')}` : '';
  switch (status.state ?? (status.paused ? 'paused' : 'running')) {
    case 'paused': return { on: false, supported: true, line: null };
    case 'stopped': return { on: true, supported: true, line: 'Stopped after repeated failures' };
    case 'budget_exhausted': return { on: true, supported: true, line: 'Daily limit reached · resumes tomorrow' };
    case 'waiting': return { on: true, supported: true, line: `Waiting: new conversations are queued${last}` };
    case 'idle': return { on: true, supported: true, line: `Up to date${last}` };
    default: return { on: true, supported: true, line: `Running${last}` };
  }
}

/**
 * Learn from conversations (automatic memory, Q28): off until the user turns
 * it on here. On reads finished conversations in the background and saves
 * what they say about you; off pauses that, and agents still save what you
 * ask them to.
 */
function LearnFromConversations() {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'unavailable' | 'error'; value: MemoryExtractionStatus | null; error: string | null }>(
    { status: 'loading', value: null, error: null });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const value = await fetchMemoryExtractionStatus();
      setState(value ? { status: 'ready', value, error: null } : { status: 'unavailable', value: null, error: null });
    } catch (error) {
      setState((current) => ({ status: current.value ? 'ready' : 'error', value: current.value, error: errorText(error, 'unknown error') }));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // A stopped one starts again the same way: resume.
  const turn = async (on: boolean) => {
    setBusy(true);
    setActionError(null);
    try {
      const value = await setMemoryExtractionPaused(!on);
      if (value) setState({ status: 'ready', value, error: null });
      else await load();
    } catch (error) {
      setActionError(`Couldn’t turn learning from conversations ${on ? 'on' : 'off'}: ${errorText(error, 'unknown error')}`);
    } finally {
      setBusy(false);
    }
  };

  const tip = 'In the background, agents read your finished conversations and save what they say about you. Off: they save only what you ask them to.';
  if (state.status === 'unavailable') {
    return <SettingsRow label="Learn from conversations" tip={tip} description="This Michi backend can’t save memories in the background yet." />;
  }
  if (state.status !== 'ready' || !state.value) {
    return (
      <SettingsRow label="Learn from conversations" tip={tip}
        description={state.status === 'loading' ? <span role="status">Loading…</span> : (
          <span role="alert">
            Couldn’t read its status{state.error ? `: ${state.error}` : ''}.{' '}
            <button type="button" className="settings-row__link" onClick={() => { void load(); }}>Try again</button>
          </span>
        )} />
    );
  }
  const status = state.value;
  const view = learningView(status);
  return (
    <SettingsRow label="Learn from conversations" tip={tip} description={view.line}
      control={view.supported && <Switch on={view.on} disabled={busy} aria-label="Learn from conversations" onChange={(next) => { void turn(next); }} />}>
      {status.state === 'stopped' && (
        <p className="settings-row__note">
          <button type="button" className="settings-row__link" disabled={busy} onClick={() => { void turn(true); }}>Try again</button>
        </p>
      )}
      {view.on && status.stateReason && <p className="settings-row__note">{status.stateReason}</p>}
      {view.on && status.lastError && <p className="settings-row__note" role="alert">Last error: {status.lastError}</p>}
      {actionError && <p className="settings-row__note" role="alert">{actionError}</p>}
    </SettingsRow>
  );
}

// ── saved memories ─────────────────────────────────────────────────────────

function SavedMemories({ memoryOn, context, reveal, reloadKey }: {
  memoryOn: boolean;
  context: MemoryContext;
  /** A memory to scroll to and focus (from About the user). */
  reveal: RevealRequest | null;
  /** Changes when every memory was deleted: the list is read again. */
  reloadKey: number;
}) {
  const workspaceId = context.workspace?.id ?? null;
  const [filter, setFilter] = useState<Filter>('all');
  const effectiveFilter: Filter = filter === 'workspace' && !workspaceId ? 'all' : filter;
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // `query` read the items; their cursor continues that query only.
  const [saved, setSaved] = useState<Load<{ items: MemoryRecord[]; nextCursor: string | null; query: MemoryListQuery | null }>>(
    { status: 'loading', value: { items: [], nextCursor: null, query: null }, error: null });
  const savedGeneration = useRef(0);
  const loadedCount = useRef(0);
  loadedCount.current = saved.value.items.length;

  const savedQuery = useMemo(() => ({
    status: ['active'] as const,
    ...(effectiveFilter === 'user' ? { scope: 'user' as const } : {}),
    ...(effectiveFilter === 'workspace' && workspaceId ? { scope: 'workspace' as const, workspaceId } : {}),
    ...(q ? { q } : {}),
  }), [effectiveFilter, workspaceId, q]);

  /** Reads the saved list again, as far as it was shown; returns the records. */
  const reloadSaved = useCallback(async (options: { keepLength?: boolean } = {}): Promise<MemoryRecord[] | null> => {
    const mine = ++savedGeneration.current;
    const limit = options.keepLength ? Math.min(LIST_MAX, Math.max(LIST_PAGE, loadedCount.current)) : LIST_PAGE;
    try {
      const page = await listMemories({ ...savedQuery, limit });
      if (mine !== savedGeneration.current) return null;
      setSaved({ status: 'ready', value: { items: page.items, nextCursor: page.nextCursor, query: savedQuery }, error: null });
      return page.items;
    } catch (error) {
      if (mine !== savedGeneration.current) return null;
      setSaved((current) => ({ status: 'error', value: current.value, error: errorText(error, 'unknown error') }));
      return null;
    }
  }, [savedQuery]);

  // A new filter or search starts the list over, and so does deleting every memory.
  useEffect(() => {
    setSaved((current) => ({ ...current, status: 'loading' }));
    void reloadSaved();
  }, [reloadSaved, reloadKey]);

  // A memory About the user cites: shown here, scrolled to and focused. One
  // the list does not hold as filtered and loaded is looked up by its text.
  const listRef = useRef<HTMLUListElement>(null);
  const [revealing, setRevealing] = useState<string | null>(null);
  const [marked, setMarked] = useState<string | null>(null);
  const itemsRef = useRef(saved.value.items);
  itemsRef.current = saved.value.items;
  useEffect(() => {
    if (!reveal) return;
    if (!itemsRef.current.some((item) => item.id === reveal.id)) {
      setFilter('all');
      setQuery(reveal.body);
      setQ(reveal.body.trim());
    }
    setRevealing(reveal.id);
    const timer = setTimeout(() => setRevealing((current) => current === reveal.id ? null : current), REVEAL_WAIT_MS);
    return () => clearTimeout(timer);
  }, [reveal]);
  useEffect(() => {
    if (!revealing) return;
    const row = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-memory-id]') ?? []).find((element) => element.dataset.memoryId === revealing);
    if (!row) return;
    setRevealing(null);
    setMarked(revealing);
    row.scrollIntoView?.({ block: 'center', behavior: prefersReducedMotion(document.documentElement.dataset.reduceMotion === 'on') ? 'auto' : 'smooth' });
    row.focus({ preventScroll: true });
  }, [revealing, saved.value.items]);
  useEffect(() => {
    if (!marked) return;
    const timer = setTimeout(() => setMarked(null), REVEAL_MARK_MS);
    return () => clearTimeout(timer);
  }, [marked]);

  // Changes made anywhere (an agent, automatic memory, another window, an Undo) refresh the list.
  const reloadRef = useRef(reloadSaved);
  reloadRef.current = reloadSaved;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = onMemoryChanged(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void reloadRef.current({ keepLength: true });
      }, RELOAD_DEBOUNCE_MS);
    });
    return () => { stop(); if (timer !== null) clearTimeout(timer); };
  }, []);

  const showMore = async () => {
    const { nextCursor: cursor, query } = saved.value;
    if (!cursor || !query) return;
    const mine = ++savedGeneration.current;
    try {
      const page = await listMemories({ ...query, cursor, limit: LIST_PAGE });
      if (mine !== savedGeneration.current) return;
      setSaved((current) => {
        const seen = new Set(current.value.items.map((item) => item.id));
        return { status: 'ready', value: { items: [...current.value.items, ...page.items.filter((item) => !seen.has(item.id))], nextCursor: page.nextCursor, query }, error: null };
      });
    } catch (error) {
      if (mine === savedGeneration.current) setSaved((current) => ({ ...current, error: errorText(error, 'unknown error') }));
    }
  };

  const replaceSaved = (record: MemoryRecord) => setSaved((current) => ({
    ...current, value: { ...current.value, items: current.value.items.map((item) => item.id === record.id ? record : item) },
  }));
  const removeSaved = (id: string) => setSaved((current) => ({
    ...current, value: { ...current.value, items: current.value.items.filter((item) => item.id !== id) },
  }));
  /** After a conflict: the record as stored now, or null when it is gone. */
  const currentRecord = async (id: string): Promise<MemoryRecord | null | undefined> => {
    const items = await reloadSaved({ keepLength: true });
    return items ? items.find((item) => item.id === id) ?? null : undefined;
  };

  return (
    <SettingsSection title="Saved memories" className="memory-saved">
      <div className="memory-toolbar">
        <select className="ui-select settings-row__select" aria-label="Show memories" value={effectiveFilter}
          onChange={(event) => setFilter(event.target.value as Filter)}>
          <option value="all">All memories</option>
          <option value="user">Global only</option>
          {context.workspace && <option value="workspace">{context.workspace.name || 'This workspace'} only</option>}
        </select>
        <input type="search" className="ui-input memory-toolbar__search" aria-label="Search memories" placeholder="Search memories"
          value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <AddMemory memoryOn={memoryOn} context={context} onAdded={(record) => {
        setSaved((current) => ({ ...current, value: { ...current.value, items: [record, ...current.value.items.filter((item) => item.id !== record.id)] } }));
        void reloadSaved({ keepLength: true });
      }} />
      {saved.status === 'loading' && saved.value.items.length === 0 && <p className="settings-section__status" role="status">Loading memories…</p>}
      {saved.error && <p className="settings-section__error" role="alert">Couldn’t load memories: {saved.error}</p>}
      {saved.status === 'ready' && saved.value.items.length === 0 && (
        <p className="settings-section__status">{q ? `No memories match “${q}”.` : effectiveFilter === 'all' ? 'No memories yet.' : 'No memories here yet.'}</p>
      )}
      {saved.value.items.length > 0 && <ul ref={listRef} className="memory-list" aria-label="Saved memories">
        {saved.value.items.map((record) => (
          <SavedMemoryItem key={record.id} record={record} context={context} marked={marked === record.id}
            onReplace={(next) => { replaceSaved(next); if (!sameScope(next.scope, record.scope)) void reloadSaved({ keepLength: true }); }}
            onRemoved={() => removeSaved(record.id)}
            onConflict={() => currentRecord(record.id)} />
        ))}
      </ul>}
      {saved.value.nextCursor && saved.value.query === savedQuery
        && <Button size="sm" className="memory-more" onClick={() => { void showMore(); }}>Show more</Button>}
    </SettingsSection>
  );
}

function MemoryMeta({ record, context }: { record: MemoryRecord; context: MemoryContext }) {
  const source = context.sourceNode(record);
  const imported = record.importSource ? IMPORT_LABEL[record.importSource] : undefined;
  return (
    <div className="memory-item__meta">
      <span>{KIND_LABEL[record.kind]}</span>
      <span>{context.scopeLabel(record.scope)}</span>
      {imported
        ? <span title={record.importRef ? `Imported from ${imported}’s memory: ${record.importRef}` : `Imported from ${imported}’s memory`}>From {imported}</span>
        : <span>{ORIGIN_LABEL[record.origin]}</span>}
      <time dateTime={new Date(record.updatedAt).toISOString()} title={new Date(record.updatedAt).toLocaleString()}>{updatedText(record.updatedAt)}</time>
      {source && <button type="button" className="settings-row__link" onClick={() => context.openSource(source)}>Open conversation</button>}
    </div>
  );
}

type Notice = { tone: 'error' | 'info'; text: string } | null;

function SavedMemoryItem({ record, context, marked, onReplace, onRemoved, onConflict }: {
  record: MemoryRecord;
  context: MemoryContext;
  /** Just shown from About the user. */
  marked: boolean;
  onReplace: (record: MemoryRecord) => void;
  onRemoved: () => void;
  /** Reads the list again: the stored record, null when it is gone, undefined when it couldn't be read. */
  onConflict: () => Promise<MemoryRecord | null | undefined>;
}) {
  const [editing, setEditing] = useState<{ draft: string; version: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const editorId = useId();

  const conflict = async (what: 'edit' | 'scope') => {
    const current = await onConflict();
    if (current === null) { setEditing(null); setNotice({ tone: 'error', text: 'This memory was deleted somewhere else.' }); return; }
    if (current === undefined) { setNotice({ tone: 'error', text: 'This memory changed somewhere else, and its current version couldn’t be loaded.' }); return; }
    if (what === 'edit') {
      setEditing({ draft: current.body, version: current.version });
      setNotice({ tone: 'error', text: 'This memory changed somewhere else, so your edit wasn’t saved. Its current text is shown.' });
    } else {
      setNotice({ tone: 'error', text: 'This memory changed somewhere else, so its scope wasn’t changed. Try again.' });
    }
  };

  const failed = async (error: unknown, what: 'edit' | 'scope' | 'delete') => {
    if (what !== 'delete' && isMemoryVersionConflict(error)) { await conflict(what); return; }
    if (isMemoryNotFound(error)) { onRemoved(); return; }
    const verb = what === 'edit' ? 'save the memory' : what === 'scope' ? 'change the scope' : 'delete the memory';
    setNotice({ tone: 'error', text: `Couldn’t ${verb}: ${errorText(error, 'unknown error')}` });
  };

  const save = async () => {
    if (!editing || busy) return;
    const body = editing.draft.trim();
    if (!body) { setNotice({ tone: 'error', text: 'A memory can’t be empty. Delete it instead.' }); return; }
    setBusy(true);
    setNotice(null);
    try {
      const updated = await runSelfMutation(record.id, () => updateMemory(record.id, { body, expectedVersion: editing.version }));
      setEditing(null);
      onReplace(updated);
    } catch (error) {
      await failed(error, 'edit');
    } finally {
      setBusy(false);
    }
  };

  const changeScope = async (key: string) => {
    const scope = context.scopeChoices(record.scope).find((choice) => scopeKey(choice) === key);
    if (!scope || sameScope(scope, record.scope) || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      onReplace(await runSelfMutation(record.id, () => updateMemory(record.id, { scope, expectedVersion: record.version })));
    } catch (error) {
      await failed(error, 'scope');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await runSelfMutation(record.id, () => deleteMemory(record.id));
      onRemoved();
    } catch (error) {
      setBusy(false);
      await failed(error, 'delete');
    }
  };

  const label = previewOf(record.body);
  return (
    <li className="memory-item" aria-label={label} aria-busy={busy || undefined} data-memory-id={record.id} data-marked={marked || undefined} tabIndex={-1}>
      {editing ? (
        <div className="memory-item__editor">
          <label className="sr-only" htmlFor={editorId}>Edit memory</label>
          <textarea id={editorId} className="ui-input memory-item__textarea" value={editing.draft} maxLength={MEMORY_BODY_MAX_CHARS} rows={3}
            autoFocus onChange={(event) => setEditing({ ...editing, draft: event.target.value })}
            onKeyDown={(event) => {
              if (isImeComposing(event)) return;
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(null); setNotice(null); }
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); }
            }} />
          <div className="memory-item__actions">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => { void save(); }}>Save</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditing(null); setNotice(null); }}>Cancel</Button>
          </div>
        </div>
      ) : <p className="memory-item__body">{record.body}</p>}
      <MemoryMeta record={record} context={context} />
      {!editing && <div className="memory-item__actions">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditing({ draft: record.body, version: record.version }); setNotice(null); setConfirmDelete(false); }}>Edit</Button>
        <select className="ui-select memory-item__scope" aria-label="Scope" value={scopeKey(record.scope)} disabled={busy}
          onChange={(event) => { void changeScope(event.target.value); }}>
          {context.scopeChoices(record.scope).map((scope) => <option key={scopeKey(scope)} value={scopeKey(scope)}>{context.scopeLabel(scope)}</option>)}
        </select>
        {confirmDelete ? <>
          <Button size="sm" danger disabled={busy} onClick={() => { void remove(); }}>Confirm delete</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>Keep</Button>
        </> : <Button size="sm" variant="ghost" danger disabled={busy} onClick={() => setConfirmDelete(true)}>Delete</Button>}
      </div>}
      {notice && <p className={notice.tone === 'error' ? 'memory-item__notice is-error' : 'memory-item__notice'} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p>}
    </li>
  );
}

function AddMemory({ memoryOn, context, onAdded }: { memoryOn: boolean; context: MemoryContext; onAdded: (record: MemoryRecord) => void }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<MemoryKind>('preference');
  const [scopeChoice, setScopeChoice] = useState('user');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyId = useId();
  const choices = context.scopeChoices();
  const scope = choices.find((choice) => scopeKey(choice) === scopeChoice) ?? choices[0];

  if (!open) {
    return <div className="memory-add">
      <Button disabled={!memoryOn} onClick={() => { setOpen(true); setError(null); }}>Add memory</Button>
      {!memoryOn && <span className="settings-row__state">Turn memory on to add memories.</span>}
    </div>;
  }
  const save = async () => {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const record = await runSelfCreate(() => createMemory({ scope, kind, body: text }));
      setBody('');
      setOpen(false);
      onAdded(record);
    } catch (failure) {
      setError((failure as MemoryApiError)?.code === 'memory_disabled' ? 'Memory is off. Turn it on to add memories.' : `Couldn’t add the memory: ${errorText(failure, 'unknown error')}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="memory-add memory-add--open" role="group" aria-label="Add memory">
      <label className="sr-only" htmlFor={bodyId}>New memory</label>
      <textarea id={bodyId} className="ui-input memory-item__textarea" value={body} rows={2} maxLength={MEMORY_BODY_MAX_CHARS} autoFocus
        placeholder="For example: Answer in Chinese unless I write in English."
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (isImeComposing(event)) return;
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); }
        }} />
      <div className="memory-item__actions">
        <select className="ui-select memory-item__scope" aria-label="Kind" value={kind} onChange={(event) => setKind(event.target.value as MemoryKind)}>
          {MEMORY_KINDS.map((value) => <option key={value} value={value}>{KIND_LABEL[value]}</option>)}
        </select>
        <select className="ui-select memory-item__scope" aria-label="New memory scope" value={scopeKey(scope)} onChange={(event) => setScopeChoice(event.target.value)}>
          {choices.map((choice) => <option key={scopeKey(choice)} value={scopeKey(choice)}>{context.scopeLabel(choice)}</option>)}
        </select>
        <Button size="sm" variant="primary" disabled={busy || !body.trim()} onClick={() => { void save(); }}>Save memory</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
      </div>
      {error && <p className="memory-item__notice is-error" role="alert">{error}</p>}
    </div>
  );
}
