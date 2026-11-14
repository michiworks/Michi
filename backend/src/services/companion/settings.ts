/**
 * The Companion's settings: one JSON value in `meta` (`companion:settings`),
 * read as DEFAULT_COMPANION_SETTINGS with every valid stored field on top, so
 * a field added later starts at its default and a hand-edited bad value falls
 * back to it. A patch (PATCH /companion/settings, an applied card) is
 * validated strictly: an unknown field or a bad value refuses the whole patch
 * and nothing is written. Nested objects merge; the pipeline watch list and
 * the workdays are replaced. Callers always get their own copy.
 *
 * migrateCompanionSettingsV2 turns the MVP's stored default name into the v2
 * one, once, when the assistant's v2 data migration runs (DESIGN-v2 §8.1(c)).
 *
 * `enabled`, `paused` and `pausedUntil` are not stored here: they read Pause
 * Michi (services/michiPause.ts), which a patch's `paused` (true: until
 * resumed; false: resume) or `pauseFor` sets. migrateCompanionPause turned the
 * stored `enabled`/`paused` into it once; they stay stored, unread, for a
 * version to go back to.
 *
 * Turning a source on forgets that source's baseline, so its next successful poll is a baseline again (DESIGN R2.5):
 * what it finds then is what was already there, never news. Changing what a
 * source watches does the same for what the change brings into view (A5):
 * the CR source watching another account starts over (its snapshots go too),
 * and a scope that grows (reviews, favorites, a pipeline added to the watch
 * list) reopens the source's first look for the objects it had not seen.
 */

import os from 'node:os';
import {
  COMPANION_CONFIGURABLE_SOURCES,
  COMPANION_HEARTBEAT_MINUTES,
  COMPANION_LIMITS,
  DEFAULT_COMPANION_NAME,
  DEFAULT_COMPANION_SETTINGS,
  LEGACY_DEFAULT_COMPANION_NAME,
  REASONING_LEVELS,
  isCompanionClock,
  isReasoningLevel,
  type CompanionConfigurableSource,
  type CompanionHeartbeatMinutes,
  type CompanionSettings,
  type CompanionSourceKind,
  type MichiPauseFor,
  type RuntimeReasoning,
  MICHI_PAUSE_FOR,
  michiPauseEnd,
} from 'michi-shared';
import { LOCAL_AGENT_OWNER_ID } from '../agentOwner';
import { getDb } from '../db';
import { michiPause, pauseMichi, resumeMichi } from '../michiPause';
import { CompanionError } from './errors';

const SETTINGS_KEY = 'companion:settings';

/**
 * The `meta` key that records a source's baseline poll (R2.5); repository.ts
 * reads and writes it, this module forgets it when the source is turned on
 * and reopens it when what the source watches grows.
 */
export const companionBaselineMetaKey = (source: CompanionSourceKind) => `companion:baseline:${source}` as const;

/**
 * A source's baseline record (the value under companionBaselineMetaKey):
 * `at` is when it was made; `open` means the source's first look is still
 * open for objects it has not seen yet, since `at` (its baseline poll was
 * incomplete, or what it watches grew then). repository.applySourcePoll
 * closes it.
 */
export interface CompanionBaselineRecord {
  at: number;
  open: boolean;
}

const OPEN_PREFIX = 'open:';

export function companionBaselineValue(record: CompanionBaselineRecord): string {
  const at = String(Math.floor(record.at));
  return record.open ? `${OPEN_PREFIX}${at}` : at;
}

/** Reads a stored baseline record; anything unreadable is a plain baseline (it was written before records had a form). */
export function parseCompanionBaselineValue(value: string): CompanionBaselineRecord {
  const open = value.startsWith(OPEN_PREFIX);
  const at = Number(open ? value.slice(OPEN_PREFIX.length) : value);
  return { at: Number.isFinite(at) ? at : 0, open };
}

