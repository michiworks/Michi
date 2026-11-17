// Native adapter. No Desk service, project identity or global assistant routing.
import { useCallback, useEffect, useRef, useState } from 'react';
import { blockSubmissionSignature } from 'michi-shared';
import type { PageBlockWithSources } from '../../../../../shared/desk-blocks';
import type { BlockCtx } from '../../types';
export const LOCK_MS = 2000;
export function useBlockSend(block: PageBlockWithSources, ctx: BlockCtx) {
  const [locked, setLocked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; clearTimeout(timer.current); }; }, []);
  const request = ctx.requestAssistant;
  const record = ctx.recordSubmission;
  const send = ctx.sendsAlways === true || block.type === 'poll' || block.type === 'choice';
  const fire = useCallback((prompt: string, title: string) => {
    if (busy.current || !request) return false;
    busy.current = true;
    if (!request(block, prompt, title, send)) { busy.current = false; return false; }
    setLocked(true);
    timer.current = setTimeout(() => { busy.current = false; setLocked(false); }, LOCK_MS);
    return true;
  }, [block, request, send]);
  const signature = blockSubmissionSignature(block as unknown as Record<string, unknown>);
  // What was submitted for this content; the block then shows it read-only and cannot be sent again.
  const submission = ctx.submissionFor?.(block);
  /**
   * Sends `prompt` as `fire` does, first storing `value` (what the block shows
   * again) when the host keeps submissions: only a stored submission is sent.
   * Resolves true when it was sent.
   */
  const submit = useCallback(async (value: unknown, prompt: string, title: string) => {
    if (!record) return fire(prompt, title);
    if (busy.current || !request) return false;
    busy.current = true;
    setSaving(true);
    setSaveFailed(false);
    let stored = false;
    try { stored = await record(block, signature, value, prompt); } catch { stored = false; }
    busy.current = false;
    if (!mounted.current) return false;
    setSaving(false);
    if (!stored) { setSaveFailed(true); return false; }
    return fire(prompt, title);
  }, [block, fire, record, request, signature]);
  return {
    available: !!request, locked, fire, sentLabel: send ? 'Sent' : 'Added to the assistant',
    submission, submit, saving,
    /** The last submit could not be stored (and was not sent); false once the block has a submission. */
    saveFailed: saveFailed && !submission,
  };
}
