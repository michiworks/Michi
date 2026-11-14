import type { Route } from '@playwright/test';
import type { AttentionNotificationV1 } from '../../shared/src/attention';
import {
  COMPANION_CHAT_NOTIFICATION_LEVEL_PATH,
  DEFAULT_COMPANION_SETTINGS,
  isChatNotificationLevel,
  type ChatNotificationLevel,
  type CompanionBriefDto,
  type CompanionCardDto,
  type CompanionCheckinChangeDto,
  type CompanionGetStartedDto,
  type CompanionGoalDto,
  type CompanionItemDto,
  type CompanionReminderDto,
  type CompanionSettings,
  type CompanionSnapshotDto,
  type CompanionStatusDto,
} from '../../shared/src/companion';

/**
 * Browser-only Companion: every /api/companion route, answered from memory.
 * installMockApi uses a quiet instance by default (no items, no brief, no
 * conversation, a change feed that sends the current revision and ends), so
 * the Topbar button shows and nothing errors; a spec that needs data seeds
 * its own (items, a status, Michi's attention records the background feed carries once) and passes
 * `handle` as `custom`. No backend, MCP or Auth.
 *
 * Unknown /companion routes answer 404, so a renderer calling one the
 * backend does not have fails console-health instead of passing quietly.
 */
export interface CompanionMockOptions {
  items?: CompanionItemDto[];
  conversation?: CompanionSnapshotDto['conversation'] | null;
  brief?: CompanionBriefDto | null;
  cards?: CompanionCardDto[];
  settings?: Partial<CompanionSettings>;
  /** Status fields to report (e.g. `nextBriefAt`). */
  status?: Partial<CompanionStatusDto>;
  /**
   * Michi's attention records (services/companion/notices.ts on the backend):
   * the first POST /chats/background/subscribe carries them, live, after an
   * empty snapshot; a window's claim of one is won.
   */
  records?: AttentionNotificationV1[];
  /**
   * What the backend says about the welcome (DESIGN-v2 §3.8): `wanted` asks
   * the panel to request it. Absent, the snapshot carries none (no welcome).
   */
  welcome?: CompanionSnapshotDto['welcome'];
  /**
   * The Get started card (D17). Start and Not now answer with the card
   * moved on, as the backend does; Start with `watch` sets the outside sources.
   */
  getStarted?: CompanionGetStartedDto | null;
  /** When "Michi is off" was told (Q29): null, not yet; absent, a backend without the record. */
  offNoticeAt?: number | null;
  /** The check-ins' changes to Today items and goals, newest first (DESIGN-v2 §2.7, snapshot.checkinChanges). */
  checkinChanges?: CompanionCheckinChangeDto[];
}

export interface CompanionMockController {
  handle(route: Route): Promise<boolean>;
  /** Every write this controller answered, as `METHOD /path`. */
  readonly writes: string[];
  /** Item action bodies, in order, with the item they were for. */
  readonly actions: Array<{ id: string; body: Record<string, unknown> }>;
  /** The items as the last request left them (open or not). */
  readonly items: CompanionItemDto[];
  /** Every chat notification level a renderer PUT (DESIGN-v2 §5.2), in order. */
  readonly notificationLevels: ChatNotificationLevel[];
}

export function companionItem(id: string, title: string, overrides: Partial<CompanionItemDto> = {}): CompanionItemDto {
  const now = Date.now();
  return {
    id, source: 'cr', subtype: 'cr_needs_attention', bucket: 'needs_you', severity: 'now', itemKey: `cr:${id}:mine`, version: 'v1',
    title, summary: null, target: { kind: 'url', url: 'https://reviews.example.com/reviews/CR-123456' }, facts: {}, status: 'new',
    snoozedUntil: null, feedback: null, feedbackReason: null, firstSeenAt: now - 3_600_000, changedAt: now - 600_000,
    observedAt: now - 60_000, createdAt: now - 3_600_000, updatedAt: now - 60_000, resolvedAt: null, ...overrides,
  };
}

const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
const noContent = (route: Route) => route.fulfill({ status: 204, body: '' });

function isOpen(item: CompanionItemDto, now: number): boolean {
  if (item.status === 'resolved' || item.status === 'dismissed' || item.status === 'muted') return false;
  if (item.status === 'snoozed') return item.snoozedUntil !== null && item.snoozedUntil <= now;
  return true;
}

