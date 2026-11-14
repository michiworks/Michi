import { assertPublicCompanionSettingsPatch, assertPublicCompanionCheckSources, assertPublicCompanionWatch } from '../services/companion/publicAvailability';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import {
  COMPANION_CHAT_NOTIFICATION_LEVEL_PATH,
  COMPANION_CONFIGURABLE_SOURCES,
  COMPANION_DELEGATIONS_PATH,
  COMPANION_EVENTS_PATH,
  COMPANION_TRAY_PATH,
  CHAT_NOTIFICATION_LEVELS,
  isChatNotificationLevel,
  isCompanionDelegationPatch,
  type CompanionConfigurableSource,
  type CompanionConversationDto,
  type CompanionFeedbackReason,
  type CompanionItemAction,
  type CompanionRunUndoResult,
  type CompanionSnapshotDto,
  type CompanionTrayDto,
} from 'michi-shared';
import { currentAssistantNodeId, ensureAssistant } from '../assistant/store';
import { applyPublicCompanionCard as applyCompanionCard, dismissCompanionCard, type CompanionCardDecision } from '../services/companion/cards';
import { setNotificationLevel } from '../services/attention/notificationLevel';
import { systemCompanionClock } from '../services/companion/clock';
import {
  companionEvents,
  companionTrayDto,
  encodeCompanionChangedEvent,
  type CompanionEventBus,
} from '../services/companion/delivery';
import { CompanionError, invalidRequest, notFound } from '../services/companion/errors';
import { companionGetStarted, parseGetStartedInput, postponeCompanionGetStarted, startCompanionGetStarted } from '../services/companion/getStarted';
import { undoCompanionRun } from '../services/companion/posts';
import {
  addGoal,
  applyItemAction,
  cancelReminder,
  clearSubtypeDemotion,
  companionOffNoticeAt,
  companionWelcomeState,
  createReminder,
  getCompanionMetaNumber,
  getReminder,
  isCompanionItemSubtype,
  markCompanionOffNotice,
  markItemsSeen,
  recordCompanionView,
  reminderDto,
  removeGoal,
  setBriefCardFeedback,
  setBriefCurate,
  setCompanionRules,
  setNotesByUser,
  setReminderStatus,
  snapshotDto,
  stopDelegationAutoSend,
  updateGoal,
} from '../services/companion/repository';
import { getCompanionSettings, patchCompanionSettings } from '../services/companion/settings';
import type { CompanionClock, CompanionService } from '../services/companion/types';
import { createSseObserver } from '../services/httpSse';
import { log } from '../services/logger';
import { localOnlyGuard } from './middleware/localOnly';

/** The Companion reads every workspace and the user's mail and reviews: only the local app or the authenticated remote owner may reach it. */
const companionLocalOnly = localOnlyGuard('The Michi Companion requires local or authenticated remote access', { allowAuthenticatedRemote: true });

/** The Companion exists only in the desktop app; a cloud backend (which never mounts this router) answers as if it had none. */
const desktopOnly: RequestHandler = (_req, res, next) => {
  if (process.env.MICHI_CLOUD === '1') {
    res.status(404).json({ error: 'The Companion is not available on this server', code: 'not_found' });
    return;
  }
  next();
};

const KEEPALIVE_MS = 15_000;
const MAX_SEEN_IDS = 100;
/** Ids Michi makes (`cmi-<uuid>`, …); anything else cannot name a Companion record. */
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const FEEDBACK_REASONS: readonly CompanionFeedbackReason[] = ['not_relevant', 'already_handled', 'too_early', 'too_late', 'too_noisy'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const isId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);

/** The JSON object body (none counts as `{}`), holding only `allowed` fields. */
function body(req: Request, allowed: readonly string[]): Record<string, unknown> {
  const raw: unknown = req.body;
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw invalidRequest('Request body must be a JSON object');
  const unknown = Object.keys(raw).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw invalidRequest(`Unknown field: ${unknown}`);
  return raw;
}

function idParam(req: Request): string {
  const id = req.params.id;
  if (!isId(id)) throw invalidRequest('id is not a Companion id');
  return id;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw invalidRequest(`${field} must be true or false`);
  return value;
}

