import { joinAnd } from 'michi-shared';
import type { ToolCallState } from '../../../state/chatTypes';
import { michiToolName } from '../michiToolCopy';
import { NBSP, SAID_SEP, basename, capitalize, clip, lowerFirst } from './phraseText';
import { isDenied, isFailedStatus, isHiddenInternalTool, toolErrorLine } from './toolStatus';
import { toolCommand, toolPath, toolPattern } from './toolInput';
import { bareToolName } from './toolTitle';
import { toolDurationMs } from './toolDuration';
import { michiCopy, toolKind } from './toolKind';
import { commandPhrase, readablePattern } from './commandPhrase';
import { isPlumbing, mergeToolPhrases, repeatedCall, saysNothing, toolIntent, toolPhrase } from './toolPhrase';
import type { OutcomeIcon } from './toolEffect';
import { changesState, toolOutcomeIcon } from './toolEffect';
import { stepName } from './toolStep';

/* ══ Outcome-first copy (the 'line' agent-block chrome) ═════════════════════
   A run reads as one sentence: the LEAD says what came of it, the REST is the
   remaining record. Lead priority: an unrecovered failure › the last
   state-changing call › the first phrase. A step row names its call: the
   agent's words as written (Claude's Bash `description`, `__tool_use_purpose`),
   else Michi's fact in the base form ("Edit index.css"); how it ended is its
   icon and a fragment ("exit 1", "denied"), not grammar. A run's sentence says
   facts in the past where Michi knows them (structured tools, one simple
   command that changed or checked something) and the agent's words elsewhere,
   set apart with " · ". Agent text is never conjugated. A wrong guess only
   changes which call leads, never the data. */

/** One phrase of a run's sentence; `rank` orders what is dropped first when it doesn't fit. */
export interface OutcomePhrase {
  text: string;
  /** A shorter form for when this phrase is all that fits ("Ran 2 commands"). */
  short?: string;
  /** 0 what the run looked at · 1 what it verified · 2 what it changed. */
  rank: number;
  /** What joins it to the phrase before (", then ", "; "); a list of looks joins with commas and "and". */
  join?: string;
  /** The agent's own words: kept as written and set apart with " · ". */
  said?: true;
}

export interface ToolOutcome {
  lead: string;
  rest: string;
  /** 'error': `rest` is the unrecovered failure's first error line. */
  restKind: 'record' | 'error';
  icon: OutcomeIcon;
  leadTool?: ToolCallState;
  /** Visible failed calls, recovered or not; declined calls are counted apart. */
  failed: number;
  /** Failed calls no later call recovered. */
  unrecovered: number;
  /** Calls the user declined. */
  denied: number;
  /** The run ended on a declined call: `lead` names it. */
  endedDenied?: boolean;
  /** Settled runs without an unrecovered failure: `lead` is this sentence,
   *  `phrases` what it keeps (≤ SUMMARY_MAX_PHRASES), `dropped` how many it
   *  counts as "+N", `full` every phrase (for the accessible name). */
  sentence?: { phrases: OutcomePhrase[]; dropped: number; full: string };
}

/** A run's sentence names at most this many phrases; the rest count as "+N". */
export const SUMMARY_MAX_PHRASES = 4;

/**
 * Keeps at most `max` phrases in their order, dropping the lowest rank first
 * (the earliest of equals: early calls gather context, later ones verify):
 * reads and searches go before commands, state changes last.
 */
export function capPhrases<T extends { rank: number }>(phrases: readonly T[], max: number): { kept: T[]; dropped: number } {
  const kept = [...phrases];
  while (kept.length > Math.max(1, max)) {
    let victim = 0;
    for (let i = 1; i < kept.length; i++) if (kept[i].rank < kept[victim].rank) victim = i;
    kept.splice(victim, 1);
  }
  return { kept, dropped: phrases.length - kept.length };
}

/**
 * "Listed changed files, read 3 files, searched for x and merged origin/dev +2".
 * The last phrase joins with "and" unless a phrase already has one ("ran a and b").
 */
export function joinSentence(texts: readonly string[], dropped = 0): string {
  const parts = texts.map((t, i) => (i === 0 ? sentenceCase(t) : lowerFirst(t)));
  // One "and" per sentence: if a phrase already has one ("edited a and b"), commas only.
  const body = parts.length <= 1 || parts.some((p) => /\band\b/.test(p))
    ? parts.join(', ')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return dropped > 0 ? `${body}${NBSP}+${dropped}` : body;
}

