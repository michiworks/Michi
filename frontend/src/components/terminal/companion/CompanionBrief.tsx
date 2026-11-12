import React, { useState } from 'react';
import { toast } from 'sonner';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { COMPANION_LIMITS, type CompanionBriefDto, type CompanionFeedback, type CompanionItemDto } from 'michi-shared';
import { Button } from '../../ui/controls';
import { MichiSectionLabel } from '../content/MichiSectionLabel';
import { curateCompanionBrief, setCompanionBriefFeedback } from '../../../services/api/companion';
import { updateCompanionSnapshot } from '../../../state/companion/companionStore';
import type { CompanionBriefSchedule } from '../../../state/companion/companionView';

const CURATE_MAX = 500;

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'unknown error';
}

/** "Tomorrow, focus on…": what the next brief should look at more (the next brief uses it and clears it). */
function SteerForm({ schedule }: { schedule: CompanionBriefSchedule }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || saving) return;
    setSaving(true);
    try {
      await curateCompanionBrief(value);
      setText('');
      toast(schedule.steerSaved);
    } catch (error) {
      toast.error(`Couldn’t save that: ${errorText(error)}`);
    } finally {
      setSaving(false);
    }
  };
  // The visible hint and the accessible name name the same brief.
  const name = schedule.steerLabel.replace(/…$/, '');
  return (
    <form className="companion-inline-form" onSubmit={(event) => { void save(event); }}>
      <input className="ui-input" value={text} maxLength={CURATE_MAX} placeholder={schedule.steerLabel}
        aria-label={name} onChange={(event) => setText(event.target.value)} />
      <Button size="sm" type="submit" disabled={!text.trim() || saving}>Save</Button>
    </form>
  );
}

/**
 * Today's brief (Pulse-style): a headline, at most seven cards, each with
 * the items it is about, an optional follow-up for the chat, and 👍 / 👎;
 * then a closing line and "Tomorrow, focus on…", which steers the next one.
 * Before there is one, it says when the next brief comes as the backend
 * reports it (companionBriefSchedule), and the next one can be steered
 * already.
 */
export function CompanionBrief({ brief, items, schedule, onOpenItem, onAction }: {
  brief: CompanionBriefDto | null;
  /** Open items, to name and open the ones a card is about. */
  items: readonly CompanionItemDto[];
  /** When the next brief comes; null when the user turned briefs off. */
  schedule: CompanionBriefSchedule | null;
  onOpenItem(item: CompanionItemDto): void;
  /** A card's follow-up: its prompt goes into the chat composer. */
  onAction(prompt: string): void;
}) {
  const [pendingIndex, setPendingIndex] = useState<number | null>(null);

  if (!brief) {
    if (!schedule) return null;
    return (
      <section className="companion-section" aria-label="Today’s brief">
        <div className="companion-section__head"><MichiSectionLabel label="Today’s brief" /></div>
        {schedule.line && <p className="companion-empty">{schedule.line}</p>}
        <SteerForm schedule={schedule} />
      </section>
    );
  }

  const byId = new Map(items.map((item) => [item.id, item]));
  const feedback = async (index: number, choice: CompanionFeedback) => {
    const next = brief.cardFeedback[index] === choice ? null : choice;
    setPendingIndex(index);
    try {
      const updated = await setCompanionBriefFeedback(brief.id, index, next);
      updateCompanionSnapshot((snapshot) => (snapshot.brief?.id === updated.id ? { ...snapshot, brief: updated } : snapshot));
    } catch (error) {
      toast.error(`Couldn’t save that: ${errorText(error)}`);
    } finally {
      setPendingIndex(null);
    }
  };

  return (
    <section className="companion-section companion-brief" aria-label="Today’s brief">
      <div className="companion-section__head"><MichiSectionLabel label="Today’s brief" /></div>
      <h3 className="companion-brief__headline">{brief.headline}</h3>
      <div className="companion-brief__cards">
        {brief.cards.slice(0, COMPANION_LIMITS.maxBriefCards).map((card, index) => {
          const linked = card.itemIds.map((id) => byId.get(id)).filter((item): item is CompanionItemDto => !!item);
          const choice = brief.cardFeedback[index] ?? null;
          return (
            <article key={`${index}:${card.title}`} className="companion-brief-card">
              <h4 className="companion-brief-card__title">{card.title}</h4>
              {card.body && <p className="companion-brief-card__body">{card.body}</p>}
              <div className="companion-brief-card__foot">
                <div className="companion-brief-card__items">
                  {linked.map((item) => (
                    <button key={item.id} type="button" className="companion-chip" title={item.title} onClick={() => onOpenItem(item)}>{item.title}</button>
                  ))}
                </div>
                {card.action && (
                  <Button size="sm" onClick={() => onAction(card.action!.prompt)}>{card.action.label}</Button>
                )}
                <span className="companion-thumbs">
                  <button type="button" className="companion-icon-btn" aria-label={`Helpful: ${card.title}`} aria-pressed={choice === 'up'}
                    disabled={pendingIndex === index} onClick={() => { void feedback(index, 'up'); }}>
                    <ThumbsUp size={13} strokeWidth={1.7} aria-hidden="true" />
                  </button>
                  <button type="button" className="companion-icon-btn" aria-label={`Not helpful: ${card.title}`} aria-pressed={choice === 'down'}
                    disabled={pendingIndex === index} onClick={() => { void feedback(index, 'down'); }}>
                    <ThumbsDown size={13} strokeWidth={1.7} aria-hidden="true" />
                  </button>
                </span>
              </div>
            </article>
          );
        })}
      </div>
      {brief.closing && <p className="companion-brief__closing">{brief.closing}</p>}
      {schedule && <SteerForm schedule={schedule} />}
    </section>
  );
}
