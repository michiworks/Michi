import { DEFAULT_COMPANION_SETTINGS, type CompanionItemDto, type CompanionSnapshotDto } from 'michi-shared';
import type { CompanionSnapshot } from '../services/api/companion';

/** Companion test data: a snapshot as the backend sends it, and feed items. */

export function companionItem(id: string, overrides: Partial<CompanionItemDto> = {}): CompanionItemDto {
  return {
    id, source: 'cr', subtype: 'cr_needs_attention', bucket: 'needs_you', severity: 'now', itemKey: `cr:${id}:mine`, version: 'v1',
    title: `Item ${id}`, summary: null, target: { kind: 'url', url: `https://reviews.example.com/reviews/${id}` }, facts: {}, status: 'new',
    snoozedUntil: null, feedback: null, feedbackReason: null, firstSeenAt: 1_000, changedAt: 2_000, observedAt: 3_000,
    createdAt: 1_000, updatedAt: 3_000, resolvedAt: null, ...overrides,
  };
}

/** The wire snapshot (CompanionSnapshotDto) with R2.16 fields, of a Michi the user turned on (Resume: it starts paused). */
export function companionSnapshotDto(overrides: Partial<CompanionSnapshotDto> = {}): CompanionSnapshotDto {
  const settings = structuredClone(DEFAULT_COMPANION_SETTINGS);
  for (const source of Object.values(settings.sources)) source.enabled = true;
  const runs = { runtimeId: 'claude', providerId: null, modelId: null, reasoning: null };
  return {
    settings: { ...settings, enabled: true, paused: false },
    status: {
      state: 'ok', auth: { valid: true, expiresAt: null, checkedAt: null }, sources: [], lastCheckAt: null, nextCheckAt: null,
      nextHeartbeatAt: null, nextBriefAt: null, turnsToday: 0, working: false,
    },
    conversation: {
      workspaceId: 'ws-assistant', nodeId: 'companion-node',
      assistant: { nodeId: 'companion-node', workspaceId: 'ws-assistant', treeId: 'tree-c', settings: runs, conversation: runs, supportedRuntimes: ['claude'] },
    },
    items: [],
    brief: null,
    cards: [],
    goals: [],
    notes: '',
    notesRevision: 0,
    rules: '',
    reminders: [],
    demotedSubtypes: [],
    catchUp: null,
    activity: [],
    counts: { needsYou: 0, newItems: 0, unreadMessages: 0 },
    revision: 1,
    ...overrides,
  };
}

/** The same, as this window keeps it (what the store and components see); its conversation may lack `assistant`. */
export function companionSnapshot(
  overrides: Omit<Partial<CompanionSnapshotDto>, 'conversation'> & { conversation?: CompanionSnapshot['conversation'] } = {},
): CompanionSnapshot {
  const { conversation, ...rest } = overrides;
  const dto = companionSnapshotDto(rest);
  const kept = conversation !== undefined ? conversation : dto.conversation ? { ...dto.conversation, assistant: dto.conversation.assistant as never } : null;
  return { ...dto, conversation: kept };
}

/** V's `/assistant` info, as the Chat tab and the Topbar button read it (DESIGN-v2 §1.3). */
export function assistantInfo(nodeId = 'companion-node', overrides: Record<string, unknown> = {}) {
  const settings = structuredClone(DEFAULT_COMPANION_SETTINGS);
  for (const source of Object.values(settings.sources)) source.enabled = true;
  const runs = { runtimeId: 'claude' as const, providerId: null, modelId: null, reasoning: null };
  return { nodeId, workspaceId: 'ws-assistant', treeId: 'tree-c', settings: runs, conversation: runs, supportedRuntimes: ['claude' as const], ...overrides };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