/** Sentence case, except a phrase that opens with a file name keeps its spelling ("chatHub.test.ts passed"). */
function sentenceCase(text: string): string {
  return /^\S*[./]/.test(text) ? text : capitalize(text);
}

/** The phrases as one sentence, with their own joins when they carry them, then "+N".
 *  The agent's words keep their case and stand apart: "Read 3 files · Fast-forward dev". */
export function sentenceOf(phrases: readonly OutcomePhrase[], dropped = 0): string {
  if (!phrases.some((p, i) => p.said || (i > 0 && p.join))) return joinSentence(phrases.map((p) => p.text), dropped);
  const body = phrases.map((p, i) => {
    if (i === 0) return p.said ? p.text : sentenceCase(p.text);
    if (p.said || phrases[i - 1].said) return `${SAID_SEP}${p.said ? p.text : sentenceCase(p.text)}`;
    return `${p.join ?? ', '}${lowerFirst(p.text)}`;
  }).join('');
  return dropped > 0 ? `${body}${NBSP}+${dropped}` : body;
}

/* ── A run's sentence: what it looked at, then changed; how its checks went ── */

const count = (n: number, noun: string, plural = `${noun}s`) => `${n}${NBSP}${n === 1 ? noun : plural}`;

type CheckType = 'typecheck' | 'lint' | 'build' | 'tests' | 'e2e';
interface Check { type: CheckType; label: string; tool: ToolCallState }

/** A verification call: typecheck, lint or build (with its workspace), or a test run (with its file or spec). */
function checkOf(tool: ToolCallState): Check | null {
  if (toolKind(tool) !== 'bash') return null;
  const command = toolCommand(tool);
  const p = command ? commandPhrase(command) : null;
  if (!p) return null;
  for (const type of ['typecheck', 'lint', 'build'] as const) {
    if (p.verb === type) return { type, label: p.generic ? type : p.object, tool };
  }
  // commandPhrase says "run" only for test runners.
  if (p.verb === 'run') return { type: /E2E/.test(p.object) ? 'e2e' : 'tests', label: p.object, tool };
  return null;
}

/** `a | tail` exits with tail's status, so its checks are reported as run, not passed. */
const PIPED = /(?:^|[^|])\|(?!\|)/;

/** Checks named by type: "a.test.ts and b.test.ts", "frontend and backend typecheck", "3 test runs". */
function checkNames(checks: readonly Check[]): Array<{ name: string; piped: boolean }> {
  const byType = new Map<CheckType, { labels: string[]; piped: boolean }>();
  for (const c of checks) {
    const entry = byType.get(c.type) ?? { labels: [], piped: false };
    if (!entry.labels.includes(c.label)) entry.labels.push(c.label);
    entry.piped ||= PIPED.test(toolCommand(c.tool) ?? '');
    byType.set(c.type, entry);
  }
  return [...byType].map(([type, { labels, piped }]) => {
    if (type === 'tests' || type === 'e2e') {
      return { name: labels.length <= 2 ? joinAnd(labels) : count(labels.length, type === 'e2e' ? 'E2E spec' : 'test run'), piped };
    }
    const where = labels.filter((l) => l !== type);
    return { name: where.length > 1 ? `${joinAnd(where)} ${type}` : type, piped };
  });
}

/**
 * "Typecheck, lint and a.test.ts passed", "Send-scroll E2E failed, typecheck
 * passed", "Ran tests". `loud` holds failed calls no rerun recovered; a check
 * that later passed under another command counts as passed.
 */
function checksText(checks: readonly Check[], loud: ReadonlySet<string>): string {
  const good = checks.filter((c) => !loud.has(c.tool.id));
  const bad = checks.filter((c) => loud.has(c.tool.id) && !good.some((g) => g.type === c.type && g.label === c.label));
  const named = checkNames(good);
  const failed = checkNames(bad).map((n) => n.name);
  const passed = named.filter((n) => !n.piped).map((n) => n.name);
  const ran = named.filter((n) => n.piped).map((n) => n.name);
  // A failure a rerun recovered still counts as passed; the line's "1 failed, rerun passed" says the rest.
  const parts = [
    failed.length ? `${sentenceCase(joinAnd(failed))} failed` : '',
    passed.length ? `${sentenceCase(joinAnd(passed))} passed` : '',
    ran.length ? `Ran ${joinAnd(ran)}` : '',
  ].filter(Boolean);
  return parts.map((p, i) => (i ? lowerFirst(p) : p)).join(', ');
}

