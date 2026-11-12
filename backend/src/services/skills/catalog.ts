import fs from 'node:fs';
import path from 'node:path';
import {
  builtinSkillId,
  isValidSkillName,
  librarySkillId,
  runtimeSkillId,
  type AgentCommand,
  type SkillCatalogError,
  type SkillCatalogResponse,
  type SkillRuntimeInfo,
  type SkillSummary,
} from 'michi-shared';
import { SKILL_FILE_MAX_BYTES, type AgentRuntime, type RuntimeSkill, type RuntimeSkillListing } from 'michi-runtime';
import { listRuntimes } from '../../agents/registry';
import { log } from '../logger';
import { isWithinRoot } from '../../agents/tools/pathSandbox';
import { listBuiltinSkills, type BuiltinSkill } from './builtin';
import { realpathOrSelf } from './files';
import { listLibrarySkills, type LibrarySkill } from './library';
import { syncSkillMounts } from './mounts';
import { skillLibraryRoot, skillMountsRoot, skillsAvailable } from './paths';
import { disabledLibrarySkills } from './state';

/**
 * The skill catalog: the library, Michi's built-in skills, and the skills each registered runtime
 * finds for a workspace folder. The REST API, the composer's / menu and the
 * message route read runtime skills through the same listings.
 *
 * A listing may start a process (a Codex app-server, a Claude initialize
 * probe), so the last one a runtime gave is kept per owner and folder and
 * served at once; after staleMs the next request also asks the runtime
 * again in the background. A caller waits at most timeoutMs for a listing,
 * and one that answers later still lands here. The two catalogs wait only
 * catalogWaitMs, so library skills and commands never wait for a runtime:
 * a listing still running then is reported as pending until it is
 * timeoutMs old. A failed listing never replaces one that answered. Until
 * one answers, its failure is the answer for a catalog with no listing to
 * show, even while the next listing runs, and the Skills page hears of it
 * beside the listing it keeps. A refresh (↻) hides the listing it replaces
 * from the Skills page only.
 */

const DEFAULT_TIMING = { timeoutMs: 10_000, staleMs: 30_000, catalogWaitMs: 1_500 };
const timing = { ...DEFAULT_TIMING };
/** A listing still unsettled after this is given up, so the next request asks again. */
const LISTING_ABANDON_MS = 120_000;
const FOLDERS_PER_RUNTIME_MAX = 64;
const LISTING_ERRORS_MAX = 20;
const ERROR_TEXT_MAX = 500;

type SkillLister = Pick<AgentRuntime, 'id' | 'listSkills'>;

interface CachedListing {
  /** The last listing the runtime gave. */
  listing?: RuntimeSkillListing;
  listedAt: number;
  /** Why the newest listing asked for failed; cleared when one answers or a refresh asks anew. */
  failure?: string;
  /** The newest listing in flight, shared by every caller, and when it was asked for. */
  pending?: Promise<RuntimeSkillListing>;
  pendingSince: number;
  /** The listing in flight is a refresh: until it settles, the Skills page waits for it instead of taking `listing`. */
  refreshing: boolean;
  /** Listings land in the order they were asked for: an older one never replaces a newer. */
  asked: number;
  landed: number;
}

/** Per runtime instance: a runtime registered again starts empty. */
const caches = new WeakMap<object, Map<string, CachedListing>>();

export interface RuntimeSkillListingOptions {
  /** The workspace folder. */
  cwd: string;
  ownerUserId?: string | null;
  /** Ask the runtime again, bypassing its own cache too. */
  refresh?: boolean;
}

export interface RuntimeSkillsResult {
  /** The newest listing the runtime gave for the folder; null when it never answered, or while pending. */
  listing: RuntimeSkillListing | null;
  /** A newer one is on its way: this one is older than staleMs, or a refresh is running. */
  stale: boolean;
  /** Why this request got no new listing: the runtime failed (now, or the last time with none answered since), or it took longer than timeoutMs. */
  error: string | null;
  /** `brief` only: the listing asked for had not answered within catalogWaitMs; a later request gets it. */
  pending: boolean;
}

