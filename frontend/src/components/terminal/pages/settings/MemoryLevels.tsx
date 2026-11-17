import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { BrainIcon, ChevronLeftIcon, DocIcon, FlagIcon, InfoIcon, PlusIcon, RulerIcon, SearchIcon, SlidersIcon, TagIcon, TrashIcon, type IconComponent } from '../../icons';
import { toast } from 'sonner';
import {
  MEMORY_BODY_MAX_CHARS,
  MEMORY_KINDS,
  MEMORY_TOPIC_MAX_CHARS,
  plural,
  type MemoryImportSource,
  type MemoryKind,
  type MemoryRecord,
  type MemoryScope,
  type MemoryUpdateRequest,
} from 'michi-shared';
import { relativeTime } from '../../../../lib/relativeTime';
import { isImeComposing } from '../../../../lib/ime';
import { runSelfCreate, runSelfMutation } from '../../../../state/memory/memoryNotifications';
import {
  createMemory,
  deleteMemory,
  isMemoryNotFound,
  isMemoryVersionConflict,
  updateMemory,
  type MemoryApiError,
} from '../../../../services/api/memories';
import { confirmDialog } from '../../../ui/ConfirmDialog';
import { Button } from '../../../ui/controls';
import { HistoryDetail, HistoryEmpty, HistoryGroup, HistoryLoading, HistoryRow, HistorySearch, HistoryToolbar } from './HistoryList';
import { useSettingsBack, useSettingsHeaderAction, useSettingsPageTitle, useSettingsPhone } from './settingsPhone';
import { memoryMatches, sameScope, scopeKey, shelvesOf, summaryOf, topicNamesIn, topicOf, type MemoryShelf, type MemoryTopic } from './memoryLibrary';
import { errorText, LIBRARY_MAX, type MemoryContext, type MemoryLibrary, type MemoryProfile } from './useMemoryLibrary';
import { useFocusAfterChange } from './useFocusAfterChange';

/**
 * The levels inside Settings › Memory, as Claude arranges its memory: Your
 * memories (topics, where they apply), a topic (the summary About the user
 * gives it, then each memory in it) and one memory (where it came from;
 * edit, move or delete it). Each is a level of the page, as a skill is in
 * Settings › Skills.
 */

export type MemoryLevel =
  /** `back`: returned to from a topic or a memory, by Back or after a delete. */
  | { kind: 'manage'; back?: boolean }
  | { kind: 'topic'; key: string }
  /** `from`: the topic it was opened from, where Back returns. */
  | { kind: 'memory'; id: string; from: string | null };

/** All memories, or one shelf's (a scopeKey). */
export type MemoryFilter = string;
export const ALL_MEMORIES: MemoryFilter = 'all';

const KIND_LABEL: Record<MemoryKind, string> = { preference: 'Preference', fact: 'Fact', decision: 'Decision', convention: 'Convention' };
const KIND_ICON: Record<MemoryKind, IconComponent> = { preference: SlidersIcon, fact: InfoIcon, decision: FlagIcon, convention: RulerIcon };
const IMPORT_LABEL: Record<MemoryImportSource, string> = { claude: 'Claude Code', codex: 'Codex', kiro: 'Kiro' };
/** Topics a shelf shows before Show more. */
const PREVIEW_TOPICS = 6;
const OTHER = 'Other';

const memoriesText = (count: number) => plural(count, 'memory', 'memories');
export const topicTitle = (topic: Pick<MemoryTopic, 'name'>) => topic.name || OTHER;

function agoText(at: number, prefix: string): string {
  const ago = relativeTime(at);
  return ago === 'now' ? `${prefix} just now` : ago === 'yesterday' ? `${prefix} yesterday` : `${prefix} ${ago} ago`;
}
const dateText = (at: number) => new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const pad = (value: number) => String(value).padStart(2, '0');
/** A date input's value (YYYY-MM-DD, local) for a memory's end: the last day it is true, the day before validUntil. */
function lastDayValue(validUntil: number | null | undefined): string {
  if (typeof validUntil !== 'number') return '';
  const day = new Date(validUntil - 1);
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}
/** The end a date input's last day gives (the next local midnight), or null when it isn't a whole date. */
function validUntilOf(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1).getTime();
}
const untilText = (validUntil: number) => `${validUntil <= Date.now() ? 'Ended' : 'Until'} ${dateText(validUntil - 1)}`;
const when = (at: number) => ({ label: agoText(at, 'Updated'), dateTime: new Date(at).toISOString(), title: new Date(at).toLocaleString() });
const rowKey = { topic: (key: string) => `topic:${key}`, memory: (id: string) => `memory:${id}` };
export { rowKey as memoryRowKey };

