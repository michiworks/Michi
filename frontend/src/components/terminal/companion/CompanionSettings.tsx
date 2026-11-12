import React, { useEffect, useId, useState } from 'react';
import {
  COMPANION_HEARTBEAT_MINUTES,
  COMPANION_LIMITS,
  REASONING_LEVELS,
  companionAgo,
  companionStatusLine,
  isCompanionClock,
  type CompanionDelegationDto,
  type CompanionGoalDto,
  type CompanionHeartbeatMinutes,
  type CompanionItemSubtype,
  type CompanionNotificationLevel,
  type CompanionPostChange,
  type CompanionRunDto,
  type CompanionSourceStatus,
  type RuntimeReasoning,
} from 'michi-shared';
import { useRuntimeCatalog } from '../../../hooks/useRuntimeCatalog';
import { AssistantApiError, type AssistantInfo } from '../../../services/api/assistant';
import {
  addCompanionGoal,
  patchCompanionSettings,
  removeCompanionGoal,
  resetCompanionConversation,
  saveCompanionNotes,
  saveCompanionRules,
  stopCompanionDelegationAutoSend,
  undoCompanionDemotion,
  undoCompanionRun,
  updateCompanionGoal,
  type CompanionSettingsPatch,
  type CompanionSnapshot,
} from '../../../services/api/companion';
import { useCompanionName } from '../../../state/companion/companionName';
import { openCompanionPanel } from '../../../state/companion/companionPanel';
import {
  adoptCompanionSnapshot,
  loadCompanion,
  scheduleCompanionRefresh,
  updateCompanionSnapshot,
  useCompanion,
} from '../../../state/companion/companionStore';
import { companionPipelineWatchLine } from '../../../state/companion/companionView';
import type { ResolvedNodeBinding } from '../../../state/nodeBindingResolution';
import { Button, Switch } from '../../ui/controls';
import { confirmDialog } from '../../ui/ConfirmDialog';
import { modelDisplayLabel } from '../../../lib/modelLabel';
import { resolveComposerReasoning } from '../composerReasoning';
import { REASONING_LABELS } from '../PaneComposerToolbarLeft';
import { Radio, type RadioOption } from '../pages/settings/controls';
import { WINDOWS_CLOSED_TITLE } from '../pages/settings/residencyCopy';
import { SettingsRow, SettingsSection } from '../pages/settings/SettingsSection';
import { useOpenSettingsPage, useSettingsPhone } from '../pages/settings/settingsPhone';
import { PAGES_UPKEEP_TITLE } from '../rail/settingsPages';
import { PagesUpkeepSettings, useLocalAgentStatus } from '../settings/metaAgent/MetaAgentSettings';
import { metaAgentRuntimeLabel } from '../settings/metaAgent/runtimeCopy';
import './companion.css';

/** The agent's own notification levels: only what it sends itself (posts, the brief, Today's items). */
function notificationOptions(name: string): ReadonlyArray<RadioOption<CompanionNotificationLevel>> {
  return [
    { value: 'all', label: 'All', description: `Urgent changes, and a note whenever ${name} posts something.` },
    { value: 'important', label: 'Important', description: 'Only what needs you now: a blocked pipeline, a CR that needs changes, a conflict.' },
    { value: 'off', label: 'Off', description: `No notifications from ${name}. Everything still shows in its panel.` },
  ];
}