/** A change to some settings: nested objects merge, `sources.pipeline.watch`, `brief.days` and `workdays` replace the list. */
export interface CompanionSettingsPatch {
  /** Pause Michi: true until resumed, false resumes. */
  paused?: boolean;
  /** The Companion's old off switch, for one version: false pauses Michi until resumed, true resumes. */
  enabled?: boolean;
  /** Pause Michi for a while (michiPauseEnd). */
  pauseFor?: MichiPauseFor;
  displayName?: string;
  sources?: { [K in CompanionConfigurableSource]?: Partial<CompanionSettings['sources'][K]> };
  pollMinutes?: number;
  heartbeat?: Partial<CompanionSettings['heartbeat']>;
  brief?: Partial<CompanionSettings['brief']>;
  quietHours?: Partial<CompanionSettings['quietHours']>;
  workdays?: number[];
  /** DESIGN-v2 §6: the reasoning check-ins and new conversations use; null: the default (the lower of the global one and high). */
  reasoning?: RuntimeReasoning | null;
}

export const COMPANION_NAME_MAX_CHARS = 40;
/** A code review account name: it becomes part of a URL path, so nothing else gets in. */
const ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** A pipeline name: it reaches a tool argument and a builds.example.com URL. */
const PIPELINE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

const invalid = (message: string) => new CompanionError(400, 'invalid_settings', message);

/** A short, single-line rendering of a refused value for an error message. */
function shown(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  const line = text.replace(/\s+/g, ' ');
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
}

// ── Field rules ─────────────────────────────────────────────────────────────

type Parse = (value: unknown, path: string) => unknown;
interface Group { fields: Record<string, Parse | Group> }

const group = (fields: Record<string, Parse | Group>): Group => ({ fields });

const bool: Parse = (value, path) => {
  if (typeof value !== 'boolean') throw invalid(`${path} must be true or false`);
  return value;
};

const wholeNumber = (min: number, max: number): Parse => (value, path) => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalid(`${path} must be a whole number from ${min} to ${max}`);
  }
  return value;
};

const oneOf = <T extends string | number>(allowed: readonly T[]): Parse => (value, path) => {
  if (!(allowed as readonly unknown[]).includes(value)) throw invalid(`${path} must be one of: ${allowed.join(', ')}`);
  return value;
};

/** A reasoning level, or null for the default (DESIGN-v2 §6). */
const reasoning: Parse = (value, path) => {
  if (value === null || isReasoningLevel(value)) return value;
  throw invalid(`${path} must be null (the default) or one of: ${REASONING_LEVELS.join(', ')}`);
};

const clock: Parse = (value, path) => {
  if (!isCompanionClock(value)) throw invalid(`${path} must be a time as HH:MM (24-hour), not ${shown(value)}`);
  return value;
};

/** 1-40 characters on one line; inner whitespace collapses to single spaces. */
export function parseCompanionName(value: unknown, path = 'displayName'): string {
  if (typeof value !== 'string') throw invalid(`${path} must be text`);
  const name = value.replace(/\s+/g, ' ').trim();
  if (CONTROL.test(name)) throw invalid(`${path} cannot contain control characters`);
  if (name.length < 1 || name.length > COMPANION_NAME_MAX_CHARS) throw invalid(`${path} must be 1 to ${COMPANION_NAME_MAX_CHARS} characters`);
  return name;
}

/** This computer's account name, when it can be a code review account name: the CR source's account when the alias setting is null. */
export function localAccountAlias(): string | null {
  try {
    const name = os.userInfo().username.trim().toLowerCase();
    return ALIAS.test(name) ? name : null;
  } catch {
    return null;
  }
}

/** The account whose CRs the CR source watches: the alias setting, else `defaultAlias` (this computer's account name). */
export function effectiveCrAlias(settings: CompanionSettings, defaultAlias: () => string | null = localAccountAlias): string | null {
  return settings.sources.cr.alias ?? defaultAlias();
}

