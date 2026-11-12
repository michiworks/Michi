import type { ToolCallState } from '../../../state/chatTypes';
import { toolCommand, toolPath, toolPattern, toolRowDetail } from './toolInput';
import { toolKind } from './toolKind';

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanJsonValues(obj: unknown): unknown {
  if (typeof obj === 'string' && /<[a-z][\s\S]*>/i.test(obj)) {
    return stripHtml(obj);
  }
  if (Array.isArray(obj)) return obj.map(cleanJsonValues);
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = cleanJsonValues(v);
    }
    return out;
  }
  return obj;
}

/** Pretty-print a tool payload: JSON re-indented with HTML-bearing string
 *  values stripped to text; non-JSON passes through verbatim. */
export function formatToolPayload(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    const cleaned = cleanJsonValues(parsed);
    return JSON.stringify(cleaned, null, 2);
  } catch {
    return raw;
  }
}

/** What an opened call shows on its first line: its command, its pattern (and where), its file, else its detail. */
export interface PayloadSubject {
  kind: 'command' | 'pattern' | 'path' | 'detail';
  text: string;
  within?: string;
}

export function payloadSubject(tool: ToolCallState): PayloadSubject | undefined {
  const kind = toolKind(tool);
  if (kind === 'bash') {
    const command = toolCommand(tool);
    if (command) return { kind: 'command', text: command };
  } else if (kind === 'grep' || kind === 'glob') {
    const pattern = toolPattern(tool);
    const path = toolPath(tool);
    if (pattern) return { kind: 'pattern', text: pattern, ...(path ? { within: path } : {}) };
    if (path) return { kind: 'path', text: path };
  } else if (kind === 'read' || kind === 'edit' || kind === 'write') {
    const path = toolPath(tool) ?? toolRowDetail(tool);
    if (path) return { kind: 'path', text: path };
  }
  const detail = toolRowDetail(tool);
  return detail ? { kind: 'detail', text: detail } : undefined;
}
