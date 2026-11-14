import { useEffect, useState } from 'react';
import { fetchMemoryExtractionStatus } from '../../services/api/memories';

/**
 * Memory on this machine's backend as Settings › Memory sets it: `memoryOn`
 * (Use memory) and `learning` (Learn from conversations, automatic memory;
 * off until Settings › Memory turns it on, and off whenever memory is). Null
 * until the backend answers, or when it can't. Read once per mount.
 */
export function useMemoryLearning(): { memoryOn: boolean; learning: boolean } | null {
  const [state, setState] = useState<{ memoryOn: boolean; learning: boolean } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetchMemoryExtractionStatus(controller.signal).then(
      (status) => setState(status ? { memoryOn: status.enabled, learning: status.enabled && !status.paused } : null),
      () => {},
    );
    return () => controller.abort();
  }, []);
  return state;
}