/** null or blank: the local account name. */
const alias: Parse = (value, path) => {
  if (value === null) return null;
  if (typeof value !== 'string') throw invalid(`${path} must be a code review account name or null`);
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '') return null;
  if (!ALIAS.test(trimmed)) throw invalid(`${path} must be a code review account name (letters, digits, ".", "_" or "-"), not ${shown(value)}`);
  return trimmed;
};

/** Trimmed, de-duplicated pipeline names in the given order, at most COMPANION_LIMITS.maxPipelineWatch. */
export function parsePipelineNames(value: unknown, path = 'sources.pipeline.watch'): string[] {
  if (!Array.isArray(value)) throw invalid(`${path} must be a list of pipeline names`);
  const names: string[] = [];
  for (const entry of value) {
    const name = typeof entry === 'string' ? entry.trim() : entry;
    if (typeof name !== 'string' || !PIPELINE_NAME.test(name)) {
      throw invalid(`${path}: ${shown(entry)} is not a pipeline name (letters, digits, ".", "_", "+" or "-", at most 128)`);
    }
    if (!names.includes(name)) names.push(name);
  }
  if (names.length > COMPANION_LIMITS.maxPipelineWatch) throw invalid(`${path} can hold at most ${COMPANION_LIMITS.maxPipelineWatch} pipelines`);
  return names;
}

/**
 * Local weekdays (0 = Sunday … 6 = Saturday), de-duplicated and in week
 * order; at least one (the brief's days: off is brief.enabled).
 */
export function parseCompanionWorkdays(value: unknown, path = 'workdays'): number[] {
  if (!Array.isArray(value)) throw invalid(`${path} must be a list of weekdays (0 = Sunday … 6 = Saturday)`);
  const days = new Set<number>();
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0 || entry > 6) {
      throw invalid(`${path}: ${shown(entry)} is not a weekday (a whole number from 0 = Sunday to 6 = Saturday)`);
    }
    days.add(entry);
  }
  if (days.size === 0) throw invalid(`${path} needs at least one day`);
  return [...days].sort((a, b) => a - b);
}

const SETTINGS = group({
  displayName: (value, path) => parseCompanionName(value, path),
  sources: group({
    michi: group({ enabled: bool }),
    cr: group({ enabled: bool, alias, includeReviews: bool }),
    pipeline: group({ enabled: bool, watch: (value, path) => parsePipelineNames(value, path), includeFavorites: bool }),
    email: group({ enabled: bool }),
    calendar: group({ enabled: bool }),
  }),
  pollMinutes: wholeNumber(COMPANION_LIMITS.minPollMinutes, COMPANION_LIMITS.maxPollMinutes),
  heartbeat: group({ enabled: bool, intervalMinutes: oneOf<CompanionHeartbeatMinutes>(COMPANION_HEARTBEAT_MINUTES) }),
  brief: group({ enabled: bool, time: clock, days: (value, path) => parseCompanionWorkdays(value, path) }),
  quietHours: group({ enabled: bool, start: clock, end: clock }),
  workdays: (value, path) => parseCompanionWorkdays(value, path),
  reasoning,
});

/**
 * Writes `raw`'s fields into `target` (a full settings object). Strict: an
 * unknown field, a non-object group or a bad value throws. Lenient (stored
 * values): those are skipped and the target keeps what it had.
 */
function apply(target: Record<string, unknown>, raw: unknown, spec: Group, path: string, strict: boolean): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (strict) throw invalid(`${path || 'settings'} must be an object`);
    return;
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const at = path ? `${path}.${key}` : key;
    const field = Object.prototype.hasOwnProperty.call(spec.fields, key) ? spec.fields[key] : undefined;
    if (!field) {
      if (strict) throw invalid(`unknown setting: ${at}`);
      continue;
    }
    if (value === undefined) continue;
    if (typeof field !== 'function') {
      apply(target[key] as Record<string, unknown>, value, field, at, strict);
      continue;
    }
    try {
      target[key] = field(value, at);
    } catch (error) {
      if (strict) throw error;
    }
  }
}

