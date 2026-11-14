import React, { useEffect, useId, useState } from 'react';
import {
  COMPANION_LIMITS,
  companionAgo,
  companionStatusLine,
  isCompanionClock,
  type CompanionGoalDto,
  type CompanionItemSubtype,
  type CompanionSourceStatus,
} from 'michi-shared';
import { useRuntimeCatalog } from '../../../hooks/useRuntimeCatalog';
import type { AssistantInfo } from '../../../services/api/assistant';
import {
  addCompanionGoal,
  patchCompanionSettings,
  removeCompanionGoal,
  saveCompanionNotes,
  saveCompanionRules,
  undoCompanionDemotion,
  updateCompanionGoal,
  type CompanionSettingsPatch,
  type CompanionSnapshot,
} from '../../../services/api/companion';
import { useCompanionName } from '../../../state/companion/companionName';
import {
  adoptCompanionSnapshot,
  loadCompanion,
  scheduleCompanionRefresh,
  updateCompanionSnapshot,
  useCompanion,
} from '../../../state/companion/companionStore';
import { companionPipelineWatchLine } from '../../../state/companion/companionView';
import { useMemoryLearning } from '../../../state/memory/learningStatus';
import { Button, Switch } from '../../ui/controls';
import { modelDisplayLabel } from '../../../lib/modelLabel';
import { SettingsRow, SettingsSection } from '../pages/settings/SettingsSection';
import { useOpenSettingsPage } from '../pages/settings/settingsPhone';
import { PAGES_UPKEEP_TITLE } from '../rail/settingsPages';
import { BackgroundWorkSettings, PagesUpkeepSettings, useLocalAgentStatus } from '../settings/metaAgent/MetaAgentSettings';
import { metaAgentRuntimeLabel } from '../settings/metaAgent/runtimeCopy';
import './companion.css';

const DAYS: ReadonlyArray<{ day: number; label: string }> = [
  { day: 1, label: 'Mon' }, { day: 2, label: 'Tue' }, { day: 3, label: 'Wed' }, { day: 4, label: 'Thu' },
  { day: 5, label: 'Fri' }, { day: 6, label: 'Sat' }, { day: 0, label: 'Sun' },
];

const SOURCE_NAME: Record<CompanionSourceStatus['kind'], string> = {
  michi: 'Michi conversations', cr: 'Code reviews', pipeline: 'Pipelines', email: 'Email', calendar: 'Calendar',
};

const SUBTYPE_LABEL: Readonly<Record<CompanionItemSubtype, string>> = {
  michi_waiting: 'Conversations waiting on you',
  michi_stalled: 'Stalled conversations',
  michi_done: 'Finished conversations',
  michi_scheduled_failed: 'Failed scheduled jobs',
  cr_needs_attention: 'CRs that need changes',
  cr_approved: 'Approved CRs',
  cr_merged: 'Merged CRs',
  cr_stale: 'CRs without reviews',
  cr_unpublished: 'Unpublished CR revisions',
  cr_review_requested: 'Reviews requested from you',
  cr_review_stale: 'Reviews still waiting on you',
  pipeline_blocked: 'Blocked pipelines',
  pipeline_recovered: 'Recovered pipelines',
  email_unread: 'Unread email',
  meeting_soon: 'Upcoming meetings',
  calendar_conflict: 'Meeting conflicts',
  system_auth: 'Auth sign-in',
  system_source_error: 'Source problems',
  reminder_due: 'Reminders',
};

function errorText(error: unknown, fallback = 'unknown error'): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A text setting committed on blur or Enter. */
function TextField({ id, value, placeholder, maxLength, label, onCommit, width = 180 }: {
  id?: string; value: string; placeholder?: string; maxLength: number; label: string; width?: number; onCommit(value: string): void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => { if (draft.trim() !== value.trim()) onCommit(draft.trim()); };
  return (
    <input id={id} className="ui-input" value={draft} placeholder={placeholder} maxLength={maxLength} aria-label={label} style={{ width }}
      onChange={(event) => setDraft(event.target.value)} onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }} />
  );
}