type LookKind = 'file' | 'search' | 'command' | 'agent' | 'tool';
interface Look { kind: LookKind; key: string; tool: ToolCallState }

/** What a call that changes nothing looked at. A shell call with an instruction is named by it. */
function lookOf(tool: ToolCallState): Look {
  const kind = toolKind(tool);
  if (kind === 'subagent') return { kind: 'agent', key: tool.id, tool };
  if (kind === 'read') { const path = toolPath(tool); return { kind: 'file', key: path ? basename(path) : 'a file', tool }; }
  if (kind === 'grep' || kind === 'glob') return { kind: 'search', key: clip(kind === 'grep' && toolPattern(tool) ? readablePattern(toolPattern(tool)!) : toolPattern(tool) ?? toolPath(tool) ?? tool.id, 48), tool };
  if (kind === 'bash') {
    if (!toolIntent(tool)) {
      const p = commandPhrase(toolCommand(tool) ?? '');
      if (p?.verb === 'read') return { kind: 'file', key: p.object, tool };
      if (p?.verb === 'search') return { kind: 'search', key: p.object.replace(/^for /, ''), tool };
    }
    return { kind: 'command', key: tool.id, tool };
  }
  return { kind: 'tool', key: michiToolName(tool.title) ?? bareToolName(tool.title), tool };
}

/** Distinct keys, most touched first (first seen among equals). */
function byUse(keys: readonly string[]): string[] {
  const uses = new Map<string, number>();
  for (const k of keys) uses.set(k, (uses.get(k) ?? 0) + 1);
  return [...uses.keys()].sort((a, b) => uses.get(b)! - uses.get(a)!);
}

type NamedPhrase = { text: string; short?: string; said?: true };

/** Identical phrases fold into one with a count: "Listed files 2 times", not "listed files and listed files". */
function collapse<T extends { text: string; said?: true }>(ps: T[]): T[] {
  const seen = new Map<string, { p: T; n: number }>();
  for (const p of ps) { const e = seen.get(p.text); if (e) e.n++; else seen.set(p.text, { p, n: 1 }); }
  return [...seen.values()].map(({ p, n }) => (n > 1 ? { ...p, text: `${p.text} ${n}${NBSP}times` } : p));
}

/** Named one by one up to three; more name the slowest (its instruction, else the last) and count the rest. */
function namedCalls(tools: readonly ToolCallState[], noun: string): NamedPhrase {
  const say = (t: ToolCallState) => toolPhrase(t);
  const short = `Ran ${count(tools.length, noun)}`;
  if (tools.length <= 3) {
    const ps = collapse(tools.map(say));
    const shortened = tools.length > 1 ? { short } : {};
    if (ps.some((p) => p.said)) return { text: ps.map((p) => p.text).join(SAID_SEP), said: true, ...shortened };
    return { text: joinAnd(ps.map((p, i) => (i ? lowerFirst(p.text) : p.text))), ...shortened };
  }
  const pool = tools.some((t) => toolIntent(t)) ? tools.filter((t) => toolIntent(t)) : tools;
  const slowest = say(pool.reduce((a, b) => ((toolDurationMs(b) ?? 0) >= (toolDurationMs(a) ?? 0) ? b : a)));
  const more = count(tools.length - 1, `more ${noun}`);
  return slowest.said ? { text: `${slowest.text}${SAID_SEP}${more}`, short, said: true } : { text: `${slowest.text} and ${more}`, short };
}

/**
 * Tools, most used first: Michi's each say what they did ("Read 3 threads"),
 * other tools are named under one "Used" ("Used InternalSearch 3 times and
 * read-webpage"); past three, the rest are counted.
 */
function toolCalls(byTool: ReadonlyArray<readonly ToolCallState[]>): NamedPhrase {
  const shown = byTool.slice(0, 3);
  const more = byTool.slice(3).reduce((n, calls) => n + calls.length, 0);
  const said: string[] = [];
  const ours: string[] = [];
  const others: string[] = [];
  for (const calls of shown) {
    if (michiCopy(calls[0])) { ours.push(calls.length === 1 ? toolPhrase(calls[0]).text : repeatedCall(calls)); continue; }
    const p = calls.length === 1 ? toolPhrase(calls[0]) : null;
    if (p?.said) { said.push(p.text); continue; }
    others.push(calls.length === 1 ? bareToolName(calls[0].title) : `${bareToolName(calls[0].title)} ${calls.length}${NBSP}times`);
  }
  const parts = [...ours, ...(others.length ? [`Used ${joinAnd(others)}`] : [])];
  const cased = parts.map((t, i) => (i ? lowerFirst(t) : t));
  const facts = !cased.length ? '' : more ? `${cased.join(', ')} and ${count(more, 'more tool call')}` : joinAnd(cased);
  if (said.length) return { text: [...said, ...(facts ? [facts] : [])].join(SAID_SEP), said: true };
  return { text: facts || `Used ${count(more, 'tool call')}` };
}

