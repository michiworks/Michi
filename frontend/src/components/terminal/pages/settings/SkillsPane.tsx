import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, CircleAlert, Plus, RotateCw, Search } from 'lucide-react';
import { toast } from 'sonner';
import { joinAnd, type SkillCatalogResponse, type SkillSummary } from 'michi-shared';
import { useChatProjects } from '../../../../state/chatStore';
import type { Project } from '../../../../state/chatTypes';
import { isSystemWorkspace } from '../../../../state/assistant/systemWorkspace';
import { useBackendConnections } from '../../../../state/useBackendConnections';
import { backendConnectionIdForWorkspace, LOCAL_BACKEND_CONNECTION_ID } from '../../../../config/backendConnections';
import { isSkillsUnavailable, listSkills, SKILLS_CHANGED_EVENT, SkillsApiError } from '../../../../services/api/skills';
import { Button } from '../../../ui/controls';
import { TrashIconButton } from '../TrashControls';
import { SearchHighlight } from '../../../ui/SearchHighlight';
import { findRowButton, HistoryEmpty, HistoryGroup, HistoryLoading, HistoryRow, HistorySearch, HistoryToolbar } from './HistoryList';
import { useSettingsHeaderAction } from './settingsPhone';
import { SkillDetailLevel, type SkillPlace } from './SkillDetail';
import { SkillForm } from './SkillForm';
import { BUILTIN, catalogRuntimes, errorText, LIBRARY, libraryRoot, scopeLabel, skillMatches } from './skillsModel';
import './skills.css';

const ALL = 'all';
/** Rows a runtime shows under All sources before "Show N more". */
const PREVIEW_ROWS = 5;
/** While a runtime is still listing, the page asks again this often, this many times in a row. */
const PENDING_RETRY_MS = 2_000;
const PENDING_RETRIES = 10;

type Level = { kind: 'skill'; id: string } | { kind: 'new' } | { kind: 'edit'; skill: SkillSummary; content: string } | null;

interface Answer {
  /** The backend and workspace it lists. */
  key: string;
  backendConnectionId: string;
  catalog: SkillCatalogResponse;
  /** Runtimes were still listing after every retry: the page waits to be asked again. */
  stalled: boolean;
}

interface Listing {
  /** The newest listing that landed, for whichever workspace was selected then. */
  answer: Answer | null;
  loadingKey: string | null;
  error: { key: string; text: string } | null;
  /** The backend has no Skills: 'skills_unavailable' keeps no library, null is older than Skills. */
  unavailable: { backendConnectionId: string; code: string | null } | null;
  /** Counts answers, so an open skill reads its file again with each. */
  revision: number;
}

/** A runtime still listing keeps the skills it listed for the same workspace last time until its new listing lands. */
function keepListed(fresh: SkillCatalogResponse, previous: SkillCatalogResponse | null): SkillCatalogResponse {
  const waiting = new Set(fresh.pending ?? []);
  if (!previous || waiting.size === 0) return fresh;
  const kept = previous.skills.filter((skill) => skill.origin !== LIBRARY && !!skill.runtimeId && waiting.has(skill.runtimeId)
    && !fresh.skills.some((other) => other.id === skill.id));
  return kept.length ? { ...fresh, skills: [...fresh.skills, ...kept] } : fresh;
}

/**
 * The listing of one backend for one workspace. It is read again when the
 * page opens, when the window comes back into view, after any write to the
 * library in this window, and shortly after an answer in which a runtime
 * was still listing. The last answer stays while one is on its way, and its
 * library stays while another workspace of the same backend loads. A newer
 * read cancels the one before it.
 */