function TimeField({ value, label, onCommit }: { value: string; label: string; onCommit(value: string): void }) {
  return (
    <input className="ui-input" type="time" value={value} aria-label={label} style={{ width: 120 }}
      onChange={(event) => { if (isCompanionClock(event.target.value)) onCommit(event.target.value); }} />
  );
}

/**
 * A text the user edits over a value that can change elsewhere meanwhile (a
 * check-in saving its notes, an applied card, another window). Until the
 * user types it shows the value as it is now; once they do, it keeps their
 * text, and says so when the value changes under it. Save or Discard ends
 * the edit; a failed save keeps it.
 */
function useEditedText(value: string) {
  const [edit, setEdit] = useState<{ text: string; base: string } | null>(null);
  return {
    text: edit ? edit.text : value,
    edited: edit !== null,
    changedElsewhere: edit !== null && value !== edit.base && value !== edit.text,
    change: (text: string) => setEdit((current) => {
      const base = current ? current.base : value;
      return text === base ? null : { text, base };
    }),
    discard: () => setEdit(null),
    /**
     * A save (or Clear) clicked while `shown` was on screen went through, as
     * `stored` (the backend tidies it): show the value again, unless the user
     * typed on since the click.
     */
    saved: (shown: string, stored: string) => setEdit((current) => (
      !current || current.text === shown || current.text === stored ? null : { text: current.text, base: stored }
    )),
  };
}

/** A long text the user writes (rules, notes): Save and, when it has text, Clear. */
function LongText({ value, maxLength, label, placeholder, changedNote, onSave, extra }: {
  value: string; maxLength: number; label: string; placeholder: string;
  /** Shown when the value changes while the user edits it. */
  changedNote: string;
  /** Saves the text: the text as saved, or null when it was not (the caller says why). */
  onSave(text: string): Promise<string | null>;
  /** More actions beside Save (the notes' Keep). */
  extra?: React.ReactNode;
}) {
  const draft = useEditedText(value);
  const [saving, setSaving] = useState(false);
  const save = async (text: string) => {
    const shown = draft.text;
    setSaving(true);
    try {
      const stored = await onSave(text);
      if (stored !== null) draft.saved(shown, stored);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <textarea className="ui-input companion-settings-textarea" value={draft.text} maxLength={maxLength} aria-label={label}
        placeholder={placeholder} onChange={(event) => draft.change(event.target.value)} />
      {draft.changedElsewhere && <p className="settings-section__status" role="status">{changedNote}</p>}
      <div className="companion-settings-actions">
        <Button size="sm" variant="primary" disabled={saving || !draft.edited || draft.text === value} onClick={() => { void save(draft.text); }}>Save</Button>
        {draft.edited && <Button size="sm" variant="ghost" disabled={saving} onClick={draft.discard}>Discard</Button>}
        {!draft.edited && extra}
        {value && <Button size="sm" variant="ghost" danger disabled={saving} onClick={() => { void save(''); }}>Clear</Button>}
        <span className="companion-settings-muted">{draft.text.length} / {maxLength}</span>
      </div>
    </>
  );
}

/** A setting's text in one line under its name: its first line, or "None". */
function previewLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? 'None';
}

/** "Edit" beside a row whose editor opens in place under it; "Done" closes it. */
function EditToggle({ open, label, onToggle }: { open: boolean; label: string; onToggle(): void }) {
  return <Button size="sm" aria-expanded={open} aria-label={open ? `Done editing ${label}` : `Edit ${label}`} onClick={onToggle}>{open ? 'Done' : 'Edit'}</Button>;
}

