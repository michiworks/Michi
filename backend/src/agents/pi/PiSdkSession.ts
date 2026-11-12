import { getRuntimeDeps } from "../runtimeDeps";
import { isRunOwner } from "../ownerMapping";
import type { AgentSession, CompactResult } from "../types";
import { PiSession, type PiSessionDeps } from "./PiSession";
import { createPiSdkHarness, invalidatePiSdkTranscript, type PiSdkFeatures } from './piSdkHarness';
import { sessionReplayRows, type ReplayRow, type TimedReplayEntry } from '../sessionReplayView';
import { getCompanionSettings } from '../../services/companion/settings';

export type PiSessionKind = "sdk" | "agent-core";
/** The old engine remains available for operational rollback. */
export function selectPiSessionKind(env: NodeJS.ProcessEnv = process.env): PiSessionKind {
  return env.MICHI_PI_SESSION_SDK === '0' ? 'agent-core' : 'sdk';
}

/** Michi branches always own an independent transcript. */
export function shouldNavigatePiTreeOnMichiBranch(): false { return false; }

/**
 * A node's stored history as Pi rebuilds and settles against it: the session
 * replay view (posted check-ins as one-line facts, never their text, and no
 * two assistant entries in a row; DESIGN-v2 §2.8 T2, §9 risk 11). Restore
 * (PiRuntime) and the settled-turn checkpoint below both read it, so the
 * native transcript is resumed only against the same view. A post written
 * after a checkpoint changes that view, so the transcript is retired and
 * rebuilt from it rather than carrying the post in as text.
 */
export function piHostHistory(rows: readonly ReplayRow[]): TimedReplayEntry[] {
  return sessionReplayRows(rows, { name: () => getCompanionSettings().displayName });
}

export class PiSdkSession extends PiSession {
  private sdkHarness: any;
  constructor(id: string, private readonly sdkDeps: PiSessionDeps) { super(id, sdkDeps); }

  protected override async createHarness(core: any, options: any, features: PiSdkFeatures): Promise<any> {
    return this.sdkHarness = await createPiSdkHarness(this.id, this.sdkDeps, core, options, features);
  }

  protected override supportsToolSearch(): boolean { return true; }

  protected override async onTurnSettled(): Promise<void> {
    if (!this.sdkHarness) return;
    // ChatHub finalizes SQLite before returning the generator at turn_end.
    // Read that canonical view: it includes displayText, steered users and
    // finalized assistant sentinels, unlike the model-facing raw transcript.
    if (!isRunOwner(this.owner)) {
      const store = getRuntimeDeps().historyStore;
      if (store.getNode(this.id)) {
        this.sdkHarness.checkpoint(piHostHistory(store.listMessages(this.id)));
        return;
      }
    }
    this.sdkHarness.checkpoint(this.getHistory());
  }

  override describeNativeState(): Record<string, unknown> {
    return { ...super.describeNativeState(), kind: 'pi-sdk' };
  }

  /** SDK manual compaction between turns (POST /chats/:chatId/compact). The agent-core rollback has none. */
  compact(instructions?: string): Promise<CompactResult> {
    return this.compactBetweenTurns(instructions);
  }
}

export async function createPiSession(id: string, deps: PiSessionDeps): Promise<AgentSession> {
  if (selectPiSessionKind() === 'sdk') return new PiSdkSession(id, deps);
  invalidatePiSdkTranscript(id, deps);
  return new PiSession(id, deps);
}