export function createCompanionMock(options: CompanionMockOptions = {}): CompanionMockController {
  const state = {
    // A Michi the user turned on (Resume: it starts paused); options.settings can pause it again.
    settings: { ...DEFAULT_COMPANION_SETTINGS, enabled: true, paused: false, ...options.settings } as CompanionSettings,
    items: [...(options.items ?? [])],
    cards: [...(options.cards ?? [])],
    goals: [] as CompanionGoalDto[],
    reminders: [] as CompanionReminderDto[],
    brief: options.brief ?? null,
    notes: '',
    notesRevision: 0,
    rules: '',
    revision: 1,
    getStarted: options.getStarted,
    offNoticeAt: options.offNoticeAt,
  };
  const writes: string[] = [];
  const actions: Array<{ id: string; body: Record<string, unknown> }> = [];
  const notificationLevels: ChatNotificationLevel[] = [];
  let next = 1;
  /** Records not sent yet: the first background subscription carries them. */
  let unsentRecords = [...(options.records ?? [])];

  const snapshot = (): CompanionSnapshotDto => {
    const now = Date.now();
    const open = state.items.filter((item) => isOpen(item, now));
    return {
      settings: state.settings,
      status: {
        state: state.settings.enabled ? (state.settings.paused ? 'paused' : 'ok') : 'off',
        auth: { valid: true, expiresAt: null, checkedAt: now - 60_000 },
        sources: [],
        lastCheckAt: now - 120_000,
        nextCheckAt: now + 180_000,
        nextHeartbeatAt: null,
        nextBriefAt: null,
        turnsToday: 0,
        working: false,
        ...options.status,
      },
      conversation: options.conversation ?? null,
      items: open,
      brief: state.brief,
      cards: state.cards,
      goals: state.goals,
      notes: state.notes,
      notesRevision: state.notesRevision,
      rules: state.rules,
      reminders: state.reminders,
      ...(options.welcome ? { welcome: options.welcome } : {}),
      ...(options.checkinChanges ? { checkinChanges: options.checkinChanges } : {}),
      ...(state.getStarted !== undefined ? { getStarted: state.getStarted } : {}),
      ...(state.offNoticeAt !== undefined ? { offNoticeAt: state.offNoticeAt } : {}),
      demotedSubtypes: [],
      catchUp: null,
      activity: [],
      counts: {
        needsYou: open.filter((item) => item.bucket === 'needs_you').length,
        newItems: open.filter((item) => item.status === 'new').length,
        unreadMessages: 0,
      },
      revision: state.revision,
    };
  };
  const changed = () => { state.revision += 1; };

  async function handle(route: Route): Promise<boolean> {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^.*?\/api/, '');
    const method = request.method();
    if (method === 'POST' && path === '/chats/background/subscribe' && unsentRecords.length > 0) {
      const frames = [
        `event: attention_snapshot\ndata: ${JSON.stringify({ protocol: 'v1', notifications: [] })}\n\n`,
        ...unsentRecords.map((record) => `event: attention_notification\ndata: ${JSON.stringify(record)}\n\n`),
      ].join('');
      unsentRecords = [];
      await route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'cache-control': 'no-cache' }, body: `: keepalive\n\n${frames}` });
      return true;
    }
    if (method === 'POST' && /^\/attention\/notifications\/[^/]+\/claim$/.test(path)) {
      let windowId = 'window';
      try { windowId = String((request.postDataJSON() as { windowId?: unknown } | null)?.windowId ?? windowId); } catch { /* no body */ }
      await json(route, { claimed: true, claimedByWindowId: windowId, status: 'active' });
      return true;
    }
    if (path !== '/companion' && !path.startsWith('/companion/')) return false;
    if (method !== 'GET') writes.push(`${method} ${path}`);
    const body = (): Record<string, unknown> => {
      try { return (request.postDataJSON() ?? {}) as Record<string, unknown>; } catch { return {}; }
    };

    if (method === 'GET' && path === '/companion/events') {
      await route.fulfill({
        status: 200, contentType: 'text/event-stream', headers: { 'cache-control': 'no-cache' },
        body: `event: companion_changed\ndata: ${JSON.stringify({ type: 'companion_changed', revision: state.revision, reason: 'status' })}\n\n`,
      });
      return true;
    }
    if (method === 'GET' && path === '/companion') { await json(route, snapshot()); return true; }
    if (method === 'PATCH' && path === '/companion/settings') {
      const patch = body();
      state.settings = {
        ...state.settings,
        ...patch,
        sources: { ...state.settings.sources, ...(patch.sources as object | undefined) },
      } as CompanionSettings;
      changed();
      await json(route, snapshot());
      return true;
    }
    if (method === 'PUT' && path === COMPANION_CHAT_NOTIFICATION_LEVEL_PATH) {
      // Every renderer sends its chat notification level at start and on each change (DESIGN-v2 §5.2).
      const level = body().level;
      if (!isChatNotificationLevel(level)) { await json(route, { error: 'level must be all, approval-only or off', code: 'invalid' }, 400); return true; }
      notificationLevels.push(level);
      await noContent(route);
      return true;
    }
    if (method === 'POST' && path === '/companion/check') { await json(route, { queued: true }, 202); return true; }
    if (method === 'POST' && path === '/companion/off-notice') {
      if (state.offNoticeAt === null) state.offNoticeAt = Date.now();
      await noContent(route);
      return true;
    }
    if (method === 'POST' && path === '/companion/presence') { await noContent(route); return true; }
    if (method === 'POST' && path === '/companion/view') { await json(route, { catchUp: null }); return true; }
    if (method === 'POST' && path === '/companion/welcome') { await json(route, { started: false }); return true; }
    if (method === 'POST' && (path === '/companion/get-started' || path === '/companion/get-started/later') && state.getStarted) {
      const input = body();
      if (path === '/companion/get-started') {
        if (typeof input.watch === 'boolean') {
          const sources = { ...state.settings.sources };
          for (const kind of ['cr', 'pipeline', 'email', 'calendar'] as const) sources[kind] = { ...sources[kind], enabled: input.watch };
          state.settings = { ...state.settings, sources } as CompanionSettings;
        }
        state.getStarted = { ...state.getStarted, state: 'started', at: Date.now(), homes: input.homes === true,
          watch: typeof input.watch === 'boolean' ? input.watch : null, homesOn: input.homes === true };
      } else if (state.getStarted.state !== 'started') {
        state.getStarted = { ...state.getStarted, state: 'later', at: Date.now() };
      }
      changed();
      await json(route, snapshot());
      return true;
    }
    if (method === 'POST' && path === '/companion/items/seen') {
      const ids = new Set((body().ids as string[] | undefined) ?? []);
      for (const item of state.items) if (ids.has(item.id) && item.status === 'new') item.status = 'seen';
      changed();
      await noContent(route);
      return true;
    }
    const itemMatch = /^\/companion\/items\/([^/]+)$/.exec(path);
    if (method === 'POST' && itemMatch) {
      const id = decodeURIComponent(itemMatch[1]);
      const item = state.items.find((entry) => entry.id === id);
      if (!item) { await json(route, { error: 'Item not found', code: 'not_found' }, 404); return true; }
      const action = body();
      actions.push({ id, body: action });
      switch (action.action) {
        case 'seen': if (item.status === 'new') item.status = 'seen'; break;
        case 'snooze': item.status = 'snoozed'; item.snoozedUntil = action.until as number; break;
        case 'dismiss': item.status = 'dismissed'; break;
        case 'mute': item.status = 'muted'; break;
        case 'restore': item.status = 'seen'; item.snoozedUntil = null; break;
        case 'feedback': item.feedback = (action.feedback as CompanionItemDto['feedback']) ?? null; item.feedbackReason = (action.reason as CompanionItemDto['feedbackReason']) ?? null; break;
      }
      item.updatedAt = Date.now();
      changed();
      await json(route, item);
      return true;
    }
    const cardMatch = /^\/companion\/cards\/([^/]+)\/(apply|dismiss)$/.exec(path);
    if (method === 'POST' && cardMatch) {
      const card = state.cards.find((entry) => entry.id === decodeURIComponent(cardMatch[1]));
      if (!card) { await json(route, { error: 'Card not found', code: 'not_found' }, 404); return true; }
      card.status = cardMatch[2] === 'apply' ? 'applied' : 'dismissed';
      card.decidedAt = Date.now();
      changed();
      await json(route, card);
      return true;
    }
    if (method === 'PUT' && path === '/companion/notes') {
      state.notes = String(body().notes ?? '');
      state.notesRevision += 1;
      changed();
      await json(route, { notes: state.notes, notesRevision: state.notesRevision });
      return true;
    }
    if (method === 'PUT' && path === '/companion/rules') {
      state.rules = String(body().rules ?? '');
      changed();
      await json(route, { rules: state.rules });
      return true;
    }
    if (method === 'POST' && path === '/companion/goals') {
      const now = Date.now();
      const goal: CompanionGoalDto = { id: `cmg-${next++}`, text: String(body().text ?? ''), progress: null, progressAt: null, createdAt: now, updatedAt: now };
      state.goals.push(goal);
      changed();
      await json(route, goal, 201);
      return true;
    }
    const goalMatch = /^\/companion\/goals\/([^/]+)$/.exec(path);
    if (goalMatch && (method === 'PATCH' || method === 'DELETE')) {
      const id = decodeURIComponent(goalMatch[1]);
      const goal = state.goals.find((entry) => entry.id === id);
      if (!goal) { await json(route, { error: 'Goal not found', code: 'not_found' }, 404); return true; }
      changed();
      if (method === 'DELETE') { state.goals = state.goals.filter((entry) => entry.id !== id); await noContent(route); return true; }
      goal.text = String(body().text ?? goal.text);
      goal.updatedAt = Date.now();
      await json(route, goal);
      return true;
    }
    if (method === 'POST' && path === '/companion/reminders') {
      const input = body();
      const reminder: CompanionReminderDto = {
        id: `cmr-${next++}`, kind: input.until ? 'watch' : 'time', text: String(input.text ?? ''), at: (input.at as number | undefined) ?? null,
        dailyAt: (input.dailyAt as string | undefined) ?? null, itemId: (input.itemId as string | undefined) ?? null,
        until: (input.until as CompanionReminderDto['until'] | undefined) ?? null, status: 'active', createdAt: Date.now(), firedAt: null,
      };
      state.reminders.push(reminder);
      changed();
      await json(route, reminder);
      return true;
    }
    const reminderMatch = /^\/companion\/reminders\/([^/]+)$/.exec(path);
    if (reminderMatch && (method === 'PATCH' || method === 'DELETE')) {
      const id = decodeURIComponent(reminderMatch[1]);
      const reminder = state.reminders.find((entry) => entry.id === id);
      if (!reminder) { await json(route, { error: 'Reminder not found', code: 'not_found' }, 404); return true; }
      changed();
      if (method === 'DELETE') { reminder.status = 'cancelled'; await noContent(route); return true; }
      reminder.status = body().status === 'paused' ? 'paused' : 'active';
      await json(route, reminder);
      return true;
    }
    if (method === 'DELETE' && /^\/companion\/demotions\/[^/]+$/.test(path)) { changed(); await noContent(route); return true; }
    if (method === 'POST' && path === '/companion/brief/curate') { await noContent(route); return true; }
    const feedbackMatch = /^\/companion\/brief\/([^/]+)\/feedback$/.exec(path);
    if (method === 'POST' && feedbackMatch) {
      if (!state.brief || state.brief.id !== decodeURIComponent(feedbackMatch[1])) { await json(route, { error: 'Brief not found', code: 'not_found' }, 404); return true; }
      const input = body();
      const cardFeedback = { ...state.brief.cardFeedback };
      if (input.feedback === 'up' || input.feedback === 'down') cardFeedback[input.index as number] = input.feedback;
      else delete cardFeedback[input.index as number];
      state.brief = { ...state.brief, cardFeedback };
      changed();
      await json(route, state.brief);
      return true;
    }
    if (method === 'POST' && path === '/companion/reset') { changed(); await json(route, snapshot()); return true; }
    if (method === 'POST' && /^\/companion\/notifications\/[^/]+\/ack$/.test(path)) { await noContent(route); return true; }
    await json(route, { error: `No mock for ${method} ${path}`, code: 'not_found' }, 404);
    return true;
  }

  return {
    handle,
    writes,
    actions,
    notificationLevels,
    get items() { return state.items; },
  };
}