/** The morning brief's days as one choice: weekdays, every day, or the days picked under Custom. */
type BriefDays = 'weekdays' | 'every' | 'custom';
const WEEKDAYS = [1, 2, 3, 4, 5];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const sameDays = (a: readonly number[], b: readonly number[]) => a.length === b.length && b.every((day) => a.includes(day));
function briefDaysOf(days: readonly number[]): BriefDays {
  return sameDays(days, WEEKDAYS) ? 'weekdays' : sameDays(days, EVERY_DAY) ? 'every' : 'custom';
}

/**
 * Model: conversations run on Settings › Runtime & model (and the composer's
 * pick), shown here only; Background work, what check-ins and Pages upkeep
 * run on, is the one model setting of the agent's own (D8).
 */
function ModelSection({ snapshot }: { snapshot: CompanionSnapshot }) {
  const agentStatus = useLocalAgentStatus();
  const openSettingsPage = useOpenSettingsPage();
  const assistant: AssistantInfo | null = snapshot.conversation?.assistant ?? null;
  const runs = assistant ? assistant.conversation ?? assistant.settings : null;
  const runtimeId = runs?.runtimeId ?? agentStatus?.runtime ?? '';
  const catalog = useRuntimeCatalog({ enabled: !!runtimeId, connectionId: 'local', runtime: runtimeId, provider: runs?.providerId ?? null });
  const runsOn = runtimeId
    ? `${metaAgentRuntimeLabel(runtimeId)} · ${runs?.modelId ? modelDisplayLabel(runtimeId, runs.modelId, catalog.models) : 'default model'}`
    : null;
  return (
    <SettingsSection title="Model">
      <SettingsRow label="Conversations"
        control={<>
          {runsOn && <span className="settings-row__state">{runsOn}</span>}
          <button type="button" className="settings-row__link" onClick={() => openSettingsPage('runtime')}>Runtime & model</button>
        </>} />
      <BackgroundWorkSettings />
    </SettingsSection>
  );
}