function stored(): unknown {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(SETTINGS_KEY) as { value: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return undefined;
  }
}

/**
 * DESIGN-v2 §8.1(c), run by W2-E's migrateAssistantV2 in its step 5 (one
 * transaction, guarded by `assistant:v2_merged_at`): reads and writes only
 * the stored settings row.
 * - No stored settings: nothing (the defaults already say DEFAULT_COMPANION_NAME).
 * - A stored displayName that is the MVP's default (LEGACY_DEFAULT_COMPANION_NAME,
 *   which MVP stored on every PATCH) becomes DEFAULT_COMPANION_NAME; any other
 *   stored name stays. A second run changes nothing.
 * - A stored row without `reasoning` gets `reasoning: null` (§7 step 5).
 */
export function migrateCompanionSettingsV2(): void {
  const raw = stored();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const settings = { ...(raw as Record<string, unknown>) };
  let changed = false;
  if (!Object.prototype.hasOwnProperty.call(settings, 'reasoning')) {
    settings.reasoning = null;
    changed = true;
  }
  if (settings.displayName === LEGACY_DEFAULT_COMPANION_NAME) {
    settings.displayName = DEFAULT_COMPANION_NAME;
    changed = true;
  }
  if (changed) getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(SETTINGS_KEY, JSON.stringify(settings));
}

const SOURCE_DEFAULTS_KEY = 'companion:source_defaults_v2';
/** The outside sources a new user starts without (D17): the Get started card's Watch turns them on. */
const OUTSIDE_SOURCES = ['cr', 'pipeline', 'email', 'calendar'] as const;

/**
 * Once, at boot before anything polls (server.ts): someone who has not met Michi yet
 * (no welcome, no message of theirs in V) and never saved a setting starts
 * with the outside sources off, so nothing outside Michi is read before Get
 * started's Start (unification design D17). Someone who met it keeps
 * watching what they watched. Later boots change nothing.
 */
export function settleCompanionSourceDefaults(met: boolean, now: number = Date.now()): void {
  const db = getDb();
  if (db.prepare('SELECT 1 FROM meta WHERE key = ?').get(SOURCE_DEFAULTS_KEY)) return;
  if (!met && stored() === undefined) {
    const settings = structuredClone(DEFAULT_COMPANION_SETTINGS);
    for (const kind of OUTSIDE_SOURCES) settings.sources[kind].enabled = false;
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(SETTINGS_KEY, JSON.stringify(settings));
  }
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(SOURCE_DEFAULTS_KEY, String(Math.floor(now)));
}

/**
 * DESIGN §5 P2: the Companion's own off switch and pause become Pause Michi,
 * once (guarded by PAUSE_MERGED_KEY): stored `enabled: false` or `paused:
 * true` pauses Michi until resumed. A Michi that is already paused stays so.
 */
const PAUSE_MERGED_KEY = 'companion:pause_merged_at';

export function migrateCompanionPause(now: number = Date.now()): void {
  const db = getDb();
  if (db.prepare('SELECT 1 FROM meta WHERE key = ?').get(PAUSE_MERGED_KEY)) return;
  const raw = stored() as { enabled?: unknown; paused?: unknown } | undefined;
  db.exec('SAVEPOINT companion_pause_merge');
  try {
    if (raw && typeof raw === 'object' && (raw.enabled === false || raw.paused === true)
      && !michiPause(LOCAL_AGENT_OWNER_ID, now).paused) pauseMichi(LOCAL_AGENT_OWNER_ID, null);
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(PAUSE_MERGED_KEY, String(Math.floor(now)));
    db.exec('RELEASE SAVEPOINT companion_pause_merge');
  } catch (error) {
    db.exec('ROLLBACK TO SAVEPOINT companion_pause_merge');
    db.exec('RELEASE SAVEPOINT companion_pause_merge');
    throw error;
  }
}

