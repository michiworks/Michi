import React, { useRef, useState } from 'react';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import type { CompanionCheckinChangeDto, CompanionFeedbackReason, CompanionItemAction, CompanionItemDto, CompanionSourceKind } from 'michi-shared';
import { Button } from '../../ui/controls';
import { ActionMenu, type ActionMenuEntry } from '../../ui/ActionMenu';
import { MenuPresence, menuOpenKey } from '../../ContextMenu';
import { useFresh } from '../../../motion/useFresh';
import { TRANSITION } from '../../../motion/tokens';
import { useRowSwipe } from '../../../hooks/useRowSwipe';
import { actOnCompanionItem } from '../../../state/companion/companionStore';
import { recordUndo } from '../../../state/undoStack';
import { useCompanionName } from '../../../state/companion/companionName';
import { companionSnoozeTimes } from '../../../state/companion/companionView';
import type { CompanionTodayEntry } from '../../../state/companion/companionToday';
import { CompanionVisibleText } from './CompanionVisibleText';
import {
  AlarmIcon, BellRingIcon, CalendarIcon, ChatIcon, CheckIcon, ChevronRightIcon, MailIcon, MoreIcon, PullRequestIcon, WarningIcon, WorkflowIcon,
  type IconComponent,
} from '../icons';

const SOURCE_ICON: Record<CompanionSourceKind, IconComponent> = {
  michi: ChatIcon,
  cr: PullRequestIcon,
  pipeline: WorkflowIcon,
  email: MailIcon,
  calendar: CalendarIcon,
  system: WarningIcon,
};

const SOURCE_LABEL: Record<Exclude<CompanionSourceKind, 'system'>, string> = {
  michi: 'Michi conversation',
  cr: 'Code review',
  pipeline: 'Pipeline',
  email: 'Email',
  calendar: 'Calendar',
};

/** Where an item comes from; the agent's own items carry its name (DESIGN-v2 §1.5). */
const sourceLabel = (source: CompanionSourceKind, name: string): string => (source === 'system' ? name : SOURCE_LABEL[source]);

const COMPANION_FEEDBACK_REASONS: ReadonlyArray<{ value: CompanionFeedbackReason; label: string }> = [
  { value: 'not_relevant', label: 'Not relevant' },
  { value: 'already_handled', label: 'Already handled' },
  { value: 'too_early', label: 'Too early' },
  { value: 'too_late', label: 'Too late' },
  { value: 'too_noisy', label: 'Too noisy' },
];

const ENTRANCE = { opacity: 0, y: 4 } as const;
const SETTLED = { opacity: 1, y: 0 } as const;

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'unknown error';
}

type Menu = { kind: 'more' | 'reasons'; anchor: HTMLButtonElement };

/** What the whole row offers the user, for one item or for several of one kind. */
interface EntryHandlers {
  busy: boolean;
  done(): Promise<unknown>;
  snoozeTomorrow(): Promise<unknown>;
  menuItems(kind: Menu['kind'], menu: Menu | null, setMenu: React.Dispatch<React.SetStateAction<Menu | null>>): ActionMenuEntry[];
}

/**
 * Snooze, Done and Don't show this again for an entry, each with its Undo
 * toast; a group takes them for every item at once ("Mark all done (3)"), so
 * the row the user reads is the row they act on. The agent's thumbs stay for
 * a single item: a thumb is about one thing Michi chose to show.
 */