function useSkillsListing(workspaceId: string | undefined, backendConnectionId: string) {
  const key = `${backendConnectionId}\n${workspaceId ?? ''}`;
  const [state, setState] = useState<Listing>({ answer: null, loadingKey: null, error: null, unavailable: null, revision: 0 });
  const inflight = useRef<AbortController | null>(null);
  const retries = useRef(0);
  /** ↻ was pressed: the answer that settles every runtime says whether all is up to date. */
  const confirming = useRef(false);

  /** The listing that landed, or null when it failed or a newer read replaced it. */
  const load = useCallback(async (options: { refresh?: boolean; confirm?: boolean; retry?: boolean } = {}): Promise<SkillCatalogResponse | null> => {
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    retries.current = options.retry ? retries.current + 1 : 0;
    if (options.confirm) confirming.current = true;
    setState((current) => ({ ...current, loadingKey: key }));
    try {
      const fresh = await listSkills({ workspaceId, backendConnectionId, refresh: options.refresh, signal: controller.signal });
      if (controller.signal.aborted) return null;
      const waiting = (fresh.pending?.length ?? 0) > 0;
      const stalled = waiting && retries.current >= PENDING_RETRIES;
      if (confirming.current && (!waiting || stalled)) {
        confirming.current = false;
        if (!waiting && !fresh.errors.some((entry) => entry.failed || entry.stale)) toast.success('Runtime skills are up to date');
      }
      setState((current) => ({
        answer: { key, backendConnectionId, catalog: keepListed(fresh, current.answer?.key === key ? current.answer.catalog : null), stalled },
        loadingKey: null,
        error: null,
        unavailable: null,
        // A retry only brings runtime skills: an open skill's file stays as read.
        revision: current.revision + (options.retry ? 0 : 1),
      }));
      return fresh;
    } catch (error) {
      if (controller.signal.aborted) return null;
      confirming.current = false;
      setState((current) => ({
        ...current,
        loadingKey: null,
        error: isSkillsUnavailable(error) ? null : { key, text: errorText(error) },
        unavailable: isSkillsUnavailable(error) ? { backendConnectionId, code: (error as SkillsApiError).code } : null,
      }));
      return null;
    } finally {
      if (inflight.current === controller) inflight.current = null;
    }
  }, [key, workspaceId, backendConnectionId]);
  useEffect(() => {
    void load();
    return () => {
      inflight.current?.abort();
      confirming.current = false;
    };
  }, [load]);
  useEffect(() => {
    // Coming back to the window fires focus and visibilitychange together: one read answers both.
    const again = () => { if (document.visibilityState !== 'hidden' && !inflight.current) void load(); };
    // A write in this window needs a read that starts after it.
    const changed = () => { void load(); };
    window.addEventListener('focus', again);
    window.addEventListener(SKILLS_CHANGED_EVENT, changed);
    document.addEventListener('visibilitychange', again);
    return () => {
      window.removeEventListener('focus', again);
      window.removeEventListener(SKILLS_CHANGED_EVENT, changed);
      document.removeEventListener('visibilitychange', again);
    };
  }, [load]);
  const { answer } = state;
  const waiting = answer?.key === key && !answer.stalled && (answer.catalog.pending?.length ?? 0) > 0;
  useEffect(() => {
    if (!waiting) return;
    // A read on its way (↻ among them) answers instead; its answer starts the wait again.
    const timer = setTimeout(() => { if (!inflight.current) void load({ retry: true }); }, PENDING_RETRY_MS);
    return () => clearTimeout(timer);
  }, [waiting, answer, load]);
  /** A write's answer, shown before the listing after it lands. */
  const update = useCallback((change: (skills: SkillSummary[]) => SkillSummary[]) => {
    setState((current) => current.answer?.backendConnectionId === backendConnectionId
      ? { ...current, answer: { ...current.answer, catalog: { ...current.answer.catalog, skills: change(current.answer.catalog.skills) } } }
      : current);
  }, [backendConnectionId]);
  return {
    key,
    /** The answer for this workspace; null until it lands. */
    catalog: answer?.key === key ? answer.catalog : null,
    /** The newest answer from this backend: its library is the same for each of the backend's workspaces. */
    libraryCatalog: answer?.backendConnectionId === backendConnectionId ? answer.catalog : null,
    stalled: answer?.key === key && answer.stalled,
    loading: state.loadingKey === key,
    error: state.error?.key === key ? state.error.text : null,
    unavailable: state.unavailable?.backendConnectionId === backendConnectionId ? state.unavailable : null,
    revision: state.revision,
    load,
    update,
  };
}

const isUserWorkspace = (project: Project) => !project.deletedAt && !project.archivedAt && !isSystemWorkspace(project);
const byName = (a: SkillSummary, b: SkillSummary) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.scope ?? '').localeCompare(b.scope ?? '');

