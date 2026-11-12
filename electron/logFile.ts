/**
 * electron-main.log, written like backend.log. Electron main cannot load
 * shared/src/logFormat.ts at runtime, so formatLogLine mirrors it;
 * scripts/electron-log.test.mjs keeps the two equal.
 */
import * as fs from 'node:fs';

/** Same limit as backend.log: one rotation to <file>.1 keeps a runaway session off the disk. */
const MAX_BYTES = 5 * 1024 * 1024;

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

/** Appends a line, first renaming a file that reached `maxBytes` to <file>.1. */
export function appendLogLine(file: string, line: string, maxBytes = MAX_BYTES): void {
  try {
    if (fs.statSync(file).size >= maxBytes) fs.renameSync(file, `${file}.1`);
  } catch {
    // Not written yet.
  }
  try { fs.appendFileSync(file, line); } catch { /* best effort */ }
}
