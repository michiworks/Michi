import { CHAT_STREAM_EVENTS, isTurnMetadataToolTitle, type ChatStreamEvent } from 'michi-shared';
import { omitInlineImagesInText } from 'michi-runtime/internal/contract/toolPayload';

/**
 * Tool outputs and inputs as HTTP responses and SSE frames carry them to a window.
 *
 * Stored rows and in-process events keep the whole call: agent tools,
 * backups, export and the server's own subscribers read those. Only the wire
 * copy is projected. Inline image data becomes a placeholder, and a long
 * output becomes its head and tail around an in-band marker line, except for
 * the tools whose output the frontend parses. An input stays valid JSON: its
 * long string values become head and tail, except where the frontend needs
 * the whole input (see PARSED_INPUT_TOOLS).
 */

/** Outputs longer than this travel as head + marker + tail. */
export const TOOL_OUTPUT_TRANSPORT_LIMIT = 2560;
const HEAD_CHARS = 1024;
const TAIL_CHARS = 1024;
/** A newline this close to a cut moves the cut there. */
const NEWLINE_SLACK = 256;

/**
 * Tools whose output a frontend parser reads (page and task receipts, Meta
 * chat cards and lines, scheduled-job receipts, the multi-model plan card,
 * the agent's own tool lines in state/companion/companionToolLines.ts):
 * they pass through whole.
 * The names the frontend gives normalizeTurnToolName, toolMatch and michiToolNamed;
 * test/toolOutputTransport.test.ts fails when a parser names one missing here.
 */
export const PARSED_OUTPUT_TOOLS: ReadonlySet<string> = new Set([
  'read_home', 'edit_home', 'list_pages', 'read_page', 'preview_page', 'edit_page', 'create_page', 'create_database', 'configure_database', 'read_database',
  'edit_database', 'configure_database_view', 'open_task_database', 'list_tasks',
  'list_page_components', 'read_page_component', 'save_page_component', 'layout_rules',
  'read_conversation_updates', 'start_conversation', 'list_workspaces', 'list_threads', 'search_messages',
  'read_node', 'read_node_overview', 'list_panes', 'inspect_pane', 'read_pane_output', 'wait_pane',
  'michi_docs',
  'list_scheduled_jobs', 'create_scheduled_job', 'update_scheduled_job', 'run_scheduled_job', 'delete_scheduled_job',
  'propose_multi_model_plan',
  'companion_items', 'companion_item', 'companion_check_now', 'companion_update_item', 'companion_save_notes',
  'companion_goal_progress', 'companion_propose', 'companion_set_name',
  'companion_set_notifications', 'companion_cr_detail', 'companion_pipeline_detail', 'companion_email_search', 'companion_headline', 'nothing_to_do',
  'memory_save', 'memory_update', 'memory_delete',
]);

/**
 * Crew calls every Michi tool through this wrapper, with `{tool, arguments}`
 * as its input; the frontend unwraps it (lib/turnPageReceipt.ts
 * michiToolCall). Its output passes whole only when the wrapped tool is one
 * of the parsed tools, or when the input does not name it.
 */
export const WRAPPER_TOOLS: ReadonlySet<string> = new Set(['michi_call_tool']);

/** What may precede a tool's name in a title: `@michi/name`, `server.name`, `server:name`, `mcp__server__name`. */
export const TOOL_NAME_SEPARATORS: readonly string[] = ['/', '.', ':', '__'];

function titleNames(title: unknown, names: ReadonlySet<string>): boolean {
  if (typeof title !== 'string') return false;
  const normalized = title.trim().toLowerCase();
  if (!normalized) return false;
  for (const name of names) {
    if (normalized === name || TOOL_NAME_SEPARATORS.some((separator) => normalized.endsWith(separator + name))) return true;
  }
  return false;
}

/** Whether a stored or streamed title names one of those tools, by the frontend's rule (lib/turnPageReceipt.ts toolMatch). */
export function isParsedOutputTool(title: unknown): boolean {
  return titleNames(title, PARSED_OUTPUT_TOOLS);
}

/**
 * The tool a wrapper call's input names, if any. A capped input is invalid
 * JSON, so the "tool" key is read as the frontend does.
 */
function wrappedToolName(inputJson: unknown): string | undefined {
  if (typeof inputJson !== 'string' || !inputJson) return undefined;
  let name: unknown;
  try {
    const parsed = JSON.parse(inputJson) as unknown;
    name = parsed && typeof parsed === 'object' ? (parsed as { tool?: unknown }).tool : undefined;
  } catch {
    name = /"tool"\s*:\s*"([a-z_]+)"/.exec(inputJson)?.[1];
  }
  return typeof name === 'string' && name.trim() ? name : undefined;
}

