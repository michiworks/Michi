import React, { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AlarmClock, Archive } from 'lucide-react';
import { isOpenCompanionItem, type CompanionCatchUpDto, type CompanionCheckinChangeDto, type CompanionItemDto } from 'michi-shared';
import { Button } from '../../ui/controls';
import { MichiSectionLabel } from '../content/MichiSectionLabel';
import { useMinuteClock } from '../content/home/useMinuteClock';
import { CompanionApiError, checkCompanionNow, type CompanionSnapshot } from '../../../services/api/companion';
import {
  actOnCompanionItem,
  companionBriefSeenBefore,
  companionItemShowsOnToday,
  markCompanionItemsSeen,
} from '../../../state/companion/companionStore';
import { takeCompanionFocusItem, useCompanionPanel } from '../../../state/companion/companionPanel';
import { useCompanionName } from '../../../state/companion/companionName';
import {
  COMPANION_BUCKET_TITLES,
  COMPANION_OTHER_BUCKETS,
  companionAgo,
  companionBriefSchedule,
  itemsInBucket,
} from '../../../state/companion/companionView';
import { CompanionBrief } from './CompanionBrief';
import { CompanionItemRow } from './CompanionItemRow';
import { CompanionReminders } from './CompanionReminders';
import { CompanionVisibleText } from './CompanionVisibleText';

/** How long the item a notice brought into view stays highlighted; then it fades (companion.css). */
const COMPANION_FOCUS_HIGHLIGHT_MS = 2_000;

