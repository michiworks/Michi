import React, { useState } from 'react';
import { toast } from 'sonner';
import { Pause, Play, X } from 'lucide-react';
import { COMPANION_LIMITS, isCompanionClock, type CompanionItemDto, type CompanionReminderDto } from 'michi-shared';
import { Button } from '../../ui/controls';
import { MichiSectionLabel } from '../content/MichiSectionLabel';
import { addCompanionReminder, removeCompanionReminder, setCompanionReminderStatus } from '../../../services/api/companion';
import { updateCompanionSnapshot } from '../../../state/companion/companionStore';
import { companionReminderWhen, companionSnoozeTimes } from '../../../state/companion/companionView';

type When = 'hour' | 'tomorrow' | 'daily';
const TEXT_MAX = 200;

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'unknown error';
}

function upsert(reminders: readonly CompanionReminderDto[], next: CompanionReminderDto): CompanionReminderDto[] {
  return reminders.some((reminder) => reminder.id === next.id)
    ? reminders.map((reminder) => (reminder.id === next.id ? next : reminder))
    : [...reminders, next];
}

/**
 * The reminders and watches Michi keeps for the user (DESIGN R2.9), compact:
 * each with when it goes off, Pause / Resume and Delete, and a one-line form
 * to add a reminder without asking the Companion.
 */
export function CompanionReminders({ reminders, items, clock }: {
  reminders: readonly CompanionReminderDto[];
  items: readonly CompanionItemDto[];
  clock: number;
}) {
  const [text, setText] = useState('');
  const [when, setWhen] = useState<When>('tomorrow');
  const [dailyAt, setDailyAt] = useState('09:00');
  const [busy, setBusy] = useState(false);
  const live = reminders.filter((reminder) => reminder.status === 'active' || reminder.status === 'paused');
  const titleOf = (itemId: string | null) => (itemId ? items.find((item) => item.id === itemId)?.title ?? null : null);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    if (when === 'daily' && !isCompanionClock(dailyAt)) { toast.error('Pick a time like 09:00'); return; }
    setBusy(true);
    try {
      const times = companionSnoozeTimes(Date.now());
      const reminder = await addCompanionReminder(when === 'daily' ? { text: body, dailyAt }
        : { text: body, at: when === 'hour' ? times.hour : times.tomorrow });
      updateCompanionSnapshot((snapshot) => ({ ...snapshot, reminders: upsert(snapshot.reminders, reminder) }));
      setText('');
    } catch (error) {
      toast.error(`Couldn’t add the reminder: ${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (reminder: CompanionReminderDto) => {
    try {
      const next = await setCompanionReminderStatus(reminder.id, reminder.status === 'paused' ? 'active' : 'paused');
      updateCompanionSnapshot((snapshot) => ({ ...snapshot, reminders: upsert(snapshot.reminders, next) }));
    } catch (error) {
      toast.error(`Couldn’t update the reminder: ${errorText(error)}`);
    }
  };
  const remove = async (reminder: CompanionReminderDto) => {
    try {
      await removeCompanionReminder(reminder.id);
      updateCompanionSnapshot((snapshot) => ({ ...snapshot, reminders: snapshot.reminders.filter((entry) => entry.id !== reminder.id) }));
    } catch (error) {
      toast.error(`Couldn’t delete the reminder: ${errorText(error)}`);
    }
  };

  return (
    <section className="companion-section" aria-label="Reminders and watches">
      <div className="companion-section__head"><MichiSectionLabel label="Reminders & watches" count={live.length || undefined} /></div>
      {live.map((reminder) => (
        <div key={reminder.id} className="companion-reminder" data-status={reminder.status}>
          <span className="companion-reminder__text" title={reminder.text}>{reminder.text}</span>
          <span className="companion-reminder__when">
            {reminder.status === 'paused' ? 'Paused · ' : ''}{companionReminderWhen(reminder, titleOf(reminder.itemId), clock)}
          </span>
          <button type="button" className="companion-icon-btn" onClick={() => { void toggle(reminder); }}
            aria-label={`${reminder.status === 'paused' ? 'Resume' : 'Pause'}: ${reminder.text}`}>
            {reminder.status === 'paused' ? <Play size={12} aria-hidden="true" /> : <Pause size={12} aria-hidden="true" />}
          </button>
          <button type="button" className="companion-icon-btn" onClick={() => { void remove(reminder); }} aria-label={`Delete: ${reminder.text}`}>
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      ))}
      {live.length < COMPANION_LIMITS.maxReminders && (
        <form className="companion-reminder-form" onSubmit={(event) => { void add(event); }}>
          <input className="ui-input" value={text} maxLength={TEXT_MAX} placeholder="Remind me to…" aria-label="Reminder"
            onChange={(event) => setText(event.target.value)} />
          <select className="companion-select" value={when} aria-label="When" onChange={(event) => setWhen(event.target.value as When)}>
            <option value="hour">In 1 hour</option>
            <option value="tomorrow">Tomorrow 9:00</option>
            <option value="daily">Every workday at…</option>
          </select>
          {when === 'daily' && (
            <input className="ui-input" type="time" value={dailyAt} aria-label="Time" style={{ flex: '0 0 96px' }}
              onChange={(event) => setDailyAt(event.target.value)} />
          )}
          <Button size="sm" type="submit" disabled={!text.trim() || busy}>Add</Button>
        </form>
      )}
    </section>
  );
}