/** One item action, each with exactly its own fields. */
function itemAction(req: Request): CompanionItemAction {
  const raw: unknown = req.body;
  if (!isRecord(raw)) throw invalidRequest('Request body must be a JSON object');
  switch (raw.action) {
    case 'seen':
    case 'dismiss':
    case 'mute':
    case 'restore':
      body(req, ['action']);
      return { action: raw.action };
    case 'snooze':
      body(req, ['action', 'until']);
      if (typeof raw.until !== 'number' || !Number.isSafeInteger(raw.until)) throw invalidRequest('until must be a time in epoch ms');
      return { action: 'snooze', until: raw.until };
    case 'feedback': {
      body(req, ['action', 'feedback', 'reason']);
      const { feedback, reason } = raw;
      if (feedback !== null && feedback !== 'up' && feedback !== 'down') throw invalidRequest('feedback must be up, down or null');
      if (reason !== undefined && reason !== null && !FEEDBACK_REASONS.includes(reason as CompanionFeedbackReason)) {
        throw invalidRequest(`reason must be one of: ${FEEDBACK_REASONS.join(', ')}`);
      }
      return { action: 'feedback', feedback, ...(reason === undefined ? {} : { reason: reason as CompanionFeedbackReason | null }) };
    }
    default:
      throw invalidRequest('action must be one of: seen, snooze, dismiss, mute, restore, feedback');
  }
}

function checkSources(value: unknown): CompanionConfigurableSource[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > COMPANION_CONFIGURABLE_SOURCES.length
    || !value.every((kind) => COMPANION_CONFIGURABLE_SOURCES.includes(kind as CompanionConfigurableSource))) {
    throw invalidRequest(`sources must be a list of: ${COMPANION_CONFIGURABLE_SOURCES.join(', ')}`);
  }
  return [...new Set(value as CompanionConfigurableSource[])];
}

/** Refusals answer `{ error, code }`; anything unexpected is logged without request content. */
function handle(fn: (req: Request, res: Response) => Promise<void> | void): RequestHandler {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (res.headersSent) return;
      if (error instanceof CompanionError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      log.warn('http', 'companion request failed', { method: req.method, path: req.path, err: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: 'The Companion is not available', code: 'internal' });
    }
  };
}

function openSse(res: Response): ReturnType<typeof createSseObserver> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  return createSseObserver(res);
}

export interface CompanionRouterDeps {
  /**
   * The Companion's live side (service.ts's no-op until the coordinator
   * runs). Its checkNow throws errors.ts notOwner() where this process does
   * not hold the scheduler lease: Check now answers 409 `not_owner`.
   */
  service: () => CompanionService;
  events?: CompanionEventBus;
  clock?: CompanionClock;
  /**
   * The conversation waits on the user: an approval or a question in its
   * running turn (server.ts asks chatHub). The tray's "<name> is waiting for
   * you"; without it, never.
   */
  conversationWaiting?: (nodeId: string) => boolean;
  /**
   * A settings change resumed Michi (`paused: false`): server.ts retries the
   * Pages upkeep that stopped itself, as POST /meta-agent/resume does.
   */
  resumed?: () => void;
  /**
   * A settings change turned Michi off (`paused: true`, Q29): server.ts stops
   * the turn its conversation `nodeId` runs, denying an approval it waits for.
   */
  turnedOff?: (nodeId: string) => Promise<unknown> | void;
  /**
   * Get started's Start begins the Pages first run through this
   * (metaAgent/firstRun.ts startSpacesFirstRun for this machine's owner);
   * absent without scheduled jobs, where Start with workspace homes is refused.
   */
  startFirstRun?: () => void;
}