function useEntryActions(entry: CompanionTodayEntry): EntryHandlers {
  const name = useCompanionName();
  const [busy, setBusy] = useState(false);
  const items = entry.items;
  const many = items.length > 1;
  // What an error names is what the user reads on the row, not the item's raw title.
  const subject = many ? `${items.length} items` : `“${entry.title}”`;

  const act = async (action: CompanionItemAction, done?: { text: string; undo: boolean }) => {
    setBusy(true);
    try {
      await Promise.all(items.map((item) => actOnCompanionItem(item.id, action)));
      if (done?.undo) {
        recordUndo({ label: done.text, toast: true, undo: () => Promise.all(items.map((item) => actOnCompanionItem(item.id, { action: 'restore' }))) });
      } else if (done) toast(done.text);
    } catch (error) {
      toast.error(`Couldn’t update ${subject}: ${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const done = () => act({ action: 'dismiss' }, { text: many ? `Marked ${items.length} done` : 'Marked done', undo: true });
  const snooze = (until: number, label: string) =>
    act({ action: 'snooze', until }, { text: many ? `Snoozed ${items.length} ${label}` : `Snoozed ${label}`, undo: true });
  const snoozeTomorrow = () => snooze(companionSnoozeTimes(Date.now()).tomorrow, 'until tomorrow');

  const menuItems = (kind: Menu['kind'], menu: Menu | null, setMenu: React.Dispatch<React.SetStateAction<Menu | null>>): ActionMenuEntry[] => {
    if (kind === 'reasons') {
      return COMPANION_FEEDBACK_REASONS.map((reason) => ({
        id: reason.value,
        label: reason.label,
        onSelect: () => { void act({ action: 'feedback', feedback: 'down', reason: reason.value }, { text: `Thanks — ${name} will take that into account`, undo: false }); },
      }));
    }
    const times = companionSnoozeTimes(Date.now());
    const entries: ActionMenuEntry[] = many
      ? [
        { id: 'tomorrow', label: 'Snooze all until tomorrow 9:00', onSelect: () => { void snooze(times.tomorrow, 'until tomorrow'); } },
        { id: 'done', label: `Mark all done (${items.length})`, onSelect: () => { void done(); } },
        { id: 'mute', label: 'Don’t show any of these again', dividerBefore: true,
          onSelect: () => { void act({ action: 'mute' }, { text: 'They won’t show again', undo: true }); } },
      ]
      : [
        { id: 'hour', label: 'Snooze for 1 hour', onSelect: () => { void snooze(times.hour, 'for an hour'); } },
        { id: 'tomorrow', label: 'Snooze until tomorrow 9:00', onSelect: () => { void snooze(times.tomorrow, 'until tomorrow'); } },
        { id: 'done', label: 'Done', onSelect: () => { void done(); } },
        { id: 'mute', label: 'Don’t show this again', dividerBefore: true,
          onSelect: () => { void act({ action: 'mute' }, { text: 'It won’t show again', undo: true }); } },
      ];
    if (many) return entries;
    const item = items[0];
    return [
      ...entries,
      { id: 'up', label: item.feedback === 'up' ? 'Helpful ✓' : 'Helpful', dividerBefore: true,
        onSelect: () => { void act({ action: 'feedback', feedback: item.feedback === 'up' ? null : 'up' }); } },
      { id: 'down', label: item.feedback === 'down' ? 'Not helpful ✓' : 'Not helpful…',
        onSelect: () => {
          if (item.feedback === 'down') { void act({ action: 'feedback', feedback: null }); return; }
          // The reason list opens where the overflow menu was.
          const anchor = menu?.anchor;
          if (anchor) requestAnimationFrame(() => setMenu({ kind: 'reasons', anchor }));
        } },
    ];
  };

  return { busy, done, snoozeTomorrow, menuItems };
}

function useMenu(): [Menu | null, React.Dispatch<React.SetStateAction<Menu | null>>, (kind: Menu['kind']) => (event: React.MouseEvent<HTMLButtonElement>) => void] {
  const [menu, setMenu] = useState<Menu | null>(null);
  const openMenu = (kind: Menu['kind']) => (event: React.MouseEvent<HTMLButtonElement>) => {
    const anchor = event.currentTarget;
    setMenu((current) => (current?.kind === kind ? null : { kind, anchor }));
  };
  return [menu, setMenu, openMenu];
}

/** The ⋯ button and the menu it opens, the same for a full row and a compact one. */
function EntryMenu({ entry, handlers, className }: { entry: CompanionTodayEntry; handlers: EntryHandlers; className?: string }) {
  const [menu, setMenu, openMenu] = useMenu();
  return (
    <>
      <Button size="sm" variant="ghost" className={className} disabled={handlers.busy} onClick={openMenu('more')} aria-haspopup="menu"
        aria-expanded={menu !== null} aria-label={`More actions for ${entry.title}`}>
        <MoreIcon />
      </Button>
      <MenuPresence>{menu && (
        <ActionMenu
          key={menuOpenKey(menu)}
          anchor={menu.anchor}
          liftTarget={menu.anchor.closest<HTMLElement>('.companion-row, .companion-line')}
          label={menu.kind === 'reasons' ? 'Why wasn’t it helpful?' : `More actions for ${entry.title}`}
          items={handlers.menuItems(menu.kind, menu, setMenu)}
          onClose={() => setMenu((current) => (current?.kind === menu.kind ? null : current))}
        />
      )}</MenuPresence>
    </>
  );
}

/** The one next step the row offers: open what it is about, or finish it here. */
function PrimaryAction({ entry, handlers, onOpen, ghost }: {
  entry: CompanionTodayEntry;
  handlers: EntryHandlers;
  onOpen(item: CompanionItemDto): void;
  ghost?: boolean;
}) {
  const { action } = entry;
  if (!action) return null;
  const label = `${action.label}: ${entry.title}`;
  if (action.kind === 'done') {
    return (
      <Button size="sm" variant={ghost ? 'ghost' : undefined} disabled={handlers.busy} aria-label={label}
        onClick={() => { void handlers.done(); }}>
        {action.label}
      </Button>
    );
  }
  return (
    <Button size="sm" variant={ghost ? 'ghost' : undefined} disabled={handlers.busy} aria-label={label} onClick={() => onOpen(action.item)}>
      {action.label}
    </Button>
  );
}

/** A group's summary line: it says what is inside, and opens the members in place (TR-18's one frame). */
function MembersToggle({ entry, open, onToggle, className }: {
  entry: CompanionTodayEntry;
  open: boolean;
  onToggle(key: string): void;
  className?: string;
}) {
  return (
    <button type="button" className={`companion-members-toggle${className ? ` ${className}` : ''}`} aria-expanded={open}
      onClick={() => onToggle(entry.key)}>
      <ChevronRightIcon size="sm" />
      <span>{entry.summary ?? `${entry.items.length} items`}</span>
    </button>
  );
}

/**
 * The check-ins' newest standing change per item (snapshot.checkinChanges):
 * a restore says "Brought back by <name>" on that item's own row, wherever
 * it sits. One that no longer stands (the item is back for another reason,
 * W3-F3-review #1) says nothing.
 */
export type CompanionRestored = ReadonlyMap<string, Pick<CompanionCheckinChangeDto, 'action' | 'reason' | 'standing'>>;

export interface CompanionRowProps {
  entry: CompanionTodayEntry;
  clock: number;
  /** Which groups and folds the user opened (Today owns it, so a notice can open the right one). */
  open: ReadonlySet<string>;
  onToggle(key: string): void;
  onOpen(item: CompanionItemDto): void;
  /** Just brought into view by a notice: highlighted for a moment. */
  focused?: boolean;
  restored?: CompanionRestored;
}

/** "Brought back by <name> — <reason>" under the item a check-in restored (DESIGN-v2 §2.7). */
function BroughtBack({ change, name, className }: {
  change: Pick<CompanionCheckinChangeDto, 'action' | 'reason' | 'standing'> | undefined;
  name: string;
  className: string;
}) {
  if (change?.action !== 'restore' || !change.standing) return null;
  return (
    <p className={`companion-row__by ${className}`}>
      Brought back by {name}{change.reason && <> — <CompanionVisibleText text={change.reason} /></>}
    </p>
  );
}

/**
 * One row of "Waiting on you": where it is from, what waits and since when,
 * the one next step, Ask <name>, and in the overflow Snooze, Done, Don't
 * show this again and the thumbs. Several items of one kind read as one row,
 * whose summary line opens the members. An item a check-in brought back says
 * so, with its reason ("Brought back by <name> — …", DESIGN-v2 §2.7). On a
 * touch screen a swipe right marks a single item done and a swipe left
 * snoozes it until tomorrow.
 */
export function CompanionItemRow({ entry, clock, open, onToggle, onOpen, arrivedAt, showNew, focused, restored, onAsk }: CompanionRowProps & {
  /** When this window first saw the item; undefined for items it hydrated with (no entrance). */
  arrivedAt?: number;
  /** The entry was new when the user looked: keep its dot for this visit. */
  showNew?: boolean;
  onAsk(item: CompanionItemDto): void;
}) {
  const fresh = useFresh(arrivedAt);
  const name = useCompanionName();
  const handlers = useEntryActions(entry);
  const single = entry.items.length === 1 ? entry.items[0] : null;
  const head = entry.items[0];
  const Icon = head.source === 'system' && head.subtype === 'reminder_due' ? BellRingIcon : SOURCE_ICON[head.source];
  const expanded = open.has(entry.key);

  const rowRef = useRef<HTMLDivElement>(null);
  // A swipe acts on one item: a group's rows are opened first, so a flick never clears several.
  useRowSwipe(rowRef, !handlers.busy && single !== null, { left: () => handlers.snoozeTomorrow(), right: () => handlers.done() });

  return (
    <motion.div
      ref={rowRef}
      className="companion-row"
      data-item-id={single?.id}
      data-item-ids={entry.items.map((item) => item.id).join(' ')}
      data-status={single?.status}
      data-focused={focused ? '' : undefined}
      data-now={entry.now ? '' : undefined}
      initial={fresh ? ENTRANCE : false}
      animate={SETTLED}
      transition={TRANSITION.enter}
    >
      <span className="companion-row__icon" title={sourceLabel(head.source, name)}>
        <Icon aria-label={sourceLabel(head.source, name)} />
      </span>
      <div className="companion-row__main">
        <div className="companion-row__line">
          {showNew && <span className="companion-row__new" aria-label="New" />}
          <span className="companion-row__title" title={entry.title}>{entry.title}</span>
          <span className="companion-row__age">{entry.meta}</span>
        </div>
        {single
          ? entry.summary && <p className="companion-row__summary"><CompanionVisibleText text={entry.summary} /></p>
          : <MembersToggle entry={entry} open={expanded} onToggle={onToggle} className="companion-row__summary" />}
        {!single && expanded && (
          <div className="companion-members">
            {entry.members?.map((member) => (
              <CompanionItemLine key={member.key} entry={member} clock={clock} open={open} onToggle={onToggle} onOpen={onOpen} restored={restored} />
            ))}
          </div>
        )}
        {single && <BroughtBack change={restored?.get(single.id)} name={name} className="companion-row__summary" />}
        <div className="companion-row__actions">
          <PrimaryAction entry={entry} handlers={handlers} onOpen={onOpen} />
          {single && (
            <Button size="sm" variant="ghost" disabled={handlers.busy} onClick={() => onAsk(single)} aria-label={`Ask about: ${entry.title}`}>Ask</Button>
          )}
          <EntryMenu entry={entry} handlers={handlers} />
        </div>
      </div>
      {/* What a swipe uncovers (useRowSwipe, companion.css); the buttons above say it to everyone else. */}
      <span className="companion-row__reveal companion-row__reveal--done" aria-hidden="true"><CheckIcon />Done</span>
      <span className="companion-row__reveal companion-row__reveal--snooze" aria-hidden="true"><AlarmIcon />Snooze until tomorrow</span>
    </motion.div>
  );
}

/**
 * One line of "On your plate" or "Everything else", and of a group opened
 * inside a row: what it is, when it last moved, and the same actions in less
 * weight. Folded away is not out of reach (owner, 2026-11-17).
 */
export function CompanionItemLine({ entry, clock, open, onToggle, onOpen, focused, restored }: CompanionRowProps) {
  const name = useCompanionName();
  const handlers = useEntryActions(entry);
  const single = entry.items.length === 1 ? entry.items[0] : null;
  const group = (entry.members?.length ?? 0) > 1;
  const expanded = open.has(entry.key);
  return (
    <div className="companion-line" data-item-id={entry.items.length === 1 ? entry.items[0].id : undefined}
      data-item-ids={entry.items.map((item) => item.id).join(' ')} data-focused={focused ? '' : undefined}>
      <span className="companion-line__title" title={entry.title}>{entry.title}</span>
      <span className="companion-line__meta">{entry.meta}</span>
      {group
        ? <MembersToggle entry={entry} open={expanded} onToggle={onToggle} />
        : <span className="companion-line__sub">{entry.summary}</span>}
      <span className="companion-line__acts">
        <PrimaryAction entry={entry} handlers={handlers} onOpen={onOpen} ghost />
        <EntryMenu entry={entry} handlers={handlers} />
      </span>
      {single && <BroughtBack change={restored?.get(single.id)} name={name} className="companion-line__sub" />}
      {group && expanded && (
        <div className="companion-members">
          {entry.members?.map((member) => (
            <CompanionItemLine key={member.key} entry={member} clock={clock} open={open} onToggle={onToggle} onOpen={onOpen} restored={restored} />
          ))}
        </div>
      )}
    </div>
  );
}
