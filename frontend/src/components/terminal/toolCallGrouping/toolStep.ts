import type { ToolCallState } from '../../../state/chatTypes';
import { editLineDelta } from '../../../lib/editLineDelta';
import { NBSP, capitalize, clip } from './phraseText';
import { isDenied, isFailedStatus, isRunningStatus, isStoppedStatus, toolErrorLine, toolExitCode } from './toolStatus';
import { parseDetailObject, toolCommand, toolPath, toolRowDetail } from './toolInput';
import { bareToolName } from './toolTitle';
import { michiCopy, toolKind } from './toolKind';
import { commandGist, commandHead, commandPhrase } from './commandPhrase';
import { BUCKET_BASE, intentText, objectOf } from './toolPhrase';

/** A step's name: the agent's words as written, else Michi's fact in the base form ("Edit index.css"). */
export function stepName(tool: ToolCallState): { text: string; said?: true } {
  const kind = toolKind(tool);
  const intent = kind === 'subagent' ? null : intentText(tool);
  if (intent) return { text: clip(intent, 120), said: true };
  if (kind === 'subagent') return { text: `Run ${objectOf(tool, kind)}` };
  if (kind === 'bash') {
    const command = toolCommand(tool);
    const p = command ? commandPhrase(command) : null;
    if (p) return { text: `${capitalize(p.verb)} ${p.object}` };
    return { text: `Run ${command ? commandHead(command) : 'a command'}` };
  }
  if (kind === 'unknown') {
    const copy = michiCopy(tool);
    return { text: copy ? `${capitalize(copy.verb)} ${copy.object}` : `Use ${bareToolName(tool.title)}` };
  }
  return { text: `${capitalize(BUCKET_BASE[kind])} ${objectOf(tool, kind)}` };
}

const shortPath = (p: string) => {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : p;
};

/** What a step touched, muted beside its name: a command's gist, a path (an edit with its lines), where a search ran. */
export function stepDetail(tool: ToolCallState): string | undefined {
  const kind = toolKind(tool);
  if (kind === 'bash') { const c = toolCommand(tool); return c ? commandGist(c) : undefined; }
  if (kind === 'edit' || kind === 'write') {
    const path = toolPath(tool);
    const { added: plus, removed: minus } = editLineDelta((parseDetailObject(tool.inputJson) ?? {}) as Record<string, unknown>) ?? { added: 0, removed: 0 };
    const delta = [plus ? `+${plus}` : '', minus ? `−${minus}` : ''].filter(Boolean).join(' ');
    return [delta, path && shortPath(path)].filter(Boolean).join(' · ') || undefined;
  }
  if (kind === 'read') { const p = toolPath(tool); return p ? shortPath(p) : undefined; }
  if (kind === 'grep' || kind === 'glob') { const p = toolPath(tool); return p ? `in ${shortPath(p)}` : undefined; }
  if (kind === 'subagent' || michiCopy(tool)) return undefined;
  return toolRowDetail(tool);
}

export interface StepView {
  lead: string;
  /** The muted rest: what the step touched, or the error line that replaced it. */
  rest?: string;
  restKind: 'cmd' | 'error';
  /**
   * How it ended when not plainly: "exit 1", "rerun passed", "denied", "stopped".
   * `srOnly`: a bare "failed" beside the error line that already says so is
   * read to screen readers (the × icon is hidden from them) but not shown.
   */
  frag: { tone: 'calm' | 'danger'; text: string; srOnly?: boolean } | null;
  /** A failure no rerun recovered: the row is marked failed. */
  loud: boolean;
}

/** A step row: its name (with an ellipsis while it runs), its detail or the error that replaced it, how it ended. */
export function stepView(tool: ToolCallState, recovered: boolean): StepView {
  const name = stepName(tool).text;
  const failed = isFailedStatus(tool.status);
  const denied = isDenied(tool) && !recovered;
  const loud = failed && !recovered && !denied;
  const code = failed ? toolExitCode(tool) : undefined;
  const error = loud ? toolErrorLine(tool) : '';
  return {
    lead: isRunningStatus(tool.status) ? `${name}…` : name,
    rest: error || stepDetail(tool),
    restKind: error ? 'error' : 'cmd',
    frag: isStoppedStatus(tool.status) ? { tone: 'calm', text: 'stopped' }
      : !failed ? null
        : recovered ? { tone: 'calm', text: 'rerun passed' }
          : denied ? { tone: 'calm', text: 'denied' }
            : code !== undefined ? { tone: 'danger', text: `exit${NBSP}${code}` }
              : { tone: 'danger', text: 'failed', ...(error ? { srOnly: true } : {}) },
    loud,
  };
}
