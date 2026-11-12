import { parseAgentCommands, type SkillCatalogResponse, type SkillDetail, type SkillRuntimeInfo, type SkillSummary } from 'michi-shared';
import { serverEntityId } from '../../config/backendIdentity';
import { backendApiBase, LOCAL_BACKEND_CONNECTION_ID, workspaceBackendApiBase } from '../../config/backendConnections';
import { backendFetch } from './backendRequest';

// Michi Skills on one backend (backend/src/routes/skills.ts): the skill
// library it keeps, the skills each runtime there finds for a workspace
// folder, and the catalog the composer's / menu offers for one runtime.
// A backend without these routes answers 404 with no code; callers show
// that as unavailable rather than as a failure.

/** Dispatched in this window after a write to the library, so every catalog here refetches. */
export const SKILLS_CHANGED_EVENT = 'michi:skills-changed';

export function notifySkillsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SKILLS_CHANGED_EVENT));
}

export class SkillsApiError extends Error {
  readonly status: number;
  /** skills_unavailable, not_found, runtime_unavailable, invalid_skill, name_taken, ... when the backend named one. */
  readonly code: string | null;
  /** Validation problems for invalid_skill. */
  readonly problems: string[];
  /** This backend has no such route. */
  readonly unavailable: boolean;
  constructor(status: number, message: string, options: { code?: string | null; problems?: string[] } = {}) {
    super(message);
    this.name = 'SkillsApiError';
    this.status = status;
    this.code = options.code ?? null;
    this.problems = options.problems ?? [];
    this.unavailable = (status === 404 && !options.code) || this.code === 'skills_unavailable';
  }
}