function savedText(record: MemoryRecord): string {
  if (record.importSource) return `From ${IMPORT_LABEL[record.importSource]}`;
  return record.origin === 'explicit' ? 'By you' : 'Automatically';
}

/** The page's own title, with its Back link, while a level takes the page's title. */
function LevelHead({ backLabel, onBack, title, action }: { backLabel: string; onBack: () => void; title: string; action?: React.ReactNode }) {
  const phone = useSettingsPhone();
  const heading = useRef<HTMLHeadingElement>(null);
  useSettingsBack(onBack);
  useSettingsPageTitle(true);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  return <>
    {!phone && <button type="button" className="settings-history__back" onClick={onBack}><ChevronLeftIcon aria-hidden="true" />{backLabel}</button>}
    <div className="settings-titlebar" data-action={action && !phone ? '' : undefined}>
      <h1 ref={heading} tabIndex={-1} className="terminal-settings-heading">{title}</h1>
      {!phone && action}
    </div>
  </>;
}

/** The page's Add memory: in the drawer's header on a phone, beside the title in the window. */
function useAddAction(enabled: boolean, onAdd: () => void, ref: React.Ref<HTMLButtonElement>): React.ReactNode {
  useSettingsHeaderAction(enabled ? 'Add memory' : null, onAdd, { short: 'Add', icon: PlusIcon });
  return enabled ? <Button ref={ref} variant="primary" onClick={onAdd}><PlusIcon aria-hidden="true" />Add memory</Button> : null;
}

