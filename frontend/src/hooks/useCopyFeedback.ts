import { useCallback, useEffect, useState } from 'react';
import { copyText } from '../lib/clipboard';

export type CopyResult = 'idle' | 'copied' | 'failed';

const FEEDBACK_MS = 1600;

/**
 * A copy button's result, shown for a moment: `status` is the words for an
 * sr-only role="status" so a screen reader hears it once.
 */
export function useCopyFeedback(): { result: CopyResult; status: string; copy: (text: string) => Promise<boolean> } {
  const [result, setResult] = useState<CopyResult>('idle');
  useEffect(() => {
    if (result === 'idle') return undefined;
    const id = window.setTimeout(() => setResult('idle'), FEEDBACK_MS);
    return () => window.clearTimeout(id);
  }, [result]);
  const copy = useCallback(async (text: string) => {
    const ok = await copyText(text);
    setResult(ok ? 'copied' : 'failed');
    return ok;
  }, []);
  const status = result === 'copied' ? 'Copied' : result === 'failed' ? 'Couldn’t copy. Select the text and copy it instead.' : '';
  return { result, status, copy };
}
