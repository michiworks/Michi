import React, { useState } from 'react';
import type { CompanionDelegationDto, CompanionPostChange, CompanionRunDto } from 'michi-shared';
import {
  stopCompanionDelegationAutoSend,
  undoCompanionRun,
  type CompanionSnapshot,
} from '../../../services/api/companion';
import { openCompanionPanel } from '../../../state/companion/companionPanel';
import { scheduleCompanionRefresh, updateCompanionSnapshot } from '../../../state/companion/companionStore';
import { Switch } from '../../ui/controls';
import { InfoTip } from '../../ui/InfoTip';

const RUN_KIND_LABEL: Record<CompanionRunDto['kind'], string> = {
  poll: 'Check', heartbeat: 'Check-in', brief: 'Brief', welcome: 'Welcome', catch_up: 'Catch-up', worker_report: 'Worker report', wake: 'Alert',
  send: 'Follow-up',
};

/** How a run ended, in words (DESIGN-v2 §3.3: a superseded run keeps the fact, never the reply). */
const OUTCOME_LABEL: Record<CompanionRunDto['outcome'], string> = {
  running: 'running', ok: 'done', spoke: 'posted', quiet: 'nothing to say', skipped: 'skipped', error: 'failed',
  preempted: 'stopped so you could go first', superseded: 'not posted: you wrote first',
};

function errorText(error: unknown, fallback: string): string {
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

/** One run: when, what, how it ended, what it changed with Undo all, and its post. */
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
          <> · <button type="button" className="companion-link-btn" disabled={busy} onClick={() => { void undo(); }}>Undo all</button></>
        )}
        {post && (
          // §2.7: the link goes to the post itself (cmp-post-<runId>), not just the Chat tab.
          <> · <button type="button" className="companion-link-btn" onClick={() => openCompanionPanel({ focusMessageId: post })}>View in chat</button></>
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
 * companionCheckinMaySendDirectly) and what would leave the machine there still asks (D19).
 */
function DelegationRow({ delegation, name }: { delegation: CompanionDelegationDto; name: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = delegation.title || 'Untitled conversation';
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
  return (
    <li className="companion-activity-sheet__follow">
      <span className="companion-activity-sheet__follow-title" title={title}>{title}</span>
      <label className="companion-activity-sheet__ask">
        Ask before sending
        <Switch on={!delegation.autoSend} disabled={busy || !delegation.autoSend} aria-label={`Ask before sending to ${delegation.title || 'this conversation'}`}
          onChange={(on) => { if (on) void askAgain(); }} />
      </label>
      {error && <span className="companion-activity-sheet__error" role="alert">{error}</span>}
    </li>
  );
}

/**
 * The panel's Activity (its ⋯ menu; Settings › <name> before Q31): each
 * source's latest check, every check that failed or found something, and
 * every check-in with what it changed and Undo all; then the conversations
 * the agent started and follows, with "Ask before sending".
 */
export function CompanionActivity({ snapshot, name }: { snapshot: CompanionSnapshot | null; name: string }) {
  if (!snapshot) return <p className="companion-settings-muted" role="status">Activity isn’t available right now.</p>;
  const following = (snapshot.delegations ?? []).filter((delegation) => delegation.state === 'following');
  return (
    <div className="companion-activity-sheet">
      {snapshot.activity.length === 0 ? <p className="companion-settings-muted">Nothing yet.</p> : (
        <ul className="companion-runs" aria-label="Recent activity">
          {snapshot.activity.slice(0, 20).map((run) => <RunRow key={run.id} run={run} />)}
        </ul>
      )}
      {following.length > 0 && (
        <section className="companion-activity-sheet__following" aria-label={`Conversations ${name} follows`}>
          <div className="companion-activity-sheet__head">
            <h3>{`Conversations ${name} follows`}</h3>
            <InfoTip label="More about these conversations"
              text={`When you ask ${name} for a follow-up to one of these, it shows you the text first unless you chose “Send, and stop asking”. Check-ins only suggest one, or send it directly to a conversation that runs in Ask, where whatever would leave this machine still asks you first.`} />
          </div>
          <ul className="companion-settings-list">
            {following.map((delegation) => <DelegationRow key={delegation.id} delegation={delegation} name={name} />)}
          </ul>
        </section>
      )}
    </div>
  );
}
