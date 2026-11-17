import React, { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { isOpenCompanionItem, type CompanionCheckinChangeDto, type CompanionConfigurableSource, type CompanionItemDto } from 'michi-shared';
import { Button } from '../../ui/controls';
import { MichiSectionLabel } from '../content/MichiSectionLabel';
import { AlarmIcon, ArchiveIcon, ChevronRightIcon, WarningIcon } from '../icons';
import { useMinuteClock } from '../content/home/useMinuteClock';
import { CompanionApiError, checkCompanionNow, type CompanionSnapshot } from '../../../services/api/companion';
import {
  actOnCompanionItem,
  companionItemShowsOnToday,
  markCompanionItemsSeen,
} from '../../../state/companion/companionStore';
import { takeCompanionFocusItem, useCompanionPanel } from '../../../state/companion/companionPanel';
import { useCompanionName } from '../../../state/companion/companionName';
import { companionAgo, companionClock } from '../../../state/companion/companionView';
import {
  companionTodayHeadline,
  companionTodayView,
  type CompanionTodayEntry,
  type CompanionTodayFold,
  type CompanionTodayHealth,
  type CompanionTodayView,
} from '../../../state/companion/companionToday';
import { CompanionItemLine, CompanionItemRow } from './CompanionItemRow';
import { CompanionReminders } from './CompanionReminders';
import { CompanionVisibleText } from './CompanionVisibleText';

/** How long the item a notice brought into view stays highlighted; then it fades (companion.css). */
const COMPANION_FOCUS_HIGHLIGHT_MS = 2_000;

/** How long an item a check-in dismissed is listed under "Moved by <name>", with its Undo; a snooze stays listed until it ends. */
const COMPANION_MOVED_OFF_TODAY_MS = 24 * 3_600_000;

/** The keys of the folds Today opens and closes; a group's key is its entry's. */
const SPILL = 'spill';
const ASIDE = 'aside';

/**
 * What the check-ins did to Today's items (DESIGN-v2 §2.7, snapshot.checkinChanges,
 * newest first): for each item, the newest change, while it stands (the
 * backend's Undo-all check: not undone, and the item is still as the change
 * left it; W3-F3-review #1). What the user, the item's source or a later run
 * did since is theirs, not the check-in's.
 * `restored`: items on Today that a check-in brought back (their row says so).
 * `movedOff`: items a check-in took off Today, newest first, each with Undo:
 * a dismissal for COMPANION_MOVED_OFF_TODAY_MS, a snooze until it ends.
 */
function companionTodayChanges(
  changes: readonly CompanionCheckinChangeDto[] | undefined,
  items: readonly Pick<CompanionItemDto, 'id'>[],
  now: number,
): { restored: ReadonlyMap<string, CompanionCheckinChangeDto>; movedOff: CompanionCheckinChangeDto[] } {
  const onToday = new Set(items.map((item) => item.id));
  const newest = new Map<string, CompanionCheckinChangeDto>();
  for (const change of changes ?? []) {
    if (change.targetKind === 'item' && !newest.has(change.targetId)) newest.set(change.targetId, change);
  }
  const restored = new Map<string, CompanionCheckinChangeDto>();
  const movedOff: CompanionCheckinChangeDto[] = [];
  for (const change of newest.values()) {
    if (!change.standing || change.undoneAt !== null) continue;
    if (onToday.has(change.targetId)) {
      if (change.action === 'restore') restored.set(change.targetId, change);
    } else if (change.action === 'dismiss'
      ? now - change.at <= COMPANION_MOVED_OFF_TODAY_MS
      : change.action === 'snooze' && change.snoozedUntil !== null && change.snoozedUntil > now) {
      movedOff.push(change);
    }
  }
  return { restored, movedOff };
}

const MOVED_BY: Partial<Record<CompanionCheckinChangeDto['action'], string>> = { dismiss: 'Dismissed', snooze: 'Snoozed' };

/**
 * "Dismissed by <name> — <reason> · Undo": Undo puts the item back on Today
 * (its restore action). Success is said only when the answer shows on Today:
 * the backend leaves a resolved item as it is, and an off source keeps its
 * items out of sight.
 */
function MovedOffRow({ change, name, settings }: { change: CompanionCheckinChangeDto; name: string; settings: CompanionSnapshot['settings'] }) {
  const [busy, setBusy] = useState(false);
  const title = change.title ?? 'An item';
  const undo = async () => {
    setBusy(true);
    try {
      const answer = await actOnCompanionItem(change.targetId, { action: 'restore' });
      if (companionItemShowsOnToday(answer, settings)) toast(`Put “${title}” back on Today`);
      else if (!isOpenCompanionItem(answer, Date.now())) toast(`“${title}” is no longer open, so it can’t go back on Today`);
      else toast(`Put “${title}” back, but its source is off in Settings, so Today doesn’t show it`);
    } catch (error) {
      toast.error(`Couldn’t put it back: ${error instanceof Error && error.message ? error.message : 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  };
  const Icon = change.action === 'snooze' ? AlarmIcon : ArchiveIcon;
  // Laid out as an item row (companion.css), so it reads as one of Today's.
  return (
    <div className="companion-row companion-moved" data-moved-item-id={change.targetId}>
      <span className="companion-row__icon" aria-hidden="true"><Icon /></span>
      <div className="companion-row__main">
        <div className="companion-row__line">
          <span className="companion-row__title" title={title}><CompanionVisibleText text={title} /></span>
        </div>
        <p className="companion-moved__by companion-row__summary">
        {MOVED_BY[change.action] ?? 'Changed'} by {name}
        {change.reason && <> — <CompanionVisibleText text={change.reason} /></>}
        {' · '}
        <button type="button" className="companion-link-btn" disabled={busy} aria-label={`Undo: ${title}`}
          onClick={() => { void undo(); }}>Undo</button>
        </p>
      </div>
    </div>
  );
}

/**
 * Michi cannot see, or cannot think: one line per cause, above everything
 * else, each with the one thing that helps from here (Check again after
 * refreshing credentials, a retry for the source that failed, Settings for the model that
 * refuses to run). Without these lines the rows below look like a judgement
 * Michi made, when nothing of the sort happened.
 */
function HealthLine({ line, onOpenSettings }: { line: CompanionTodayHealth; onOpenSettings(): void }) {
  const [busy, setBusy] = useState(false);
  const check = async (sources?: readonly CompanionConfigurableSource[]) => {
    setBusy(true);
    try {
      await checkCompanionNow(sources);
      toast('Checking now');
    } catch (error) {
      toast.error(error instanceof CompanionApiError && error.code === 'not_owner'
        ? 'Another Michi window is doing the checking'
        : `Couldn’t check now: ${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="companion-health__line">
      <WarningIcon aria-hidden="true" />
      <span>{line.text}</span>
      {line.remedy.kind === 'check'
        ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void check(line.remedy.kind === 'check' ? line.remedy.sources : undefined); }}>{line.remedy.label}</Button>
        : <Button size="sm" onClick={onOpenSettings}>{line.remedy.label}</Button>}
    </div>
  );
}

/** A fold: what is inside it, how much, and its rows in one frame when it opens (TR-18). */
function Fold({ id, summary, meta, open, onToggle, className, children }: {
  id: string;
  summary: string;
  meta?: string;
  open: boolean;
  onToggle(key: string): void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`companion-fold${className ? ` ${className}` : ''}`}>
      <button type="button" className="companion-fold__summary" aria-expanded={open} onClick={() => onToggle(id)}>
        <ChevronRightIcon size="sm" />
        <span>{summary}</span>
        {meta && <span className="companion-fold__meta">{meta}</span>}
      </button>
      {open && <div className="companion-fold__body">{children}</div>}
    </div>
  );
}

/** Every item a row, a line or an open fold has on screen: what Today may mark seen. */
function visibleItemIds(view: CompanionTodayView, open: ReadonlySet<string>): string[] {
  const ids: string[] = [];
  const add = (entries: readonly CompanionTodayEntry[]) => { for (const entry of entries) for (const item of entry.items) ids.push(item.id); };
  add(view.waiting.rows);
  if (open.has(SPILL)) add(view.waiting.spill);
  for (const fold of view.mine.folds) if (open.has(fold.key)) add(fold.entries);
  if (open.has(ASIDE)) add(view.aside.entries);
  return ids;
}

/** The folds and groups that have to open for this item to be on screen. */
function foldsTo(view: CompanionTodayView, id: string): string[] {
  const holds = (entry: CompanionTodayEntry) => entry.items.some((item) => item.id === id);
  const group = (entry: CompanionTodayEntry) => (entry.members && entry.items.length > 1 ? [entry.key] : []);
  for (const entry of view.waiting.rows) if (holds(entry)) return group(entry);
  for (const entry of view.waiting.spill) if (holds(entry)) return [SPILL, ...group(entry)];
  for (const fold of view.mine.folds) for (const entry of fold.entries) if (holds(entry)) return [fold.key, ...group(entry)];
  for (const entry of view.aside.entries) if (holds(entry)) return [ASIDE, ...group(entry)];
  return [];
}

/**
 * Today: what Michi cannot do, then how many things wait on the user and the
 * rows that are those things, then their own work and the rest, folded away
 * but not out of reach. There is no brief and no "Since you left": a
 * headline written hours ago cannot stay true, while a count taken from the
 * rows always is (owner, 2026-11-17).
 *
 * The new items on screen are marked seen while the window has focus; a row
 * keeps its New dot for this visit.
 */
export function CompanionToday({ snapshot, arrivals, onOpenItem, onAsk, onOpenSettings }: {
  snapshot: CompanionSnapshot;
  arrivals: Readonly<Record<string, number>>;
  onOpenItem(item: CompanionItemDto): void;
  onAsk(item: CompanionItemDto): void;
  onOpenSettings(): void;
}) {
  const clock = useMinuteClock(true);
  const panel = useCompanionPanel();
  const view = useMemo(
    () => companionTodayView({ items: snapshot.items, settings: snapshot.settings, activity: snapshot.activity }, clock),
    [snapshot.items, snapshot.settings, snapshot.activity, clock],
  );
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string) => setOpen((current) => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  });

  const newIds = useMemo(
    () => visibleItemIds(view, open).filter((id) => snapshot.items.find((item) => item.id === id)?.status === 'new'),
    [view, open, snapshot.items],
  );
  // New when the user first had it on screen: keeps its dot after it is marked seen.
  const newAtSight = useRef(new Set<string>());
  for (const id of newIds) newAtSight.current.add(id);
  const newKey = newIds.join('\n');
  useEffect(() => {
    if (!newKey || !document.hasFocus()) return;
    markCompanionItemsSeen(newKey.split('\n'));
  }, [newKey]);

  // A notice's target named an item: show it (opening the folds it sits in), bring it into view and
  // highlight it briefly. One that is no longer open leaves just Today. Each request is taken once,
  // so coming back to Today later does not jump again.
  const focusId = panel.focusItem?.id ?? null;
  const focusSeq = panel.focusItem?.seq ?? 0;
  const [highlight, setHighlight] = useState<{ id: string; seq: number } | null>(null);
  useEffect(() => {
    if (!focusId) return;
    takeCompanionFocusItem(focusSeq);
    if (!snapshot.items.some((item) => item.id === focusId)) return;
    const keys = foldsTo(view, focusId);
    if (keys.length > 0) setOpen((current) => new Set([...current, ...keys]));
    setHighlight({ id: focusId, seq: focusSeq });
    // Once per request (seq), not on every snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, focusSeq]);
  // The highlighted row is on screen now: scroll to it, then let the highlight fade.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!highlight) return undefined;
    // Matched by dataset, not by a selector: an item's id is not a CSS identifier.
    const rows = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-item-ids]') ?? []);
    const row = rows.find((element) => element.dataset.itemId === highlight.id)
      ?? rows.find((element) => element.dataset.itemIds?.split(' ').includes(highlight.id));
    row?.scrollIntoView?.({ block: 'center' });
    const timer = setTimeout(() => setHighlight((current) => (current === highlight ? null : current)), COMPANION_FOCUS_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlight]);

  // What the check-ins did here (DESIGN-v2 §2.7): "by <name>" on what they brought back, and what they took off, with Undo.
  const name = useCompanionName();
  const { restored, movedOff } = useMemo(
    () => companionTodayChanges(snapshot.checkinChanges, snapshot.items, clock),
    [snapshot.checkinChanges, snapshot.items, clock],
  );

  const row = (entry: CompanionTodayEntry) => (
    <CompanionItemRow key={entry.key} entry={entry} clock={clock} open={open} onToggle={toggle}
      arrivedAt={entry.items.length === 1 ? arrivals[entry.items[0].id] : undefined}
      showNew={entry.items.some((item) => newAtSight.current.has(item.id))}
      focused={entry.items.some((item) => item.id === highlight?.id)}
      restored={restored} onOpen={onOpenItem} onAsk={onAsk} />
  );
  const line = (entry: CompanionTodayEntry) => (
    <CompanionItemLine key={entry.key} entry={entry} clock={clock} open={open} onToggle={toggle} onOpen={onOpenItem}
      focused={entry.items.some((item) => item.id === highlight?.id)} restored={restored} />
  );
  const foldOf = (fold: CompanionTodayFold) => (
    <Fold key={fold.key} id={fold.key} summary={fold.summary} meta={fold.meta} open={open.has(fold.key)} onToggle={toggle}>
      {fold.entries.map(line)}
    </Fold>
  );

  return (
    <div ref={rootRef} className="companion-today term-scrollbar" role="tabpanel" aria-label="Today">
      {view.health.length > 0 && (
        <div className="companion-health" aria-label={`What ${name} can’t do`}>
          {view.health.map((health) => <HealthLine key={health.key} line={health} onOpenSettings={onOpenSettings} />)}
        </div>
      )}
      <h3 className="companion-today__head">{companionTodayHeadline(view.waiting.count)}</h3>
      {view.waiting.rows.length > 0 && (
        <section className="companion-section" aria-label="Waiting on you">
          {view.waiting.rows.map(row)}
          {view.waiting.spill.length > 0 && (
            <Fold id={SPILL} className="companion-fold--spill" open={open.has(SPILL)} onToggle={toggle}
              summary={`${view.waiting.spillCount} more waiting on you`}
              meta={view.waiting.spill.length === 1 ? '1 row' : `${view.waiting.spill.length} rows`}>
              {view.waiting.spill.map(row)}
            </Fold>
          )}
        </section>
      )}
      {view.mine.folds.length > 0 && (
        <section className="companion-section" aria-label="On your plate">
          <div className="companion-section__head">
            <MichiSectionLabel label="On your plate" count={view.mine.count} />
          </div>
          {view.mine.folds.map(foldOf)}
        </section>
      )}
      {view.aside.entries.length > 0 && (
        <section className="companion-section" aria-label="Everything else">
          <div className="companion-section__head">
            <MichiSectionLabel label="Everything else" count={view.aside.count} />
          </div>
          {/* The section's label already counts them, so the fold only says what it is. */}
          <Fold id={ASIDE} summary="Tucked away" open={open.has(ASIDE)} onToggle={toggle}>
            {view.aside.entries.map(line)}
          </Fold>
        </section>
      )}
      {movedOff.length > 0 && (
        <section className="companion-section" aria-label={`Moved by ${name}`}>
          <div className="companion-section__head">
            <MichiSectionLabel label={`Moved by ${name}`} count={movedOff.length} />
          </div>
          {movedOff.map((change) => <MovedOffRow key={change.id} change={change} name={name} settings={snapshot.settings} />)}
        </section>
      )}
      <CompanionReminders reminders={snapshot.reminders} items={snapshot.items} clock={clock} />
      <ActivityLine snapshot={snapshot} lastLookAt={view.lastLookAt} clock={clock} onOpenSettings={onOpenSettings} />
    </div>
  );
}