/**
 * Whether a wrapper call's output passes whole: its input names a parsed
 * tool, or names none (the frontend then matches the wrapper itself).
 */
function wrappedOutputParsed(inputJson: unknown): boolean {
  const name = wrappedToolName(inputJson);
  return name === undefined || isParsedOutputTool(name);
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** The first and last ~1 KB of a long output around `… [N chars omitted] …`, cut at a nearby newline when there is one. */
export function headTailOutput(output: string): string {
  if (output.length <= TOOL_OUTPUT_TRANSPORT_LIMIT) return output;
  let headEnd = HEAD_CHARS;
  const headBreak = output.lastIndexOf('\n', HEAD_CHARS);
  // The marker line starts and ends with a newline, which stands in for the one at each cut.
  if (headBreak >= HEAD_CHARS - NEWLINE_SLACK) headEnd = headBreak;
  let tailStart = output.length - TAIL_CHARS;
  const tailBreak = output.indexOf('\n', tailStart);
  if (tailBreak !== -1 && tailBreak < tailStart + NEWLINE_SLACK) tailStart = tailBreak + 1;
  if (isHighSurrogate(output.charCodeAt(headEnd - 1))) headEnd--;
  if (isLowSurrogate(output.charCodeAt(tailStart))) tailStart++;
  return `${output.slice(0, headEnd)}\n… [${tailStart - headEnd} chars omitted] …\n${output.slice(tailStart)}`;
}

/** Whether a call stored or streamed under `titles`, with this input, keeps its whole output. */
function passesWhole(titles: readonly unknown[], inputJson: unknown): boolean {
  if (titles.some(isParsedOutputTool)) return true;
  return titles.some((title) => titleNames(title, WRAPPER_TOOLS)) && wrappedOutputParsed(inputJson);
}

/** One tool output as the wire carries it; `titles` are the names it was stored or streamed under. */
export function projectToolOutput(output: string, titles: readonly unknown[], inputJson?: unknown): string {
  const withoutImages = omitInlineImagesInText(output);
  if (withoutImages.length <= TOOL_OUTPUT_TRANSPORT_LIMIT || passesWhole(titles, inputJson)) return withoutImages;
  return headTailOutput(withoutImages);
}

/**
 * Tools whose whole input a frontend parser reads, by the toolMatch rule: the
 * parsed-output tools (Meta chat lines read their inputs, state/metaChat/
 * toolLines.ts) and file edits under their tool names. Every file write or
 * edit counts too, named by FILE_MUTATION_WORDS. test/toolOutputTransport.test.ts
 * fails when a parser names a tool missing here.
 */
export const PARSED_INPUT_TOOLS: ReadonlySet<string> = new Set([...PARSED_OUTPUT_TOOLS, 'multiedit', 'notebookedit']);

/**
 * A title's first word or a kind that makes a call a file write or edit, by
 * the frontend's rules (lib/turnDiffReceipt.ts mutationKind; toolCallGrouping
 * toolBucketKey): their diff receipts and step lines count the lines of the
 * written content and the old and new strings.
 */
export const FILE_MUTATION_WORDS: ReadonlySet<string> = new Set(['write', 'writing', 'edit', 'editing']);

/**
 * Input keys whose values travel whole in any tool: a shell command, which a
 * window shows and copies as typed (toolCallGrouping toolCommand), and the raw
 * input a runtime could not parse, which the window parses itself.
 */
export const WHOLE_INPUT_KEYS: ReadonlySet<string> = new Set(['command', 'cmd', '__unparsedToolInput']);

/** Whether a stored or streamed call's title or kind names a tool whose whole input the frontend reads. */
export function isParsedInputTool(title: unknown, kind?: unknown): boolean {
  if (typeof kind === 'string' && FILE_MUTATION_WORDS.has(kind.trim().toLowerCase())) return true;
  if (typeof title !== 'string') return false;
  const normalized = title.trim().toLowerCase();
  if (!normalized) return false;
  if (FILE_MUTATION_WORDS.has(normalized.split(/\s+/)[0])) return true;
  for (const name of PARSED_INPUT_TOOLS) {
    if (normalized === name || TOOL_NAME_SEPARATORS.some((separator) => normalized.endsWith(separator + name))) return true;
  }
  return false;
}

/**
 * Whether a wrapper call's input passes whole: the frontend unwraps its
 * arguments as the input of the tool it names (lib/turnPageReceipt.ts
 * michiToolCall), so it does for a tool whose whole input a parser reads, or
 * when it names none.
 */
function wrappedInputParsed(inputJson: unknown): boolean {
  const name = wrappedToolName(inputJson);
  return name === undefined || isParsedInputTool(name);
}

/**
 * One tool input (a JSON text) as the wire carries it: long string values as
 * head + marker + tail, so it stays valid JSON with its keys and structure.
 * Invalid JSON and the inputs of parsed tools pass whole, as does a wrapper's
 * input when it wraps one of them or names none.
 */
export function projectToolInput(inputJson: string, titles: readonly unknown[], kind?: unknown): string {
  if (inputJson.length <= TOOL_OUTPUT_TRANSPORT_LIMIT) return inputJson;
  if (isParsedInputTool(undefined, kind) || titles.some((title) => isParsedInputTool(title))) return inputJson;
  if (titles.some((title) => titleNames(title, WRAPPER_TOOLS)) && wrappedInputParsed(inputJson)) return inputJson;
  let input: unknown;
  try {
    input = JSON.parse(inputJson);
  } catch {
    return inputJson;
  }
  let changed = false;
  const project = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (value.length <= TOOL_OUTPUT_TRANSPORT_LIMIT) return value;
      changed = true;
      return headTailOutput(value);
    }
    if (Array.isArray(value)) return value.map(project);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, WHOLE_INPUT_KEYS.has(key) ? item : project(item)]));
  };
  const projected = project(input);
  return changed ? JSON.stringify(projected) : inputJson;
}