export function isSkillsUnavailable(error: unknown): boolean {
  return error instanceof SkillsApiError && error.unavailable;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSkillSummary(value: unknown): value is SkillSummary {
  return isObject(value) && typeof value.id === 'string' && typeof value.name === 'string'
    && typeof value.description === 'string' && (value.origin === 'library' || value.origin === 'builtin' || value.origin === 'runtime')
    && typeof value.userInvocable === 'boolean' && typeof value.modelInvocable === 'boolean' && typeof value.enabled === 'boolean';
}

function isSkillDetail(value: unknown): value is SkillDetail {
  return isSkillSummary(value) && typeof (value as unknown as Record<string, unknown>).content === 'string'
    && Array.isArray((value as unknown as Record<string, unknown>).files);
}

async function request(url: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<unknown> {
  const response = await backendFetch(url, {
    ...(init.signal ? { signal: init.signal } : {}),
    ...(init.method ? { method: init.method } : {}),
    ...(init.body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : {}),
  });
  if (response.status === 204) return null;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = isObject(body) && typeof body.code === 'string' ? body.code : null;
    const message = isObject(body) && typeof body.error === 'string' ? body.error : `Skills request failed (${response.status})`;
    const problems = isObject(body) && Array.isArray(body.problems) ? body.problems.filter((p): p is string => typeof p === 'string') : [];
    throw new SkillsApiError(response.status, message, { code, problems });
  }
  return body;
}

function isRuntimeInfo(value: unknown): value is SkillRuntimeInfo {
  return isObject(value) && typeof value.id === 'string' && typeof value.label === 'string' && typeof value.available === 'boolean';
}

function catalogOf(body: unknown): SkillCatalogResponse {
  if (!isObject(body) || !Array.isArray(body.skills) || !Array.isArray(body.errors) || typeof body.libraryAvailable !== 'boolean') {
    throw new SkillsApiError(200, 'Unexpected skills response', { code: 'skills_unavailable' });
  }
  return {
    skills: body.skills.filter(isSkillSummary),
    errors: body.errors.flatMap((error) => isObject(error) && typeof error.message === 'string'
      ? [{
        message: error.message,
        ...(typeof error.runtimeId === 'string' ? { runtimeId: error.runtimeId } : {}),
        ...(error.failed === true ? { failed: true } : {}),
        ...(error.stale === true ? { stale: true } : {}),
      }] : []),
    libraryAvailable: body.libraryAvailable,
    ...(typeof body.libraryPath === 'string' && body.libraryPath ? { libraryPath: body.libraryPath } : {}),
    ...(Array.isArray(body.runtimes) ? { runtimes: body.runtimes.filter(isRuntimeInfo) } : {}),
    ...(Array.isArray(body.pending) ? { pending: body.pending.filter((id): id is string => typeof id === 'string') } : {}),
    ...(Array.isArray(body.commands) ? { commands: parseAgentCommands(body.commands) } : {}),
  };
}

function summaryOf(body: unknown): SkillSummary {
  const skill = isObject(body) ? body.skill : undefined;
  if (!isSkillSummary(skill)) throw new SkillsApiError(200, 'Unexpected skills response', { code: 'skills_unavailable' });
  return skill;
}

/** The backend a workspace lives on, or the given connection (default: this machine). */
function baseFor(target: { workspaceId?: string; backendConnectionId?: string }): string {
  return target.workspaceId ? workspaceBackendApiBase(target.workspaceId) : backendApiBase(target.backendConnectionId ?? LOCAL_BACKEND_CONNECTION_ID);
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : '';
}

export interface SkillsTarget {
  /** Lists project skills for this workspace's folder, on the backend it lives on. */
  workspaceId?: string;
  /** Without a workspace: which backend (default: this machine). */
  backendConnectionId?: string;
  signal?: AbortSignal;
}

/** Everything for the Skills page: the library, and each runtime's own skills for the workspace folder. */
export async function listSkills(target: SkillsTarget & { refresh?: boolean } = {}): Promise<SkillCatalogResponse> {
  const url = `${baseFor(target)}/skills${query({
    workspaceId: target.workspaceId ? serverEntityId(target.workspaceId) : undefined,
    refresh: target.refresh ? '1' : undefined,
  })}`;
  return catalogOf(await request(url, { signal: target.signal }));
}

/**
 * What the / menu offers in a chat on this runtime: the enabled library
 * skills and its own user-invocable skills, plus the commands it runs before
 * a live session lists them.
 */
export async function fetchSkillCatalog(target: SkillsTarget & { runtimeId: string; workspaceId: string }): Promise<SkillCatalogResponse> {
  const url = `${baseFor(target)}/skills/catalog${query({ runtimeId: target.runtimeId, workspaceId: serverEntityId(target.workspaceId) })}`;
  return catalogOf(await request(url, { signal: target.signal }));
}

export async function fetchSkillDetail(id: string, target: SkillsTarget = {}): Promise<SkillDetail> {
  const url = `${baseFor(target)}/skills/detail${query({ id, workspaceId: target.workspaceId ? serverEntityId(target.workspaceId) : undefined })}`;
  const body = await request(url, { signal: target.signal });
  const skill = isObject(body) ? body.skill : undefined;
  if (!isSkillDetail(skill)) throw new SkillsApiError(200, 'Unexpected skills response', { code: 'skills_unavailable' });
  return skill;
}

export interface LibrarySkillWrite {
  /** The whole SKILL.md; its frontmatter name must equal the skill's name. */
  content: string;
  enabled?: boolean;
}

/** Rejects with invalid_skill (problems listed) or name_taken. */
export async function createLibrarySkill(name: string, input: LibrarySkillWrite, target: Omit<SkillsTarget, 'workspaceId'> = {}): Promise<SkillSummary> {
  return summaryOf(await request(`${baseFor(target)}/skills/library`, { method: 'POST', body: { name, ...input }, signal: target.signal }));
}

/** Any subset; `newName` renames the folder (the content's name must then be the new name). */
export async function updateLibrarySkill(
  name: string,
  patch: Partial<LibrarySkillWrite> & { newName?: string },
  target: Omit<SkillsTarget, 'workspaceId'> = {},
): Promise<SkillSummary> {
  return summaryOf(await request(`${baseFor(target)}/skills/library/${encodeURIComponent(name)}`, { method: 'PUT', body: patch, signal: target.signal }));
}

/** A built-in skill can only be turned on or off. */
export async function setBuiltinSkillEnabled(name: string, enabled: boolean, target: Omit<SkillsTarget, 'workspaceId'> = {}): Promise<SkillSummary> {
  return summaryOf(await request(`${baseFor(target)}/skills/builtin/${encodeURIComponent(name)}`, { method: 'PUT', body: { enabled }, signal: target.signal }));
}

export async function deleteLibrarySkill(name: string, target: Omit<SkillsTarget, 'workspaceId'> = {}): Promise<void> {
  await request(`${baseFor(target)}/skills/library/${encodeURIComponent(name)}`, { method: 'DELETE', signal: target.signal });
}
