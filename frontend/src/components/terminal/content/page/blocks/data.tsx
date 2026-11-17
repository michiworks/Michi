import React, { useEffect, useId, useRef, useState } from 'react';
import type { BlockProps } from '../blockTypes';
import { isPlanSchedule, list, num, objects, pct, planActualModel, planScheduleModel, str, timelineWhen } from '../michiPageModel';
import { ChatIcon, CheckIcon, ChevronRightIcon, CloseIcon } from '../../../icons';
import { Button } from '../../../../ui/controls';
import { useBlockSend } from '../vendor-blocks/src/desk/blocks/catalog/interactive/useBlockSend';
import { SubmitFailedNote, SubmittedNote } from '../vendor-blocks/src/desk/blocks/catalog/interactive/SubmittedNote';
import type { PageBlockWithSources } from '../vendor-blocks/shared/desk-blocks';
import { BlockTitle } from './text';
import { PageViewEntry } from '../PageViewContext';
import { useCompanionName } from '../../../../../state/companion/companionName';

/** A row of labelled figures; tone `warn` flags one, `accent` highlights it. A note is a native page's hint. */
export function MetricsBlock({ block }: BlockProps) {
  const items = objects(block.items).filter((m) => str(m.label).trim() || str(m.value).trim());
  return (
    <dl className="michi-doc-metrics" data-layout={items.every((m) => str(m.value).length <= 12) ? 'row' : 'cards'} data-michi-block="metrics">
      {items.map((m, i) => {
        const hint = str(m.hint).trim() || str(m.note).trim();
        return (
          <div key={i} className="michi-doc-metric" data-tone={m.tone === 'warn' || m.tone === 'accent' ? m.tone : undefined}>
            <dt className="michi-doc-label">{str(m.label)}</dt>
            <dd className="michi-doc-metric__value">{m.action ? <PageViewEntry action={m.action}><span className="sr-only">{str(m.label)}: </span>{str(m.value)}</PageViewEntry> : str(m.value)}</dd>
            {hint && <dd className="michi-doc-metric__hint">{hint}</dd>}
          </div>
        );
      })}
    </dl>
  );
}

const ARROWS = { up: '↑', down: '↓', flat: '→' } as const;
type Direction = keyof typeof ARROWS;

function directionOf(delta: string, tone: unknown): Direction {
  if (tone === 'up' || tone === 'down' || tone === 'flat') return tone;
  if (/^\s*\+/.test(delta)) return 'up';
  if (/^\s*[-−–]/.test(delta)) return 'down';
  return 'flat';
}