/** The goals, under Instructions › Goals' Edit: Keep, Edit and Remove each, and Add. */
function GoalsEditor({ goals, name }: { goals: readonly CompanionGoalDto[]; name: string }) {
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    setError(null);
    try { await action(); } catch (cause) { setError(errorText(cause, 'Couldn’t save the goal')); }
  };
  const replace = (goal: CompanionGoalDto) => updateCompanionSnapshot((snapshot) => ({
    ...snapshot, goals: snapshot.goals.map((entry) => (entry.id === goal.id ? goal : entry)),
  }));
  const add = () => run(async () => {
    const goal = await addCompanionGoal(text.trim());
    updateCompanionSnapshot((snapshot) => ({ ...snapshot, goals: [...snapshot.goals, goal] }));
    setText('');
  });
  const save = (id: string, next: string) => run(async () => {
    replace(await updateCompanionGoal(id, next.trim()));
    setEditing(null);
  });
  // Keep: the same text saved by the user makes it the user's (DESIGN-v2 §8.1 #19), so the conversation reads it again.
  const keep = (goal: CompanionGoalDto) => run(async () => {
    const kept = await updateCompanionGoal(goal.id, goal.text);
    replace({ ...kept, textOrigin: kept.textOrigin ?? 'user' });
  });
  const remove = (id: string) => run(async () => {
    await removeCompanionGoal(id);
    updateCompanionSnapshot((snapshot) => ({ ...snapshot, goals: snapshot.goals.filter((entry) => entry.id !== id) }));
  });
  return (
    <div className="companion-settings-editor">
      <ul className="companion-settings-list">
        {goals.map((goal) => (
          <li key={goal.id}>
            {editing?.id === goal.id ? (
              <>
                <input className="ui-input" value={editing.text} maxLength={COMPANION_LIMITS.maxGoalChars} aria-label="Goal" style={{ flex: 1 }}
                  onChange={(event) => setEditing({ id: goal.id, text: event.target.value })}
                  onKeyDown={(event) => { if (event.key === 'Enter' && editing.text.trim()) void save(goal.id, editing.text); if (event.key === 'Escape') setEditing(null); }} />
                <Button size="sm" disabled={!editing.text.trim()} onClick={() => { void save(goal.id, editing.text); }}>Save</Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              </>
            ) : (
              <>
                <span>
                  {goal.text}
                  {goal.textOrigin === 'checkin' && <span className="companion-settings-muted"> · Written by {name}</span>}
                  {goal.progress && <span className="companion-settings-muted"> · {goal.progress}{goal.progressAt ? ` (${companionAgo(goal.progressAt, Date.now())})` : ''}</span>}
                </span>
                {goal.textOrigin === 'checkin' && (
                  <Button size="sm" variant="ghost" aria-label={`Keep goal: ${goal.text}`} onClick={() => { void keep(goal); }}>Keep</Button>
                )}
                <Button size="sm" variant="ghost" aria-label={`Edit goal: ${goal.text}`} onClick={() => setEditing({ id: goal.id, text: goal.text })}>Edit</Button>
                <Button size="sm" variant="ghost" danger aria-label={`Remove goal: ${goal.text}`} onClick={() => { void remove(goal.id); }}>Remove</Button>
              </>
            )}
          </li>
        ))}
      </ul>
      {goals.some((goal) => goal.textOrigin === 'checkin') && (
        <p className="companion-settings-muted">
          {`Your conversation with ${name} doesn’t read a goal ${name} wrote until you keep or edit it.`}
        </p>
      )}
      {goals.length < COMPANION_LIMITS.maxGoals && (
        <div className="companion-settings-actions">
          <input className="ui-input" value={text} maxLength={COMPANION_LIMITS.maxGoalChars} placeholder="Add a goal" aria-label="New goal" style={{ flex: 1 }}
            onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && text.trim()) void add(); }} />
          <Button size="sm" disabled={!text.trim()} onClick={() => { void add(); }}>Add</Button>
        </div>
      )}
      {error && <p className="settings-row__note" role="alert">{error}</p>}
    </div>
  );
}

/** Instructions › Memory: Settings › Memory as it is, and the way there. */
function MemoryRow() {
  const memory = useMemoryLearning();
  const openSettingsPage = useOpenSettingsPage();
  const state = memory === null ? null : !memory.memoryOn ? 'Off' : `Learn from conversations: ${memory.learning ? 'On' : 'Off'}`;
  return (
    <SettingsRow label="Memory"
      control={<>
        {state && <span className="settings-row__state">{state}</span>}
        <button type="button" className="settings-row__link" onClick={() => openSettingsPage('memory')}>Settings › Memory</button>
      </>} />
  );
}

