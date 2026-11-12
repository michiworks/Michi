import type { TurnMetadataValidation } from 'michi-runtime';
import { hasClosedFollowUpSentinels } from 'michi-shared';

/**
 * Per-turn Michi metadata policy of a session that reports its overview
 * through the tool and its follow-ups as sentinel lines. Once the follow-ups
 * are complete, the overview call ends the visible answer: what the model
 * writes after it is hidden. Adapters retain their native completion
 * boundaries; this state contains no SDK, transport or queue work.
 */
export class TurnMetadataState {
  private suppressedChunks = 0;
  private suppressedThoughts = 0;
  private sentinelTail = '';
  private sentinelsComplete = false;
  private silentOverviewTail = false;

  begin(): void {
    this.reset();
  }

  setOverview(value: string): { overview: string; beforeSentinelsComplete: boolean } | null {
    const overview = value.trim();
    if (!overview) return null;
    const beforeSentinelsComplete = !this.sentinelsComplete;
    if (this.sentinelsComplete) this.silentOverviewTail = true;
    return { overview, beforeSentinelsComplete };
  }

  observeChunk(text: string, enableFollowUps: boolean): void {
    if (!enableFollowUps || this.sentinelsComplete) return;
    this.sentinelTail = `${this.sentinelTail}${text}`.slice(-12_000);
    this.sentinelsComplete = hasClosedFollowUpSentinels(this.sentinelTail);
  }

  suppressOutput(kind: string): boolean {
    if (!this.silentOverviewTail) return false;
    if (kind === 'chunk') { this.suppressedChunks++; return true; }
    if (kind === 'thought') { this.suppressedThoughts++; return true; }
    return false;
  }

  finish(): { chunks: number; thoughts: number } {
    const suppressed = { chunks: this.suppressedChunks, thoughts: this.suppressedThoughts };
    this.reset();
    return suppressed;
  }

  // Inert: the runtime's v1 TurnMetadataTracker still declares these
  // Stop-hook POC members, and no adapter calls them.
  readonly validationActive = false;
  acceptsFollowUps(): boolean { return false; }
  setFollowUps(): null { return null; }
  validate(): TurnMetadataValidation { return { status: 'inactive', missingTools: [], response: {} }; }
  completeOutputBoundary(): boolean { return false; }

  private reset(): void {
    this.suppressedChunks = 0;
    this.suppressedThoughts = 0;
    this.sentinelTail = '';
    this.sentinelsComplete = false;
    this.silentOverviewTail = false;
  }
}
