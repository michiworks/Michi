import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface AtomicWriteOptions {
  /** The file's permissions, 0o600 by default; 'preserve' keeps an existing file's (a new one gets the umask default). */
  mode?: number | 'preserve';
  /** Write where a symlink points; by default the link itself is replaced. */
  followSymlink?: boolean;
}

/**
 * Replace a file whole: readers see the old or the new content. The
 * temporary file is created next to the target, exclusively, and never
 * outlives the call. Errors are thrown.
 */
export function writeFileAtomicSync(file: string, data: string, options: AtomicWriteOptions = {}): void {
  let target = file;
  if (options.followSymlink) {
    try { target = fs.realpathSync(file); } catch { /* a new file */ }
  }
  let mode: number | undefined = options.mode === 'preserve' ? undefined : options.mode ?? 0o600;
  if (options.mode === 'preserve') {
    try { mode = fs.statSync(target).mode & 0o777; } catch { /* a new file */ }
  }
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, data, { flag: 'wx', ...(mode !== undefined ? { mode } : {}) });
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