/**
 * The sources Michi does not watch now (conv-3): those turned off.
 * [COMPANION CONTEXT], the hidden notes and companion_items / check_now say so
 * instead of answering for them as if there were nothing there.
 */
export function companionSourcesOff(settings: Pick<CompanionSettings, 'sources'>): CompanionConfigurableSource[] {
  return COMPANION_CONFIGURABLE_SOURCES.filter((kind) => !settings.sources[kind].enabled);
}

/**
 * The brief's days as stored, or null when there are none to read (P3:
 * settings from before them read the old workdays as the brief's days).
 */
function storedBriefDays(raw: unknown): number[] | null {
  const brief = raw && typeof raw === 'object' ? (raw as { brief?: unknown }).brief : undefined;
  const days = brief && typeof brief === 'object' ? (brief as { days?: unknown }).days : undefined;
  if (days === undefined) return null;
  try {
    return parseCompanionWorkdays(days);
  } catch {
    return null;
  }
}

/** The current settings: the defaults with every valid stored field applied, and Pause Michi at `now`. A fresh copy each call. */
export function getCompanionSettings(now: number = Date.now()): CompanionSettings {
  const settings = structuredClone(DEFAULT_COMPANION_SETTINGS);
  const raw = stored();
  apply(settings as unknown as Record<string, unknown>, raw, SETTINGS, '', false);
  if (storedBriefDays(raw) === null) settings.brief.days = [...settings.workdays];
  const pause = michiPause(LOCAL_AGENT_OWNER_ID, now);
  return { ...settings, enabled: true, paused: pause.paused, pausedUntil: pause.until };
}

/**
 * A patch's Pause Michi change: undefined for none, null to resume, else when
 * it ends (`until` null: when resumed). Pausing wins over resuming, so the old
 * off switch (`enabled: false`) holds whatever `paused` says.
 */
function pauseOf(patch: Record<string, unknown>, now: number): { until: number | null } | null | undefined {
  const { paused, enabled, pauseFor } = patch;
  if (paused !== undefined && typeof paused !== 'boolean') throw invalid('paused must be true or false');
  if (enabled !== undefined && typeof enabled !== 'boolean') throw invalid('enabled must be true or false');
  if (pauseFor !== undefined && !(MICHI_PAUSE_FOR as readonly unknown[]).includes(pauseFor)) {
    throw invalid(`pauseFor must be one of: ${MICHI_PAUSE_FOR.join(', ')}`);
  }
  if (pauseFor !== undefined) return { until: michiPauseEnd(pauseFor as MichiPauseFor, now) };
  if (paused === true || enabled === false) return { until: null };
  if (paused === false || enabled === true) return null;
  return undefined;
}

function splitPatch(patch: unknown, now: number): { rest: Record<string, unknown>; pause: { until: number | null } | null | undefined } {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid('settings must be an object');
  const { paused: _paused, enabled: _enabled, pauseFor: _pauseFor, ...rest } = patch as Record<string, unknown>;
  return { rest, pause: pauseOf(patch as Record<string, unknown>, now) };
}

/** The settings with `patch` applied; throws CompanionError (invalid_settings) without writing anything. */
export function previewCompanionSettings(patch: unknown, now: number = Date.now()): CompanionSettings {
  const { rest, pause } = splitPatch(patch, now);
  const next = getCompanionSettings(now);
  apply(next as unknown as Record<string, unknown>, rest, SETTINGS, '', true);
  if (pause !== undefined) {
    next.paused = pause !== null;
    next.pausedUntil = pause?.until ?? null;
  }
  const quiet = (patch as { quietHours?: Record<string, unknown> }).quietHours;
  if ((quiet?.start !== undefined || quiet?.end !== undefined) && next.quietHours.start === next.quietHours.end) {
    throw invalid('quietHours.start and quietHours.end must differ');
  }
  return next;
}