/**
 * The Companion (shared/src/companion.ts, DESIGN R2.17): its feed, goals,
 * notes, rules, reminders, cards, brief and settings, and its change stream.
 * Mounted under /api after the access middleware, in the desktop app only
 * (never in cloud mode).
 *
 *   GET    /companion                           → CompanionSnapshotDto; its conversation is V, the assistant's (created on first use)
 *   PATCH  /companion/settings                  partial CompanionSettings (Pause Michi: paused, pauseFor) → snapshot
 *   POST   /companion/check                     {sources?} → 202 {queued: true}; 409 not_owner in a process without the scheduler lease
 *   POST   /companion/items/seen                {ids ≤ 100} → 204
 *   POST   /companion/items/:id                 CompanionItemAction → CompanionItemDto
 *   POST   /companion/presence                  CompanionPresenceInput (a window's), or {systemIdleSeconds} (Electron main's) → 204
 *   POST   /companion/view                      {} → {catchUp} (the panel opened: messages read; "Since you left" after 30 min away)
 *   POST   /companion/welcome                   → {started: false}: there is no welcome turn any more (D17); kept for older windows
 *   POST   /companion/get-started               CompanionGetStartedInput → snapshot (Get started's Start); 409 scheduler_off
 *   POST   /companion/get-started/later         {} → snapshot (Not now)
 *   POST   /companion/off-notice                {} → 204: "Michi is off" was told (or Michi was found on), once
 *   POST   /companion/cards/:id/apply|dismiss   → CompanionCardDto; 409 card_not_pending / card_expired (with `card`); a failed Apply is 200 status failed
 *   PUT    /companion/notes                     {notes} → {notes, notesRevision} (the user's write, whatever the revision)
 *   PUT    /companion/rules                     {rules ≤ 2000} → {rules}
 *   POST   /companion/goals                     {text} → 201 goal;  PATCH /companion/goals/:id {text?, progress?} → goal;  DELETE → 204
 *   POST   /companion/reminders                 {text, at?, dailyAt?, itemId?, until?} → 201 reminder
 *   PATCH  /companion/reminders/:id             {status: active|paused} → reminder;  DELETE → 204 (cancelled)
 *   DELETE /companion/demotions/:subtype        → 204 (the feedback demotion is undone)
 *   POST   /companion/brief/curate              {text ≤ 500} → 204
 *   POST   /companion/brief/:id/feedback        {index, feedback} → brief
 *   POST   /companion/runs/:runId/undo          {} → CompanionRunUndoResult (Undo all of a check-in's changes; 404 for any other run)
 *   PATCH  /companion/delegations/:id           {autoSend: false} → CompanionDelegationDto (404 when there is none)
 *   GET    /companion/tray                      → CompanionTrayDto: the tray menu's data, titles only (DESIGN-v2 §5.1)
 *   PUT    /companion/chat-notification-level   {level: all|approval-only|off} → {level} (the renderer's pref, Settings ›
 *                                               Notifications: what the desktop notifier is sent, services/attention/notificationLevel.ts)
 *   GET    /companion/events                    SSE `companion_changed`; the first frame carries the current revision (reason `status`)
 *
 * Michi's notices are attention records (services/companion/notices.ts):
 * windows get them on the background feed, Electron main on its desktop feed
 * (routes/attention.ts), which also carries `companion_changed` for the tray.
 *
 * Bodies are validated strictly: unknown fields, bad values and oversized
 * text are refused with 400 `{ error, code }`.
 */
