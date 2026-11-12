import React, { useState } from 'react';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import {
  BellRing, CalendarDays, ChevronDown, Ellipsis, GitPullRequest, Mail, MessageSquare, TriangleAlert, Workflow, type LucideIcon,
} from 'lucide-react';
import type { CompanionCheckinChangeDto, CompanionFeedbackReason, CompanionItemAction, CompanionItemDto, CompanionSourceKind } from 'michi-shared';
import { Button } from '../../ui/controls';
import { ActionMenu, type ActionMenuEntry } from '../../ui/ActionMenu';
import { useFresh } from '../../../motion/useFresh';
import { TRANSITION } from '../../../motion/tokens';
import { actOnCompanionItem } from '../../../state/companion/companionStore';
import { useCompanionName } from '../../../state/companion/companionName';
import { companionItemTime, companionSnoozeTimes } from '../../../state/companion/companionView';
import { CompanionVisibleText } from './CompanionVisibleText';

const SOURCE_ICON: Record<CompanionSourceKind, LucideIcon> = {
  michi: MessageSquare,
  cr: GitPullRequest,
  pipeline: Workflow,
  email: Mail,
  calendar: CalendarDays,
  system: TriangleAlert,
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

export const COMPANION_FEEDBACK_REASONS: ReadonlyArray<{ value: CompanionFeedbackReason; label: string }> = [
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

type Menu = { kind: 'snooze' | 'more' | 'reasons'; anchor: HTMLButtonElement };

/**
 * One feed item: where it is from, what it is and when it last moved (a
 * meeting: when it starts), what changed, and what the user can do with it:
 * Open, Ask <name>, Snooze, Done, and in the overflow Don't show this
 * again and 👍 / 👎 with a reason. An item a check-in brought back says so,
 * with its reason ("Brought back by <name> — …", DESIGN-v2 §2.7).
 */
export function CompanionItemRow({ item, clock, arrivedAt, showNew, focused, checkinChange, onOpen, onAsk }: {
  item: CompanionItemDto;
  clock: number;
  /** When this window first saw the item; undefined for items it hydrated with (no entrance). */
  arrivedAt?: number;
  /** The item was new when the user looked: keep its dot for this visit. */
  showNew?: boolean;
  /** Just brought into view by a notice: highlighted for a moment. */
  focused?: boolean;
  /**
   * The check-in's newest change to this item (snapshot.checkinChanges): a
   * standing restore says "Brought back by <name>"; one that no longer stands
   * (the item is back for another reason, W3-F3-review #1) says nothing.
   */
  checkinChange?: Pick<CompanionCheckinChangeDto, 'action' | 'reason' | 'standing'> | null;
  onOpen(item: CompanionItemDto): void;
  onAsk(item: CompanionItemDto): void;
}) {
  const fresh = useFresh(arrivedAt);
  const name = useCompanionName();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [busy, setBusy] = useState(false);
  const Icon = item.source === 'system' && item.subtype === 'reminder_due' ? BellRing : SOURCE_ICON[item.source];

  const act = async (action: CompanionItemAction, done?: { text: string; undo: boolean }) => {
    setBusy(true);
    try {
      await actOnCompanionItem(item.id, action);
      if (done) {
        toast(done.text, done.undo ? {
          action: {
            label: 'Undo',
            onClick: () => { actOnCompanionItem(item.id, { action: 'restore' }).catch((error: unknown) => toast.error(`Couldn’t undo: ${errorText(error)}`)); },
          },
        } : undefined);
      }
    } catch (error) {
      toast.error(`Couldn’t update “${item.title}”: ${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const snooze = (until: number, label: string) => { void act({ action: 'snooze', until }, { text: `Snoozed ${label}`, undo: true }); };
  const times = companionSnoozeTimes(Date.now());
  const menuItems = (kind: Menu['kind']): ActionMenuEntry[] => {
    switch (kind) {
      case 'snooze':
        return [
          { id: 'hour', label: 'For 1 hour', onSelect: () => snooze(times.hour, 'for an hour') },
          { id: 'tomorrow', label: 'Until tomorrow 9:00', onSelect: () => snooze(times.tomorrow, 'until tomorrow') },
        ];
      case 'more':
        return [
          { id: 'mute', label: 'Don’t show this again', onSelect: () => { void act({ action: 'mute' }, { text: 'It won’t show again', undo: true }); } },
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
      case 'reasons':
        return COMPANION_FEEDBACK_REASONS.map((reason) => ({
          id: reason.value,
          label: reason.label,
          onSelect: () => { void act({ action: 'feedback', feedback: 'down', reason: reason.value }, { text: `Thanks — ${name} will take that into account`, undo: false }); },
        }));
    }
  };

  const openMenu = (kind: Menu['kind']) => (event: React.MouseEvent<HTMLButtonElement>) => {
    const anchor = event.currentTarget;
    setMenu((current) => (current?.kind === kind ? null : { kind, anchor }));
  };

  return (
    <motion.div
      className="companion-row"
      data-item-id={item.id}
      data-status={item.status}
      data-focused={focused ? '' : undefined}
      initial={fresh ? ENTRANCE : false}
      animate={SETTLED}
      transition={TRANSITION.enter}
    >
      <span className="companion-row__icon" title={sourceLabel(item.source, name)}>
        <Icon size={14} strokeWidth={1.7} aria-label={sourceLabel(item.source, name)} />
      </span>
      <div className="companion-row__main">
        <div className="companion-row__line">
          {showNew && <span className="companion-row__new" aria-label="New" />}
          <span className="companion-row__title" title={item.title}>{item.title}</span>
          <span className="companion-row__age">{companionItemTime(item, clock)}</span>
        </div>
        {item.summary && <p className="companion-row__summary">{item.summary}</p>}
        {checkinChange?.action === 'restore' && checkinChange.standing && (
          <p className="companion-row__by companion-row__summary">
            Brought back by {name}{checkinChange.reason && <> — <CompanionVisibleText text={checkinChange.reason} /></>}
          </p>
        )}
        <div className="companion-row__actions">
          {item.target && (
            <Button size="sm" disabled={busy} onClick={() => onOpen(item)} aria-label={`Open: ${item.title}`}>Open</Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAsk(item)} aria-label={`Ask about: ${item.title}`}>Ask</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={openMenu('snooze')} aria-haspopup="menu"
            aria-expanded={menu?.kind === 'snooze'} aria-label={`Snooze: ${item.title}`}>
            Snooze<ChevronDown size={12} strokeWidth={1.8} aria-hidden="true" />
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} aria-label={`Done: ${item.title}`}
            onClick={() => { void act({ action: 'dismiss' }, { text: 'Marked done', undo: true }); }}>Done</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={openMenu('more')} aria-haspopup="menu"
            aria-expanded={menu?.kind === 'more' || menu?.kind === 'reasons'} aria-label={`More actions for ${item.title}`}>
            <Ellipsis size={14} strokeWidth={1.8} aria-hidden="true" />
          </Button>
        </div>
      </div>
      {menu && (
        <ActionMenu
          key={menu.kind}
          anchor={menu.anchor}
          label={menu.kind === 'snooze' ? `Snooze ${item.title}` : menu.kind === 'reasons' ? 'Why wasn’t it helpful?' : `More actions for ${item.title}`}
          items={menuItems(menu.kind)}
          onClose={() => setMenu((current) => (current?.kind === menu.kind ? null : current))}
        />
      )}
    </motion.div>
  );
}