function MemoryRow({ record, query = '', showTopic = false, onOpen, onDelete }: {
  record: MemoryRecord;
  query?: string;
  showTopic?: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  // A phone gives the text the row's width; when it changed goes under it.
  const phone = useSettingsPhone();
  const imported = record.importSource ? IMPORT_LABEL[record.importSource] : null;
  return <HistoryRow id={rowKey.memory(record.id)} icon={imported ? DocIcon : KIND_ICON[record.kind]} title={record.body} query={query}
    meta={[...(showTopic ? [topicOf(record) || OTHER] : []), KIND_LABEL[record.kind], ...(imported ? [`From ${imported}`] : []),
      ...(typeof record.validUntil === 'number' ? [untilText(record.validUntil)] : []),
      ...(phone ? [agoText(record.updatedAt, 'Updated')] : [])]}
    when={phone ? undefined : when(record.updatedAt)} primary={{ label: 'Delete', icon: TrashIcon }} onPrimary={onDelete} onOpen={onOpen} />;
}

/** Deletes one memory once the user agrees; true once it is gone. */
async function deleteOne(record: MemoryRecord, library: MemoryLibrary): Promise<boolean> {
  const confirmed = await confirmDialog({
    title: 'Delete this memory?',
    message: `“${record.body}”\n\nAgents won’t read it again. The conversation it came from stays.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!confirmed) return false;
  try {
    await runSelfMutation(record.id, () => deleteMemory(record.id));
  } catch (error) {
    if (!isMemoryNotFound(error)) {
      toast.error(`Couldn’t delete the memory: ${errorText(error)}`);
      return false;
    }
  }
  library.remove(record.id);
  toast.success('Memory deleted');
  return true;
}

// ── Your memories ──────────────────────────────────────────────────────────

export function MemoryManageLevel({ library, profile, context, memoryOn, entrance, query, onQuery, filter, onFilter, onBack, onOpenTopic, onOpenMemory }: {
  library: MemoryLibrary;
  profile: MemoryProfile;
  context: MemoryContext;
  memoryOn: boolean;
  /** Opened from Settings › Memory, the level drills in as the others do; Back returns to it in one frame. */
  entrance: boolean;
  query: string;
  onQuery: (query: string) => void;
  filter: MemoryFilter;
  onFilter: (filter: MemoryFilter) => void;
  onBack: () => void;
  onOpenTopic: (key: string) => void;
  onOpenMemory: (id: string) => void;
}) {
  const search = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const addRef = useRef<HTMLButtonElement>(null);
  const addAction = useAddAction(memoryOn && !adding && library.status === 'ready', () => setAdding(true), addRef);
  // The form takes its own focus; once it closes, Add memory, else the title, has it.
  useFocusAfterChange(adding, (now) => now ? null : addRef.current);
  const all = useMemo(() => shelvesOf(library.records), [library.records]);
  const shownFilter = filter === ALL_MEMORIES || all.some((shelf) => shelf.key === filter) ? filter : ALL_MEMORIES;
  const shelves = all.filter((shelf) => shownFilter === ALL_MEMORIES || shelf.key === shownFilter);
  const searching = !!query.trim();
  const label = (shelf: MemoryShelf) => context.scopeLabel(shelf.scope);

  let body: React.ReactNode;
  if (library.status === 'loading') {
    body = <HistoryLoading label="Loading memories…" />;
  } else if (library.status === 'error') {
    body = <div className="settings-history__error" role="alert">
      <span>Couldn’t load memories: {library.error}.</span><Button size="sm" onClick={() => { void library.reload(); }}>Try again</Button>
    </div>;
  } else if (library.records.length === 0) {
    body = !adding && <HistoryEmpty icon={BrainIcon} title="Nothing remembered yet"
      action={memoryOn ? <Button onClick={() => setAdding(true)}><PlusIcon aria-hidden="true" />Add memory</Button> : undefined}>
      Michi saves what you ask it to remember, and what you say about yourself and your work in conversations.
    </HistoryEmpty>;
  } else if (searching) {
    const groups = shelves.map((shelf) => ({ shelf, rows: shelf.topics.flatMap((topic) => topic.memories).filter((record) => memoryMatches(record, query)) }))
      .filter((group) => group.rows.length > 0);
    body = groups.length === 0
      ? <HistoryEmpty icon={SearchIcon} title="No matching memories"
        action={<Button size="sm" onClick={() => { onQuery(''); onFilter(ALL_MEMORIES); search.current?.focus(); }}>Show all memories</Button>}>
        {`Nothing matches “${query.trim()}”.`}
      </HistoryEmpty>
      : groups.map(({ shelf, rows }) => <HistoryGroup key={shelf.key} title={label(shelf)} count={rows.length}>
        {rows.map((record) => <MemoryRow key={record.id} record={record} query={query} showTopic
          onOpen={() => onOpenMemory(record.id)} onDelete={() => { void deleteOne(record, library); }} />)}
      </HistoryGroup>);
  } else {
    body = shelves.map((shelf) => {
      const whole = shownFilter === shelf.key || expanded.has(shelf.key);
      const rows = whole ? shelf.topics : shelf.topics.slice(0, PREVIEW_TOPICS);
      const everywhere = shelf.scope.kind === 'user';
      return <HistoryGroup key={shelf.key} title={label(shelf)} count={shelf.count}
        footer={everywhere && <ProfileNote profile={profile} memoryOn={memoryOn} />}>
        {rows.map((topic) => <TopicRow key={topic.key} topic={topic} profile={profile} onOpen={() => onOpenTopic(topic.key)} />)}
        {shelf.topics.length > rows.length && <li className="memory-more">
          <button type="button" onClick={() => setExpanded((current) => new Set(current).add(shelf.key))}>
            Show {shelf.topics.length - rows.length} more
          </button>
        </li>}
      </HistoryGroup>;
    });
  }

  // Escape goes back, as it does from a topic or a memory; a search or the Add form takes it first.
  return <div className="memory-manage" data-entrance={entrance || undefined} onKeyDown={(event) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.stopPropagation(); onBack(); } }}>
    <LevelHead backLabel="Memory" onBack={onBack} title="Your memories" action={addAction} />
    <p className="settings-history__lede">Agents read these in every conversation. Open a topic to see each memory in it.</p>
    {library.records.length > 0 && <HistoryToolbar>
      <HistorySearch inputRef={search} value={query} onChange={onQuery} label="Search memories" placeholder="Search memories" />
      <select className="ui-select" aria-label="Show" value={shownFilter} onChange={(event) => onFilter(event.target.value)}>
        <option value={ALL_MEMORIES}>All memories · {library.records.length}</option>
        {all.map((shelf) => <option key={shelf.key} value={shelf.key}>{label(shelf)} · {shelf.count}</option>)}
      </select>
    </HistoryToolbar>}
    {adding && <AddMemory library={library} context={context} onDone={() => setAdding(false)} />}
    {body}
    {library.truncated && <p className="settings-history__note">The newest {LIBRARY_MAX.toLocaleString()} memories are listed here.</p>}
  </div>;
}

function TopicRow({ topic, profile, onOpen }: { topic: MemoryTopic; profile: MemoryProfile; onOpen: () => void }) {
  const phone = useSettingsPhone();
  const summary = profile.view ? summaryOf(topic, profile.view.lines)[0]?.text : undefined;
  return <HistoryRow id={rowKey.topic(topic.key)} icon={TagIcon} title={topicTitle(topic)} query=""
    meta={[memoriesText(topic.memories.length), summary ?? topic.memories[0].body]}
    when={phone ? undefined : when(topic.updatedAt)} onOpen={onOpen} />;
}

/** Under Everywhere: when About the user was written, and Rebuild. */
function ProfileNote({ profile, memoryOn }: { profile: MemoryProfile; memoryOn: boolean }) {
  const view = profile.view;
  if (!view) return null;
  const requested = view.rebuildRequested;
  return <>
    <p className="settings-history__note memory-profile-note">
      {view.builtAt ? agoText(view.builtAt, 'Summaries written') : 'Michi writes summaries once it has learned a few things about you'}
      {memoryOn && <> · <button type="button" className="settings-row__link" disabled={requested || profile.requesting}
        onClick={() => { void profile.rebuild(); }}>{requested ? 'Rebuilding…' : 'Rebuild'}</button></>}
    </p>
    {profile.rebuildError && <p className="settings-history__note is-error" role="alert">{profile.rebuildError}</p>}
  </>;
}

// ── a topic ────────────────────────────────────────────────────────────────

export function MemoryTopicLevel({ topic, library, profile, context, memoryOn, onBack, onOpenMemory, onDeleted }: {
  topic: MemoryTopic;
  library: MemoryLibrary;
  profile: MemoryProfile;
  context: MemoryContext;
  memoryOn: boolean;
  onBack: () => void;
  onOpenMemory: (id: string) => void;
  onDeleted: () => void;
}) {
  const phone = useSettingsPhone();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const summaryId = useId();
  const memoriesId = useId();
  const addRef = useRef<HTMLButtonElement>(null);
  const addAction = useAddAction(memoryOn && !adding, () => setAdding(true), addRef);
  useFocusAfterChange(adding, (now) => now ? null : addRef.current);
  const summary = profile.view ? summaryOf(topic, profile.view.lines) : [];
  const title = topicTitle(topic);
  const count = topic.memories.length;

  const removeAll = async () => {
    if (busy) return;
    const confirmed = await confirmDialog({
      title: `Delete ${title}?`,
      message: `This deletes its ${memoriesText(count)}. Agents won’t read them again; the conversations they came from stay.`,
      confirmLabel: `Delete ${memoriesText(count)}`,
      danger: true,
    });
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    let deleted = 0;
    for (const record of topic.memories) {
      try {
        await runSelfMutation(record.id, () => deleteMemory(record.id));
      } catch (failure) {
        if (!isMemoryNotFound(failure)) {
          setError(`Deleted ${deleted} of ${count}. Couldn’t delete the rest: ${errorText(failure)}`);
          setBusy(false);
          void library.reload();
          return;
        }
      }
      deleted += 1;
      library.remove(record.id);
    }
    toast.success(`Deleted ${title} · ${memoriesText(count)}`);
    onDeleted();
  };

  return <HistoryDetail backLabel="Your memories" onBack={onBack} icon={TagIcon} title={title} pageTitle readOnly={false}
    kind={[context.scopeLabel(topic.scope), memoriesText(count), agoText(topic.updatedAt, 'updated')].join(' · ')}
    details={[]}
    lead={<>
      {adding && <AddMemory library={library} context={context} initial={{ scope: topic.scope, topic: topic.name }} onDone={() => setAdding(false)} />}
      {error && <div className="settings-history__error" role="alert"><span>{error}</span></div>}
    </>}
    actions={<>
      {!phone && addAction}
      <Button danger disabled={busy} onClick={() => { void removeAll(); }}><TrashIcon aria-hidden="true" />{busy ? 'Deleting…' : `Delete ${title}…`}</Button>
    </>}>
    {summary.length > 0 && <section className="settings-section memory-summary" aria-labelledby={summaryId}>
      <div className="settings-section__head">
        <h2 id={summaryId} className="settings-section__title">Summary</h2>
        <span className="settings-section__aside">From About the user</span>
      </div>
      <ul className="settings-section__body memory-summary__lines">{summary.map((line) => <li key={line.index}>{line.text}</li>)}</ul>
    </section>}
    <section className="settings-section memory-rows" aria-labelledby={memoriesId}>
      <div className="settings-section__head">
        <h2 id={memoriesId} className="settings-section__title">Memories</h2>
        <span className="settings-section__aside">{count}</span>
      </div>
      <ul className="settings-history__card" aria-labelledby={memoriesId}>
        {topic.memories.map((record) => <MemoryRow key={record.id} record={record}
          onOpen={() => onOpenMemory(record.id)} onDelete={() => { void deleteOne(record, library); }} />)}
      </ul>
    </section>
  </HistoryDetail>;
}

// ── one memory ─────────────────────────────────────────────────────────────

type Notice = { tone: 'error' | 'info'; text: string } | null;

export function MemoryDetailLevel({ record, library, context, backLabel, onBack, onDeleted }: {
  record: MemoryRecord;
  library: MemoryLibrary;
  context: MemoryContext;
  backLabel: string;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const [editing, setEditing] = useState<{ draft: string; version: number } | null>(null);
  const [topicDraft, setTopicDraft] = useState(topicOf(record));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const editorId = useId();
  const topicsId = useId();
  const editRef = useRef<HTMLButtonElement>(null);
  // Edit gives way to the editor, and its Save, Cancel or Escape back to Edit.
  useFocusAfterChange(editing !== null, (now) => now ? document.getElementById(editorId) : editRef.current);
  const storedTopic = topicOf(record);
  useEffect(() => { setTopicDraft(storedTopic); }, [record.id, storedTopic]);
  // The last day it is true: saved once it is a whole date; No end date clears it.
  const storedUntil = lastDayValue(record.validUntil);
  const [untilDraft, setUntilDraft] = useState(storedUntil);
  useEffect(() => { setUntilDraft(storedUntil); }, [record.id, storedUntil]);

  /** One change at a time, checked against the version shown. */
  const change = async (what: string, patch: Omit<MemoryUpdateRequest, 'expectedVersion'>, version = record.version): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setNotice(null);
    try {
      library.replace(await runSelfMutation(record.id, () => updateMemory(record.id, { ...patch, expectedVersion: version })));
      return true;
    } catch (error) {
      if (isMemoryNotFound(error)) {
        library.remove(record.id);
        toast.error('This memory was deleted somewhere else.');
        onDeleted();
      } else if (isMemoryVersionConflict(error)) {
        await library.reload();
        setNotice({ tone: 'error', text: `This memory changed somewhere else, so ${what} wasn’t saved. It shows its current version now.` });
        setEditing(null);
      } else {
        setNotice({ tone: 'error', text: `Couldn’t save ${what}: ${errorText(error)}` });
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!editing) return;
    const body = editing.draft.trim();
    if (!body) { setNotice({ tone: 'error', text: 'A memory can’t be empty. Delete it instead.' }); return; }
    if (body === record.body) { setEditing(null); return; }
    if (await change('your edit', { body }, editing.version)) setEditing(null);
  };
  const saveTopic = async () => {
    const topic = topicDraft.trim();
    if (topic === topicOf(record)) { setTopicDraft(topic); return; }
    await change('the topic', { topic: topic || null });
  };

  const saveUntil = async (validUntil: number | null) => {
    if (validUntil === (record.validUntil ?? null)) return;
    await change('the end date', { validUntil });
  };

  const source = context.sourceNode(record);
  const imported = record.importSource ? IMPORT_LABEL[record.importSource] : null;
  const scopes = context.scopeChoices(record.scope);
  const topics = topicNamesIn(library.records, record.scope);
  let from: React.ReactNode;
  if (imported) {
    from = <span className="memory-from"><code>{record.importRef ?? `${imported}’s memory`}</code><small>Editing it here doesn’t change {imported}’s file.</small></span>;
  } else if (source) {
    from = <button type="button" className="settings-row__link" onClick={() => context.openSource(source)}>Open conversation</button>;
  } else if (record.source?.nodeId) {
    from = <span className="memory-from"><span>A conversation</span><small>Not open on this machine, or deleted.</small></span>;
  } else {
    from = record.origin === 'explicit' ? 'Added by hand' : '—';
  }

  const details = [
    {
      label: 'Kind',
      value: <select className="ui-select memory-field" aria-label="Kind" value={record.kind} disabled={busy}
        onChange={(event) => { void change('the kind', { kind: event.target.value as MemoryKind }); }}>
        {MEMORY_KINDS.map((kind) => <option key={kind} value={kind}>{KIND_LABEL[kind]}</option>)}
      </select>,
    },
    {
      label: 'Applies to',
      value: <select className="ui-select memory-field" aria-label="Applies to" value={scopeKey(record.scope)} disabled={busy}
        onChange={(event) => {
          const scope = scopes.find((choice) => scopeKey(choice) === event.target.value);
          if (scope && !sameScope(scope, record.scope)) void change('where it applies', { scope });
        }}>
        {scopes.map((scope) => <option key={scopeKey(scope)} value={scopeKey(scope)}>{context.scopeLabel(scope)}</option>)}
      </select>,
    },
    {
      label: 'Topic',
      value: <>
        <input className="ui-input memory-field" aria-label="Topic" list={topicsId} value={topicDraft} placeholder={OTHER} disabled={busy}
          maxLength={MEMORY_TOPIC_MAX_CHARS} spellCheck={false} autoComplete="off"
          onChange={(event) => setTopicDraft(event.target.value)}
          onBlur={() => { void saveTopic(); }}
          onKeyDown={(event) => {
            if (isImeComposing(event)) return;
            if (event.key === 'Enter') { event.preventDefault(); void saveTopic(); }
            if (event.key === 'Escape' && topicDraft !== topicOf(record)) { event.preventDefault(); event.stopPropagation(); setTopicDraft(topicOf(record)); }
          }} />
        <datalist id={topicsId}>{topics.map((name) => <option key={name} value={name} />)}</datalist>
      </>,
    },
    {
      label: 'Last day it’s true',
      value: <>
        <input type="date" className="ui-input memory-field" aria-label="Last day it’s true" value={untilDraft} disabled={busy}
          title="Agents don’t use a memory after its last day."
          onChange={(event) => setUntilDraft(event.target.value)}
          onBlur={() => { const next = validUntilOf(untilDraft); if (next !== null) void saveUntil(next); else setUntilDraft(storedUntil); }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); const next = validUntilOf(untilDraft); if (next !== null) void saveUntil(next); }
            if (event.key === 'Escape' && untilDraft !== storedUntil) { event.preventDefault(); event.stopPropagation(); setUntilDraft(storedUntil); }
          }} />
        {typeof record.validUntil === 'number' && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void saveUntil(null); }}>No end date</Button>
        )}
      </>,
    },
    { label: 'Saved', value: <span>{savedText(record)} · <time dateTime={new Date(record.createdAt).toISOString()}>{dateText(record.createdAt)}</time></span> },
    ...(dateText(record.updatedAt) !== dateText(record.createdAt)
      ? [{ label: 'Last updated', value: <time dateTime={new Date(record.updatedAt).toISOString()}>{dateText(record.updatedAt)}</time> }] : []),
    { label: 'From', value: from },
    ...(record.keywords?.length ? [{
      label: 'Search words',
      value: <span className="memory-words" title="Michi also finds this memory by these words">{record.keywords.map((word) => <span key={word}>{word}</span>)}</span>,
    }] : []),
  ];

  const remove = async () => {
    if (busy) return;
    if (await deleteOne(record, library)) onDeleted();
  };

  return <HistoryDetail backLabel={backLabel} onBack={onBack} icon={imported ? DocIcon : KIND_ICON[record.kind]} title={record.body} pageTitle readOnly={false}
    kind={[topicOf(record) || OTHER, context.scopeLabel(record.scope)].join(' · ')}
    details={details}
    lead={<>
      {editing && <div className="memory-editor">
        <label className="sr-only" htmlFor={editorId}>Memory</label>
        <textarea id={editorId} className="ui-input memory-editor__text" value={editing.draft} maxLength={MEMORY_BODY_MAX_CHARS} rows={3} autoFocus
          onChange={(event) => setEditing({ ...editing, draft: event.target.value })}
          onKeyDown={(event) => {
            if (isImeComposing(event)) return;
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(null); setNotice(null); }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); }
          }} />
        <div className="memory-editor__actions">
          <Button size="sm" variant="primary" busy={busy} busyLabel="Saving…" onClick={() => { void save(); }}>Save</Button>
          <Button size="sm" variant="ghost" aria-disabled={busy || undefined}
            onClick={() => { if (busy) return; setEditing(null); setNotice(null); }}>Cancel</Button>
        </div>
      </div>}
      {notice && <p className={notice.tone === 'error' ? 'memory-notice is-error' : 'memory-notice'} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p>}
    </>}
    actions={editing ? undefined : <>
      <Button ref={editRef} variant="primary" disabled={busy} onClick={() => { setEditing({ draft: record.body, version: record.version }); setNotice(null); }}>Edit</Button>
      <Button danger disabled={busy} onClick={() => { void remove(); }}><TrashIcon aria-hidden="true" />Delete…</Button>
    </>} />;
}

// ── adding one ─────────────────────────────────────────────────────────────

function AddMemory({ library, context, initial, onDone }: {
  library: MemoryLibrary;
  context: MemoryContext;
  /** On a topic's page: its scope and name. */
  initial?: { scope: MemoryScope; topic: string };
  onDone: () => void;
}) {
  const choices = context.scopeChoices(initial?.scope);
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<MemoryKind>('preference');
  const [scopeChoice, setScopeChoice] = useState(scopeKey(initial?.scope ?? choices[0]));
  const [topic, setTopic] = useState(initial?.topic ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyId = useId();
  const topicsId = useId();
  const scope = choices.find((choice) => scopeKey(choice) === scopeChoice) ?? choices[0];
  const topics = topicNamesIn(library.records, scope);

  const save = async () => {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const record = await runSelfCreate(() => createMemory({ scope, kind, body: text, ...(topic.trim() ? { topic: topic.trim() } : {}) }));
      library.add(record);
      toast.success(`Saved to ${record.topic?.trim() || OTHER}`);
      onDone();
    } catch (failure) {
      setError((failure as MemoryApiError)?.code === 'memory_disabled' ? 'Memory is off. Turn it on to add memories.' : `Couldn’t add the memory: ${errorText(failure)}`);
      setBusy(false);
    }
  };
  const keys = (event: React.KeyboardEvent) => {
    if (isImeComposing(event)) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDone(); }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); }
  };
  return (
    <div className="memory-add" role="group" aria-label="Add memory">
      <label className="sr-only" htmlFor={bodyId}>New memory</label>
      <textarea id={bodyId} className="ui-input memory-editor__text" value={body} rows={2} maxLength={MEMORY_BODY_MAX_CHARS} autoFocus
        placeholder="For example: Answer in Chinese unless I write in English."
        onChange={(event) => setBody(event.target.value)} onKeyDown={keys} />
      <div className="memory-editor__actions">
        <select className="ui-select memory-field" aria-label="Kind" value={kind} onChange={(event) => setKind(event.target.value as MemoryKind)}>
          {MEMORY_KINDS.map((value) => <option key={value} value={value}>{KIND_LABEL[value]}</option>)}
        </select>
        <select className="ui-select memory-field" aria-label="Applies to" value={scopeKey(scope)} onChange={(event) => setScopeChoice(event.target.value)}>
          {choices.map((choice) => <option key={scopeKey(choice)} value={scopeKey(choice)}>{context.scopeLabel(choice)}</option>)}
        </select>
        <input className="ui-input memory-field" aria-label="Topic" list={topicsId} value={topic} placeholder="Topic" maxLength={MEMORY_TOPIC_MAX_CHARS}
          spellCheck={false} autoComplete="off" onChange={(event) => setTopic(event.target.value)} onKeyDown={keys} />
        <datalist id={topicsId}>{topics.map((name) => <option key={name} value={name} />)}</datalist>
        <span className="settings-history__spacer" />
        <Button size="sm" variant="ghost" aria-disabled={busy || undefined} onClick={() => { if (!busy) onDone(); }}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={!body.trim()} busy={busy} busyLabel="Saving…" onClick={() => { void save(); }}>Save memory</Button>
      </div>
      {error && <p className="memory-notice is-error" role="alert">{error}</p>}
    </div>
  );
}