const WORKDAYS: ReadonlyArray<{ day: number; label: string }> = [
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

const RUN_KIND_LABEL: Record<CompanionRunDto['kind'], string> = {
  poll: 'Check', heartbeat: 'Check-in', brief: 'Brief', welcome: 'Welcome', catch_up: 'Catch-up', worker_report: 'Worker report', wake: 'Alert',
  send: 'Follow-up',
};

/** How a run ended, in words (DESIGN-v2 §3.3: a superseded run keeps the fact, never the reply). */
const OUTCOME_LABEL: Record<CompanionRunDto['outcome'], string> = {
  running: 'running', ok: 'done', spoke: 'posted', quiet: 'nothing to say', skipped: 'skipped', error: 'failed',
  preempted: 'stopped so you could go first', superseded: 'not posted: you wrote first',
};

/** Check-ins stop after this many minutes (DESIGN-v2 §3.1), which the Reasoning note warns about. */
const CHECKIN_MINUTES = 3;

function errorText(error: unknown, fallback = 'unknown error'): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function clockText(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function listWords(parts: readonly string[]): string {
  return parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

const ITEM_VERB: Record<string, string> = { snooze: 'snoozed', dismiss: 'dismissed', restore: 'restored' };
const GOAL_VERB: Record<string, string> = { add: 'added', reword: 'reworded', remove: 'removed' };

/**
 * What a check-in changed, in a line: "Changed 3 blocks on Tasks, snoozed 1
 * item, reworded 1 goal and sent 1 follow-up to “Fix CI”". Titles are only
 * the ones that existed before the check-in, and a conversation's as Michi
 * read it when it sent (CompanionPostChange.title); null when it changed nothing.
 */
function runChangesText(changes: readonly CompanionPostChange[]): string | null {
  const parts: string[] = [];
  for (const change of changes) {
    if (change.kind !== 'page' && change.kind !== 'database') continue;
    const where = change.title ? `“${change.title}”` : change.kind === 'page' ? 'a page' : 'a database';
    const unit = change.kind === 'page' ? 'block' : 'row';
    if (change.applied > 0) parts.push(`changed ${count(change.applied, unit)} on ${where}`);
    if (change.proposed > 0) parts.push(`suggested ${count(change.proposed, 'change')} on ${where}`);
  }
  const tally = (kind: CompanionPostChange['kind'], verbs: Record<string, string>, noun: string) => {
    const byAction = new Map<string, number>();
    for (const change of changes) {
      if (change.kind === kind && change.action) byAction.set(change.action, (byAction.get(change.action) ?? 0) + 1);
    }
    for (const [action, n] of byAction) parts.push(`${verbs[action] ?? action} ${count(n, noun)}`);
  };
  tally('item', ITEM_VERB, 'item');
  tally('goal', GOAL_VERB, 'goal');
  // Follow-ups it sent itself (D21), per conversation, under the title Michi read when it sent.
  const sends = new Map<string, { title: string | undefined; n: number }>();
  for (const change of changes) {
    if (change.kind !== 'send' || change.applied <= 0) continue;
    const sent = sends.get(change.id);
    sends.set(change.id, { title: sent?.title ?? change.title, n: (sent?.n ?? 0) + change.applied });
  }
  for (const { title, n } of sends.values()) parts.push(`sent ${count(n, 'follow-up')} to ${title ? `“${title}”` : 'a conversation'}`);
  if (parts.length === 0) return null;
  const text = listWords(parts);
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** The lower of `level` and high: the default reasoning of check-ins and new conversations (DESIGN-v2 §6). */
function cappedReasoning(level: RuntimeReasoning): RuntimeReasoning {
  return REASONING_LEVELS.indexOf(level) > REASONING_LEVELS.indexOf('high') ? 'high' : level;
}

const reasoningLabel = (level: string) => REASONING_LABELS[level] ?? level;

/**
 * The Reasoning select's Default option, as the backend resolves it
 * (assistant/store.ts companionDefaultReasoning): the lower of the runtime's
 * global level and high, and with no global level none at all, so the model
 * runs at its own default (W2 fix D10). Plain "Default" while the global
 * settings can't be read.
 */
function defaultReasoningLabel(global: RuntimeReasoning | null | undefined, known: boolean): string {
  if (!known) return 'Default';
  return global ? `Default (${reasoningLabel(cappedReasoning(global))})` : 'Default (model default)';
}

/** A number setting committed on blur or Enter, clamped to its range. */
function NumberField({ id, value, min, max, onCommit, label }: {
  id?: string; value: number; min: number; max: number; label: string; onCommit(value: number): void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Math.round(Number(draft));
    if (!Number.isFinite(parsed)) { setDraft(String(value)); return; }
    const next = Math.min(max, Math.max(min, parsed));
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <input id={id} className="ui-input" type="number" min={min} max={max} value={draft} aria-label={label} style={{ width: 72 }}
      onChange={(event) => setDraft(event.target.value)} onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }} />
  );
}

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
    <input className="ui-input" type="time" value={value} aria-label={label} style={{ width: 104 }}
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

function Goals({ goals, name }: { goals: readonly CompanionGoalDto[]; name: string }) {
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
    <SettingsSection title="Goals" intro={`What you are working toward. ${name} keeps an eye on progress, and may add or reword a goal during a check-in; it says so when it does.`}>
      <div className="settings-section__block">
        {goals.length === 0 && <p className="companion-settings-muted">No goals yet.</p>}
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
        {error && <p className="settings-section__status" role="alert">{error}</p>}
      </div>
    </SettingsSection>
  );
}

/**
 * Model: what the agent runs on (the same as the conversation with it), the
 * reasoning check-ins and new conversations use (DESIGN-v2 §6), and the
 * known gap of the trust rules (§2.8 T5).
 */
function ModelSection({ snapshot, name, patch }: { snapshot: CompanionSnapshot; name: string; patch(next: CompanionSettingsPatch): void }) {
  const agentStatus = useLocalAgentStatus();
  const assistant: AssistantInfo | null = snapshot.conversation?.assistant ?? null;
  const runs = assistant ? assistant.conversation ?? assistant.settings : null;
  const runtimeId = runs?.runtimeId ?? agentStatus?.runtime ?? '';
  const catalog = useRuntimeCatalog({ enabled: !!runtimeId, connectionId: 'local', runtime: runtimeId, provider: runs?.providerId ?? null });
  const binding: ResolvedNodeBinding = {
    runtime: runtimeId, provider: runs?.providerId ?? undefined, model: runs?.modelId ?? undefined, reasoning: undefined, source: 'global',
  };
  // The same levels the composer chip offers for this runtime and model.
  const effort = resolveComposerReasoning(binding, agentStatus, catalog.capabilities, catalog.models, catalog.providers);
  const global = agentStatus?.reasoningByRuntime?.[runtimeId] ?? (agentStatus?.runtime === runtimeId ? agentStatus.reasoning : undefined);
  const stored = snapshot.settings.reasoning ?? null;
  const reasoningId = useId();
  const runsOn = runtimeId
    ? `${metaAgentRuntimeLabel(runtimeId)} · ${runs?.modelId ? modelDisplayLabel(runtimeId, runs.modelId, catalog.models) : 'default model'} — same as your conversation`
    : 'The same runtime and model as your conversation';
  return (
    <SettingsSection title="Model">
      <SettingsRow label="Runs on" description={runsOn} />
      <SettingsRow label="Reasoning" labelFor={reasoningId}
        description={`Used by check-ins and new conversations; the composer can change it for one conversation. Check-ins stop after ${CHECKIN_MINUTES} minutes, so xhigh and max can cut them short.`}
        control={(
          <select id={reasoningId} className="companion-select" value={stored ?? ''}
            onChange={(event) => { patch({ reasoning: (event.target.value || null) as RuntimeReasoning | null }); }}>
            <option value="">{defaultReasoningLabel(global, agentStatus !== null)}</option>
            {stored && !effort.levels.includes(stored) && <option value={stored}>{`${reasoningLabel(stored)} (this model doesn’t offer it)`}</option>}
            {effort.levels.map((level) => <option key={level} value={level}>{reasoningLabel(level)}</option>)}
          </select>
        )} />
      {/* §2.8 T5's remaining gaps (DESIGN-v2 §2.8 补记): Codex's Trust and YOLO turns never ask mid-turn (approvalPolicy 'never'), and
          Kiro runs what the user's own Kiro agent allows (allowedTools) without a permission request; Michi's own tools enforce the
          taint themselves on both (D23). Claude (the D4 hook) and Pi ask Michi per call, and the next turn starts in Ask (D1). */}
      <p className="settings-row__note">{`On Codex in Trust or YOLO, once ${name} reads check-in material, the rest of that turn’s tools don’t ask first. `
        + `On Kiro, tools your own Kiro agent already allows (its allowedTools) run without asking, even then. `
        + `${name}’s own tools that start other work or reach outside Michi still ask first.`}</p>
    </SettingsSection>
  );
}

/** One run in Activity: when, what, how it ended, what it changed with Undo all, and its post. */
function RunRow({ run }: { run: CompanionRunDto }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const changes = runChangesText(run.changes ?? []);
  // A follow-up went out: with nothing else changed, there is nothing for Undo all to take back (D21).
  const undoable = (run.changes ?? []).some((change) => change.kind !== 'send');
  const post = run.postedMessageId ?? null;
  const undo = async () => {
    setBusy(true);
    setNote(null);
    try {
      const result = await undoCompanionRun(run.id);
      setNote(result.conflicts.length > 0
        ? `Undid ${count(result.reverted.length, 'change')}; ${count(result.conflicts.length, 'change')} changed since: ${result.conflicts[0]!.message}`
        : 'Undone.');
      scheduleCompanionRefresh();
    } catch (cause) {
      setNote(errorText(cause, 'Couldn’t undo that'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li>
      <span>{clockText(run.startedAt)}</span>
      <span>
        {RUN_KIND_LABEL[run.kind] ?? run.kind} · {OUTCOME_LABEL[run.outcome] ?? run.outcome}{run.detail ? ` · ${run.detail}` : ''}
        {changes && <> · {changes}{run.undoneAt ? ' · Undone' : ''}</>}
        {changes && undoable && !run.undoneAt && (
          <> · <button type="button" className="settings-row__link" disabled={busy} onClick={() => { void undo(); }}>Undo all</button></>
        )}
        {post && (
          // §2.7: the link goes to the post itself (cmp-post-<runId>), not just the Chat tab.
          <> · <button type="button" className="settings-row__link" onClick={() => openCompanionPanel({ focusMessageId: post })}>View in chat</button></>
        )}
        {note && <span className="companion-settings-muted" role="status"> {note}</span>}
      </span>
    </li>
  );
}

/**
 * A conversation the agent started and follows (DESIGN-v2 §4): "Ask before
 * sending" is on unless the user chose "Send, and stop asking"; it can only
 * be turned back on here (PATCH companionDelegationPath(id) {autoSend:false}).
 * The switch is about the follow-ups the user asks for in their own turns.
 * Check-ins never use it: they suggest a follow-up as a card, except to a
 * conversation that runs in Ask, where they may send it directly (Q1,
 * companionCheckinMaySendDirectly) and that conversation's tools still ask.
 */
function DelegationRow({ delegation, name }: { delegation: CompanionDelegationDto; name: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const askAgain = async () => {
    setBusy(true);
    setError(null);
    try {
      // The row shows what the server answered: an answer that still sends without asking stays off, and says so.
      const saved = await stopCompanionDelegationAutoSend(delegation.id);
      updateCompanionSnapshot((snapshot) => ({
        ...snapshot,
        delegations: (snapshot.delegations ?? []).map((entry) => (entry.id === delegation.id ? { ...entry, ...saved } : entry)),
      }));
      if (saved.autoSend) setError(`${name} still sends here without asking. Try again.`);
    } catch (cause) {
      setError(errorText(cause, 'Couldn’t change that'));
    } finally {
      setBusy(false);
      scheduleCompanionRefresh();
    }
  };
  const checkins = `Check-ins only suggest a follow-up for you to apply, unless this conversation runs in Ask: then ${name} may send it directly, and the conversation’s tools still ask you first.`;
  return (
    <SettingsRow label={delegation.title || 'Untitled conversation'}
      description={delegation.autoSend
        ? `Follow-ups you ask ${name} for go here without asking you first. ${checkins}`
        : `When you ask ${name} for a follow-up here, it shows you the text before sending. To stop asking, answer one with “Send, and stop asking for this conversation”. ${checkins}`}
      control={<Switch on={!delegation.autoSend} disabled={busy || !delegation.autoSend} aria-label={`Ask before sending to ${delegation.title || 'this conversation'}`}
        onChange={(on) => { if (on) void askAgain(); }} />}>
      {error && <p className="settings-row__note" role="alert">{error}</p>}
    </SettingsRow>
  );
}

function ActivitySection({ snapshot, name }: { snapshot: CompanionSnapshot; name: string }) {
  const following = (snapshot.delegations ?? []).filter((delegation) => delegation.state === 'following');
  return (
    <SettingsSection title="Activity"
      intro={`Each source’s latest check, every check that failed or found something, and every check-in: whether ${name} posted, what it changed, and Undo.`}>
      <div className="settings-section__block">
        {snapshot.activity.length === 0 ? <p className="companion-settings-muted">Nothing yet.</p> : (
          <ul className="companion-runs" aria-label="Recent activity">
            {snapshot.activity.slice(0, 20).map((run) => <RunRow key={run.id} run={run} />)}
          </ul>
        )}
      </div>
      {following.length > 0 && (
        <div role="group" aria-label={`Conversations ${name} follows`}>
          <p className="settings-row__note">{`Conversations ${name} started and still follows, with whether it asks you before sending one a follow-up you asked for.`}</p>
          {following.map((delegation) => <DelegationRow key={delegation.id} delegation={delegation} name={name} />)}
        </div>
      )}
    </SettingsSection>
  );
}

/** New conversation (POST /assistant/reset; the panel follows the snapshot's conversation) and where History is. */
function ConversationSection({ snapshot, name }: { snapshot: CompanionSnapshot; name: string }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const nodeId = snapshot.conversation?.nodeId;
  const start = async () => {
    const ok = await confirmDialog({
      title: 'Start a new conversation?',
      message: `${name} starts a new conversation; this one moves to History. Notes, goals, rules and Today stay.`,
      confirmLabel: 'New conversation',
      danger: false,
    });
    if (!ok) return;
    setBusy(true);
    setNote(null);
    try {
      adoptCompanionSnapshot(await resetCompanionConversation(nodeId));
      setNote('Started a new conversation.');
    } catch (cause) {
      if (cause instanceof AssistantApiError && cause.current) {
        // Another window started over first: the next read shows the conversation that is current now.
        scheduleCompanionRefresh();
        setNote('Started a new conversation.');
      } else if (cause instanceof AssistantApiError && cause.status === 409) {
        setNote(`${name} is answering right now. Try again when it’s done.`);
      } else {
        setNote(errorText(cause, 'Couldn’t start a new conversation'));
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection title="Conversation">
      <SettingsRow label="New conversation" description={note ?? `Start over with ${name}. This conversation moves to History; notes, goals, rules and Today stay.`}
        control={<Button size="sm" disabled={busy || !nodeId} onClick={() => { void start(); }}>New conversation</Button>} />
      <SettingsRow label="History" description={`Earlier conversations, Scheduled-job chats included, are under History in ${name}’s panel menu.`}
        control={<Button size="sm" onClick={() => openCompanionPanel({ history: true })}>Open History</Button>} />
    </SettingsSection>
  );
}

function SettingsBody({ snapshot, name }: { snapshot: CompanionSnapshot; name: string }) {
  const { settings, status } = snapshot;
  const openSettingsPage = useOpenSettingsPage();
  const [error, setError] = useState<string | null>(null);
  const [keepingNotes, setKeepingNotes] = useState(false);
  const nameId = useId();
  const pollId = useId();
  const budgetId = useId();
  const notificationsId = useId();

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
  const sourceDetail = (kind: CompanionSourceStatus['kind']) => {
    const source = status.sources.find((entry) => entry.kind === kind);
    if (!source || source.state === 'ok' || source.state === 'disabled') return source?.lastPolledAt ? `Checked ${companionAgo(source.lastPolledAt, Date.now())}` : undefined;
    return source.detail ?? (source.state === 'pending' ? 'Not checked yet' : 'Unavailable');
  };
  const sourceSwitch = (kind: CompanionSourceStatus['kind']) => (
    <Switch on={settings.sources[kind].enabled} aria-label={SOURCE_NAME[kind]}
      onChange={(on) => { void patch({ sources: { [kind]: { enabled: on } } as NonNullable<CompanionSettingsPatch['sources']> }); }} />
  );
  const toggleDay = (day: number) => {
    const next = settings.workdays.includes(day) ? settings.workdays.filter((entry) => entry !== day) : [...settings.workdays, day];
    void patch({ workdays: next.sort((a, b) => a - b) });
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
  const line = companionStatusLine(snapshot, Date.now());
  const checkinNotes = snapshot.notesOrigin === 'checkin' && snapshot.notes.trim() !== '';

  return (
    <>
      <SettingsSection title="Name" aside={<span className="companion-settings-muted">{line.text}</span>}>
        <SettingsRow label="Name" labelFor={nameId} description="What you call it: on its button, in its messages and notifications, and here."
          control={<TextField id={nameId} value={settings.displayName} maxLength={40} label="Name"
            onCommit={(next) => { if (next) void patch({ displayName: next }); }} />} />
        {error && <p className="settings-section__status" role="alert">{error}</p>}
      </SettingsSection>

      <ModelSection snapshot={snapshot} name={name} patch={(next) => { void patch(next); }} />

      <SettingsSection title="Watching" intro={`What ${name} checks on its own. It only reads; it never comments, merges, approves or sends.`}>
        <SettingsRow label="Watch and check in" description={`Off: ${name} doesn’t check your sources, check in or notify you. You can still talk to it.`}
          control={<Switch on={settings.enabled} aria-label="Watch and check in" onChange={(on) => { void patch({ enabled: on }); }} />} />
        <SettingsRow label="Pause" description="Keeps everything as it is, but stops checks, check-ins and notifications until you resume."
          control={<Switch on={settings.paused} aria-label="Pause" onChange={(on) => { void patch({ paused: on }); }} />} />
        <SettingsRow label="Michi conversations" description={sourceDetail('michi') ?? 'Conversations waiting on you, stalled or finished.'} control={sourceSwitch('michi')} />

      </SettingsSection>

      <SettingsSection title="Check-ins" intro={`${name} looks over what changed and posts in your conversation only when something needs you. Check-in transcripts aren’t kept.`}>
        <SettingsRow label="Check-ins" description="Skipped when nothing is new."
          control={(
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <select className="companion-select" value={settings.heartbeat.intervalMinutes} aria-label="Check-in interval" disabled={!settings.heartbeat.enabled}
                onChange={(event) => { void patch({ heartbeat: { intervalMinutes: Number(event.target.value) as CompanionHeartbeatMinutes } }); }}>
                {COMPANION_HEARTBEAT_MINUTES.map((minutes) => <option key={minutes} value={minutes}>Every {minutes < 60 ? `${minutes} min` : `${minutes / 60} h`}</option>)}
              </select>
              <Switch on={settings.heartbeat.enabled} aria-label="Check-ins" onChange={(on) => { void patch({ heartbeat: { enabled: on } }); }} />
            </span>
          )} />
        <SettingsRow label="Morning brief" description="A short brief of what matters today, with an ending."
          control={(
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <TimeField value={settings.brief.time} label="Morning brief time" onCommit={(time) => { void patch({ brief: { time } }); }} />
              <Switch on={settings.brief.enabled} aria-label="Morning brief" onChange={(on) => { void patch({ brief: { enabled: on } }); }} />
            </span>
          )} />
        <SettingsRow label="Daily turn budget" labelFor={budgetId} description={`At most this many check-ins, alerts and briefs a day (${status.turnsToday} today). Welcome and worker reports don’t count.`}
          control={<NumberField id={budgetId} value={settings.dailyTurnBudget} min={1} max={COMPANION_LIMITS.maxDailyTurnBudget} label="Daily turn budget"
            onCommit={(dailyTurnBudget) => { void patch({ dailyTurnBudget }); }} />} />
      </SettingsSection>

      <SettingsSection title="Notifications"
        intro={(
          <p>
            {`Only what ${name} sends on its own: the check-ins it posts, the morning brief and Today’s items. Approvals, questions and replies in your conversations follow `}
            <button type="button" className="settings-row__link" onClick={() => openSettingsPage('notifications', 'Notifications')}>Settings › Notifications</button>.
          </p>
        )}>
        <SettingsRow label="Notifications" labelId={notificationsId}>
          <Radio label={`${name} notifications`} opts={notificationOptions(name)} value={settings.notifications}
            onChange={(notifications) => { void patch({ notifications }); }} />
        </SettingsRow>
        <SettingsRow label="Quiet hours" description="No notifications and no check-ins; urgent changes wait for the morning brief."
          control={(
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <TimeField value={settings.quietHours.start} label="Quiet hours start" onCommit={(start) => { void patch({ quietHours: { start } }); }} />
              <span className="companion-settings-muted">to</span>
              <TimeField value={settings.quietHours.end} label="Quiet hours end" onCommit={(end) => { void patch({ quietHours: { end } }); }} />
              <Switch on={settings.quietHours.enabled} aria-label="Quiet hours" onChange={(on) => { void patch({ quietHours: { enabled: on } }); }} />
            </span>
          )} />
        <SettingsRow label="Workdays" description={`On other days ${name} keeps checking but stays quiet; Monday’s brief covers the weekend.`}>
          <div className="companion-workdays" role="group" aria-label="Workdays">
            {WORKDAYS.map(({ day, label }) => (
              <button key={day} type="button" className="companion-workday" aria-pressed={settings.workdays.includes(day)} onClick={() => toggleDay(day)}>{label}</button>
            ))}
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Your rules" intro={`${name} follows these before anything else. Only you can change them.`}>
        <div className="settings-section__block">
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
      </SettingsSection>

      <SettingsSection title="Notes" intro={`${name}’s own notes: what it is tracking and how you like to work. You can edit, keep or clear them.`}>
        <div className="settings-section__block">
          {checkinNotes && (
            <p className="settings-section__status" role="note">
              {`Written by ${name} during a check-in. Your conversation with ${name} doesn’t read them until you keep or edit them.`}
            </p>
          )}
          <LongText value={snapshot.notes} maxLength={COMPANION_LIMITS.maxNotesChars} label="Notes" placeholder="No notes yet."
            changedNote={`${name} updated these notes while you were editing. Save replaces them with your text; Discard loads the new version.`}
            onSave={saveNotes}
            extra={checkinNotes && <Button size="sm" disabled={keepingNotes} onClick={() => { void keepNotes(); }}>Keep</Button>} />
        </div>
      </SettingsSection>

      <Goals goals={snapshot.goals} name={name} />

      {snapshot.demotedSubtypes.length > 0 && (
        <SettingsSection title="Quieter after your feedback" intro="You marked these as too noisy, so they wait for the brief instead of interrupting.">
          <div className="settings-section__block">
            <ul className="companion-settings-list">
              {snapshot.demotedSubtypes.map((subtype) => (
                <li key={subtype}>
                  <span>{SUBTYPE_LABEL[subtype] ?? subtype}</span>
                  <Button size="sm" variant="ghost" onClick={() => {
                    undoCompanionDemotion(subtype).then(() => {
                      updateCompanionSnapshot((current) => ({ ...current, demotedSubtypes: current.demotedSubtypes.filter((entry) => entry !== subtype) }));
                      scheduleCompanionRefresh();
                    }, (cause: unknown) => setError(errorText(cause, 'Couldn’t undo that')));
                  }}>Undo</Button>
                </li>
              ))}
            </ul>
          </div>
        </SettingsSection>
      )}

      <PagesUpkeepSection name={name} />

      <ActivitySection snapshot={snapshot} name={name} />

      <ConversationSection snapshot={snapshot} name={name} />

      <WindowsClosedLink name={name} />
    </>
  );
}

/** Settings › <name> › Pages upkeep: what was Settings › Meta agent (DESIGN-v2 §1.5, item 7). */
function PagesUpkeepSection({ name }: { name: string }) {
  return (
    <SettingsSection title={PAGES_UPKEEP_TITLE}
      intro={`In the background, ${name} reads your finished conversations and keeps every workspace home and the Pages Home up to date.`}>
      <PagesUpkeepSettings />
    </SettingsSection>
  );
}

/**
 * The link to Settings › Notifications › When Michi’s windows are closed
 * (DESIGN-v2 §1.5, item 10). A phone leaves that section out (it is the
 * desktop app's), so it leaves the link out too.
 */
function WindowsClosedLink({ name }: { name: string }) {
  const openSettingsPage = useOpenSettingsPage();
  const phone = useSettingsPhone();
  if (phone) return null;
  return (
    <SettingsSection title={WINDOWS_CLOSED_TITLE}>
      <SettingsRow label={WINDOWS_CLOSED_TITLE}
        description={`Keep Michi in the menu bar, and running after you quit, so ${name} can still reach you.`}
        control={<button type="button" className="settings-row__link" onClick={() => openSettingsPage('notifications', WINDOWS_CLOSED_TITLE)}>Open</button>} />
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
 * Settings › <name> (DESIGN-v2 §1.5), in order: Name; Model (runs on,
 * Reasoning, the trust gap); Watching; Check-ins; Notifications (only its
 * own); rules, notes and goals; Pages upkeep (Settings › Meta agent before
 * v2); Activity (check-ins' changes with Undo all, and the followed
 * conversations' "Ask before sending"); Conversation; and a link to "When
 * Michi’s windows are closed". Without the agent's snapshot only Pages
 * upkeep, which does not need it, shows.
 */
export default function CompanionSettings() {
  const { availability, snapshot } = useCompanion();
  const name = useCompanionName();
  useEffect(() => { void loadCompanion(); }, []);
  return (
    <>
      <div className="settings-section__intro">
        <p>{`${name} answers you here with your runtime’s tools and permissions. On its own it only reads your sources and tidies your pages, tasks, goals and Today. It never runs commands or edits files, and whatever would act outside Michi waits for your OK: it suggests follow-ups to the conversations it started for you to apply, and sends one directly only to a conversation that runs in Ask, whose tools still ask you first. Check-in transcripts aren’t kept.`}</p>
      </div>
      {snapshot ? <SettingsBody snapshot={snapshot} name={name} /> : (
        <>
          {availability === 'unavailable'
            ? <p className="settings-section__status" role="status">{`${name}’s check-ins aren’t available on this backend.`}</p>
            : <div role="status">{`Loading ${name}…`}</div>}
          <PagesUpkeepSection name={name} />
        </>
      )}
    </>
  );
}
