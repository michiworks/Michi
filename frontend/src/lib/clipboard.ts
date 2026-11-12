/**
 * Puts text on the clipboard and says whether it got there. A plain-http
 * origin other than localhost has no navigator.clipboard, and a denied
 * permission rejects the write; both are false here, never a throw.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