interface ListingWait {
  /** A stale listing waits for its renewal too. */
  whenStale?: boolean;
  /** Wait at most catalogWaitMs, then report a listing still younger than timeoutMs as pending (the catalogs). */
  brief?: boolean;
  /**
   * What the newest listing says (the Skills page): a refresh still running
   * is waited for instead of the listing it replaces, and a listing that
   * failed after the cached one is reported with it.
   */
  latest?: boolean;
}

class ListingTimeout extends Error {}

function timeoutText(): string {
  return `Listing its skills took longer than ${Math.round(timing.timeoutMs / 1000)} seconds`;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > ERROR_TEXT_MAX ? `${text.slice(0, ERROR_TEXT_MAX - 1)}…` : text;
}

function isRuntimeSkill(value: unknown): value is RuntimeSkill {
  if (!value || typeof value !== 'object') return false;
  const skill = value as Partial<RuntimeSkill>;
  return typeof skill.name === 'string' && skill.name.trim() !== '' && typeof skill.description === 'string';
}

/**
 * A runtime that loads Michi's mounts reports library skills as its own
 * (Codex extra roots, a Kiro workspace folder). They are the library's, so
 * they are listed once, as library skills.
 */
function isLibraryCopy(skill: RuntimeSkill, roots: readonly string[]): boolean {
  if (!skill.path) return false;
  if (isWithinRoot(path.resolve(skill.path), skillMountsRoot())) return true;
  const real = realpathOrSelf(skill.path);
  return roots.some((root) => isWithinRoot(real, root));
}

function normalizeListing(value: RuntimeSkillListing): RuntimeSkillListing {
  const roots = [realpathOrSelf(skillLibraryRoot()), realpathOrSelf(skillMountsRoot())];
  const skills = (Array.isArray(value?.skills) ? value.skills : []).filter(isRuntimeSkill)
    .filter((skill) => !isLibraryCopy(skill, roots));
  const errors = (Array.isArray(value?.errors) ? value.errors : []).filter((error): error is string => typeof error === 'string');
  return { skills, ...(errors.length ? { errors } : {}) };
}

function cacheEntry(runtime: SkillLister, key: string): CachedListing {
  const entries = caches.get(runtime) ?? new Map<string, CachedListing>();
  caches.set(runtime, entries);
  const entry = entries.get(key) ?? { listedAt: 0, pendingSince: 0, refreshing: false, asked: 0, landed: 0 };
  // Most recently used last, so the oldest folder goes first.
  entries.delete(key);
  entries.set(key, entry);
  while (entries.size > FOLDERS_PER_RUNTIME_MAX) entries.delete(entries.keys().next().value!);
  return entry;
}

/** The listing in flight, or a new one; `refresh` always asks anew. It lands in the entry whenever it answers. */
function fetchListing(runtime: SkillLister, entry: CachedListing, options: RuntimeSkillListingOptions): Promise<RuntimeSkillListing> {
  if (entry.pending && !options.refresh) return entry.pending;
  const order = ++entry.asked;
  const signal = AbortSignal.timeout(LISTING_ABANDON_MS);
  const abandoned = new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('The runtime never finished listing its skills')), { once: true });
  });
  const pending = Promise.race([
    Promise.resolve().then(() => runtime.listSkills!({
      cwd: options.cwd,
      ownerUserId: options.ownerUserId ?? null,
      ...(options.refresh ? { refresh: true } : {}),
      signal,
    })),
    abandoned,
  ]).then(normalizeListing);
  entry.pending = pending;
  entry.pendingSince = Date.now();
  entry.refreshing = options.refresh === true;
  if (options.refresh) entry.failure = undefined;
  pending.then((listing) => {
    if (order < entry.landed) return;
    entry.landed = order;
    entry.listing = listing;
    entry.listedAt = Date.now();
    entry.failure = undefined;
  }, (error) => {
    log.warn('workspace', 'a runtime could not list its skills', { runtimeId: runtime.id, error: errorText(error) });
    // A listing asked for since then tells for itself.
    if (order === entry.asked) entry.failure = errorText(error);
  }).finally(() => {
    if (entry.pending !== pending) return;
    entry.pending = undefined;
    entry.refreshing = false;
  });
  return pending;
}