function Spark({ values }: { values: number[] }) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const points = values
    .map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - lo) / span) * 24 - 2}`)
    .join(' ');
  return (
    <svg className="michi-doc-stat__spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** One big figure with an optional change and trend line. */
export function StatBlock({ block }: BlockProps) {
  const delta = str(block.delta).trim();
  const dir = delta ? directionOf(delta, block.deltaTone) : 'flat';
  const spark = list(block.spark).map(num).filter((n): n is number => n != null);
  return (
    <div className="michi-doc-metric" data-michi-block="stat" style={{ maxWidth: 280 }}>
      <span className="michi-doc-label">{str(block.label)}</span>
      <span className="michi-doc-metric__value" style={{ fontSize: 'var(--fs-5xl)' }}>{str(block.value)}</span>
      {delta && <span className="michi-doc-stat__delta" data-dir={dir}><span aria-hidden="true">{ARROWS[dir]}</span> {delta}</span>}
      {spark.length >= 2 && <Spark values={spark} />}
    </div>
  );
}

/** Share done, with a tick where the plan expected it by now. */
export function ProgressBlock({ block }: BlockProps) {
  const actual = Math.min(1, Math.max(0, num(block.actual) ?? 0));
  const rawExpected = num(block.expected);
  const expected = rawExpected == null ? null : Math.min(1, Math.max(0, rawExpected));
  const words = `actual ${pct(actual)}${expected == null ? '' : ` · plan by now ${pct(expected)}`}`;
  return (
    <div data-michi-block="progress">
      <BlockTitle text={str(block.title)} />
      <div
        className="michi-doc-progress"
        role="progressbar"
        aria-label={str(block.title) || 'Progress'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(actual * 100)}
        aria-valuetext={words}
      >
        <span className="michi-doc-progress__fill" style={{ width: pct(actual) }} />
        {expected != null && <span className="michi-doc-progress__mark" style={{ left: pct(expected) }} />}
      </div>
      <div className="michi-doc-progress__legend" aria-hidden="true">{words}</div>
    </div>
  );
}

const share = (f: number) => `${(f * 100).toFixed(2)}%`;

/**
 * Plan against actual per item: the plan as an outline, the actual filled
 * (any overrun in the warning colour), a dashed forecast when there is one,
 * and a line for today when the block places it. `actual / planned` sits on
 * the right in words, so nothing depends on the bars alone.
 */
export function PlanActualBlock({ block, ctx }: BlockProps) {
  if (isPlanSchedule(block)) return <PlanScheduleBlock block={block} ctx={ctx} />;
  const model = planActualModel(block);
  const title = str(block.title).trim();
  return (
    <div data-michi-block="plan-actual">
      <div className="michi-doc-block-head">
        <h3 className="michi-doc-block-title">{title || 'Plan vs actual'}</h3>
        <span className="michi-doc-pa__legend" aria-hidden="true">
          <span className="michi-doc-pa__key"><span className="michi-doc-pa__swatch" data-kind="plan" />plan</span>
          <span className="michi-doc-pa__key"><span className="michi-doc-pa__swatch" data-kind="actual" />actual</span>
          {model.hasOver && <span className="michi-doc-pa__key"><span className="michi-doc-pa__swatch" data-kind="over" />over plan</span>}
          {model.hasForecast && <span className="michi-doc-pa__key"><span className="michi-doc-pa__swatch" data-kind="forecast" />forecast</span>}
        </span>
      </div>
      <ul className="michi-doc-pa__grid">
        {model.rows.map((row, i) => (
          <li
            key={i}
            className="michi-doc-pa__row"
            data-over={row.over || undefined}
            aria-label={`${row.label}: ${row.text}${row.over ? ', over plan' : ''}`}
          >
            <span className="michi-doc-pa__label">{row.label}</span>
            <span className="michi-doc-pa__track" aria-hidden="true">
              {row.planWidth > 0 && <span className="michi-doc-pa__bar" data-kind="plan" style={{ left: 0, width: share(row.planWidth) }} />}
              {row.actualWidth > 0 && <span className="michi-doc-pa__bar" data-kind="actual" style={{ left: 0, width: share(row.actualWidth) }} />}
              {row.overWidth > 0 && <span className="michi-doc-pa__bar" data-kind="over" style={{ left: share(row.overStart), width: share(row.overWidth) }} />}
              {row.forecastWidth > 0 && (
                <span className="michi-doc-pa__bar" data-kind="forecast" style={{ left: share(row.forecastStart), width: share(row.forecastWidth) }} />
              )}
              {model.today != null && <span className="michi-doc-pa__today" style={{ left: share(model.today) }} />}
            </span>
            <span className="michi-doc-pa__nums">{row.text}</span>
          </li>
        ))}
        {model.today != null && (
          <li className="michi-doc-pa__row" aria-hidden="true">
            <span />
            <span className="michi-doc-pa__axis"><span style={{ left: share(model.today) }}>today</span></span>
            <span />
          </li>
        )}
      </ul>
    </div>
  );
}

/**
 * A plan-actual block in days: one calendar track for every phase, the plan
 * as an outline over what happened, today as a line and the dates under it.
 * Days taken against days planned sit on the right in words.
 */
function PlanScheduleBlock({ block, ctx }: BlockProps) {
  const model = planScheduleModel(block, ctx.now ?? Date.now());
  const title = str(block.title).trim();
  const place = (span: { start: number; width: number }) => ({ left: share(span.start), width: share(span.width) });
  return (
    <div data-michi-block="plan-actual" data-measure="days">
      <div className="michi-doc-block-head">
        <h3 className="michi-doc-block-title">{title || 'Plan vs actual'}</h3>
        <span className="michi-doc-pa__legend" aria-hidden="true">
          <span className="michi-doc-pa__key"><span className="michi-doc-pa__swatch" data-kind="plan" />plan</span>
          <span className="michi-doc-pa__key"><span className="michi-doc-pa__swatch" data-kind="actual" />actual</span>
          {model.hasOver && <span className="michi-doc-pa__key"><span className="michi-doc-pa__swatch" data-kind="over" />over plan</span>}
          {model.hasForecast && <span className="michi-doc-pa__key"><span className="michi-doc-pa__swatch" data-kind="forecast" />forecast</span>}
        </span>
      </div>
      <ul className="michi-doc-pa__grid">
        {model.rows.map((row, i) => (
          <li key={i} className="michi-doc-pa__row" data-over={row.overPlan || undefined} aria-label={row.words}>
            <span className="michi-doc-pa__label">{row.label}</span>
            <span className="michi-doc-pa__track" aria-hidden="true">
              <span className="michi-doc-pa__bar" data-kind="plan" style={place(row.plan)} />
              {row.actual && <span className="michi-doc-pa__bar" data-kind="actual" style={place(row.actual)} />}
              {row.over && <span className="michi-doc-pa__bar" data-kind="over" style={place(row.over)} />}
              {row.forecast && <span className="michi-doc-pa__bar" data-kind="forecast" style={place(row.forecast)} />}
              {model.today != null && <span className="michi-doc-pa__today" style={{ left: share(model.today) }} />}
            </span>
            <span className="michi-doc-pa__nums">{row.text}</span>
          </li>
        ))}
        {model.axis.length > 0 && (
          <li className="michi-doc-pa__row" aria-hidden="true">
            <span />
            <span className="michi-doc-pa__axis">
              {model.axis.map((label) => <span key={label.kind} data-kind={label.kind} style={{ left: share(label.at) }}>{label.text}</span>)}
            </span>
            <span />
          </li>
        )}
      </ul>
    </div>
  );
}

/**
 * Options side by side, each with its value, note, pros and cons. On a page
 * the person may edit, "Pick this" records their choice on the block; the
 * agent's leaning shows until they pick. Elsewhere the button is off.
 */
export function CompareBlock({ block, ctx }: BlockProps) {
  const options = objects(block.options);
  const picked = typeof block.picked === 'number' && options[block.picked] ? block.picked : null;
  const pick = ctx.updateBlock && typeof block.id === 'string' && block.id ? ctx.updateBlock : undefined;
  return (
    <div data-michi-block="compare">
      <BlockTitle text={str(block.title)} />
      <ul className="michi-doc-compare">
        {options.map((o, i) => {
          const name = str(o.name).trim();
          if (!name) return null;
          const lean = o.lean === true && picked === null;
          const chosen = picked === i;
          const pros = list(o.pros).map(str).filter((line) => line.trim());
          const cons = list(o.cons).map(str).filter((line) => line.trim());
          const value = str(o.value).trim();
          const unit = str(o.unit).trim();
          return (
            <li key={i} className="michi-doc-option" data-lean={lean || undefined} data-picked={chosen || undefined}>
              <span className="michi-doc-option__head">
                <span className="michi-doc-option__name">{name}</span>
                {chosen && <span className="michi-doc-option__tag" data-tone="info">Picked</span>}
                {lean && <span className="michi-doc-option__tag">Leaning</span>}
              </span>
              {value && <span className="michi-doc-option__value">{value}{unit && <small> {unit}</small>}</span>}
              {str(o.note).trim() && <span className="michi-doc-option__note">{str(o.note)}</span>}
              {(pros.length > 0 || cons.length > 0) && (
                <ul className="michi-doc-option__lines">
                  {pros.map((line, j) => <li key={`p${j}`} data-kind="pro"><span className="sr-only">Pro: </span>{line}</li>)}
                  {cons.map((line, j) => <li key={`c${j}`} data-kind="con"><span className="sr-only">Con: </span>{line}</li>)}
                </ul>
              )}
              <Button
                className="michi-doc-option__pick"
                disabled={!pick || chosen}
                aria-pressed={pick ? chosen : undefined}
                title={pick ? undefined : 'Coming later'}
                onClick={() => pick?.(block, { ...block, picked: i })}
              >
                {chosen ? 'Picked' : 'Pick this'}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Conversations that disagree, as a choice to make: each version with the
 * app or conversation it came from (which opens it) and when. "Keep this"
 * records the version kept, "Both are fine" that both stand; once decided the
 * kept version is marked and the choice can be changed.
 */
export function ConflictBlock({ block, ctx }: BlockProps) {
  const options = objects(block.options);
  const resolution = block.resolution === 'both' ? 'both' : typeof block.resolution === 'number' && options[block.resolution] ? block.resolution : null;
  const decide = ctx.updateBlock && typeof block.id === 'string' && block.id ? ctx.updateBlock : undefined;
  const [choosing, setChoosing] = useState(false);
  const keptIndex = typeof resolution === 'number' ? resolution : null;
  const [selected, setSelected] = useState<number | null>(keptIndex);
  // When the versions or the decision change under it (an agent rewrote the block), the choice starts again from what is kept.
  const versions = options.map((o) => str(o.text)).join('\n');
  useEffect(() => { setSelected(keptIndex); setChoosing(false); }, [versions, keptIndex, resolution]);
  const name = useId();
  const open = resolution === null || choosing;
  const question = str(block.question).trim();
  const save = (next: number | 'both') => {
    setChoosing(false);
    decide?.(block, { ...block, resolution: next });
  };
  return (
    <fieldset className="michi-doc-conflict" data-michi-block="conflict" data-resolved={open ? undefined : 'true'}>
      <legend className="michi-doc-conflict__q">{question || 'Which is right?'}</legend>
      {options.map((o, i) => {
        const text = str(o.text).trim();
        if (!text) return null;
        const kept = !open && (resolution === 'both' || resolution === i);
        const from = str(o.from).trim();
        const nodeId = str(o.nodeId).trim();
        const when = o.at === undefined ? null : timelineWhen(o.at);
        const where = from && nodeId && ctx.openConversation
          ? <button type="button" className="michi-doc-conflict__from" onClick={() => ctx.openConversation?.(nodeId)} aria-label={`Open the conversation in ${from}`}>{from}</button>
          : from ? <span className="michi-doc-conflict__from">{from}</span> : null;
        return (
          <label key={i} className="michi-doc-conflict__option" data-on={(open ? selected === i : kept) || undefined} data-muted={!open && !kept ? 'true' : undefined}>
            <input
              type="radio"
              name={name}
              checked={open ? selected === i : kept}
              disabled={!decide || !open}
              onChange={() => setSelected(i)}
            />
            <span className="michi-doc-conflict__text">{text}</span>
            <span className="michi-doc-conflict__meta">
              {where}
              {when && (when.dateTime ? <time dateTime={when.dateTime}>{when.text}</time> : <span>{when.text}</span>)}
              {kept && <span className="michi-doc-option__tag" data-tone="info">{resolution === 'both' ? 'Both stand' : 'Kept'}</span>}
            </span>
          </label>
        );
      })}
      {decide && (open ? (
        <div className="michi-doc-conflict__actions">
          <Button size="sm" variant="primary" disabled={selected === null || !options[selected]} onClick={() => { if (selected !== null && options[selected]) save(selected); }}>Keep this</Button>
          <Button size="sm" variant="ghost" onClick={() => save('both')}>Both are fine</Button>
          {choosing && <Button size="sm" variant="ghost" onClick={() => { setChoosing(false); setSelected(keptIndex); }}>Cancel</Button>}
        </div>
      ) : (
        <div className="michi-doc-conflict__actions">
          <button type="button" className="michi-doc-link-btn" onClick={() => { setSelected(keptIndex); setChoosing(true); }}>Change</button>
        </div>
      ))}
    </fieldset>
  );
}

/**
 * Choosing sends only the question and answer the person can see. Where the
 * host keeps submissions the pick is stored first, and a submitted choice
 * shows it read-only.
 */
export function ChoiceBlock({ block, ctx }: BlockProps) {
  const question = str(block.question).trim();
  const options = list(block.options).map(str).filter((option) => option.trim());
  const { available, locked, fire, submit, submission, saving, saveFailed } = useBlockSend(block as PageBlockWithSources, ctx);
  const [picked, setPicked] = useState<number | null>(null);
  const stored = typeof submission?.value === 'number' ? submission.value : null;
  const selected = stored ?? (ctx.updateBlock ? null : picked) ?? (typeof block.selected === 'number' ? block.selected : -1);
  const choose = (index: number, option: string) => {
    const prompt = `For “${question}” I pick: ${option}`;
    const sent = (ok: boolean) => { if (!ok) return; if (ctx.updateBlock) ctx.updateBlock(block, { ...block, selected: index }); else setPicked(index); };
    if (ctx.recordSubmission) void submit(index, prompt, question).then(sent);
    else sent(fire(prompt, question));
  };
  return <fieldset className="michi-doc-choice" data-michi-block="choice" disabled={!available || locked || saving || !!submission}>
    <legend className="michi-doc-choice__q">{question}</legend>
    {options.map((option, index) => <button type="button" key={index} className="michi-doc-choice__option" aria-pressed={selected === index}
      onClick={() => choose(index, option)}>
      <span className="michi-doc-radio" aria-hidden="true" /><span>{option}</span>
    </button>)}
    {submission && <SubmittedNote submission={submission} now={ctx.now} />}
    {saveFailed && <SubmitFailedNote />}
  </fieldset>;
}

export function ProsConsBlock({ block }: BlockProps) {
  const pros = list(block.pros).map(str).filter((s) => s.trim());
  const cons = list(block.cons).map(str).filter((s) => s.trim());
  const title = str(block.title).trim();
  // Under the block's own title the sides are subheads; without one they are its headings.
  const SideHead = title ? 'h4' : 'h3';
  const side = (kind: 'pro' | 'con', head: string, items: string[]) => items.length > 0 && (
    <div>
      <SideHead className="michi-doc-label">{head}</SideHead>
      <ul>
        {items.map((t, i) => (
          <li key={i}><span className="michi-doc-pc__mark" data-kind={kind} aria-hidden="true">{kind === 'pro' ? <CheckIcon /> : <CloseIcon />}</span>{t}</li>
        ))}
      </ul>
    </div>
  );
  return (
    <div data-michi-block="pros-cons">
      <BlockTitle text={title} />
      <div className="michi-doc-pc">
        {side('pro', 'Pros', pros)}
        {side('con', 'Cons', cons)}
      </div>
    </div>
  );
}

/**
 * How long an item the person just ticked keeps its place, ticked and struck
 * through, before it joins the done ones. A dwell, not motion (TK-32): the row
 * then leaves in one frame, as every list edit does (TR-28).
 */
export const TICKED_HOLD_MS = 1200;

/**
 * Items with their marks: the open ones, then the done ones folded under one
 * "Show N done" row that opens them, struck through. Each group keeps its saved
 * order. On a page the person may edit, a mark or the item's words tick the
 * item there and then;
 * the item stays where it was for a moment, so the tick shows, a slip can be
 * undone on the spot and the next item does not jump under the pointer. Ticking
 * another restarts the wait for all of them.
 * Where the page offers Ask, each item offers "Ask <name>" at its end (on hover
 * or focus; always on touch).
 */
export function ChecklistBlock({ block, ctx }: BlockProps) {
  const all = objects(block.items);
  const shown = all.map((it, index) => ({ it, index })).filter(({ it }) => str(it.text).trim());
  // Just ticked here: saved position → the item's text, so an entry cannot
  // hold a different item once the list has been rewritten under it.
  const [held, setHeld] = useState<ReadonlyMap<number, string>>(() => new Map());
  const holdTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(holdTimer.current), []);
  // A row that folds away takes its mark with it, and the keyboard would land on the page body a second after the
  // key that ticked it. When that happens the toggle that now holds the row takes the focus instead.
  const listRef = useRef<HTMLDivElement | null>(null);
  const doneToggleRef = useRef<HTMLButtonElement | null>(null);
  const hadFocus = useRef(false);
  useEffect(() => {
    if (!hadFocus.current) return;
    hadFocus.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) doneToggleRef.current?.focus();
  }, [held]);
  const isHeld = ({ it, index }: (typeof shown)[number]) => it.done === true && held.get(index) === str(it.text);
  // `index` stays the saved position, which ticking and Ask address.
  const open = shown.filter((entry) => entry.it.done !== true || isHeld(entry));
  const finished = shown.filter((entry) => entry.it.done === true);
  const folded = finished.filter((entry) => !isHeld(entry));
  const [showDone, setShowDone] = useState(false);
  const doneListId = useId();
  const hasId = typeof block.id === 'string' && !!block.id;
  const toggle = ctx.toggleItem && hasId ? ctx.toggleItem : undefined;
  const ask = ctx.askItem && hasId ? ctx.askItem : undefined;
  const name = useCompanionName();
  const onToggle = (it: (typeof shown)[number]['it'], index: number) => {
    if (!toggle) return;
    if (it.done === true) {
      // Unticked again, in the hold or from the done ones: nothing left to hold.
      if (held.has(index)) setHeld((prev) => { const next = new Map(prev); next.delete(index); return next; });
    } else {
      setHeld((prev) => new Map(prev).set(index, str(it.text)));
      window.clearTimeout(holdTimer.current);
      holdTimer.current = window.setTimeout(() => {
        hadFocus.current = listRef.current?.contains(document.activeElement) === true;
        setHeld(new Map());
      }, TICKED_HOLD_MS);
    }
    toggle(block, index);
  };
  const row = ({ it, index }: (typeof shown)[number]) => {
    const checked = it.done === true;
    return (
      <li key={index} data-done={checked || undefined}>
        {toggle ? (
          <button
            type="button"
            className="michi-doc-check michi-doc-check--live"
            role="checkbox"
            aria-checked={checked}
            aria-label={str(it.text)}
            onClick={() => onToggle(it, index)}
          >
            {checked && <CheckIcon size="sm" />}
          </button>
        ) : (
          <span className="michi-doc-check" role="checkbox" aria-checked={checked} aria-readonly="true" aria-label={str(it.text)}>
            {checked && <CheckIcon size="sm" />}
          </span>
        )}
        {/* The words tick the item too, as a checkbox's label does; the mark stays the one focus stop. A drag
            that selects some of the words is a selection, not a tick. */}
        <span
          className="michi-doc-checklist__text"
          data-live={toggle ? 'true' : undefined}
          onClick={toggle ? () => { if (!window.getSelection()?.toString()) onToggle(it, index); } : undefined}
        >
          {str(it.text)}
        </span>
        {ask && (
          <button
            type="button"
            className="michi-doc-checklist__ask"
            aria-label={`Ask ${name} about “${str(it.text)}”`}
            title={`Ask ${name} about this item`}
            onClick={() => ask(block, index)}
          >
            <ChatIcon aria-hidden="true" />
          </button>
        )}
      </li>
    );
  };
  return (
    <div data-michi-block="checklist" ref={listRef}>
      <div className="michi-doc-block-head">
        <h3 className="michi-doc-block-title">{str(block.title).trim() || 'Checklist'}</h3>
        <span className="michi-doc-mono michi-doc-muted" style={{ fontSize: 'var(--fs-md)' }}>{finished.length}/{shown.length}</span>
      </div>
      {open.length > 0 && <ul className="michi-doc-checklist">{open.map(row)}</ul>}
      {folded.length > 0 && (
        <>
          <button
            type="button"
            ref={doneToggleRef}
            className="michi-doc-link-btn michi-doc-checklist__done-toggle"
            aria-expanded={showDone}
            aria-controls={doneListId}
            onClick={() => setShowDone(!showDone)}
          >
            <ChevronRightIcon aria-hidden="true" className="michi-doc-checklist__chevron" />
            {showDone ? 'Hide done' : `Show ${folded.length} done`}
          </button>
          {showDone && <ul id={doneListId} className="michi-doc-checklist">{folded.map(row)}</ul>}
        </>
      )}
    </div>
  );
}

/** Who acts on each step, the step, and what finishing it unblocks; a live page offers to start a conversation from a step. */
export function NextStepsBlock({ block, ctx }: BlockProps) {
  const items = objects(block.items).filter((it) => str(it.text).trim());
  const start = ctx.startConversation;
  return (
    <div data-michi-block="next-steps">
      <BlockTitle text={str(block.title)} />
      <ul className="michi-doc-steps">
        {items.map((it, i) => {
          const user = it.who === 'user';
          const unblocks = str(it.unblocks).trim();
          return (
            <li key={i} className="michi-doc-steps__item">
              <span className="michi-doc-steps__who" data-who={user ? 'user' : 'agent'}>{user ? 'You' : 'Agent'}</span>
              <span className="michi-doc-steps__what">
                {str(it.text)}
                {unblocks && <span className="michi-doc-steps__unblocks">Unblocks {unblocks}</span>}
              </span>
              {start && (
                <Button size="sm" className="michi-doc-steps__start" onClick={() => start(str(it.text))}>
                  <ChatIcon size="sm" aria-hidden="true" />Start a conversation
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