function SettingsBody({ snapshot, name }: { snapshot: CompanionSnapshot; name: string }) {
  const { settings, status } = snapshot;
  const [error, setError] = useState<string | null>(null);
  const [keepingNotes, setKeepingNotes] = useState(false);
  // Which options and editors are open in place under their rows.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [customDays, setCustomDays] = useState(false);
  const nameId = useId();
  const daysId = useId();
  const isOpen = (key: string) => open.has(key);
  const toggle = (key: string) => setOpen((current) => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  });

  /** The snapshot the change came to, or null when it was not saved (the error says why). */
  const patch = async (next: CompanionSettingsPatch): Promise<CompanionSnapshot | null> => {
    setError(null);
    try {
      const saved = await patchCompanionSettings(next);
      adoptCompanionSnapshot(saved);
      return saved;
    } catch (cause) {
      setError(errorText(cause, 'Couldn’t save the setting'));
      return null;
    }
  };
  // A source's state shows under its name only when it isn't working ("Auth expired — refresh your credentials").
  const sourceProblem = (kind: CompanionSourceStatus['kind']) => {
    const source = status.sources.find((entry) => entry.kind === kind);
    if (!source || !settings.sources[kind].enabled || source.state === 'ok' || source.state === 'disabled' || source.state === 'pending') return undefined;
    return source.detail ?? 'Unavailable';
  };
  const sourceSwitch = (kind: CompanionSourceStatus['kind']) => (
    <Switch on={settings.sources[kind].enabled} aria-label={SOURCE_NAME[kind]}
      onChange={(on) => { void patch({ sources: { [kind]: { enabled: on } } as NonNullable<CompanionSettingsPatch['sources']> }); }} />
  );
  const optionsToggle = (key: string, label: string) => (
    <button type="button" className="settings-row__link" aria-expanded={isOpen(key)} aria-label={`${label} options`} onClick={() => toggle(key)}>Options</button>
  );
  const days = settings.brief.days;
  const briefDays: BriefDays = customDays ? 'custom' : briefDaysOf(days);
  const chooseDays = (choice: BriefDays) => {
    setCustomDays(choice === 'custom');
    if (choice === 'weekdays' && !sameDays(days, WEEKDAYS)) void patch({ brief: { days: WEEKDAYS } });
    if (choice === 'every' && !sameDays(days, EVERY_DAY)) void patch({ brief: { days: EVERY_DAY } });
  };
  const toggleDay = (day: number) => {
    const next = days.includes(day) ? days.filter((entry) => entry !== day) : [...days, day];
    if (next.length > 0) void patch({ brief: { days: next.sort((a, b) => a - b) } });
  };
  const saveNotes = async (notes: string): Promise<string | null> => {
    try {
      const saved = await saveCompanionNotes(notes);
      // The user wrote them: from now on the conversation reads them (DESIGN-v2 §2.8 T1).
      updateCompanionSnapshot((current) => ({
        ...current, notes: saved.notes, notesRevision: saved.notesRevision ?? current.notesRevision + 1, notesOrigin: 'user',
      }));
      return saved.notes;
    } catch (cause) {
      setError(errorText(cause, 'Couldn’t save the notes'));
      return null;
    }
  };
  const keepNotes = async () => {
    setKeepingNotes(true);
    try { await saveNotes(snapshot.notes); } finally { setKeepingNotes(false); }
  };
  // Off is Pause Michi until resumed (Q30): its settings stay shown and editable, and apply once it is on (Q33).
  const on = !settings.paused;
  const line = companionStatusLine(snapshot, Date.now());
  const checkinNotes = snapshot.notesOrigin === 'checkin' && snapshot.notes.trim() !== '';
  const goals = snapshot.goals;

  return (
    <>
      <SettingsSection title={name} aside={on && <span className="companion-settings-muted">{line.text}</span>}>
        <SettingsRow label="Name" labelFor={nameId}
          control={<TextField id={nameId} value={settings.displayName} maxLength={40} label="Name"
            onCommit={(next) => { if (next) void patch({ displayName: next }); }} />} />
        <SettingsRow label={name}
          tip="Off stops check-ins, Pages upkeep and the automatic checks of your sources. You can still talk to it. Memory follows Settings › Memory."
          description={on ? undefined : 'Off · settings apply when on'}
          control={<Switch on={on} aria-label={name} onChange={(next) => { void patch({ paused: !next }); }} />} />
        {error && <p className="settings-section__status" role="alert">{error}</p>}
      </SettingsSection>

      <ModelSection snapshot={snapshot} />

      <SettingsSection title="Watching">
        <SettingsRow label="Michi conversations" description={sourceProblem('michi')} control={sourceSwitch('michi')} />
      </SettingsSection>

      <SettingsSection title="Updates">
        <SettingsRow label="Morning brief"
          control={(
            <>
              <select id={daysId} className="ui-select settings-row__select" aria-label="Morning brief days" value={briefDays}
                onChange={(event) => chooseDays(event.target.value as BriefDays)}>
                <option value="weekdays">Weekdays</option>
                <option value="every">Every day</option>
                <option value="custom">Custom…</option>
              </select>
              <TimeField value={settings.brief.time} label="Morning brief time" onCommit={(time) => { void patch({ brief: { time } }); }} />
              <Switch on={settings.brief.enabled} aria-label="Morning brief" onChange={(next) => { void patch({ brief: { enabled: next } }); }} />
            </>
          )}>
          {briefDays === 'custom' && (
            <div className="companion-workdays" role="group" aria-label="Morning brief days of the week">
              {DAYS.map(({ day, label }) => (
                <button key={day} type="button" className="companion-workday" aria-pressed={days.includes(day)}
                  disabled={days.length === 1 && days.includes(day)} onClick={() => toggleDay(day)}>{label}</button>
              ))}
            </div>
          )}
        </SettingsRow>
        {snapshot.demotedSubtypes.length > 0 && (
          <SettingsRow label="Quieter after your feedback">
            <ul className="companion-settings-list">
              {snapshot.demotedSubtypes.map((subtype) => (
                <li key={subtype}>
                  <span>{SUBTYPE_LABEL[subtype] ?? subtype}</span>
                  <Button size="sm" variant="ghost" aria-label={`Undo: ${SUBTYPE_LABEL[subtype] ?? subtype}`} onClick={() => {
                    undoCompanionDemotion(subtype).then(() => {
                      updateCompanionSnapshot((current) => ({ ...current, demotedSubtypes: current.demotedSubtypes.filter((entry) => entry !== subtype) }));
                      scheduleCompanionRefresh();
                    }, (cause: unknown) => setError(errorText(cause, 'Couldn’t undo that')));
                  }}>Undo</Button>
                </li>
              ))}
            </ul>
          </SettingsRow>
        )}
      </SettingsSection>

      <SettingsSection title="Instructions">
        <SettingsRow label="Your rules" description={<span className="companion-settings-preview">{previewLine(snapshot.rules)}</span>}
          control={<EditToggle open={isOpen('rules')} label="your rules" onToggle={() => toggle('rules')} />}>
          {isOpen('rules') && (
            <div className="companion-settings-editor">
              <LongText value={snapshot.rules} maxLength={COMPANION_LIMITS.maxRulesChars} label="Your rules"
                placeholder="For example: Don’t tell me about merged CRs. Mention pipeline Foo only if prod is blocked."
                changedNote="Your rules changed while you were editing (an applied suggestion, or another window). Save replaces them with your text; Discard loads the new version."
                onSave={async (rules) => {
                  try {
                    const saved = await saveCompanionRules(rules);
                    updateCompanionSnapshot((current) => ({ ...current, rules: saved }));
                    return saved;
                  } catch (cause) {
                    setError(errorText(cause, 'Couldn’t save your rules'));
                    return null;
                  }
                }} />
            </div>
          )}
        </SettingsRow>
        <SettingsRow label="Working notes"
          description={<span className="companion-settings-preview">{checkinNotes ? `Written by ${name} · ` : ''}{previewLine(snapshot.notes)}</span>}
          control={<EditToggle open={isOpen('notes')} label="working notes" onToggle={() => toggle('notes')} />}>
          {isOpen('notes') && (
            <div className="companion-settings-editor">
              {checkinNotes && (
                <p className="settings-row__note" role="note">
                  {`Your conversation with ${name} doesn’t read notes ${name} wrote during a check-in until you keep or edit them.`}
                </p>
              )}
              <LongText value={snapshot.notes} maxLength={COMPANION_LIMITS.maxNotesChars} label="Working notes" placeholder="No notes yet."
                changedNote={`${name} updated these notes while you were editing. Save replaces them with your text; Discard loads the new version.`}
                onSave={saveNotes}
                extra={checkinNotes && <Button size="sm" disabled={keepingNotes} onClick={() => { void keepNotes(); }}>Keep</Button>} />
            </div>
          )}
        </SettingsRow>
        <SettingsRow label="Goals" description={goals.length === 0 ? 'None' : count(goals.length, 'goal')}
          control={<EditToggle open={isOpen('goals')} label="goals" onToggle={() => toggle('goals')} />}>
          {isOpen('goals') && <GoalsEditor goals={goals} name={name} />}
        </SettingsRow>
        <MemoryRow />
      </SettingsSection>

      <PagesSection />
    </>
  );
}