function projectToolCall(call: unknown): unknown {
  if (!call || typeof call !== 'object') return call;
  const { output, inputJson, title, toolName, kind } = call as {
    output?: unknown; inputJson?: unknown; title?: unknown; toolName?: unknown; kind?: unknown;
  };
  // A wrapper's output is judged by the whole input, before the input is projected.
  const projectedOutput = typeof output === 'string' ? projectToolOutput(output, [title, toolName], inputJson) : output;
  const projectedInput = typeof inputJson === 'string' ? projectToolInput(inputJson, [title, toolName], kind) : inputJson;
  if (projectedOutput === output && projectedInput === inputJson) return call;
  return {
    ...call,
    ...(projectedOutput !== output ? { output: projectedOutput } : {}),
    ...(projectedInput !== inputJson ? { inputJson: projectedInput } : {}),
  };
}

/** A message row's encoded tool_calls, projected; still an encoded JSON string. */
function projectToolCallsJson(encoded: string): string {
  // No output in a shorter row can need projecting, and an inline image is longer.
  if (encoded.length <= TOOL_OUTPUT_TRANSPORT_LIMIT) return encoded;
  let calls: unknown;
  try {
    calls = JSON.parse(encoded);
  } catch {
    return encoded;
  }
  if (!Array.isArray(calls)) return encoded;
  let changed = false;
  const projected = calls.map((call) => {
    const next = projectToolCall(call);
    if (next !== call) changed = true;
    return next;
  });
  return changed ? JSON.stringify(projected) : encoded;
}

/** One message row for a response body: a copy where a tool output changes, the stored row untouched. */
export function projectMessageRowForTransport<T extends { tool_calls?: string | null }>(row: T): T {
  if (typeof row.tool_calls !== 'string') return row;
  const tool_calls = projectToolCallsJson(row.tool_calls);
  return tool_calls === row.tool_calls ? row : { ...row, tool_calls };
}

/** Message rows for a response body: copies where a tool output changes, the stored rows untouched. */
export function projectMessageRowsForTransport<T extends { tool_calls?: string | null }>(rows: readonly T[]): T[] {
  return rows.map(projectMessageRowForTransport);
}

/*
 * Display pages (`toolCalls=lean`) leave the body of a finished call on the
 * server: what its rows, group lines and the turn's "Worked for…" line do not
 * read. GET …/tool-calls brings it when one of them opens.
 */

/** An output this short travels whole; so does an input this short. */
const LEAN_OUTPUT_CHARS = 200;
const LEAN_INPUT_CHARS = 160;
/**
 * A detail this short that is not JSON travels whole: it is the agent's stated
 * purpose, which a step row shows. A JSON detail repeats the input or holds a
 * result.
 */
