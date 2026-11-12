import { importWorkspaceFile } from '../../services/api';

/** A paste at least this long becomes a .txt attachment instead of inline text. */
const PASTE_AS_FILE_THRESHOLD = 10_000;

/** The pasted text when the paste should become a .txt attachment: long plain text without files. */
export function longPastedText(dt: DataTransfer): string | null {
  const text = dt.getData('text/plain');
  if (!text || text.length < PASTE_AS_FILE_THRESHOLD) return null;
  if (Array.from(dt.items).some((item) => item.kind === 'file')) return null;
  return text;
}

/** Saves pasted text as .attachments/pasted-text-<time>.txt and returns it as a pending attachment. */
export async function savePastedText(workspaceId: string, cwd: string, text: string) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = `pasted-text-${ts}.txt`;
  const result = await importWorkspaceFile(workspaceId, cwd, fileName, text, { subdir: '.attachments' });
  const abs = result.filePath.startsWith('/')
    ? result.filePath
    : `${cwd.replace(/\/$/, '')}/${result.filePath}`;
  return { abs, displayName: fileName, relPath: result.filePath };
}
