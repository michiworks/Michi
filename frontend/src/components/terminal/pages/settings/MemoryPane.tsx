import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { plural, type MemoryMode, type MemoryRecord } from 'michi-shared';
import type { PageId } from '../../../../state/commands';
import { noteMemoryOn } from '../../../../state/memory/conversationMemory';
import { API_BASE_URL } from '../../../../config/env';
import { relativeTime } from '../../../../lib/relativeTime';
import {
  fetchMemoryExtractionStatus,
  fetchMemorySettings,
  isMemoryUnavailable,
  resetMemories,
  saveMemorySettings,
  setMemoryExtractionPaused,
  type MemoryExtractionStatus,
} from '../../../../services/api/memories';
import { confirmDialog } from '../../../ui/ConfirmDialog';
import { Button, Switch } from '../../../ui/controls';
import { findRowButton } from './HistoryList';
import { MemoryGuesses } from './MemoryGuesses';
import { findTopic, shelvesOf, topicKey, topicOf } from './memoryLibrary';
import { ALL_MEMORIES, MemoryDetailLevel, MemoryManageLevel, memoryRowKey, MemoryTopicLevel, topicTitle, type MemoryFilter, type MemoryLevel } from './MemoryLevels';
import { onMemoryReveal, takeMemoryReveal, type MemoryRevealRequest } from './memoryReveal';
import { SettingsRow, SettingsSection } from './SettingsSection';
import { errorText, useMemoryContext, useMemoryLibrary, useMemoryProfile } from './useMemoryLibrary';
import './history.css';
import './memory.css';

/**
 * Settings › Memory, a page few people need: memory on or off, Learn from
 * conversations (automatic memory, off until turned on), Your memories and
 * Delete all, then Guesses (patterns Michi noticed, for the user to confirm)
 * while there is one.
 * Your memories opens as levels of the page (MemoryLevels): the memories by
 * where they apply and by topic, a topic with its summary from About the
 * user, and one memory. Nothing here waits for the user: agents and
 * automatic memory save without asking. Everything is on this machine's
 * backend; a workspace on another machine keeps its memories there.
 */

function updatedText(updatedAt: number): string {
  const ago = relativeTime(updatedAt);
  return ago === 'now' ? 'Updated just now' : ago === 'yesterday' ? 'Updated yesterday' : `Updated ${ago} ago`;
}

const MANAGE_KEY = 'manage';