/** Settings › <name> › Pages: what was Settings › Meta agent (DESIGN-v2 §1.5, item 7). */
function PagesSection() {
  return (
    <SettingsSection title={PAGES_UPKEEP_TITLE}>
      <PagesUpkeepSettings />
    </SettingsSection>
  );
}

/** The pipelines watched besides favorites, one per line, and what is watched in all. */
function PipelineWatch({ watch, includeFavorites, onSave }: {
  watch: readonly string[];
  /** The user's favorite pipelines are watched too (the switch below the list). */
  includeFavorites: boolean;
  /** Saves the list: the list as saved, or null when it was not (the error says why). */
  onSave(watch: string[]): Promise<readonly string[] | null>;
}) {
  const joined = watch.join('\n');
  // An applied "watch this pipeline" suggestion must not wipe a list the user is typing.
  const draft = useEditedText(joined);
  const [saving, setSaving] = useState(false);
  const names = [...new Set(draft.text.split(/[\n,]/).map((name) => name.trim()).filter(Boolean))];
  const tooMany = names.length > COMPANION_LIMITS.maxPipelineWatch;
  const save = async () => {
    const shown = draft.text;
    setSaving(true);
    try {
      const stored = await onSave(names);
      if (stored !== null) draft.saved(shown, stored.join('\n'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div style={{ marginTop: 6 }}>
      <textarea className="ui-input companion-settings-textarea" style={{ minHeight: 64 }} value={draft.text} aria-label="Pipelines to watch"
        placeholder="Pipeline names to watch, one per line" onChange={(event) => draft.change(event.target.value)} />
      {draft.changedElsewhere && (
        <p className="settings-section__status" role="status">
          The watched pipelines changed while you were editing. Save replaces them with your list; Discard loads the new one.
        </p>
      )}
      <div className="companion-settings-actions">
        <Button size="sm" disabled={saving || tooMany || !draft.edited || draft.text === joined} onClick={() => { void save(); }}>Save</Button>
        {draft.edited && <Button size="sm" variant="ghost" disabled={saving} onClick={draft.discard}>Discard</Button>}
        <span className="companion-settings-muted">
          {tooMany ? `At most ${COMPANION_LIMITS.maxPipelineWatch} pipelines` : companionPipelineWatchLine(includeFavorites, names.length)}
        </span>
      </div>
    </div>
  );
}

/**
 * Settings › <name> (DESIGN-v2 §1.5; the reorganised page of 2026-11-12), in
 * order: <name> (Name, and the switch that turns it on and off); Model
 * (conversations, Background work); Watching; Updates; Instructions (rules,
 * working notes, goals, Memory); Pages (Pages upkeep). Activity is in the
 * panel's ⋯ menu (Q31). Without the agent's snapshot only Model's Background
 * work and Pages, which do not need it, show.
 */
export default function CompanionSettings() {
  const { availability, snapshot } = useCompanion();
  const name = useCompanionName();
  useEffect(() => { void loadCompanion(); }, []);
  return snapshot ? <SettingsBody snapshot={snapshot} name={name} /> : (
    <>
      {availability === 'unavailable'
        ? <p className="settings-section__status" role="status">{`${name}’s check-ins aren’t available on this backend.`}</p>
        : <div role="status">{`Loading ${name}…`}</div>}
      <SettingsSection title="Model"><BackgroundWorkSettings /></SettingsSection>
      <PagesSection />
    </>
  );
}