function waitAtMost<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ListingTimeout(timeoutText())), ms);
  });
  return Promise.race([promise, timedOut]).finally(() => clearTimeout(timer));
}

/**
 * The skills a runtime finds for a folder: the cached listing at once
 * (renewed in the background when stale), else the runtime's answer within
 * timeoutMs, or within catalogWaitMs with `wait.brief`.
 */
export async function listRuntimeSkills(
  runtime: SkillLister,
  options: RuntimeSkillListingOptions,
  wait: ListingWait = {},
): Promise<RuntimeSkillsResult> {
  if (!runtime.listSkills) return { listing: { skills: [] }, stale: false, error: null, pending: false };
  const entry = cacheEntry(runtime, `${options.ownerUserId ?? ''}\u0000${options.cwd}`);
  const cached = options.refresh || (entry.refreshing && wait.latest) ? undefined : entry.listing;
  const stale = !!cached && (entry.refreshing || Date.now() - entry.listedAt >= timing.staleMs);
  if (cached && !(stale && wait.whenStale)) {
    if (stale) fetchListing(runtime, entry, options).catch(() => { /* reported when it fails */ });
    return { listing: cached, stale, error: wait.latest ? entry.failure ?? null : null, pending: false };
  }
  const failed = options.refresh ? undefined : entry.failure;
  const listing = fetchListing(runtime, entry, options);
  // A brief wait ends at catalogWaitMs, or where the listing in flight turns timeoutMs old.
  const left = Math.max(0, entry.pendingSince + timing.timeoutMs - Date.now());
  const ms = wait.brief ? Math.min(timing.catalogWaitMs, left) : timing.timeoutMs;
  try {
    return { listing: await waitAtMost(listing, ms), stale: false, error: null, pending: false };
  } catch (error) {
    if (error instanceof ListingTimeout && wait.brief && ms < left) {
      // The listing before this one failed and none has answered since: that is the answer until this one lands.
      return failed
        ? { listing: entry.listing ?? null, stale: !!entry.listing, error: failed, pending: false }
        : { listing: null, stale: false, error: null, pending: true };
    }
    return { listing: entry.listing ?? null, stale: !!entry.listing, error: errorText(error), pending: false };
  }
}

/** The catalog id of a skill a runtime reported. */
export function runtimeSkillIdOf(runtimeId: string, skill: RuntimeSkill): string {
  return runtimeSkillId(runtimeId, skill.scope, skill.nativeName ?? skill.name);
}

/**
 * The listed skill a catalog id names, or null when the runtime's listing
 * has none. A stale listing that lacks it waits for its renewal first (a
 * refresh still running among them). Throws the listing's error when the
 * runtime could not say: the skill may well exist.
 */
export async function findListedRuntimeSkill(
  runtime: SkillLister,
  options: RuntimeSkillListingOptions,
  id: string,
): Promise<RuntimeSkill | null> {
  const find = (listing: RuntimeSkillListing | null) => listing?.skills.find((skill) => runtimeSkillIdOf(runtime.id, skill) === id) ?? null;
  let result = await listRuntimeSkills(runtime, options);
  if (!find(result.listing) && result.stale) result = await listRuntimeSkills(runtime, options, { whenStale: true });
  const skill = find(result.listing);
  if (!skill && result.error) throw new Error(result.error);
  return skill;
}

export function librarySkillSummary(skill: LibrarySkill): SkillSummary {
  return {
    id: librarySkillId(skill.name),
    name: skill.name,
    description: skill.description,
    origin: 'library',
    path: skill.path,
    ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
    userInvocable: skill.userInvocable,
    modelInvocable: skill.modelInvocable,
    enabled: skill.enabled,
    ...(skill.linkTarget ? { linkTarget: skill.linkTarget } : {}),
  };
}

