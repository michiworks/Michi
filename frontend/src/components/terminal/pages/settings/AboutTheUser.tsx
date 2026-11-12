import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { MemoryProfileCitation } from 'michi-shared';
import { relativeTime } from '../../../../lib/relativeTime';
import { onMemoryChanged } from '../../../../state/memory/memoryNotifications';
import {
  fetchMemoryProfile,
  isMemoryNotFound,
  isMemoryVersionConflict,
  rebuildMemoryProfile,
  removeMemoryProfileLine,
  type MemoryProfileLine,
  type MemoryProfileView,
} from '../../../../services/api/memories';
import { Button } from '../../../ui/controls';
import { SettingsSection } from './SettingsSection';

/**
 * Settings › Memory › About the user: the short profile Michi writes from the
 * memories it saved about the user and pins in every conversation (GET
 * /api/memory-profile). Each line lists the memories it rests on, each a link
 * to that memory under Saved memories. Remove deletes those memories, which
 * takes the line out; Rebuild asks automatic memory to write it again now.
 */

const RELOAD_DEBOUNCE_MS = 250;
/** While a requested rebuild waits for automatic memory, the profile is read again this often, for at most this long. */
const REBUILD_POLL_MS = 4_000;
const REBUILD_POLL_LIMIT_MS = 5 * 60_000;
const CHANGED = 'About the user changed meanwhile, so nothing was removed. Check it and try again.';

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'unknown error';
}

function builtText(builtAt: number): string {
  const ago = relativeTime(builtAt);
  return ago === 'now' ? 'Built just now' : ago === 'yesterday' ? 'Built yesterday' : `Built ${ago} ago`;
}

const memoriesText = (count: number) => count === 1 ? '1 memory' : `${count} memories`;

/** Consecutive lines under one topic, in the profile's order. */
function byTopic(lines: readonly MemoryProfileLine[]): Array<{ topic: string; lines: MemoryProfileLine[] }> {
  const groups: Array<{ topic: string; lines: MemoryProfileLine[] }> = [];
  for (const line of lines) {
    const last = groups[groups.length - 1];
    if (last && last.topic === line.topic) last.lines.push(line);
    else groups.push({ topic: line.topic, lines: [line] });
  }
  return groups;
}

const sameLine = (a: MemoryProfileLine | undefined, b: MemoryProfileLine) => !!a && a.text === b.text
  && a.refs.length === b.refs.length && a.refs.every((ref, index) => ref.ref === b.refs[index].ref);

type Load = { status: 'loading' | 'ready' | 'unavailable' | 'error'; view: MemoryProfileView | null; error: string | null };

