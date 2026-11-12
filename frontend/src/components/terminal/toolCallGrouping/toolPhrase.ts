import type { ToolCallState } from '../../../state/chatTypes';
import { michiToolName } from '../michiToolCopy';
import type { PhraseVerb } from './phraseText';
import { NBSP, SAID_SEP, VERB_PAST, basename, capitalize, clip, lowerFirst } from './phraseText';
import { inputField, toolCommand, toolPath, toolPattern, toolPurpose, toolRowDetail } from './toolInput';
import { bareToolName, toolDisplayTitle } from './toolTitle';
import { subagentToolInfo } from './subagentTools';
import type { PhraseKind } from './toolKind';
import { isTaskListCall, michiCopy, toolKind } from './toolKind';
import { commandHead, commandPhrase, isSimpleCommand, readablePattern } from './commandPhrase';

/** Verbs that only looked: a look says why in the agent's words, when it has them. */
const LOOK_VERBS = new Set<PhraseVerb>(['read', 'search', 'list', 'view', 'check', 'fetch', 'review']);

/** The agent's stated purpose: `__tool_use_purpose`, or a Bash call's `description`. */
export function toolIntent(tool: ToolCallState): string | undefined {
  const purpose = toolPurpose(tool);
  if (purpose) return purpose;
  return toolKind(tool) === 'bash' ? inputField(tool, ['description']) : undefined;
}

/** The agent's stated purpose as written: one line, without its closing period. */
export function intentText(tool: ToolCallState): string | null {
  const intent = toolIntent(tool)?.trim().replace(/\s+/g, ' ').replace(/[.。]$/, '');
  return intent || null;
}

/** One call as a phrase. Michi's phrases split into a past-tense verb and an
 *  object so phrases sharing a verb can merge; `said` marks the agent's own
 *  words, which are shown as written and never merged or recased. */
export interface ToolPhrase {
  kind: PhraseKind;
  verb: string;
  object: string;
  text: string;
  said?: true;
}

function phrase(kind: PhraseKind, verb: string, object: string): ToolPhrase {
  return { kind, verb, object, text: object ? `${verb} ${object}` : verb };
}

function saidPhrase(kind: PhraseKind, text: string): ToolPhrase {
  return { kind, verb: '', object: '', text: clip(text, 120), said: true };
}

/** A shell call whose input never arrived (cut off, or lost): there is nothing to say about it. */
export function saysNothing(tool: ToolCallState): boolean {
  return toolKind(tool) === 'bash' && !toolCommand(tool) && !toolIntent(tool);
}

/** Calls that only manage the agent's own work (loading tool schemas, its plan): left out of a run's sentence. */
export function isPlumbing(tool: ToolCallState): boolean {
  return tool.title === 'ToolSearch' || tool.title === 'TodoWrite' || isTaskListCall(tool);
}

export function objectOf(tool: ToolCallState, kind: PhraseKind): string {
  switch (kind) {
    case 'read':
    case 'edit':
    case 'write': {
      const path = toolPath(tool) ?? toolRowDetail(tool);
      return path ? basename(path) : 'a file';
    }
    case 'grep':
      // A regex alternation reads as its first alternative ("send-motion|data-send-motion").
      return clip(readablePattern(toolPattern(tool) ?? 'a pattern'), 48);
    case 'glob':
      return clip(toolPattern(tool) ?? toolPath(tool) ?? 'files', 48);
    case 'bash':
      return clip((toolCommand(tool) ?? toolDisplayTitle(tool)).split('\n')[0], 72);
    case 'subagent':
      return subagentToolInfo(tool)?.agentType?.split(':').pop() ?? 'a subagent';
    default:
      return bareToolName(tool.title) || 'a tool';
  }
}

const BUCKET_PAST: Record<PhraseKind, string> = {
  read: 'Read', edit: 'Edited', write: 'Created', grep: 'Searched for', glob: 'Listed', bash: 'Ran', subagent: 'Ran', unknown: 'Used',
};
export const BUCKET_BASE: Record<PhraseKind, string> = {
  read: 'read', edit: 'edit', write: 'create', grep: 'search for', glob: 'list', bash: 'run', subagent: 'run', unknown: 'use',
};
/** Counted forms for three or more objects of one verb. */
const BUCKET_COUNT: Record<PhraseKind, [verb: string, noun: string]> = {
  read: ['Read', 'files'], edit: ['Edited', 'files'], write: ['Created', 'files'], grep: ['Searched', 'patterns'],
  glob: ['Listed', 'paths'], bash: ['Ran', 'commands'], subagent: ['Ran', 'subagents'], unknown: ['Used', 'tools'],
};

/**
 * What a call did, for a run's sentence. Structured tools (files, searches,
 * Michi's tools) say their fact. A shell line says its fact only when it is one
 * simple command that changed or checked something; a look says why in the
 * agent's words, and a compound line (heredocs, chains, loops) would be a guess,
 * so the agent's words say it too. A step row names a call with stepName.
 */