export function builtinSkillSummary(skill: BuiltinSkill): SkillSummary {
  return {
    id: builtinSkillId(skill.name),
    name: skill.name,
    description: skill.description,
    origin: 'builtin',
    ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
    userInvocable: skill.userInvocable,
    modelInvocable: skill.modelInvocable,
    managedBy: 'Michi',
    enabled: skill.enabled,
  };
}

export function runtimeSkillSummary(runtimeId: string, skill: RuntimeSkill): SkillSummary {
  return {
    id: runtimeSkillIdOf(runtimeId, skill),
    name: skill.name,
    description: skill.description,
    origin: 'runtime',
    runtimeId,
    ...(skill.scope ? { scope: skill.scope } : {}),
    ...(skill.pluginId ? { pluginId: skill.pluginId } : {}),
    ...(skill.nativeName ? { nativeName: skill.nativeName } : {}),
    ...(skill.path ? { path: skill.path } : {}),
    ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
    userInvocable: skill.userInvocable !== false,
    modelInvocable: skill.modelInvocable !== false,
    ...(skill.managedBy ? { managedBy: skill.managedBy } : {}),
    enabled: skill.enabled !== false,
  };
}

/** Folders in the library that cannot be used, frontmatter worth fixing and an unreadable state file, for the Skills page. */
function libraryProblems(skills: readonly LibrarySkill[]): SkillCatalogError[] {
  const problems: SkillCatalogError[] = [];
  if (disabledLibrarySkills() === null) {
    problems.push({ message: 'skills-state.json could not be read, so every library skill is off until the file is repaired or removed.' });
  }
  let entries: string[];
  try { entries = fs.readdirSync(skillLibraryRoot()).sort(); }
  catch { entries = []; }
  const listed = new Set(skills.map((skill) => skill.name));
  const isFolder = (entry: string) => {
    try { return fs.statSync(path.join(skillLibraryRoot(), entry)).isDirectory(); } catch { return false; }
  };
  for (const entry of entries) {
    if (entry.startsWith('.') || listed.has(entry) || !isFolder(entry)) continue;
    problems.push({
      message: isValidSkillName(entry)
        ? `${entry}: no readable SKILL.md (at most ${SKILL_FILE_MAX_BYTES / 1024} KiB), so Michi skips this folder`
        : `${entry}: not a skill name (lowercase letters, digits and single hyphens), so Michi skips this folder`,
    });
  }
  for (const skill of skills) {
    for (const warning of skill.warnings) problems.push({ message: `${skill.name}: ${warning}` });
  }
  return problems;
}

function isAvailable(runtime: AgentRuntime): boolean {
  try {
    return runtime.checkAvailability?.().available !== false;
  } catch {
    // As /agent/status does: a failing probe does not hide the runtime.
    return true;
  }
}

function runtimeInfo(runtime: AgentRuntime): SkillRuntimeInfo {
  return { id: runtime.id, label: runtime.label, available: isAvailable(runtime) };
}

interface RuntimeEntries {
  skills: SkillSummary[];
  errors: SkillCatalogError[];
  /** Its listing is still running (RuntimeSkillsResult.pending). */
  pending: boolean;
}

/**
 * A runtime's part of a catalog, waiting briefly. An error is `failed` when
 * none of its skills are in the answer; a listing that failed after an
 * earlier one answered keeps that one, and the listing's own problems
 * (one unreadable SKILL.md, a plugin that did not load) are notes.
 */
async function runtimeEntries(runtime: AgentRuntime, options: RuntimeSkillListingOptions, wait: ListingWait = {}): Promise<RuntimeEntries> {
  const { listing, error, pending } = await listRuntimeSkills(runtime, options, { ...wait, brief: true });
  const seen = new Set<string>();
  const skills: SkillSummary[] = [];
  for (const skill of listing?.skills ?? []) {
    const summary = runtimeSkillSummary(runtime.id, skill);
    if (seen.has(summary.id)) continue;
    seen.add(summary.id);
    skills.push(summary);
  }
  const errors: SkillCatalogError[] = [];
  if (error && !listing) errors.push({ runtimeId: runtime.id, message: error, failed: true });
  if (error && listing) errors.push({ runtimeId: runtime.id, message: `${error}; these are the skills it listed before`, stale: true });
  for (const message of (listing?.errors ?? []).slice(0, LISTING_ERRORS_MAX)) {
    errors.push({ runtimeId: runtime.id, message: errorText(message) });
  }
  return { skills, errors, pending };
}

