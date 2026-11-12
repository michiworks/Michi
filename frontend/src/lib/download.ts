/** WebKit may read a blob URL only after the click, or after its download prompt. */
const REVOKE_AFTER_MS = 60_000;

/** Saves a blob as a file through an anchor in the page; false where there is no page to do it in. */
export function downloadBlob(blob: Blob, filename: string): boolean {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  return true;
}

export function downloadText(filename: string, text: string, type: string): boolean {
  return downloadBlob(new Blob([text], { type }), filename);
}
