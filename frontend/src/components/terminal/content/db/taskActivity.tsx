import React, { createContext, useContext, useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { joinAnd, plural, type CompanionActor, type MichiDatabase, type MichiDbCellValue, type MichiDbColumn, type PageChangeDto, type TaskMark, type TaskOrigin, type TaskUpkeep } from 'michi-shared';
import { useCompanionName } from '../../../../state/companion/companionName';
import { pagesUpkeepTitle } from '../../scheduled/metaAgent/metaAgentCopy';
import { formatMichiAgo } from '../michiFormat';
import { michiOneLine } from '../michiPlainText';
import { columnName, filterValueText } from './dbLabels';

/**
 * What a task board shows of Pages upkeep (the agent's background
 * maintenance), handed to its cards and a task's details by the board's
 * host. Each part is optional: All tasks only says who made a task.
 */
export interface TaskActivityView {
  /** New or Updated: Pages upkeep added or changed the task lately, and the person has not opened it since. */
  markOf?: (rowId: string) => TaskMark['kind'] | null;
  /** The suggestions waiting on the task, newest first. */
  suggestionsOf?: (rowId: string) => readonly PageChangeDto[];
  /** One suggestion with its Accept and Dismiss. */
  renderSuggestion?: (change: PageChangeDto) => React.ReactNode;
  /** The person opened the task's details: its mark goes. */
  seen?: (rowId: string) => void;
  /** Who made the task and when; null when Michi has no record of it. */
  loadOrigin?: (rowId: string) => Promise<TaskOrigin | null>;
}

export const TaskActivityContext = createContext<TaskActivityView | null>(null);
export const useTaskActivity = (): TaskActivityView | null => useContext(TaskActivityContext);


/**
 * The agent as the author of something (DESIGN-v2 §2.7): "<name>", and its
 * background maintenance "<name> · Pages upkeep" (an older backend's
 * 'meta-agent' actor arrives as upkeep: services/api/legacyActor.ts).
 */
export function companionActorName(actor: CompanionActor, name: string): string {
  return actor.via === 'upkeep' ? pagesUpkeepTitle(name) : name;
}

/**
 * "Michi · Pages upkeep added 1 task and updated 1", "Michi · Pages upkeep
 * updated 2 tasks, removed 1 and suggested 1 change": what the agent's Pages
 * upkeep did (a board's upkeep note is only ever about it).
 */
export function upkeepSummary(upkeep: Pick<TaskUpkeep, 'added' | 'updated' | 'removed' | 'suggested'>, name: string): string {
  const parts: string[] = [];
  for (const [verb, n] of [['added', upkeep.added], ['updated', upkeep.updated], ['removed', upkeep.removed]] as const) {
    if (n) parts.push(`${verb} ${parts.length ? n : plural(n, 'task')}`);
  }
  if (upkeep.suggested) parts.push(`suggested ${plural(upkeep.suggested, 'change')}`);
  const said = joinAnd(parts) || 'changed nothing';
  return `${companionActorName({ kind: 'companion', via: 'upkeep' }, name)} ${said}`;
}

/** "Created by Michi from 3 conversations", "Created by an agent from 1 conversation", "Created by you". */
export function originText(origin: Pick<TaskOrigin, 'by' | 'conversations'>, name: string): string {
  if (origin.by === 'you') return 'Created by you';
  const who = origin.by === 'agent' ? 'an agent' : companionActorName(origin.by, name);
  return origin.conversations > 0 ? `Created by ${who} from ${plural(origin.conversations, 'conversation')}` : `Created by ${who}`;
}

function valueWords(db: MichiDatabase, column: MichiDbColumn, value: MichiDbCellValue): string {
  if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) return 'empty';
  if (column.type === 'threads' && Array.isArray(value)) return plural(value.length, 'conversation');
  const text = michiOneLine(filterValueText(db, column, value));
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/** What a suggestion would change, in a line: "Suggested: Status → Done · Next step → Tag v2". */
export function suggestionSummary(db: MichiDatabase, change: PageChangeDto): string {
  const forward = change.forward;
  if (forward.kind === 'row' && forward.op === 'delete') return 'Suggested: remove this task';
  if (forward.kind !== 'row' || forward.op !== 'patch') return 'Suggested change';
  const parts = Object.entries(forward.values).flatMap(([id, value]) => {
    const column = db.columns.find((c) => c.id === id);
    return column ? [`${columnName(db, column)} → ${valueWords(db, column, value)}`] : [];
  });
  if (forward.body !== undefined) parts.push('Notes');
  return parts.length ? `Suggested: ${parts.join(' · ')}` : 'Suggested change';
}

/** A card's marks: Suggestion while one waits on the task, New or Updated after Pages upkeep. A click on the card opens its details. */
export function TaskMarks({ rowId, id }: { rowId: string; id?: string }) {
  const activity = useTaskActivity();
  const mark = activity?.markOf?.(rowId) ?? null;
  const suggested = (activity?.suggestionsOf?.(rowId).length ?? 0) > 0;
  if (!mark && !suggested) return null;
  return (
    <span id={id} className="michi-task-marks">
      {suggested && <span className="michi-task-mark" data-mark="suggestion">Suggestion</span>}
      {mark && <span className="michi-task-mark" data-mark={mark}>{mark === 'new' ? 'New' : 'Updated'}</span>}
    </span>
  );
}

/** The suggestions on a task, at the top of its details: what each would change, then the suggestion with its Accept and Dismiss. */
export function TaskSuggestions({ db, changes, render }: { db: MichiDatabase; changes: readonly PageChangeDto[]; render: (change: PageChangeDto) => React.ReactNode }) {
  return (
    <section className="michi-peek__section michi-task-suggestions" aria-label="Suggestions">
      {changes.map((change) => (
        <div key={change.id} className="michi-task-suggestion">
          <p className="michi-task-suggestion__what">{suggestionSummary(db, change)}</p>
          {render(change)}
        </div>
      ))}
    </section>
  );
}

/** Who made a task and when, at the foot of its details; nothing while it is read, or when Michi has no record. */
export function TaskOriginLine({ rowId, load }: { rowId: string; load: (rowId: string) => Promise<TaskOrigin | null> }) {
  const name = useCompanionName();
  const [origin, setOrigin] = useState<TaskOrigin | null>(null);
  useEffect(() => {
    let current = true;
    setOrigin(null);
    load(rowId).then((value) => { if (current) setOrigin(value); }, () => { if (current) setOrigin(null); });
    return () => { current = false; };
  }, [rowId, load]);
  if (!origin) return null;
  return (
    <p className="michi-db-peek__origin">
      {originText(origin, name)} · <time dateTime={new Date(origin.at).toISOString()}>{formatMichiAgo(origin.at)}</time>
    </p>
  );
}

/**
 * The note above a task board on Pages upkeep's latest update: what it did,
 * when, the conversation it read, and Undo while any of it was written. With
 * only suggestions left there is nothing to undo: they wait on their cards.
 */
export function TaskUpkeepLine({ upkeep, now, undoing = false, onUndo, onOpenSource }: {
  upkeep: TaskUpkeep;
  now: number;
  undoing?: boolean;
  onUndo: () => void;
  onOpenSource?: (source: { nodeId: string; turnId: string; assistantId: string }) => void;
}) {
  const name = useCompanionName();
  const summary = upkeepSummary(upkeep, name);
  const written = upkeep.added + upkeep.updated + upkeep.removed;
  const source = upkeep.source;
  return (
    <p className="michi-task-upkeep">
      <Sparkles size={12} strokeWidth={1.7} aria-hidden="true" />
      {/* Announced alone: the age beside it changes every minute and must not be read out again. */}
      <span className="sr-only" role="status">{summary}</span>
      <span aria-hidden="true">{summary}</span>
      <span aria-hidden="true">·</span>
      <time dateTime={new Date(upkeep.at).toISOString()}>{formatMichiAgo(upkeep.at, now)}</time>
      {source && (
        <>
          <span aria-hidden="true">·</span>
          <span>from {onOpenSource
            ? <button type="button" className="michi-db-link-btn" onClick={() => onOpenSource(source)}>“{source.title}”</button>
            : `“${source.title}”`}</span>
        </>
      )}
      {written > 0 && (
        <button type="button" className="michi-db-link-btn michi-task-upkeep__undo" disabled={undoing} onClick={onUndo}>Undo</button>
      )}
    </p>
  );
}