/**
 * The commands a cold chat on `runtime` runs (AgentRuntime.hostCommands),
 * without skills: a runtime that names one wrongly must not shadow a skill.
 */
function hostCommands(runtime: AgentRuntime): AgentCommand[] {
  try {
    return (runtime.hostCommands?.() ?? []).filter((command) => !command.kind || command.kind === 'command');
  } catch (error) {
    log.warn('workspace', 'a runtime could not name its commands', { runtimeId: runtime.id, error: errorText(error) });
    return [];
  }
}

export interface SkillCatalogInput {
  /** The workspace folder; without one only library skills are listed. */
  cwd: string | null;
  ownerUserId?: string | null;
  refresh?: boolean;
}

/** Everything for the Skills page: the library, the built-in skills, then each available runtime's own skills. */
export async function listSkillCatalog(input: SkillCatalogInput): Promise<SkillCatalogResponse> {
  // Skill folders added to the library by hand reach the runtimes' mounts here, too.
  syncSkillMounts();
  const library = listLibrarySkills();
  const skills = [...library.map(librarySkillSummary), ...listBuiltinSkills().map(builtinSkillSummary)];
  const errors = libraryProblems(library);
  const listers = listRuntimes().filter((runtime) => runtime.listSkills);
  const runtimes = listers.map(runtimeInfo);
  const pending: string[] = [];
  if (input.cwd) {
    const options = { cwd: input.cwd, ownerUserId: input.ownerUserId ?? null, refresh: input.refresh === true };
    const available = listers.filter((_runtime, index) => runtimes[index].available);
    const results = await Promise.all(available.map((runtime) => runtimeEntries(runtime, options, { latest: true })));
    results.forEach((result, index) => {
      skills.push(...result.skills);
      errors.push(...result.errors);
      if (result.pending) pending.push(available[index].id);
    });
  }
  return { skills, errors, libraryAvailable: true, libraryPath: skillLibraryRoot(), runtimes, ...(pending.length ? { pending } : {}) };
}

/**
 * What the / menu needs on one runtime: the enabled, user-invocable library
 * and built-in skills, every skill of the runtime with its flags (the menu offers the
 * runnable ones and knows the rest when a live session lists them), and
 * the commands it runs. Cloud mode offers only the commands.
 */
export async function runtimeSkillCatalog(runtime: AgentRuntime, input: SkillCatalogInput): Promise<SkillCatalogResponse> {
  const info = runtimeInfo(runtime);
  if (!skillsAvailable()) return { skills: [], errors: [], libraryAvailable: false, runtimes: [info], commands: hostCommands(runtime) };
  syncSkillMounts();
  const skills = [...listLibrarySkills().map(librarySkillSummary), ...listBuiltinSkills().map(builtinSkillSummary)]
    .filter((skill) => skill.enabled && skill.userInvocable);
  const errors: SkillCatalogError[] = [];
  let pending = false;
  if (input.cwd && runtime.listSkills && info.available) {
    const result = await runtimeEntries(runtime, { cwd: input.cwd, ownerUserId: input.ownerUserId ?? null });
    skills.push(...result.skills);
    errors.push(...result.errors);
    pending = result.pending;
  }
  return {
    skills,
    errors,
    libraryAvailable: true,
    runtimes: [info],
    ...(pending ? { pending: [runtime.id] } : {}),
    commands: hostCommands(runtime),
  };
}

/**
 * Test hook: shorter limits, or the defaults again without an argument.
 * @testonly
 */
export function setSkillListingTimingForTests(next?: Partial<typeof DEFAULT_TIMING>): void {
  Object.assign(timing, DEFAULT_TIMING, next);
}
