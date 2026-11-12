/**
 * What a permission card shows under its title. It takes the adapter's
 * canonical tool name (bash, edit, write); any other tool shows its input
 * as compact JSON, so an MCP tool's arguments are visible too. Long values
 * end in a visible "...".
 */
export function permissionDetail(canonicalTool: string, input: unknown): string | undefined {
  const args = asRecord(input);
  if (!args) return undefined;
  const lines = canonicalTool === 'bash' ? [
    permissionDetailLine('Description', firstString(args, ['description']), 180),
    permissionDetailLine('Command', firstString(args, ['command', 'cmd']), 600),
  ] : canonicalTool === 'edit' ? [
    permissionDetailLine('File', firstString(args, ['file_path', 'path', 'notebook_path']), 320),
    Array.isArray(args.edits) ? `Edits: ${args.edits.length}` : undefined,
  ] : canonicalTool === 'write' ? [
    permissionDetailLine('File', firstString(args, ['file_path', 'path']), 320),
    typeof args.content === 'string' ? `Content: ${args.content.length} chars` : undefined,
  ] : [Object.keys(args).length > 0 ? truncate(JSON.stringify(args), 600) : undefined];
  const shown = lines.filter((line): line is string => Boolean(line));
  return shown.length > 0 ? shown.join('\n') : undefined;
}

/** `Label: value` for a permission card's detail, or nothing without a value. */
export function permissionDetailLine(label: string, value: string | undefined, maxLength: number): string | undefined {
  return value ? `${label}: ${truncate(value, maxLength)}` : undefined;
}

/** The first of `keys` that holds non-blank text, trimmed. */
export function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
