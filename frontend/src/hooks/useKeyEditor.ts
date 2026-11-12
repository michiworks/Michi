import { useState } from 'react';
import type { VerifyProviderKeyResult } from '../services/api';

type KeyRequestResult = { ok: true } | { ok: false; error: string };

function errorMessage(err: unknown, fallback: string): string {
  return (err as { message?: string } | null | undefined)?.message ?? fallback;
}

/**
 * Draft, busy and error state of one API-key editor (Profile, Settings ›
 * Model, web search). A request that fails or throws always frees its busy
 * flag and shows a message, so an editor never sticks on "saving…".
 */
export function useKeyEditor({
  save,
  clear,
  verify,
  onChanged,
}: {
  save: (key: string) => Promise<KeyRequestResult>;
  clear: () => Promise<KeyRequestResult>;
  /** Checks the typed key, or the saved one when the draft is empty. */
  verify?: (key: string | undefined) => Promise<VerifyProviderKeyResult>;
  /** Reloads status after a saved key, and after any clear. */
  onChanged: () => void;
}) {
  const [draft, setDraftValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<VerifyProviderKeyResult | null>(null);

  const setDraft = (value: string) => {
    setDraftValue(value);
    setError(null);
    setVerifyResult(null);
  };

  /** Resolves true when the key was saved. */
  const saveDraft = async (): Promise<boolean> => {
    const key = draft.trim();
    if (!key || saving) return false;
    setSaving(true);
    setError(null);
    try {
      const result = await save(key);
      if (!result.ok) {
        setError(result.error);
        return false;
      }
      setDraftValue('');
      setVerifyResult(null);
      onChanged();
      return true;
    } catch (err) {
      setError(errorMessage(err, 'Unable to save API key'));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const clearKey = async () => {
    setClearing(true);
    setError(null);
    setVerifyResult(null);
    try {
      const result = await clear();
      if (!result.ok) setError(result.error);
    } catch (err) {
      setError(errorMessage(err, 'Unable to clear API key'));
    } finally {
      setClearing(false);
    }
    // A clear that failed on the way back may still have removed the key.
    onChanged();
  };

  const verifyKey = async () => {
    if (!verify || verifying) return;
    setVerifying(true);
    setError(null);
    setVerifyResult(null);
    try {
      setVerifyResult(await verify(draft.trim() || undefined));
    } catch (err) {
      setVerifyResult({ ok: false, error: errorMessage(err, 'Unable to verify API key') });
    } finally {
      setVerifying(false);
    }
  };

  return {
    draft,
    setDraft,
    saving,
    clearing,
    verifying,
    error,
    verifyResult,
    save: saveDraft,
    clear: clearKey,
    verify: verifyKey,
    reset: () => setDraft(''),
  };
}