const LEAN_DETAIL_CHARS = 160;
/** What a deferred input keeps of each string value: a command or raw input, a path or pattern, anything else. */
const LEAN_COMMAND_CHARS = 300;
const LEAN_SUBJECT_CHARS = 200;
const LEAN_VALUE_CHARS = 80;
/** The keys a row's summary reads (toolCallGrouping toolInput.ts toolPath, toolPattern, toolCommand). */
const LEAN_SUBJECT_KEYS: ReadonlySet<string> = new Set(['file_path', 'filePath', 'path', 'notebook_path', 'pattern', 'query', 'glob', 'url']);
const LEAN_RUNNING = new Set(['running', 'in_progress', 'pending']);
const LEAN_FAILED = new Set(['error', 'failed']);
/** The frontend's exit line (toolCallGrouping/toolStatus.ts EXIT_LINE): a row shows "exit 1" from it. */
const EXIT_LINE = /^\s*(?:exit(?:ed with)? code|exit status)[:\s]+(-?\d+)\b.*$/i;
const SUBAGENT_TITLES = new Set(['agent', 'task', 'subagent']);
const SUBAGENT_TYPE_KEY = /"(?:subagent_type|subagentType|agent_type|agentType)"\s*:/;

function clipText(value: string, chars: number): string {
  if (value.length <= chars) return value;
  const end = isHighSurrogate(value.charCodeAt(chars - 1)) ? chars - 1 : chars;
  return `${value.slice(0, end)}…`;
}

/** A long input with each string value clipped, keys and structure kept; still valid JSON when it was. */
function leanToolInput(inputJson: string): string {
  if (inputJson.length <= LEAN_INPUT_CHARS) return inputJson;
  let input: unknown;
  try {
    input = JSON.parse(inputJson);
  } catch {
    return clipText(inputJson, LEAN_COMMAND_CHARS);
  }
  const clip = (value: unknown, chars: number): unknown => {
    if (typeof value === 'string') return clipText(value, chars);
    if (Array.isArray(value)) return value.map((item) => clip(item, chars));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clip(item,
      WHOLE_INPUT_KEYS.has(key) ? LEAN_COMMAND_CHARS : LEAN_SUBJECT_KEYS.has(key) ? LEAN_SUBJECT_CHARS : LEAN_VALUE_CHARS)]));
  };
  const lean = JSON.stringify(clip(input, LEAN_VALUE_CHARS));
  return lean.length < inputJson.length ? lean : inputJson;
}

/**
 * A call as a display page carries it. Kept whole: a call still running, a
 * failed one (its error line and exit code come from its output), and every
 * call a frontend parser reads (cards, receipts, file edits, wrappers,
 * delegations, Michi's turn metadata). Any other call keeps what its collapsed
 * rows read (title, kind, status, times, a short purpose, the input's keys
 * with short values, an exit line) and says what it left out (`deferred`;
 * `hasOutput` when that includes an output).
 */
