/**
 * One line of backend.log or electron-main.log:
 *   2026-05-12T14:32:01.234Z INFO  acp        kiro-cli resolved path=… source=…
 * Electron main cannot load this package at runtime; electron/logFile.ts
 * mirrors it and scripts/electron-log.test.mjs keeps the two equal.
 */
export function formatLogLine(ts: string, level: string, stage: string, msg: string, meta?: Record<string, unknown>): string {
  return `${ts} ${level.padEnd(5, ' ')} ${stage.padEnd(10, ' ')} ${msg}${formatMeta(meta)}\n`;
}

function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined) continue;
    let s: string;
    if (typeof v === 'string') {
      // Avoid line breaks in serialized values.
      s = v.includes(' ') || v.includes('=') ? JSON.stringify(v) : v;
    } else if (v instanceof Error) {
      s = JSON.stringify(`${v.message}`);
    } else {
      try { s = JSON.stringify(v); } catch { s = String(v); }
    }
    parts.push(`${k}=${s}`);
  }
  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}