/** A run that only looked: files, searches, commands and tools, each named or counted, in the order they began. */
function lookPhrases(looks: readonly Look[]): OutcomePhrase[] {
  const out: Array<OutcomePhrase & { at: number }> = [];
  const of = (kind: LookKind) => looks.filter((l) => l.kind === kind);
  const add = (kind: LookKind, phrase: NamedPhrase | null) => {
    if (phrase) out.push({ ...phrase, rank: 0, at: looks.findIndex((l) => l.kind === kind) });
  };
  const files = byUse(of('file').map((l) => l.key));
  add('file', files.length === 0 ? null : files.length <= 3
    ? { text: `Read ${joinAnd(files)}`, ...(files.length > 1 ? { short: `Read ${count(files.length, 'file')}` } : {}) }
    : { text: `Read ${files[0]}, ${files[1]} and ${count(files.length - 2, 'more file')}`, short: `Read ${count(files.length, 'file')}` });
  const searches = byUse(of('search').map((l) => l.key));
  add('search', searches.length === 0 ? null : searches.length <= 3
    ? { text: `Searched for ${joinAnd(searches)}`, ...(searches.length > 1 ? { short: `Ran ${count(searches.length, 'search', 'searches')}` } : {}) }
    : { text: `Ran ${count(searches.length, 'search', 'searches')}` });
  const commands = of('command').map((l) => l.tool);
  add('command', commands.length ? namedCalls(commands, 'command') : null);
  const agents = of('agent').map((l) => l.tool);
  add('agent', agents.length ? namedCalls(agents, 'subagent') : null);
  const tools = of('tool');
  const names = byUse(tools.map((l) => l.key));
  const byName = (name: string) => tools.filter((l) => l.key === name).map((l) => l.tool);
  add('tool', tools.length === 0 ? null : toolCalls(names.map(byName)));
  return out.sort((a, b) => a.at - b.at).map(({ at: _at, ...p }) => p);
}

/** Looks beside changes or checks: their one phrase, or a tally ("Explored 3 files, 1 search and 1 command"). */
function lookTally(looks: readonly Look[]): NamedPhrase {
  const phrases = lookPhrases(looks);
  if (phrases.length === 1) return phrases[0];
  // Two lone calls are named ("Read a.ts and listed threads"), unless the agent's words would chop the sentence.
  if (phrases.length === 2 && looks.length <= 2 && !phrases.some((p) => p.said)) return { text: sentenceOf(phrases) };
  const distinct = (kind: LookKind) => new Set(looks.filter((l) => l.kind === kind).map((l) => l.key)).size;
  const parts = [
    distinct('file') && count(distinct('file'), 'file'),
    distinct('search') && count(distinct('search'), 'search', 'searches'),
    distinct('command') && count(distinct('command'), 'command'),
    distinct('agent') && count(distinct('agent'), 'subagent'),
    distinct('tool') && count(distinct('tool'), 'tool call'),
  ].filter((p): p is string => !!p);
  return { text: `Explored ${joinAnd(parts)}` };
}

/**
 * A run in three parts, each left out when empty: what it looked at, then what
 * it changed; how its checks went. "Searched for content-visibility, then
 * edited index.css and AgentLineBlocks.tsx; typecheck and AgentLineBlocks.test.tsx
 * passed". A run that only looked names what it looked at. Looks drop first
 * when the line is too narrow, changes last. A file read and then edited is
 * said once, by the edit. `loud` checks are said as failed.
 */