export function createCompanionRouter(deps: CompanionRouterDeps): Router {
  const router = Router();
  const events = deps.events ?? companionEvents;
  const clock = deps.clock ?? systemCompanionClock;
  router.use('/companion', desktopOnly, ...companionLocalOnly);

  // The one conversation the agent answers in and posts into (DESIGN-v2 §0.2): the assistant's current one.
  const conversation = (): CompanionConversationDto | null => {
    try {
      const assistant = ensureAssistant();
      return { workspaceId: assistant.workspaceId, nodeId: assistant.nodeId, assistant };
    } catch (error) {
      log.warn('http', 'companion conversation unavailable', { err: error instanceof Error ? error.message : String(error) });
      return null;
    }
  };

  const snapshot = (): CompanionSnapshotDto => {
    const service = deps.service();
    const current = conversation();
    const dto = snapshotDto({
      now: clock.now(),
      conversation: current,
      status: service.status?.(),
      // No live status: the engine does not run here, so no work of the Companion's own does either (B4). The
      // user's own reply in its conversation is not "Working…": nothing would tell this snapshot when it ends.
      working: false,
      // Without a live one, the snapshot shows the latest stored "Since you left".
      catchUp: service.catchUp?.(),
    });
    return { ...dto, getStarted: companionGetStarted(current?.nodeId ?? null), offNoticeAt: companionOffNoticeAt() };
  };

  router.get('/companion', handle((_req, res) => {
    res.json(snapshot());
  }));

  /**
   * The tray menu (DESIGN-v2 §5.1), which Electron main fetches after each
   * `companion_changed` frame on its feed: the panel's status line, badge
   * and welcome rule, from the same snapshot, and the open Needs you items
   * by title only. It does not make the conversation V the way GET
   * /companion does (a fetch from the menu bar must not create anything);
   * without V there is nothing to wait on.
   */
  router.get(COMPANION_TRAY_PATH, handle((_req, res) => {
    const service = deps.service();
    const now = clock.now();
    let nodeId: string | null = null;
    try {
      nodeId = currentAssistantNodeId();
    } catch {
      nodeId = null;
    }
    const base = snapshotDto({ now, conversation: null, status: service.status?.(), working: false, catchUp: null });
    const tray: CompanionTrayDto = companionTrayDto({ ...base, welcome: companionWelcomeState(nodeId) }, {
      now,
      conversationWaiting: nodeId !== null && (deps.conversationWaiting?.(nodeId) ?? false),
      lastViewedAt: getCompanionMetaNumber('companion:last_viewed_at'),
    });
    res.json(tray);
  }));

  // The renderer's notification level, so the desktop notifier shows by it while no window is open (DESIGN P4).
  router.put(COMPANION_CHAT_NOTIFICATION_LEVEL_PATH, handle((req, res) => {
    const input = body(req, ['level']);
    if (!isChatNotificationLevel(input.level)) throw invalidRequest(`level must be one of: ${CHAT_NOTIFICATION_LEVELS.join(', ')}`);
    setNotificationLevel(input.level);
    res.json({ level: input.level });
  }));

  router.patch('/companion/settings', handle((req, res) => {
    if (!isRecord(req.body)) throw invalidRequest('Request body must be a JSON object of settings');
    assertPublicCompanionSettingsPatch(req.body);
    const wasPaused = getCompanionSettings(clock.now()).paused;
    patchCompanionSettings(req.body, clock.now());
    events.emitChanged('settings');
    // Turned off just now: what its conversation runs stops at that moment, and only then (Q29).
    const nodeId = conversation()?.nodeId;
    if (req.body.paused === true && !wasPaused && nodeId && deps.turnedOff) {
      void Promise.resolve().then(() => deps.turnedOff!(nodeId)).catch((error: unknown) => {
        log.warn('http', 'stopping the conversation of Michi turned off failed', { err: error instanceof Error ? error.message : String(error) });
      });
    }
    if ((req.body.paused === false || req.body.enabled === true) && !getCompanionSettings(clock.now()).paused && deps.resumed) {
      try {
        deps.resumed();
      } catch (error) {
        log.warn('http', 'resuming Pages upkeep failed', { err: error instanceof Error ? error.message : String(error) });
      }
    }
    res.json(snapshot());
  }));

  router.post('/companion/check', handle((req, res) => {
    const input = body(req, ['sources']);
    const sources = checkSources(input.sources);
    assertPublicCompanionCheckSources(sources);
    deps.service().checkNow(sources);
    res.status(202).json({ queued: true });
  }));

  // Before /companion/items/:id, which would take "seen" for an id.
  router.post('/companion/items/seen', handle((req, res) => {
    const input = body(req, ['ids']);
    if (!Array.isArray(input.ids) || input.ids.length > MAX_SEEN_IDS || !input.ids.every(isId)) {
      throw invalidRequest(`ids must be a list of at most ${MAX_SEEN_IDS} item ids`);
    }
    if (markItemsSeen([...new Set(input.ids as string[])], clock.now()).length > 0) events.emitChanged('items');
    res.status(204).end();
  }));

  router.post('/companion/items/:id', handle((req, res) => {
    const id = idParam(req);
    const item = applyItemAction(id, itemAction(req), clock.now());
    events.emitChanged('items');
    res.json(item);
  }));

  router.post('/companion/presence', handle(async (req, res) => {
    // Electron main's system beacon: only how long the computer has been idle (DESIGN §3.2).
    if (isRecord(req.body) && 'systemIdleSeconds' in req.body) {
      const input = body(req, ['systemIdleSeconds']);
      const idle = input.systemIdleSeconds;
      if (typeof idle !== 'number' || !Number.isFinite(idle) || idle < 0) throw invalidRequest('systemIdleSeconds must be a number of seconds');
      await deps.service().onPresence({ active: false, companionFocused: false, lastInputAt: null, composing: false, systemIdleSeconds: idle });
      res.status(204).end();
      return;
    }
    const input = body(req, ['active', 'companionFocused', 'lastInputAt', 'composing', 'windowId']);
    const lastInputAt = input.lastInputAt;
    if (lastInputAt !== null && (typeof lastInputAt !== 'number' || !Number.isSafeInteger(lastInputAt) || lastInputAt < 0)) {
      throw invalidRequest('lastInputAt must be a time in epoch ms or null');
    }
    if (input.windowId !== undefined && (typeof input.windowId !== 'string' || !input.windowId || input.windowId.length > 200)) {
      throw invalidRequest('windowId must be a non-empty string of at most 200 characters');
    }
    await deps.service().onPresence({
      active: bool(input.active, 'active'),
      companionFocused: bool(input.companionFocused, 'companionFocused'),
      lastInputAt: lastInputAt as number | null,
      composing: input.composing === undefined ? false : bool(input.composing, 'composing'),
      ...(typeof input.windowId === 'string' ? { windowId: input.windowId } : {}),
    });
    res.status(204).end();
  }));

  router.post('/companion/view', handle((req, res) => {
    body(req, []);
    const view = recordCompanionView(clock.now());
    if (view.catchUp || view.hadUnread) events.emitChanged('catch_up');
    res.json({ catchUp: view.catchUp });
  }));

  // Get started's Start (D17) takes the welcome's place; a window from before it still asks here, and nothing starts.
  router.post('/companion/welcome', handle((req, res) => {
    body(req, []);
    res.json({ started: false });
  }));

  router.post('/companion/get-started', handle((req, res) => {
    const input = parseGetStartedInput(body(req, ['homes', 'watch']));
    const now = clock.now();
    startCompanionGetStarted(input, { startFirstRun: deps.startFirstRun ?? null, nodeId: conversation()?.nodeId ?? null, now });
    events.emitChanged('settings');
    // The outside sources just turned on take their first look now, not at the next poll.
    if (input.watch) {
      try { deps.service().checkNow(); } catch { /* another Michi process checks: its next poll looks */ }
    }
    res.json(snapshot());
  }));

  // Michi is off, said once (Q29), or it was found on: either way the notice never shows again, in any window.
  router.post('/companion/off-notice', handle((_req, res) => {
    markCompanionOffNotice(clock.now());
    events.emitChanged('settings');
    res.status(204).end();
  }));

  router.post('/companion/get-started/later', handle((req, res) => {
    body(req, []);
    postponeCompanionGetStarted(conversation()?.nodeId ?? null, clock.now());
    events.emitChanged('settings');
    res.json(snapshot());
  }));

  const decide = (decision: (id: string, now: number) => CompanionCardDecision | Promise<CompanionCardDecision>) => handle(async (req, res) => {
    body(req, []);
    const result = await decision(idParam(req), clock.now());
    if (result.outcome === 'not_pending') {
      res.status(409).json({ error: `This card was already ${result.card.status}`, code: 'card_not_pending', card: result.card });
      return;
    }
    events.emitChanged('cards');
    for (const reason of result.changed) events.emitChanged(reason);
    if (result.outcome === 'expired') {
      res.status(409).json({ error: 'This card expired before it was answered', code: 'card_expired', card: result.card });
      return;
    }
    res.json(result.card);
  });
  router.post('/companion/cards/:id/apply', decide(applyCompanionCard));
  router.post('/companion/cards/:id/dismiss', decide(dismissCompanionCard));

  router.put('/companion/notes', handle((req, res) => {
    const input = body(req, ['notes']);
    if (input.notes === undefined) throw invalidRequest('notes is required');
    const notes = setNotesByUser(input.notes);
    events.emitChanged('notes');
    res.json(notes);
  }));

  router.put('/companion/rules', handle((req, res) => {
    const input = body(req, ['rules']);
    if (input.rules === undefined) throw invalidRequest('rules is required');
    const rules = setCompanionRules(input.rules);
    events.emitChanged('rules');
    res.json({ rules });
  }));

  router.post('/companion/goals', handle((req, res) => {
    const input = body(req, ['text']);
    if (input.text === undefined) throw invalidRequest('text is required');
    const goal = addGoal(input.text, clock.now());
    events.emitChanged('goals');
    res.status(201).json(goal);
  }));

  router.patch('/companion/goals/:id', handle((req, res) => {
    const id = idParam(req);
    const input = body(req, ['text', 'progress']);
    if (input.text === undefined && input.progress === undefined) throw invalidRequest('text or progress is required');
    const goal = updateGoal(id, { text: input.text, progress: input.progress }, clock.now());
    events.emitChanged('goals');
    res.json(goal);
  }));

  router.delete('/companion/goals/:id', handle((req, res) => {
    const id = idParam(req);
    body(req, []);
    removeGoal(id, clock.now());
    events.emitChanged('goals');
    res.status(204).end();
  }));

  router.post('/companion/reminders', handle((req, res) => {
    const input = body(req, ['text', 'at', 'dailyAt', 'itemId', 'until']);
    if (input.text === undefined) throw invalidRequest('text is required');
    assertPublicCompanionWatch(input);
    const reminder = createReminder(input, clock.now());
    events.emitChanged('reminders');
    res.status(201).json(reminderDto(reminder));
  }));

  router.patch('/companion/reminders/:id', handle((req, res) => {
    const id = idParam(req);
    const input = body(req, ['status']);
    if (input.status !== 'active' && input.status !== 'paused') throw invalidRequest('status must be active or paused');
    if (input.status === 'active') assertPublicCompanionWatch(getReminder(id));
    const reminder = setReminderStatus(id, input.status);
    events.emitChanged('reminders');
    res.json(reminderDto(reminder));
  }));

  router.delete('/companion/reminders/:id', handle((req, res) => {
    const id = idParam(req);
    body(req, []);
    cancelReminder(id);
    events.emitChanged('reminders');
    res.status(204).end();
  }));

  router.delete('/companion/demotions/:subtype', handle((req, res) => {
    const { subtype } = req.params;
    body(req, []);
    if (!isCompanionItemSubtype(subtype)) throw invalidRequest('subtype is not a Companion item subtype');
    if (clearSubtypeDemotion(subtype, clock.now())) events.emitChanged('settings');
    res.status(204).end();
  }));

  router.post('/companion/brief/curate', handle((req, res) => {
    const input = body(req, ['text']);
    if (input.text === undefined) throw invalidRequest('text is required');
    setBriefCurate(input.text);
    res.status(204).end();
  }));

  router.post('/companion/brief/:id/feedback', handle((req, res) => {
    const id = idParam(req);
    const input = body(req, ['index', 'feedback']);
    if (typeof input.index !== 'number' || !Number.isInteger(input.index)) throw invalidRequest('index must be a card index');
    if (input.feedback !== null && input.feedback !== 'up' && input.feedback !== 'down') throw invalidRequest('feedback must be up, down or null');
    const brief = setBriefCardFeedback(id, input.index, input.feedback);
    events.emitChanged('brief');
    res.json(brief);
  }));

  // Undo all (DESIGN-v2 §2.7): only a check-in's run, the local owner's.
  router.post('/companion/runs/:id/undo', handle((req, res) => {
    const id = idParam(req);
    body(req, []);
    const undone = undoCompanionRun(id, clock.now());
    if (!undone) throw notFound('Check-in not found');
    for (const reason of ['activity', 'items', 'goals', 'conversation'] as const) events.emitChanged(reason);
    const result: CompanionRunUndoResult = { reverted: undone.reverted, conflicts: undone.conflicts };
    res.json(result);
  }));

  // "Ask before sending" back on for one followed conversation (DESIGN-v2 §8.1(d)): the body is exactly {autoSend: false}.
  router.patch(`${COMPANION_DELEGATIONS_PATH}/:id`, handle((req, res) => {
    const id = idParam(req);
    if (!isCompanionDelegationPatch(req.body)) throw invalidRequest('The body must be {"autoSend": false}');
    const delegation = stopDelegationAutoSend(id);
    if (!delegation) throw notFound('Delegation not found');
    events.emitChanged('activity');
    res.json(delegation);
  }));

  /**
   * Snapshot changes for renderer windows: the current revision first, then
   * one `companion_changed` frame per change. Closing the response only
   * detaches this subscriber. Reachable over the stream transport
   * (streamTransport.ts STREAM_PATH).
   */
  router.get(COMPANION_EVENTS_PATH, handle((_req, res) => {
    const revision = events.currentRevision();
    const observer = openSse(res);
    if (!observer.write(encodeCompanionChangedEvent({ type: 'companion_changed', revision, reason: 'status' }))) return;
    observer.addCleanup(events.subscribe({
      changed: (event) => { observer.write(encodeCompanionChangedEvent(event)); },
    }));
    observer.heartbeat(': keepalive\n\n', KEEPALIVE_MS);
  }));

  return router;
}