function ActivityLine({ snapshot, lastLookAt, clock, onOpenSettings }: {
  snapshot: CompanionSnapshot;
  /** When a check-in last really looked; the rows are only as fresh as the collectors and this. */
  lastLookAt: number | null;
  clock: number;
  onOpenSettings(): void;
}) {
  const name = useCompanionName();
  const [checking, setChecking] = useState(false);
  const { status } = snapshot;
  const check = async () => {
    setChecking(true);
    try {
      await checkCompanionNow();
      toast('Checking now');
    } catch (error) {
      toast.error(error instanceof CompanionApiError && error.code === 'not_owner'
        ? 'Another Michi window is doing the checking'
        : `Couldn’t check now: ${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      setChecking(false);
    }
  };
  return (
    <div className="companion-activity" aria-label="Activity">
      <span>
        {status.lastCheckAt === null ? 'Not checked yet' : `Last check ${companionAgo(status.lastCheckAt, clock)}`}
        {lastLookAt !== null && ` · ${name} looked at ${companionClock(lastLookAt)}`}
      </span>
      <button type="button" className="companion-link-btn" disabled={checking} onClick={() => { void check(); }}>Check now</button>
      <button type="button" className="companion-link-btn" onClick={onOpenSettings}>Activity & settings</button>
    </div>
  );
}