/** How long an item a check-in dismissed is listed under "Moved by <name>", with its Undo; a snooze stays listed until it ends. */
const COMPANION_MOVED_OFF_TODAY_MS = 24 * 3_600_000;

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
  const Icon = change.action === 'snooze' ? AlarmClock : Archive;
  // Laid out as an item row (companion.css), so it reads as one of Today's.
  return (
    <div className="companion-row companion-moved" data-moved-item-id={change.targetId}>
      <span className="companion-row__icon" aria-hidden="true"><Icon size={14} strokeWidth={1.7} /></span>
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
 * Today: "Since you left", the
 * morning brief, what needs the user (View all adds Updates, Stalled and
 * FYI), what a check-in took off Today ("Dismissed by <name> — <reason> ·
 * Undo"), the reminders and watches Michi keeps, and one Activity line.
 *
 * The new items on screen are marked seen while the window has focus; a row
 * keeps its New dot for this visit.
 */
export function CompanionToday({ snapshot, catchUp, arrivals, onOpenItem, onAsk, onAction, onOpenSettings }: {
  snapshot: CompanionSnapshot;
  catchUp: CompanionCatchUpDto | null;
  arrivals: Readonly<Record<string, number>>;
  onOpenItem(item: CompanionItemDto): void;
  onAsk(item: CompanionItemDto): void;
  onAction(prompt: string): void;
  onOpenSettings(): void;
}) {
  const clock = useMinuteClock(true);
  const panel = useCompanionPanel();
  const [expanded, setExpanded] = useState(false);
  const needsYou = itemsInBucket(snapshot.items, 'needs_you');
  const others = COMPANION_OTHER_BUCKETS
    .map((bucket) => ({ bucket, items: itemsInBucket(snapshot.items, bucket) }))
    .filter((group) => group.items.length > 0);
  const otherCount = others.reduce((total, group) => total + group.items.length, 0);

  const visible = expanded ? [...needsYou, ...others.flatMap((group) => group.items)] : needsYou;
  const newIds = visible.filter((item) => item.status === 'new').map((item) => item.id);
  // New when the user first had it on screen: keeps its dot after it is marked seen.
  const newAtSight = useRef(new Set<string>());
  for (const id of newIds) newAtSight.current.add(id);
  const newKey = newIds.join('\n');
  useEffect(() => {
    if (!newKey || !document.hasFocus()) return;
    markCompanionItemsSeen(newKey.split('\n'));
  }, [newKey]);

  // A notice's target named an item: show it (expanding View all when it is there), bring it into
  // view and highlight it briefly. One that is no longer open leaves just Today. Each request is
  // taken once, so coming back to Today later does not jump again.
  const focusId = panel.focusItem?.id ?? null;
  const focusSeq = panel.focusItem?.seq ?? 0;
  const [highlight, setHighlight] = useState<{ id: string; seq: number } | null>(null);
  useEffect(() => {
    if (!focusId) return;
    takeCompanionFocusItem(focusSeq);
    if (!snapshot.items.some((item) => item.id === focusId)) return;
    if (!needsYou.some((item) => item.id === focusId)) setExpanded(true);
    setHighlight({ id: focusId, seq: focusSeq });
    // Once per request (seq), not on every snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, focusSeq]);
  // The highlighted row is on screen now (View all included): scroll to it, then let the highlight fade.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!highlight) return undefined;
    const row = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-item-id]') ?? []).find((el) => el.dataset.itemId === highlight.id);
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

  const since = catchUp ?? snapshot.catchUp;
  const row = (item: CompanionItemDto) => (
    <CompanionItemRow key={item.id} item={item} clock={clock} arrivedAt={arrivals[item.id]} showNew={newAtSight.current.has(item.id)}
      focused={item.id === highlight?.id} checkinChange={restored.get(item.id) ?? null} onOpen={onOpenItem} onAsk={onAsk} />
  );

  return (
    <div ref={rootRef} className="companion-today term-scrollbar" role="tabpanel" aria-label="Today">
      {since && <p className="companion-since"><strong>Since you left</strong> · {since.line}</p>}
      <CompanionBrief brief={snapshot.brief} items={snapshot.items} onOpenItem={onOpenItem} onAction={onAction}
        schedule={snapshot.settings.brief.enabled ? companionBriefSchedule(snapshot, clock, { firstBrief: !companionBriefSeenBefore() }) : null} />
      <section className="companion-section" aria-label="Needs you">
        <div className="companion-section__head">
          <MichiSectionLabel label={COMPANION_BUCKET_TITLES.needs_you} count={needsYou.length} />
        </div>
        {needsYou.length === 0 ? <p className="companion-empty">Nothing needs you right now.</p> : needsYou.map(row)}
        {otherCount > 0 && (
          <Button size="sm" variant="ghost" className="companion-view-all" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
            {expanded ? 'Show less' : `View all (${otherCount})`}
          </Button>
        )}
      </section>
      {expanded && others.map((group) => (
        <section key={group.bucket} className="companion-section" aria-label={COMPANION_BUCKET_TITLES[group.bucket]}>
          <div className="companion-section__head">
            <MichiSectionLabel label={COMPANION_BUCKET_TITLES[group.bucket]} count={group.items.length} />
          </div>
          {group.items.map(row)}
        </section>
      ))}
      {movedOff.length > 0 && (
        <section className="companion-section" aria-label={`Moved by ${name}`}>
          <div className="companion-section__head">
            <MichiSectionLabel label={`Moved by ${name}`} count={movedOff.length} />
          </div>
          {movedOff.map((change) => <MovedOffRow key={change.id} change={change} name={name} settings={snapshot.settings} />)}
        </section>
      )}
      <CompanionReminders reminders={snapshot.reminders} items={snapshot.items} clock={clock} />
      <ActivityLine snapshot={snapshot} clock={clock} onOpenSettings={onOpenSettings} />
    </div>
  );
}

function ActivityLine({ snapshot, clock, onOpenSettings }: { snapshot: CompanionSnapshot; clock: number; onOpenSettings(): void }) {
  const [checking, setChecking] = useState(false);
  const { status, settings } = snapshot;
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
      <span>{status.lastCheckAt === null ? 'Not checked yet' : `Last check ${companionAgo(status.lastCheckAt, clock)}`}</span>
      <span aria-hidden="true">·</span>
      <span>{status.turnsToday} of {settings.dailyTurnBudget} turns today</span>
      <button type="button" className="companion-link-btn" disabled={checking || !settings.enabled || settings.paused} onClick={() => { void check(); }}>Check now</button>
      <button type="button" className="companion-link-btn" onClick={onOpenSettings}>Activity & settings</button>
    </div>
  );
}