export function AboutTheUser({ memoryOn, reloadKey, onShowMemory }: {
  memoryOn: boolean;
  /** Changes when every memory was deleted: the profile is read again. */
  reloadKey: number;
  /** Shows one of the memories a line rests on under Saved memories. */
  onShowMemory: (memory: MemoryProfileCitation) => void;
}) {
  const [state, setState] = useState<Load>({ status: 'loading', view: null, error: null });
  const [requesting, setRequesting] = useState(false);
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  // Why a Remove did nothing: above the lines, which may have changed under it, and brought into view.
  const [notice, setNotice] = useState<string | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (notice) noticeRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [notice]);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const view = await fetchMemoryProfile();
      if (mine !== generation.current) return;
      setState(view ? { status: 'ready', view, error: null } : { status: 'unavailable', view: null, error: null });
    } catch (error) {
      if (mine !== generation.current) return;
      setState((current) => ({ status: current.view ? 'ready' : 'error', view: current.view, error: errorText(error) }));
    }
  }, []);
  /** A write's answer, newer than any read still in flight. */
  const show = (view: MemoryProfileView) => {
    generation.current += 1;
    setState({ status: 'ready', view, error: null });
  };

  useEffect(() => { void load(); }, [load, reloadKey]);

  // A memory edited, corrected or deleted anywhere can take lines out.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = onMemoryChanged(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void load(); }, RELOAD_DEBOUNCE_MS);
    });
    return () => { stop(); if (timer !== null) clearTimeout(timer); };
  }, [load]);

  const requested = state.view?.rebuildRequested === true;
  useEffect(() => {
    if (!requested) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > REBUILD_POLL_LIMIT_MS) clearInterval(timer);
      else void load();
    }, REBUILD_POLL_MS);
    return () => clearInterval(timer);
  }, [requested, load]);

  const rebuild = async () => {
    setRequesting(true);
    setRebuildError(null);
    try {
      show(await rebuildMemoryProfile());
    } catch (error) {
      setRebuildError(`Couldn’t ask for a rebuild: ${errorText(error)}`);
    } finally {
      setRequesting(false);
    }
  };

  /** True once the line is gone. */
  const remove = async (line: MemoryProfileLine): Promise<boolean> => {
    const shown = state.view;
    if (!shown) return false;
    setNotice(null);
    try {
      // Remove names a line by its place, and lines drop out (a memory they
      // cite was deleted) without a new version: check it is still that line.
      const fresh = await fetchMemoryProfile();
      if (!fresh || fresh.version !== shown.version || !sameLine(fresh.lines.find((candidate) => candidate.index === line.index), line)) {
        if (fresh) show(fresh);
        setNotice(CHANGED);
        return false;
      }
      show(await removeMemoryProfileLine(line.index, fresh.version));
      return true;
    } catch (error) {
      if (isMemoryVersionConflict(error) || isMemoryNotFound(error)) {
        void load();
        setNotice(CHANGED);
      } else {
        setNotice(`Couldn’t remove it: ${errorText(error)}`);
      }
      return false;
    }
  };

  if (state.status === 'unavailable') return null;
  const view = state.view;
  const groups = view ? byTopic(view.lines) : [];
  return (
    <SettingsSection title="About the user" className="memory-profile"
      aside={view?.builtAt ? (
        <time dateTime={new Date(view.builtAt).toISOString()} title={new Date(view.builtAt).toLocaleString()}>{builtText(view.builtAt)}</time>
      ) : undefined}
      intro="A short summary Michi writes from the memories it saved about you. Agents read it at the start of every conversation.">
      {state.status === 'loading' && <p className="settings-section__status" role="status">Loading…</p>}
      {state.status === 'error' && (
        <p className="settings-section__error" role="alert">
          Couldn’t load About the user{state.error ? `: ${state.error}` : ''}.{' '}
          <button type="button" className="settings-row__link" onClick={() => { void load(); }}>Try again</button>
        </p>
      )}
      {notice && <p ref={noticeRef} className="memory-item__notice is-error" role="alert">{notice}</p>}
      {view && groups.length === 0 && (
        <p className="settings-section__status">
          {view.builtAt === null ? 'Nothing yet. Michi writes this once it has learned a few things about you.' : 'Nothing here right now. Michi writes it again as it learns more.'}
        </p>
      )}
      {view && groups.map((group, position) => (
        <div key={`${view.version}:${position}`} className="memory-profile__topic">
          {group.topic && <h3 className="memory-profile__topic-title">{group.topic}</h3>}
          <ul className="memory-profile__lines" aria-label={group.topic || 'About the user'}>
            {group.lines.map((line) => (
              <ProfileLine key={`${view.version}:${line.index}:${line.text}`} line={line} onRemove={() => remove(line)} onShowMemory={onShowMemory} />
            ))}
          </ul>
        </div>
      ))}
      {view && (
        <div className="memory-profile__rebuild">
          <Button size="sm" disabled={!memoryOn || requested || requesting} onClick={() => { void rebuild(); }}>Rebuild</Button>
          <span className="settings-row__state" role="status">
            {!memoryOn ? 'Turn memory on to rebuild it.' : requested ? 'Rebuilding with automatic memory. This can take a minute.' : ''}
          </span>
        </div>
      )}
      {rebuildError && <p className="memory-item__notice is-error" role="alert">{rebuildError}</p>}
    </SettingsSection>
  );
}

function ProfileLine({ line, onRemove, onShowMemory }: {
  line: MemoryProfileLine;
  /** Resolves true once the line is gone. */
  onRemove: () => Promise<boolean>;
  onShowMemory: (memory: MemoryProfileCitation) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const citesId = useId();
  const memories = memoriesText(line.refs.length);

  const remove = async () => {
    setBusy(true);
    const removed = await onRemove();
    if (!removed) {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <li className="memory-profile__line" aria-busy={busy || undefined}>
      <p className="memory-profile__text">{line.text}</p>
      <div className="memory-item__actions">
        <button type="button" className="memory-profile__cites-toggle" aria-expanded={open} aria-controls={open ? citesId : undefined}
          onClick={() => setOpen((value) => !value)}>
          <ChevronRight size={12} strokeWidth={2} aria-hidden="true" />
          Based on {memories}
        </button>
        {confirming ? <>
          <span className="memory-profile__confirm">Deletes the {memories} it’s based on.</span>
          <Button size="sm" danger disabled={busy} onClick={() => { void remove(); }}>Confirm remove</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>Keep</Button>
        </> : <Button size="sm" variant="ghost" danger disabled={busy} onClick={() => setConfirming(true)}>Remove</Button>}
      </div>
      {open && (
        <ul id={citesId} className="memory-profile__cites" aria-label="Memories it’s based on">
          {line.refs.map((ref) => (
            <li key={ref.ref}>
              <button type="button" className="settings-row__link memory-profile__cite" title="Show in Saved memories" onClick={() => onShowMemory(ref)}>
                {ref.body}
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
