import type { AgentConfig } from "./agentConfig";
import { getBuiltinDefaultModel, getBuiltinDefaultReasoning, resolveProvider } from "./agentConfig";
import type { AgentReasoning, AgentRuntime } from "../agents/types";
import { parseBranchOverviewEntries, type BranchOverviewEntry } from "michi-shared";
import { getNode } from "./dbRepository";

export type ResumeStrategy = "fresh" | "live" | "exact" | "compatible";

export interface ResumeSignature {
  runtimeId: string;
  runtimeEngine?: string | null;
  providerId: string | null;
  modelId: string | null;
  reasoning: AgentReasoning | null;
}

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Epoch ms the message was stored. Without it a cut middle gets no per-turn summaries. */
  createdAt?: number;
}

export interface ResumeDecisionInput {
  existingChatId?: string | null;
  liveSessionMatches: boolean;
  nativeResumeAvailable: boolean;
  nativeResumeEnabled?: boolean;
  nativeResumeSettings?: readonly ('model' | 'reasoning')[];
  existingSignature: ResumeSignature | null;
  targetSignature: ResumeSignature;
  /** @deprecated Fingerprint check removed — field ignored by chooseResumeStrategy. */
  storedFingerprint?: string | null;
  /** @deprecated Fingerprint check removed — field ignored by chooseResumeStrategy. */
  currentFingerprint?: string;
}

export interface ResumeDecision {
  strategy: ResumeStrategy;
  reason: string;
}

/**
 * Transcript characters a compatible context keeps, about 28k tokens: enough
 * that what a long conversation settled in its middle survives a runtime,
 * provider or model switch, and still a fraction of a current model's window.
 */
export const COMPAT_TRANSCRIPT_BUDGET = 112_000;
// A longer transcript keeps 2/7 of the budget from its start and 4/7 from its
// end, the shares the former 8k + 16k of 28k had; the 1/7 between is room
// for the per-turn summaries of the part cut out.
const COMPAT_HEAD_SHARE = 2 / 7;
const COMPAT_TAIL_SHARE = 4 / 7;
const TRANSCRIPT_SEPARATOR = "\n\n---\n\n";