export function deferToolCallBody(call: unknown): unknown {
  if (!call || typeof call !== 'object') return call;
  const c = call as Record<string, unknown>;
  const status = typeof c.status === 'string' ? c.status : '';
  if (!status || LEAN_RUNNING.has(status) || LEAN_FAILED.has(status)) return call;
  const titles = [c.title, c.toolName];
  if (passesWhole(titles, c.inputJson)
    || isParsedInputTool(undefined, c.kind) || titles.some((title) => isParsedInputTool(title))
    || titles.some((title) => titleNames(title, WRAPPER_TOOLS))) return call;
  const title = typeof c.title === 'string' ? c.title : '';
  if (isTurnMetadataToolTitle(title) || SUBAGENT_TITLES.has(title.trim().toLowerCase()) || c.kind === 'subagent'
    || [c.detail, c.inputJson].some((text) => typeof text === 'string' && SUBAGENT_TYPE_KEY.test(text))) return call;

  const output = typeof c.output === 'string' ? c.output : undefined;
  const dropOutput = output !== undefined && output.length > LEAN_OUTPUT_CHARS;
  const hasInput = typeof c.inputJson === 'string' && c.inputJson.trim() !== '';
  const inputJson = hasInput ? leanToolInput(c.inputJson as string) : c.inputJson;
  let detail = c.detail;
  if (typeof detail === 'string') {
    const json = /^\s*[[{]/.test(detail);
    // Without an input, a JSON detail is the input the rows read.
    if (json && !hasInput) detail = leanToolInput(detail);
    else if (json || detail.length > LEAN_DETAIL_CHARS) detail = undefined;
  }
  if (!dropOutput && inputJson === c.inputJson && detail === c.detail) return call;
  const { output: _output, detail: _detail, ...rest } = c;
  const exitLine = dropOutput ? output!.split('\n').slice(0, 8).find((line) => EXIT_LINE.test(line)) : undefined;
  return {
    ...rest,
    ...(dropOutput ? (exitLine ? { output: exitLine } : {}) : output !== undefined ? { output } : {}),
    ...(inputJson !== undefined ? { inputJson } : {}),
    ...(detail !== undefined ? { detail } : {}),
    deferred: true,
    ...(dropOutput ? { hasOutput: true } : {}),
  };
}

/**
 * A message row for a display page: the transport projection, and in a
 * finished turn's assistant message each call's body left on the server
 * (deferToolCallBody). `active`: the assistant message of a turn still
 * running, which a replay continues; it travels as the transport carries it.
 */
export function projectMessageRowForDisplay<T extends { role?: string; tool_calls?: string | null }>(row: T,
  context: { active: boolean }): T {
  const projected = projectMessageRowForTransport(row);
  if (context.active || projected.role !== 'assistant' || typeof projected.tool_calls !== 'string') return projected;
  let calls: unknown;
  try {
    calls = JSON.parse(projected.tool_calls);
  } catch {
    return projected;
  }
  if (!Array.isArray(calls)) return projected;
  let changed = false;
  const lean = calls.map((call) => {
    const next = deferToolCallBody(call);
    if (next !== call) changed = true;
    return next;
  });
  return changed ? { ...projected, tool_calls: JSON.stringify(lean) } : projected;
}

/** A workspace snapshot (or a tree's messages) for a response body. */
export function projectMessagesForTransport<T extends { messages: Array<{ tool_calls?: string | null }> }>(data: T): T {
  const messages = projectMessageRowsForTransport(data.messages);
  return messages.every((row, i) => row === data.messages[i]) ? data : { ...data, messages };
}

const MAX_TRACKED_CALLS = 4096;

/**
 * Projects the tool frames one SSE response writes; one per response. Claude
 * names a tool on tool_call and sends its output on an untitled
 * tool_call_update, so the projector remembers each call's title. A call
 * whose title this stream never saw (a replay that starts mid-turn) keeps
 * its whole output and input: the window may parse them. A wrapper call's
 * input (a snapshot, on the call or a later update) is remembered with it.
 */
export function createToolOutputStreamProjector(): (event: ChatStreamEvent) => ChatStreamEvent {
  /**
   * parsed: a title named a parsed tool; parsedInput: a title or kind named a
   * tool whose whole input the window reads; wrapper: a title named a wrapper;
   * wrapped: its last input's verdict.
   */
  const calls = new Map<string, { parsed: boolean; parsedInput: boolean; wrapper: boolean; wrapped?: boolean }>();
  return (event) => {
    if (event.event !== CHAT_STREAM_EVENTS.toolCall && event.event !== CHAT_STREAM_EVENTS.toolCallUpdate) return event;
    const data = event.data;
    const key = `${data.chatId ?? ''}\0${data.toolCallId}`;
    const previous = calls.get(key);
    // An untitled update of a known call can bring its input, or a kind that makes it a file write or edit.
    if (data.title || (previous && (data.inputJson || isParsedInputTool(undefined, data.kind)))) {
      const call = {
        parsed: previous?.parsed === true || isParsedOutputTool(data.title),
        parsedInput: previous?.parsedInput === true || isParsedInputTool(data.title, data.kind),
        wrapper: previous?.wrapper === true || titleNames(data.title, WRAPPER_TOOLS),
        wrapped: data.inputJson ? wrappedOutputParsed(data.inputJson) : previous?.wrapped,
      };
      calls.delete(key);
      calls.set(key, call);
      if (calls.size > MAX_TRACKED_CALLS) calls.delete(calls.keys().next().value!);
    }
    const call = calls.get(key);
    let next = data;
    if (typeof data.output === 'string' && data.output) {
      const whole = !call || call.parsed || (call.wrapper && call.wrapped !== false);
      const output = whole ? omitInlineImagesInText(data.output) : projectToolOutput(data.output, []);
      if (output !== data.output) next = { ...next, output };
    }
    if (typeof data.inputJson === 'string' && call && !call.parsedInput && !(call.wrapper && wrappedInputParsed(data.inputJson))) {
      const inputJson = projectToolInput(data.inputJson, [], data.kind);
      if (inputJson !== data.inputJson) next = { ...next, inputJson };
    }
    return next === data ? event : { ...event, data: next };
  };
}