/**
 * Settings › Skills: the Michi library of the selected workspace's backend,
 * which reaches every runtime, then the skills each runtime finds on its
 * own for that workspace, read only. A skill opens as a level of the page;
 * New skill and Edit share one form. While a listing loads or fails, or a
 * search matches nothing, the toolbar and the Workspace select stay, and the
 * section it concerns says so.
 */
export function SkillsPane() {
  const { projects, activeProject } = useChatProjects();
  const connections = useBackendConnections();
  const workspaces = useMemo(() => projects.filter(isUserWorkspace), [projects]);
  // Follows the active workspace until one is picked here.
  const [chosen, setChosen] = useState<string | null>(null);
  const workspace = workspaces.find((project) => project.id === (chosen ?? activeProject?.id)) ?? workspaces[0] ?? null;
  const machineOf = (id: string) => id === LOCAL_BACKEND_CONNECTION_ID ? null : connections.find((connection) => connection.id === id)?.name ?? id;
  const backendConnectionId = workspace ? backendConnectionIdForWorkspace(workspace.id) : LOCAL_BACKEND_CONNECTION_ID;
  const machine = machineOf(backendConnectionId);
  const { catalog, libraryCatalog, stalled, loading, error, unavailable, revision, key, load, update } = useSkillsListing(workspace?.id, backendConnectionId);

  const [query, setQuery] = useState('');
  const [source, setSource] = useState(ALL);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [level, setLevel] = useState<Level>(null);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const libraryId = useId();
  const builtinId = useId();
  const runtimesId = useId();

  const library = useMemo(() => (libraryCatalog?.skills ?? []).filter((skill) => skill.origin === LIBRARY).sort(byName), [libraryCatalog]);
  const builtins = useMemo(() => (libraryCatalog?.skills ?? []).filter((skill) => skill.origin === BUILTIN).sort(byName), [libraryCatalog]);
  const skills = useMemo(() => [...library, ...builtins, ...(catalog?.skills ?? []).filter((skill) => skill.origin === 'runtime')], [library, builtins, catalog]);

  // Another backend or workspace starts at its list.
  useEffect(() => { setLevel(null); }, [key]);
  // A skill gone from a new listing (deleted elsewhere) closes.
  useEffect(() => {
    if (level?.kind === 'skill' && libraryCatalog && !skills.some((skill) => skill.id === level.id)) setLevel(null);
  }, [level, libraryCatalog, skills]);
  // An opened level starts at its top.
  const levelKey = level ? (level.kind === 'skill' ? `skill:${level.id}` : level.kind) : null;
  useLayoutEffect(() => {
    if (levelKey) root.current?.closest('.terminal-settings-content')?.scrollTo?.({ top: 0 });
  }, [levelKey]);

  const taken = new Set(library.map((skill) => skill.name));
  // Without a workspace no runtime is asked: their skills are a folder's.
  const registry = catalog ?? libraryCatalog;
  const runtimes = workspace && registry && !unavailable ? catalogRuntimes(registry) : [];
  const ofRuntime = (id: string) => skills.filter((skill) => skill.origin === 'runtime' && skill.runtimeId === id).sort(byName);
  const errorsOf = (id: string) => catalog?.errors.filter((entry) => entry.runtimeId === id) ?? [];
  const waiting = new Set(catalog?.pending ?? []);
  const shown = runtimes.filter((runtime) => runtime.available || ofRuntime(runtime.id).length > 0 || errorsOf(runtime.id).length > 0 || waiting.has(runtime.id));
  const missing = runtimes.filter((runtime) => !shown.includes(runtime));
  const labelOf = (id: string | undefined) => runtimes.find((runtime) => runtime.id === id)?.label ?? id ?? '';
  const folder = libraryCatalog?.libraryPath ?? libraryRoot(library);
  const libraryAvailable = !unavailable && (libraryCatalog?.libraryAvailable ?? false);
  const place: SkillPlace = { workspaceId: workspace?.id, backendConnectionId, machine, root: folder };

  const focusRow = (id: string | null) => requestAnimationFrame(() => {
    const target = findRowButton(root.current, id) ?? search.current;
    target?.scrollIntoView?.({ block: 'nearest' });
    target?.focus({ preventScroll: true });
  });
  const back = (id: string | null) => { setLevel(null); focusRow(id); };
  const openNew = useCallback(() => setLevel({ kind: 'new' }), []);
  useSettingsHeaderAction(!level && libraryAvailable ? 'New skill' : null, openNew, { short: 'New', icon: Plus });
  const upsert = (saved: SkillSummary, previousId = saved.id) =>
    update((current) => [...current.filter((skill) => skill.id !== previousId && skill.id !== saved.id), saved]);

  const content = (body: React.ReactNode) => <div className="settings-history skills-settings" ref={root}>{body}</div>;

  if (level?.kind === 'new' || level?.kind === 'edit') {
    const editing = level.kind === 'edit' ? level : undefined;
    return content(<SkillForm key={level.kind} editing={editing} taken={taken} backendConnectionId={backendConnectionId} root={folder} machine={machine}
      onCancel={() => editing ? setLevel({ kind: 'skill', id: editing.skill.id }) : back(null)}
      onSaved={(saved) => {
        upsert(saved);
        setLevel({ kind: 'skill', id: saved.id });
        toast.success(editing ? 'Saved' : `${saved.name} created · /${saved.name} is in the / menu`);
      }} />);
  }
  const open = level?.kind === 'skill' ? skills.find((skill) => skill.id === level.id) : undefined;
  if (open) {
    return content(<SkillDetailLevel key={open.id} skill={open} place={place} runtimeLabel={labelOf(open.runtimeId)} revision={revision} taken={taken}
      onBack={() => back(open.id)}
      onChanged={(saved) => upsert(saved)}
      onRenamed={(saved, previousId) => {
        upsert(saved, previousId);
        setLevel({ kind: 'skill', id: saved.id });
        toast.success(`Renamed to ${saved.name}`);
      }}
      onDeleted={(gone) => {
        const at = library.findIndex((skill) => skill.id === gone.id);
        const next = library[at + 1] ?? library[at - 1];
        update((current) => current.filter((skill) => skill.id !== gone.id));
        back(next?.id ?? null);
        toast.success('Skill deleted');
      }}
      onEdit={(text) => setLevel({ kind: 'edit', skill: open, content: text })} />);
  }

  const loadError = (text: string) => <div className="settings-history__error" role="alert">
    <span>Couldn’t load skills: {text}.</span><Button size="sm" onClick={() => void load()}>Try again</Button>
  </div>;

  const shownSource = source === ALL || source === LIBRARY || (source === BUILTIN && builtins.length > 0) || shown.some((runtime) => runtime.id === source) ? source : ALL;
  // A failed read with nothing of its own on screen shows in the section it leaves empty; otherwise above both.
  const errorInSection = !!error && !catalog && (!libraryCatalog || (shownSource !== LIBRARY && shownSource !== BUILTIN));
  const counts = new Map(shown.map((runtime) => [runtime.id, ofRuntime(runtime.id).length]));
  const total = library.length + builtins.length + [...counts.values()].reduce((sum, count) => sum + count, 0);
  const failedOf = (id: string) => errorsOf(id).filter((entry) => entry.failed);
  /** Nothing listed yet: a failed listing has no number, one still running has none yet. */
  const countText = (id: string) => {
    const count = counts.get(id) ?? 0;
    if (count > 0) return String(count);
    return failedOf(id).length > 0 ? '—' : waiting.has(id) ? '…' : '0';
  };

  const searching = !!query.trim();
  const libraryRows = library.filter((skill) => skillMatches(skill, query));
  const builtinRows = builtins.filter((skill) => skillMatches(skill, query));
  const groups = (catalog ? shown : []).filter((runtime) => shownSource === ALL || shownSource === runtime.id).map((runtime) => {
    const listed = ofRuntime(runtime.id);
    const all = listed.filter((skill) => skillMatches(skill, query));
    const whole = searching || shownSource === runtime.id || expanded.has(runtime.id);
    const failed = failedOf(runtime.id);
    const listing = waiting.has(runtime.id);
    return {
      runtime, all, rows: whole ? all : all.slice(0, PREVIEW_ROWS), failed, listing,
      notes: errorsOf(runtime.id).filter((entry) => !entry.failed),
      count: listed.length === 0 && (failed.length > 0 || listing) ? undefined : all.length,
    };
  }).filter((group) => group.all.length > 0 || group.failed.length > 0 || group.listing || (!searching && group.notes.length > 0));
  const settled = !!libraryCatalog && !unavailable && (!workspace || (!!catalog && waiting.size === 0));
  const nothing = searching && settled
    && (shownSource === ALL || shownSource === LIBRARY ? libraryRows.length : 0)
    + (shownSource === ALL || shownSource === BUILTIN ? builtinRows.length : 0) + groups.reduce((sum, group) => sum + group.all.length, 0) === 0;
  const showLibrary = (shownSource === ALL || shownSource === LIBRARY) && (!searching || libraryRows.length > 0 || !libraryCatalog || !!unavailable);
  const showBuiltins = (shownSource === ALL || shownSource === BUILTIN) && !unavailable && builtinRows.length > 0;

  const row = (skill: SkillSummary) => <HistoryRow key={skill.id} id={skill.id} icon={BookOpen} title={skill.name} query={query}
    meta={[
      ...(skill.origin === 'runtime' && scopeLabel(skill) ? [scopeLabel(skill)] : []),
      <span key="description"><SearchHighlight text={skill.description || 'No description.'} query={query} /></span>,
    ]}
    when={skill.origin !== 'runtime' && !skill.enabled ? { label: 'Off', status: true } : undefined}
    onOpen={() => setLevel({ kind: 'skill', id: skill.id })} />;

  let libraryBody: React.ReactNode;
  if (unavailable) {
    libraryBody = <HistoryEmpty icon={BookOpen} title="Skills aren’t available here">
      {unavailable.code === 'skills_unavailable' ? 'This Michi server keeps no skill library.' : 'This Michi backend doesn’t support Skills yet.'}
    </HistoryEmpty>;
  } else if (!libraryCatalog) {
    libraryBody = error ? loadError(error) : <HistoryLoading label="Loading skills…" />;
  } else if (!libraryAvailable) {
    libraryBody = <p className="settings-history__note">This Michi server keeps no skill library.</p>;
  } else if (library.length === 0) {
    libraryBody = <HistoryEmpty icon={BookOpen} title="No skills in your library"
      action={<Button onClick={openNew}><Plus size={13} aria-hidden="true" />New skill</Button>}>
      {`Skills you create here reach every runtime Michi runs. Each one is a folder with a SKILL.md${folder ? ` in ${folder}` : ''}.`}
    </HistoryEmpty>;
  } else if (libraryRows.length > 0) {
    libraryBody = <ul className="settings-history__card">{libraryRows.map(row)}</ul>;
  }
  const libraryProblems = unavailable ? [] : libraryCatalog?.errors.filter((entry) => !entry.runtimeId) ?? [];
  const librarySection = showLibrary && <section className="settings-section skills-section" aria-labelledby={libraryId}>
    <div className="settings-section__head">
      <h2 id={libraryId} className="settings-section__title">Library</h2>
      {folder && !unavailable && <span className="settings-section__aside skills-path">{folder}{machine ? ` on ${machine}` : ''}</span>}
    </div>
    {libraryBody}
    {libraryProblems.map((entry, index) => <p key={index} className="settings-history__note skills-problem">{entry.message}</p>)}
  </section>;

  const builtinSection = showBuiltins && <section className="settings-section skills-section" aria-labelledby={builtinId}>
    <div className="settings-section__head">
      <h2 id={builtinId} className="settings-section__title">Built-in</h2>
      <span className="settings-section__aside">Ship with Michi · read only</span>
    </div>
    <ul className="settings-history__card">{builtinRows.map(row)}</ul>
  </section>;

  const noMatch = nothing && <HistoryEmpty icon={Search} title="No matching skills"
    action={<Button size="sm" onClick={() => { setQuery(''); setSource(ALL); search.current?.focus(); }}>Show all skills</Button>}>
    {`Nothing matches “${query.trim()}”.`}
  </HistoryEmpty>;

  const where = machine ? ` on ${machine}` : '';
  // An unavailable backend, or one with nothing on screen yet: the Library section says so.
  let runtimeBody: React.ReactNode = null;
  if (unavailable) {
    runtimeBody = null;
  } else if (!workspace) {
    runtimeBody = <p className="settings-history__note skills-note">Runtime skills are listed for a workspace’s folder. Create a workspace to see them.</p>;
  } else if (!catalog) {
    if (libraryCatalog) runtimeBody = error ? loadError(error) : <HistoryLoading label="Loading runtime skills…" />;
  } else {
    runtimeBody = <>
      <p className="settings-history__note skills-note">
        {`Read only. Personal and plugin skills${workspace.cwd ? `, plus the project skills in ${workspace.cwd}${where}` : ''}.`}
      </p>
      {groups.map(({ runtime, all, rows, failed, listing, notes, count }) => <HistoryGroup key={runtime.id} title={runtime.label} count={count}
        footer={!searching && notes.map((entry, index) => <p key={index} className="settings-history__note">{entry.message}</p>)}>
        {listing && <li className="skills-status">
          <span role="status">{stalled ? `${runtime.label} is still listing its skills.` : `Listing ${runtime.label} skills…`}</span>
          {stalled && <Button size="sm" onClick={() => void load()}>Try again</Button>}
        </li>}
        {failed.map((entry, index) => <li key={`failed-${index}`} className="skills-error">
          <CircleAlert size={14} aria-hidden="true" /><span role="alert">Couldn’t list {runtime.label} skills: {entry.message.replace(/\.$/, '')}.</span>
          <Button size="sm" onClick={() => void load()}>Try again</Button>
        </li>)}
        {rows.map(row)}
        {all.length > rows.length && <li className="skills-more">
          <button type="button" onClick={() => {
            setExpanded((current) => new Set(current).add(runtime.id));
            focusRow(all[rows.length].id);
          }}>Show {all.length - rows.length} more</button>
        </li>}
      </HistoryGroup>)}
      {groups.length === 0 && !searching && <p className="settings-history__note">No runtime reported skills for {workspace.name || 'this workspace'}.</p>}
      {missing.length > 0 && shownSource === ALL && !searching && <p className="settings-history__note">
        {joinAnd(missing.map((runtime) => runtime.label))} {missing.length > 1 ? 'aren’t' : 'isn’t'} set up on {machine ?? 'this machine'}.
      </p>}
    </>;
  }
  // With nothing to show, the Workspace select stays where it was: another workspace may match.
  const runtimeSection = shownSource !== LIBRARY && shownSource !== BUILTIN && (!nothing || !!workspace) && <section className="settings-section skills-section" aria-labelledby={runtimesId}>
    <div className="settings-section__head">
      <h2 id={runtimesId} className="settings-section__title">Runtime skills</h2>
      {workspace && <label className="skills-workspace"><span>Workspace</span>
        <select className="ui-select" value={workspace.id} onChange={(event) => { setChosen(event.target.value); setExpanded(new Set()); }}>
          {workspaces.map((project) => {
            const remote = machineOf(backendConnectionIdForWorkspace(project.id));
            return <option key={project.id} value={project.id}>{project.name || 'Untitled workspace'}{remote ? ` · ${remote}` : ''}</option>;
          })}
        </select>
      </label>}
    </div>
    {noMatch || runtimeBody}
  </section>;

  return content(<>
    <p className="settings-history__lede">Instructions agents load when a task fits, or that you run with / in a chat. Skills in your library reach every runtime.</p>
    <HistoryToolbar>
      <HistorySearch inputRef={search} value={query} onChange={setQuery} label="Search skills" placeholder="Search skills" />
      <select className="ui-select skills-source" aria-label="Source" value={shownSource} onChange={(event) => setSource(event.target.value)}>
        <option value={ALL}>All sources{catalog ? ` · ${total}` : ''}</option>
        <option value={LIBRARY}>Library{libraryCatalog ? ` · ${library.length}` : ''}</option>
        {builtins.length > 0 && <option value={BUILTIN}>Built-in · {builtins.length}</option>}
        {shown.map((runtime) => <option key={runtime.id} value={runtime.id}>{runtime.label}{catalog ? ` · ${countText(runtime.id)}` : ''}</option>)}
      </select>
      <TrashIconButton icon={RotateCw} tooltip="Check the runtimes for new skills" aria-label="Check the runtimes for new skills"
        aria-busy={loading || undefined} onClick={() => void load({ refresh: true, confirm: true })} />
    </HistoryToolbar>
    {error && !errorInSection && loadError(error)}
    {nothing ? !runtimeSection && noMatch : <>{librarySection}{builtinSection}</>}
    {runtimeSection}
  </>);
}