export function toolPhrase(tool: ToolCallState): ToolPhrase {
  const kind = toolKind(tool);
  if (kind === 'subagent') return phrase(kind, BUCKET_PAST[kind], objectOf(tool, kind));
  const intent = intentText(tool);
  if (kind === 'bash') {
    const command = toolCommand(tool);
    const fromCommand = command ? commandPhrase(command) : null;
    const look = fromCommand && LOOK_VERBS.has(fromCommand.verb) && intent;
    const trusted = fromCommand && !fromCommand.generic && !look && command && isSimpleCommand(command);
    if (fromCommand && (trusted || !intent)) return phrase(kind, capitalize(VERB_PAST[fromCommand.verb]), fromCommand.object);
    if (intent) return saidPhrase(kind, intent);
    return phrase(kind, 'Ran', command ? commandHead(command) : 'a command');
  }
  if (kind === 'unknown') {
    // A tool Michi knows says what it did from its input: a fact, never a guess.
    const copy = michiCopy(tool);
    if (copy) return phrase(kind, capitalize(VERB_PAST[copy.verb]), copy.object);
    if (intent) return saidPhrase(kind, intent);
  }
  return phrase(kind, BUCKET_PAST[kind], objectOf(tool, kind));
}

/**
 * Phrases in first-seen order; one verb folds its objects: two are named
 * ("ran related unit tests and send-scroll E2E"), three or more counted
 * ("read 3 files"). Sentence case; the caller lowercases record phrases.
 * The agent's words are never merged or recased: up to two of a kind stand
 * as said, more are counted ("ran 5 commands").
 */
export function mergeToolPhrases(tools: readonly ToolCallState[]): Array<{ text: string; short?: string; said?: true; tools: ToolCallState[] }> {
  const groups: Array<{ key: string; kind: PhraseKind; verb: string; objects: string[]; said?: true; tools: ToolCallState[] }> = [];
  for (const tool of tools) {
    const p = toolPhrase(tool);
    const key = p.said ? `said:${p.text}` : `${p.kind}:${p.verb}`;
    let group = groups.find((g) => g.key === key);
    if (!group) groups.push((group = { key, kind: p.kind, verb: p.said ? p.text : p.verb, objects: [], ...(p.said ? { said: true as const } : {}), tools: [] }));
    if (!group.objects.includes(p.object)) group.objects.push(p.object);
    group.tools.push(tool);
  }
  const out: Array<{ text: string; short?: string; said?: true; tools: ToolCallState[] }> = [];
  // A counted form names only the kind ("Ran 3 commands"), so groups of one
  // kind that count fold into the first: "ran 7 commands", not "ran 3 … ran 4".
  const countedByKind = new Map<PhraseKind, { entry: { text: string; tools: ToolCallState[] }; n: number }>();
  const counted = (kind: PhraseKind, n: number) => `${BUCKET_COUNT[kind][0]} ${n}${NBSP}${BUCKET_COUNT[kind][1]}`;
  const addCounted = (kind: PhraseKind, n: number, tools: ToolCallState[]) => {
    const prev = countedByKind.get(kind);
    if (prev) {
      prev.n += n;
      prev.entry.text = counted(kind, prev.n);
      prev.entry.tools = [...prev.entry.tools, ...tools];
    } else {
      const entry = { text: counted(kind, n), tools };
      countedByKind.set(kind, { entry, n });
      out.push(entry);
    }
  };
  // The agent's words are named up to two of a kind; more are counted with the kind.
  const saidOfKind = (kind: PhraseKind) => groups.filter((g) => g.said && g.kind === kind).length;
  for (const g of groups) {
    if (g.said) {
      if (saidOfKind(g.kind) < 3) out.push({ text: g.verb, said: true, tools: g.tools });
      else addCounted(g.kind, 1, g.tools);
      continue;
    }
    const named = g.objects.filter(Boolean);
    // Repeats of one Michi tool on nothing specific count calls: "Edited 4 pages", not "edited a page".
    const sameTool = g.tools.length > 1 && michiCopy(g.tools[0])?.generic && g.tools.every((t) => michiToolName(t.title) === michiToolName(g.tools[0].title));
    if (sameTool) { out.push({ text: repeatedCall(g.tools), tools: g.tools }); continue; }
    if (named.length <= 1) {
      out.push({ text: named.length ? `${g.verb} ${named[0]}` : g.verb, tools: g.tools });
    } else if (named.length === 2) {
      // Two objects are named; `short` is the counted form for a line too narrow for both.
      out.push({ text: `${g.verb} ${named[0]} and ${named[1]}`, short: counted(g.kind, 2), tools: g.tools });
    } else {
      addCounted(g.kind, named.length, g.tools);
    }
  }
  return out;
}

/** "listed changed files, read 3 files · Fast-forward dev". */
export function toolRecord(tools: readonly ToolCallState[]): string {
  return mergeToolPhrases(tools)
    .map((p, i, all) => `${i === 0 ? '' : p.said || all[i - 1].said ? SAID_SEP : ', '}${p.said ? p.text : lowerFirst(p.text)}`)
    .join('');
}

/** Repeat calls of one tool: Michi's say what they did ("Read 3 threads"), others how often ("Used fetch 3 times"). */
export function repeatedCall(calls: readonly ToolCallState[]): string {
  const copy = michiCopy(calls[0]);
  if (!copy) return `Used ${bareToolName(calls[0].title)} ${calls.length}${NBSP}times`;
  const n = String(calls.length);
  const object = copy.many.includes('#') ? copy.many.replace('#', n) : `${n}${NBSP}${copy.many}`;
  return `${capitalize(VERB_PAST[copy.verb])} ${object}`;
}