export function normalizeSignaturePart(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function normalizeReasoning(value: unknown): AgentReasoning | null {
  const normalized = normalizeSignaturePart(value);
  if (
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh" ||
    normalized === "max"
  ) {
    return normalized;
  }
  return null;
}

export function buildTargetResumeSignature(
  cfg: AgentConfig,
  runtime: AgentRuntime,
  modelOverride?: string | null,
  userId?: string,
): ResumeSignature {
  const runtimeId = cfg.runtime;
  const modelId = normalizeSignaturePart(
    modelOverride ??
    cfg.modelByRuntime[runtimeId] ??
    getBuiltinDefaultModel(runtimeId),
  );
  return {
    runtimeId,
    ...(runtime.nativeEngine ? { runtimeEngine: runtime.nativeEngine } : {}),
    providerId: runtime.capabilities.providerModels ? normalizeSignaturePart(resolveProvider(runtimeId, userId)) : null,
    modelId,
    reasoning: runtime.capabilities.reasoning
      ? normalizeReasoning(cfg.reasoningByRuntime[runtimeId] ?? getBuiltinDefaultReasoning(runtimeId))
      : null,
  };
}

export function normalizeResumeSignature(input: {
  runtimeId?: unknown;
  runtimeEngine?: unknown;
  providerId?: unknown;
  modelId?: unknown;
  reasoning?: unknown;
}): ResumeSignature | null {
  const runtimeId = normalizeSignaturePart(input.runtimeId);
  if (!runtimeId) return null;
  return {
    runtimeId,
    ...(input.runtimeEngine ? { runtimeEngine: normalizeSignaturePart(input.runtimeEngine) } : {}),
    providerId: normalizeSignaturePart(input.providerId),
    modelId: normalizeSignaturePart(input.modelId),
    reasoning: normalizeReasoning(input.reasoning),
  };
}

export function signaturesEqual(a: ResumeSignature, b: ResumeSignature): boolean {
  return (
    a.runtimeId === b.runtimeId &&
    (a.runtimeId !== 'kiro' || (a.runtimeEngine ?? 'v2') === (b.runtimeEngine ?? 'v2')) &&
    a.providerId === b.providerId &&
    a.modelId === b.modelId &&
    a.reasoning === b.reasoning
  );
}

export function chooseResumeStrategy(input: ResumeDecisionInput): ResumeDecision {
  if (!input.existingChatId) {
    return { strategy: "fresh", reason: "no_existing_session" };
  }
  if (!input.existingSignature && !input.nativeResumeAvailable && !input.liveSessionMatches) {
    return { strategy: "compatible", reason: "missing_resume_signature" };
  }
  const existing = input.existingSignature;
  const target = input.targetSignature;
  if (existing?.runtimeId === 'kiro' && target.runtimeId === 'kiro'
    && (existing.runtimeEngine ?? 'v2') !== (target.runtimeEngine ?? 'v2')) {
    return { strategy: 'compatible', reason: 'engine_changed' };
  }
  if (existing && !signaturesEqual(existing, target)) {
    const supported = input.nativeResumeSettings ?? [];
    if (existing.runtimeId !== target.runtimeId || existing.providerId !== target.providerId
      || (existing.modelId !== target.modelId && !supported.includes('model'))
      || (existing.reasoning !== target.reasoning && !supported.includes('reasoning'))) {
      return { strategy: "compatible", reason: "signature_changed" };
    }
  }
  // Fingerprint check removed: Pane Ownership already prevents concurrent
  // writes, edit/retry clears chatId (forcing fresh), and the fingerprint's
  // normalization divergence caused every normal follow-up to misfire into
  // compatible resume — losing live sessions that were perfectly fine.
  if (input.liveSessionMatches) {
    return { strategy: "live", reason: "live_session_matches" };
  }
  if (input.nativeResumeEnabled === false) {
    return { strategy: "compatible", reason: "native_resume_disabled" };
  }
  if (input.nativeResumeAvailable) {
    return { strategy: "exact", reason: "native_resume_available" };
  }
  return { strategy: "compatible", reason: "native_resume_unavailable" };
}

export interface CompatibleContextOptions {
  /** Override the heading used for a non-resume (for example branch) context. */
  heading?: string;
  /** Override the model-facing introduction for this context block. */
  intro?: string;
  /** Extra caveat about an incomplete or approximate transcript. */
  note?: string;
  /** Transcript characters to keep (default COMPAT_TRANSCRIPT_BUDGET); less for a model with a small window. */
  budget?: number;
}

export function buildCompatibleResumeContext(
  messages: readonly TranscriptMessage[],
  opts: { nodeId: string; title?: string | null },
  extra?: CompatibleContextOptions,
): string | null {
  const nonEmpty = messages.filter((m) => m.content.trim().length > 0);
  if (nonEmpty.length === 0 && !extra?.note) return null;
  const label = opts.title?.trim() || opts.nodeId;
  const blocks = nonEmpty.map((m) => `${m.role === "user" ? "User" : "Assistant"}:\n${m.content}`);
  const transcript = blocks.join(TRANSCRIPT_SEPARATOR);
  const budget = extra?.budget !== undefined && Number.isFinite(extra.budget) && extra.budget > 0
    ? Math.floor(extra.budget)
    : COMPAT_TRANSCRIPT_BUDGET;
  const body = transcript.length <= budget ? transcript : cutMiddle(nonEmpty, blocks, budget, opts.nodeId);
  const parts = [
    `=== ${extra?.heading ?? "Compatible resume transcript"}: ${label} ===`,
    extra?.intro ?? "The following is the visible transcript from this node. It may come from a different runtime, provider, or model. Treat it as prior conversation context and continue naturally; do not mention the restore mode unless the user asks.",
  ];
  if (body.length > 0) parts.push("", body);
  if (extra?.note) parts.push("", `Note: ${extra.note}`);
  return parts.join("\n");
}

/**
 * The transcript's start and end, and in place of its middle the summaries
 * the agent recorded for those turns (nodes.branch_overview) and where
 * read_node finds the messages themselves.
 */
function cutMiddle(messages: readonly TranscriptMessage[], blocks: readonly string[], budget: number, nodeId: string): string {
  const text = blocks.join(TRANSCRIPT_SEPARATOR);
  const headEnd = Math.floor(budget * COMPAT_HEAD_SHARE);
  const tailStart = text.length - Math.floor(budget * COMPAT_TAIL_SHARE);
  const head = text.slice(0, headEnd).trimEnd();
  const tail = text.slice(tailStart).trimStart();
  // The messages the cut reaches, whole or in part.
  let first = -1;
  let last = -1;
  let start = 0;
  blocks.forEach((block, index) => {
    const end = start + block.length;
    if (end > headEnd && start < tailStart) {
      if (first < 0) first = index;
      last = index;
    }
    start = end + TRANSCRIPT_SEPARATOR.length;
  });
  const lines = [`[... omitted ${text.length - head.length - tail.length} chars from the middle of the prior transcript ...]`];
  if (first >= 0) {
    const room = budget - headEnd - Math.floor(budget * COMPAT_TAIL_SHARE);
    lines.push(...cutSummaries(nodeId, messages, first, last, room));
    // The stored conversation has at least as many messages before the cut as this
    // transcript (it drops empty ones and joins check-in facts), so this offset never starts after it.
    lines.push(`To read the omitted messages, call read_node with nodeId "${nodeId}", from "head", offset ${first + 1}; `
      + "it starts at or just before the omitted part.");
  }
  return `${head}\n\n${lines.join("\n")}\n\n${tail}`;
}

/** The overview entries recorded during the turns of messages first..last, newest kept first when they exceed `room`. */
function cutSummaries(nodeId: string, messages: readonly TranscriptMessage[], first: number, last: number, room: number): string[] {
  const from = messages[first]?.createdAt;
  // A turn's entry is recorded as the turn ends, before the next message. One
  // after the transcript's last message may be a later turn's (past a branch point).
  const until = messages[last + 1]?.createdAt ?? messages[last]?.createdAt;
  if (from === undefined || until === undefined) return [];
  const entries = nodeOverviewEntries(nodeId).filter((entry) => entry.at >= from && entry.at < until);
  if (entries.length === 0) return [];
  const kept: string[] = [];
  let used = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const line = `- ${entries[index].text.replace(/\s*\n\s*/g, " ")}`;
    if (used + line.length + 1 > room) break;
    kept.unshift(line);
    used += line.length + 1;
  }
  if (kept.length === 0) return [];
  const left = entries.length - kept.length;
  return [
    "Summaries the agent wrote at the end of each turn in the omitted part, oldest first. "
      + "They were not checked against the messages and may leave things out:",
    ...(left > 0 ? [`(${left} earlier summar${left === 1 ? "y" : "ies"} left out for length)`] : []),
    ...kept,
  ];
}

function nodeOverviewEntries(nodeId: string): BranchOverviewEntry[] {
  try {
    return parseBranchOverviewEntries(getNode(nodeId)?.branch_overview);
  } catch {
    return [];
  }
}
