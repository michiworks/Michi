/**
 * The Companion's default name and limits, on their own so the modules about
 * its messages (companionMessageMetadata.ts, companionThreadMessage.ts) read
 * them without companion.ts: chatStreamEvents.ts imports the metadata module,
 * and the runtime package vendors chatStreamEvents.ts with every module it
 * imports, so none of them may import companion.ts (W0b recheck A-2). This
 * module imports nothing; companion.ts re-exports both.
 */

/**
 * The name the agent goes by until the user names it (DESIGN-v2 Q4: "Michi",
 * what ⌘J and the Spaces window always called it). The default of
 * `CompanionSettings.displayName`; frontend/src/state/companion/companionName.ts
 * falls back to it while no snapshot has arrived. Every surface that shows the
 * name reads it through those two (W2: F1a, F1b, F2; the Tray via
 * CompanionTrayDto.displayName).
 */
export const DEFAULT_COMPANION_NAME = 'Michi';

/**
 * Minutes between the polls of code reviews and email (pipelines: twice
 * that): a constant, no longer a setting (unification P3).
 */
export const COMPANION_POLL_MINUTES = 5;

export const COMPANION_LIMITS = Object.freeze({
  minPollMinutes: 2,
  maxPollMinutes: 60,
  maxPipelineWatch: 25,
  maxGoals: 10,
  maxGoalChars: 500,
  maxNotesChars: 4000,
  maxBriefCards: 7,
  /** Michi's latest line for Home (Q45, CompanionHeadlineDto.text). */
  maxHeadlineChars: 120,
  /** Away this long, then back: catch-up. */
  catchUpAfterMinutes: 30,
  /** Worker report excerpt cap. */
  maxReportChars: 4000,
  maxRulesChars: 2000,
  hiddenTurnTimeoutMs: 180_000,
  privacyTtlDays: 7,
  awayModeAfterMinutes: 120,
  maxReminders: 20,

  // ── v2 (DESIGN-v2) ───────────────────────────────────────────────────────
  // §2.6.3: what one check-in may write to the user's Pages and databases
  // (W2-E's checkinPageGuard enforces these; W2-G1b's companion_edit_goal the goal one).
  /** Write tool calls one check-in may make (edit_page, create_page, edit_database, create_database, configure_database, open_task_database). */
  checkinMaxWriteCalls: 5,
  /** Blocks, rows and other targets one check-in may change in total. */
  checkinMaxChangedTargets: 40,
  /** Pages one check-in may create. */
  checkinMaxNewPages: 1,
  /** Databases one check-in may create. */
  checkinMaxNewDatabases: 1,
  /** Goals one check-in may add, reword or remove (companion_edit_goal); progress readings do not count. */
  checkinMaxGoalEdits: 3,
  /** Write tool calls all check-ins together may make per local day (counted in meta). */
  checkinMaxDailyWriteCalls: 20,
  /** §2.6.5: characters of the reason a check-in gives for a Today change (required) or a goal edit, as card reasons. */
  maxChangeReasonChars: 500,
  /** §2.7: the check-in changes to Today items and goals one snapshot lists (CompanionSnapshotDto.checkinChanges), newest first. */
  maxSnapshotCheckinChanges: 50,
  /** §3.5: posts the user's next turn is told about, newest first, among those not told yet (W2-G1b turnContext, W2-G1a listUntoldPosts). */
  maxUntoldPosts: 5,
  /** §3.6: the conversation's latest messages a check-in note quotes in [RECENT CONVERSATION] (W2-G1b). */
  recentConversationMessages: 6,
  /** §3.6: characters of that excerpt at most, after the scrubber (W2-G1b). */
  maxRecentConversationChars: 4000,
  // §4: session_send, the agent's follow-ups into conversations it started (W3-G2).
  /** Characters of one follow-up's body at most; formatCompanionThreadMessage (companionThreadMessage.ts) refuses a longer one. */
  maxSendChars: 4000,
  /** companion_session_send calls one user turn may make. */
  maxSessionSendsPerTurn: 3,
  /**
   * Follow-ups one check-in may make: one session.send card (which also
   * counts among the cards a turn may propose), or (Q1) one direct send to a
   * target whose permission choice is exactly `ask` (not `approve`:
   * companionCheckinMaySendDirectly in companionThreadMessage.ts).
   */
  maxSessionSendsPerCheckin: 1,
  /** session.send cards waiting on the user at once. */
  maxPendingSessionSendCards: 3,
  /** How long a session.send card can be applied. */
  sessionSendCardTtlMs: 6 * 60 * 60 * 1000,
  /** Follow-ups into one delegated conversation per local day. */
  maxDailySendsPerDelegation: 10,
  /** A delegation stops being followed after this long without a send or a report. */
  delegationIdleMs: 24 * 60 * 60 * 1000,
  /** ... and this long after it started, whatever happens. */
  delegationMaxAgeMs: 3 * 24 * 60 * 60 * 1000,
});
