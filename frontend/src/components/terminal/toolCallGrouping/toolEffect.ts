import type { ToolCallState } from '../../../state/chatTypes';
import type { PhraseVerb } from './phraseText';
import { isFailedStatus, isTerminalStatus } from './toolStatus';
import { toolCommand, toolPath } from './toolInput';
import { subagentToolInfo } from './subagentTools';
import { michiCopy, toolKind } from './toolKind';
import { commandSegments, stripEnv } from './commandPhrase';

const GIT_PREFIX = String.raw`git\s+(?:(?:-C|-c|--git-dir|--work-tree)\s+\S+\s+|--no-pager\s+)*`;
const STATE_SEGMENT = new RegExp(
  String.raw`^(?:${GIT_PREFIX}(?:merge|push|commit|rebase|reset|cherry-pick|revert|am|stash|tag|branch\s+(?:-\w+\s+)*-[dDmM]|checkout\s+-[bB]|switch\s+-[cC])\b`
  + String.raw`|(?:rm|rmdir|mv|unlink)\s|(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci|add|uninstall|remove|rm|un|publish)\b)`,
);
const GIT_GLYPH = new RegExp(String.raw`^${GIT_PREFIX}(merge|push|commit)\b`);

/** True for calls that change state: edits/writes, and commits, pushes, merges, removals, installs. */
const MICHI_WRITES = new Set<PhraseVerb>(['save', 'update', 'edit', 'create', 'delete', 'send', 'start', 'configure', 'cancel']);

export function changesState(tool: ToolCallState): boolean {
  if (subagentToolInfo(tool)) return true;
  const copy = michiCopy(tool);
  if (copy) return MICHI_WRITES.has(copy.verb);
  const kind = toolKind(tool);
  if (kind === 'edit' || kind === 'write') return true;
  if (kind !== 'bash') return false;
  const command = toolCommand(tool);
  return !!command && commandSegments(command).some((s) => STATE_SEGMENT.test(s));
}

export type OutcomeIcon = 'terminal' | 'file' | 'search' | 'edit' | 'merge' | 'push' | 'commit' | 'agent' | 'fail' | 'sparkle';

/** The hanging icon for a call: git merge/push/commit get their own glyph, else its kind. */
export function toolOutcomeIcon(tool: ToolCallState): OutcomeIcon {
  const kind = toolKind(tool);
  if (kind === 'subagent') return 'agent';
  if (changesState(tool) && michiCopy(tool)) return 'edit';
  if (kind === 'bash') {
    const segments = commandSegments(toolCommand(tool) ?? '');
    for (let i = segments.length - 1; i >= 0; i--) {
      const m = GIT_GLYPH.exec(segments[i]);
      if (m) return m[1] as OutcomeIcon;
    }
    return 'terminal';
  }
  if (kind === 'read') return 'file';
  if (kind === 'grep' || kind === 'glob') return 'search';
  if (kind === 'edit' || kind === 'write') return 'edit';
  return 'terminal';
}

function recoveryKey(tool: ToolCallState): string | undefined {
  const kind = toolKind(tool);
  if (kind === 'bash') {
    const command = toolCommand(tool);
    return command ? `bash:${stripEnv(command).replace(/\s+/g, ' ').trim()}` : undefined;
  }
  const path = toolPath(tool);
  return path ? `${kind}:${path}` : undefined;
}

/**
 * Failed calls a later call recovered: same kind, the same command (leading
 * `ENV=…` assignments ignored) or file path, and it succeeded. Maps the failed
 * id to the recovering id. `tools` is a turn's calls in stream order.
 */
export function findRecoveries(tools: readonly ToolCallState[]): Map<string, string> {
  const out = new Map<string, string>();
  tools.forEach((failed, i) => {
    if (!isFailedStatus(failed.status)) return;
    const key = recoveryKey(failed);
    if (!key) return;
    const fix = tools.slice(i + 1).find((t) =>
      isTerminalStatus(t.status) && !isFailedStatus(t.status) && toolKind(t) === toolKind(failed) && recoveryKey(t) === key);
    if (fix) out.set(failed.id, fix.id);
  });
  return out;
}
