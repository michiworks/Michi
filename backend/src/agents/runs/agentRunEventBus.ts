import { createKeyedListenerSets, createListenerSet, type AgentRunEventV1 } from 'michi-shared';
import type { AgentRunClock } from './ports';
import { systemAgentRunClock } from './ports';
import { log } from '../../services/logger';

type Listener = (event: AgentRunEventV1) => void;

/** A listener's failure is logged, never thrown into the coordinator flow that just committed. */
const listenerOptions = {
  onError: (error: unknown) => log.warn('chat', 'Agent Run event listener failed', { error: error instanceof Error ? error.message : String(error) }),
};

/** Instance-scoped live fanout. Callers may publish only repository-returned
 * events, which guarantees commit-before-broadcast ordering. */
export class AgentRunEventBus {
  private readonly listeners = createKeyedListenerSets<string, [AgentRunEventV1]>(listenerOptions);
  private readonly allListeners = createListenerSet<[AgentRunEventV1]>(listenerOptions);

  publishCommitted(event: AgentRunEventV1): void {
    this.listeners.emit(event.runId, event);
    this.allListeners.emit(event);
  }

  subscribeAll(listener: Listener): () => void {
    return this.allListeners.subscribe(listener);
  }

  subscribe(runId: string, listener: Listener): () => void {
    return this.listeners.subscribe(runId, listener);
  }

  waitForEvent(runId: string, afterSeq: number, timeoutMs: number,
    clock: AgentRunClock = systemAgentRunClock): Promise<AgentRunEventV1 | null> {
    return new Promise((resolve) => {
      let settled = false;
      const stop = this.subscribe(runId, (event) => {
        if (event.seq <= afterSeq || settled) return;
        settled = true;
        clock.clearTimeout(timer);
        stop();
        resolve(event);
      });
      const timer = clock.setTimeout(() => {
        if (settled) return;
        settled = true;
        stop();
        resolve(null);
      }, timeoutMs);
    });
  }
}