export function MemoryPane({ onNav }: { onNav?: (page: PageId) => void }) {
  const context = useMemoryContext(onNav);
  const [settings, setSettings] = useState<{ status: 'loading' | 'ready' | 'unavailable' | 'error'; mode: MemoryMode | null; error: string | null }>(
    { status: 'loading', mode: null, error: null });
  const [modeSaving, setModeSaving] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  // Goes up once every memory was deleted: the memories and About the user are read again.
  const [resets, setResets] = useState(0);
  const library = useMemoryLibrary(resets);
  const profile = useMemoryProfile(resets);
  const shelves = useMemo(() => shelvesOf(library.records), [library.records]);
  const [level, setLevel] = useState<MemoryLevel | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<MemoryFilter>(ALL_MEMORIES);
  const root = useRef<HTMLDivElement>(null);

  // Edit under a reply (ReplyMemorySources): opens the memory it names, whether this opened for it or was open.
  const [reveal, setReveal] = useState<MemoryRevealRequest | null>(null);
  useEffect(() => {
    const waiting = takeMemoryReveal();
    if (waiting) setReveal(waiting);
    return onMemoryReveal(() => {
      const request = takeMemoryReveal();
      if (request) setReveal(request);
    });
  }, []);
  // Once the memories are read: one this machine doesn't list is searched for by its text.
  useEffect(() => {
    if (!reveal || library.status === 'loading') return;
    setReveal(null);
    if (library.records.some((record) => record.id === reveal.id)) {
      setLevel({ kind: 'memory', id: reveal.id, from: null });
    } else {
      setQuery(reveal.body);
      setFilter(ALL_MEMORIES);
      setLevel({ kind: 'manage' });
    }
  }, [reveal, library.status, library.records]);

  // An opened level starts at its top; Back returns focus to the row it was opened from.
  const levelKey = level ? (level.kind === 'memory' ? memoryRowKey.memory(level.id) : level.kind === 'topic' ? memoryRowKey.topic(level.key) : MANAGE_KEY) : null;
  useLayoutEffect(() => {
    if (levelKey) root.current?.closest('.terminal-settings-content')?.scrollTo?.({ top: 0 });
  }, [levelKey]);
  const focusRow = (key: string) => requestAnimationFrame(() => {
    const target = findRowButton(root.current, key);
    target?.scrollIntoView?.({ block: 'nearest' });
    target?.focus({ preventScroll: true });
  });
  const toManage = (focus?: string) => {
    setLevel({ kind: 'manage', back: true });
    if (focus) focusRow(focus);
  };
  const backFromMemory = (record: MemoryRecord, from: string | null) => {
    if (from && findTopic(shelves, from)) {
      setLevel({ kind: 'topic', key: from });
      focusRow(memoryRowKey.memory(record.id));
    } else {
      toManage(query.trim() ? memoryRowKey.memory(record.id) : memoryRowKey.topic(topicKey(record.scope, topicOf(record))));
    }
  };

  const loadSettings = useCallback(async () => {
    setSettings((current) => ({ ...current, status: current.mode ? current.status : 'loading', error: null }));
    try {
      const value = await fetchMemorySettings();
      setSettings({ status: 'ready', mode: value.mode, error: null });
    } catch (error) {
      if (isMemoryUnavailable(error)) setSettings({ status: 'unavailable', mode: null, error: null });
      else setSettings({ status: 'error', mode: null, error: errorText(error) });
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
      setModeError(`Couldn’t turn memory ${on ? 'on' : 'off'}: ${errorText(error)}`);
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
  const levelPage = (body: React.ReactNode) => <div className="settings-history memory-settings" ref={root}>{body}</div>;

  // A memory or topic gone meanwhile (deleted or moved elsewhere) shows Your memories.
  if (level?.kind === 'memory') {
    const record = library.records.find((candidate) => candidate.id === level.id);
    const from = level.from ? findTopic(shelves, level.from) : null;
    if (record) {
      return levelPage(<MemoryDetailLevel key={record.id} record={record} library={library} context={context}
        backLabel={from ? topicTitle(from) : 'Your memories'}
        onBack={() => backFromMemory(record, level.from)}
        onDeleted={() => { if (from) setLevel({ kind: 'topic', key: from.key }); else toManage(); }} />);
    }
  }
  if (level?.kind === 'topic') {
    const topic = findTopic(shelves, level.key);
    if (topic) {
      return levelPage(<MemoryTopicLevel key={topic.key} topic={topic} library={library} profile={profile} context={context} memoryOn={on}
        onBack={() => toManage(memoryRowKey.topic(topic.key))}
        onOpenMemory={(id) => setLevel({ kind: 'memory', id, from: topic.key })}
        onDeleted={() => toManage()} />);
    }
  }
  if (level) {
    return levelPage(<MemoryManageLevel library={library} profile={profile} context={context} memoryOn={on}
      entrance={level.kind === 'manage' && !level.back} query={query} onQuery={setQuery} filter={filter} onFilter={setFilter}
      onBack={() => { setLevel(null); setQuery(''); focusRow(MANAGE_KEY); }}
      onOpenTopic={(key) => setLevel({ kind: 'topic', key })}
      onOpenMemory={(id) => setLevel({ kind: 'memory', id, from: null })} />);
  }

  const topics = shelves.reduce((sum, shelf) => sum + shelf.topics.filter((topic) => topic.name).length, 0);
  let summary: React.ReactNode;
  if (library.status === 'loading') summary = <span role="status">Loading…</span>;
  else if (library.status === 'error') summary = <span role="alert">Couldn’t load them: {library.error}.</span>;
  else if (library.records.length === 0) summary = 'Nothing yet. See, add, edit or delete what Michi remembers.';
  else summary = `${plural(library.records.length, 'memory', 'memories')}${topics ? ` · ${plural(topics, 'topic')}` : ''}`;
  return (
    <div ref={root}>
      <SettingsSection title="Memory">
        <SettingsRow label="Use memory"
          tip="Agents read your memories and save what you tell them. Turning it off keeps saved memories and chat history. To keep one chat out of memory, start a temporary chat from Home."
          control={<Switch on={on} disabled={modeSaving} aria-label="Use memory" onChange={(next) => { void turn(next); }} />}>
          {modeSaving && <p className="settings-row__note" role="status">Saving…</p>}
          {modeError && <p className="settings-row__note" role="alert">{modeError}</p>}
        </SettingsRow>
        {on && <LearnFromConversations />}
        <SettingsRow label="Your memories" description={summary}
          control={<Button data-history-open={MANAGE_KEY} onClick={() => setLevel({ kind: 'manage' })}>Manage</Button>} />
        <DeleteAllMemories onDeleted={() => { setResets((count) => count + 1); }} />
      </SettingsSection>
      <MemoryGuesses memoryOn={on} reloadKey={resets} onConfirmed={() => { void library.reload(); }} />
    </div>
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