function runPhrases(visible: readonly ToolCallState[], loud: ReadonlySet<string>): OutcomePhrase[] {
  const changes = visible.filter(changesState);
  const checks = visible.flatMap((t) => (changesState(t) ? [] : [checkOf(t)].filter((c): c is Check => !!c)));
  const checked = new Set(checks.map((c) => c.tool.id));
  const edited = new Set(changes.flatMap((t) => { const p = toolPath(t); return p ? [basename(p)] : []; }));
  const looks = visible
    .filter((t) => !changesState(t) && !checked.has(t.id))
    .map(lookOf)
    .filter((l) => !(l.kind === 'file' && edited.has(l.key)));
  if (!changes.length && !checks.length) return lookPhrases(looks);
  const out: OutcomePhrase[] = [];
  if (looks.length) out.push({ ...lookTally(looks), rank: 0 });
  if (changes.length) {
    // Michi's phrases make one clause ("merged x and pushed dev"); the agent's words stand apart.
    let ours: ReturnType<typeof mergeToolPhrases> = [];
    const flush = () => {
      if (ours.length) out.push({ text: joinSentence(ours.map((p) => p.text)), ...(ours.length === 1 && ours[0].short ? { short: ours[0].short } : {}), rank: 2, join: ', then ' });
      ours = [];
    };
    for (const p of mergeToolPhrases(changes)) {
      if (!p.said) { ours.push(p); continue; }
      flush();
      out.push({ text: p.text, rank: 2, said: true });
    }
    flush();
  }
  if (checks.length) out.push({ text: checksText(checks, loud), rank: 1, join: '; ' });
  return out;
}

/**
 * A settled run of calls as one sentence: what it looked at, then changed;
 * how its checks went (runPhrases). A run that ended on an unrecovered
 * failure leads with it instead, its first error line as the rest. An earlier
 * one leaves the sentence to what the run did, and the line counts it
 * ("1 failed"). Hidden plumbing tools are skipped. `recovered` holds failed
 * call ids a later call recovered (findRecoveries over the whole turn).
 */
export function summarizeOutcome(
  tools: readonly ToolCallState[],
  recovered: ReadonlySet<string> | ReadonlyMap<string, string> = new Set(),
): ToolOutcome {
  const shown = tools.filter((t) => !isHiddenInternalTool(t.title));
  const visible = shown.some((t) => !isPlumbing(t)) ? shown.filter((t) => !isPlumbing(t)) : shown;
  const deniedTools = visible.filter((t) => isDenied(t) && !recovered.has(t.id));
  const failedTools = visible.filter((t) => isFailedStatus(t.status) && !deniedTools.includes(t));
  const loud = failedTools.filter((t) => !recovered.has(t.id));
  const counts = { failed: failedTools.length, unrecovered: loud.length, denied: deniedTools.length };
  if (visible.length === 0) return { lead: '', rest: '', restKind: 'record', icon: 'terminal', ...counts };
  const last = visible[visible.length - 1];
  if (loud.includes(last)) {
    return { lead: stepName(last).text, rest: toolErrorLine(last), restKind: 'error', icon: 'fail', leadTool: last, ...counts };
  }
  // A declined last call names what was asked: it did not run, and nothing failed.
  if (deniedTools.includes(last)) {
    return { lead: stepName(last).text, rest: '', restKind: 'record', icon: toolOutcomeIcon(last), leadTool: last, endedDenied: true, ...counts };
  }
  // A call that failed for good or was declined did nothing to say, except a failed
  // check ("Typecheck failed"); nor did one stopped before its input arrived.
  const silent = new Set([...loud, ...deniedTools].map((t) => t.id));
  const said = visible.filter((t) => (!silent.has(t.id) || (checkOf(t) && !deniedTools.includes(t))) && !saysNothing(t));
  if (said.length === 0) return { lead: stepName(last).text, rest: '', restKind: 'record', icon: toolOutcomeIcon(last), leadTool: last, ...counts };
  if (said.length === 1) {
    const only = said[0];
    const p = toolPhrase(only);
    return {
      lead: p.text, rest: '', restKind: 'record', icon: toolOutcomeIcon(only), leadTool: only,
      sentence: { phrases: [{ text: p.text, rank: 2, ...(p.said ? { said: true as const } : {}) }], dropped: 0, full: p.text }, ...counts,
    };
  }
  const phrases = runPhrases(said, new Set(loud.map((t) => t.id)));
  const { kept, dropped } = capPhrases(phrases, SUMMARY_MAX_PHRASES);
  // The icon names the most significant call: the last state change, else the first call.
  const iconTool = [...said].reverse().find(changesState) ?? said[0];
  return {
    lead: sentenceOf(kept, dropped),
    rest: '',
    restKind: 'record',
    icon: toolOutcomeIcon(iconTool),
    leadTool: iconTool,
    sentence: { phrases: kept, dropped, full: sentenceOf(phrases) },
    ...counts,
  };
}