/** The sources whose baseline a change from `before` to `after` forgets: each source turned on. */
export function sourcesTurnedOn(before: CompanionSettings, after: CompanionSettings): CompanionConfigurableSource[] {
  return COMPANION_CONFIGURABLE_SOURCES.filter((kind) => after.sources[kind].enabled && !before.sources[kind].enabled);
}

/**
 * The CR source watches another account after the change (A5): the effective
 * alias moved (null and this computer's account name are the same account).
 */
export function crAccountChanged(before: CompanionSettings, after: CompanionSettings, defaultAlias: () => string | null = localAccountAlias): boolean {
  return effectiveCrAlias(before, defaultAlias) !== effectiveCrAlias(after, defaultAlias);
}

/**
 * The sources that watch more after the change (A5): the CR source with its
 * review list turned on; the pipeline source with favorites turned on or a
 * pipeline added to its watch list. Watching less is not here: what left the
 * scope goes the usual way (two complete polls without it, R2.4).
 */
export function sourcesWidened(before: CompanionSettings, after: CompanionSettings): CompanionConfigurableSource[] {
  const widened: CompanionConfigurableSource[] = [];
  if (after.sources.cr.includeReviews && !before.sources.cr.includeReviews) widened.push('cr');
  const pipeline = after.sources.pipeline;
  if ((pipeline.includeFavorites && !before.sources.pipeline.includeFavorites)
    || pipeline.watch.some((name) => !before.sources.pipeline.watch.includes(name))) widened.push('pipeline');
  return widened;
}

/**
 * Validates and applies a settings change; returns the new settings. In the
 * same savepoint, a source turned on forgets its baseline (R2.5); the CR
 * source watching another account forgets its baseline and its snapshots,
 * which describe the other account (A5); and a source that watches more
 * reopens its first look from `now` for the objects it has not seen
 * (repository.applySourcePoll), unless a baseline is still to come anyway.
 */
export function patchCompanionSettings(patch: unknown, now: number = Date.now()): CompanionSettings {
  const before = getCompanionSettings(now);
  const next = previewCompanionSettings(patch, now);
  const { pause } = splitPatch(patch, now);
  // Pause Michi is not stored here; what an older version reads as its own switches stays as it was.
  const { enabled: _enabled, paused: _paused, pausedUntil: _until, ...kept } = next;
  const raw = stored() as Record<string, unknown> | undefined;
  const legacy = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? Object.fromEntries((['enabled', 'paused'] as const).filter((key) => key in raw).map((key) => [key, raw[key]])) : {};
  const db = getDb();
  const forget = db.prepare('DELETE FROM meta WHERE key = ?');
  // Only a baseline that exists reopens: without one, the next poll is a whole baseline anyway.
  const reopen = db.prepare('UPDATE meta SET value = ? WHERE key = ?');
  db.exec('SAVEPOINT companion_settings');
  try {
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(SETTINGS_KEY, JSON.stringify({ ...kept, ...legacy }));
    if (pause === null) resumeMichi(LOCAL_AGENT_OWNER_ID);
    else if (pause !== undefined) pauseMichi(LOCAL_AGENT_OWNER_ID, pause.until);
    for (const kind of sourcesTurnedOn(before, next)) forget.run(companionBaselineMetaKey(kind));
    if (crAccountChanged(before, next)) {
      forget.run(companionBaselineMetaKey('cr'));
      db.prepare('DELETE FROM companion_snapshots WHERE owner_user_id = ? AND source = ?').run(LOCAL_AGENT_OWNER_ID, 'cr');
    }
    for (const kind of sourcesWidened(before, next)) {
      reopen.run(companionBaselineValue({ at: now, open: true }), companionBaselineMetaKey(kind));
    }
    db.exec('RELEASE SAVEPOINT companion_settings');
  } catch (error) {
    db.exec('ROLLBACK TO SAVEPOINT companion_settings');
    db.exec('RELEASE SAVEPOINT companion_settings');
    throw error;
  }
  return structuredClone(next);
}
