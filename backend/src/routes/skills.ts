import path from 'node:path';
import express, { type Request, type Response } from 'express';
import { isValidSkillName, parseSkillId, type SkillDetail } from 'michi-shared';
import { getRuntime } from '../agents/registry';
import { log } from '../services/logger';
import { builtinSkillSummary, findListedRuntimeSkill, librarySkillSummary, listSkillCatalog, runtimeSkillCatalog, runtimeSkillSummary } from '../services/skills/catalog';
import { getBuiltinSkill } from '../services/skills/builtin';
import { listSkillFiles, readSkillMarkdown } from '../services/skills/files';
import { getLibrarySkill, readLibrarySkillContent } from '../services/skills/library';
import {
  createLibrarySkill,
  deleteLibrarySkill,
  setBuiltinSkillEnabled,
  SkillLibraryError,
  updateLibrarySkill,
  type SkillLibraryErrorCode,
} from '../services/skills/manage';
import { skillsAvailable } from '../services/skills/paths';
import { workspaceSkillFolder } from '../services/skills/workspaceCwd';
import { jsonConfigErrorResponse } from './jsonConfigErrorResponse';
import { localOnlyGuard } from './middleware/localOnly';
import { requireRequestAccess } from './middleware/sessionAccess';

/**
 * Michi Skills REST API (frontend/src/services/api/skills.ts): the skill
 * library this backend keeps, the built-in skills it ships, the skills its runtimes find for a workspace
 * folder, and the catalog of the composer's / menu.
 *
 * Reads are owner-scoped like the memory routes: a workspace must be the
 * caller's own, and the folder comes from its row, never from the request.
 * Writes change files on this machine, so, as for the assistant, only its
 * own app or its authenticated remote owner may make them. Paths in
 * responses are ones the backend resolved; no request names a file. Cloud
 * mode keeps no library and lists no host skills: every route answers 404
 * skills_unavailable, except the / menu's catalog, which still names the
 * commands a cold chat's runtime runs.
 */

const libraryWriter = localOnlyGuard('The skill library can be changed only from this machine or by its authenticated remote owner', { allowAuthenticatedRemote: true });

const STATUS_FOR_CODE: Record<SkillLibraryErrorCode, number> = {
  invalid_argument: 400,
  invalid_skill: 400,
  not_found: 404,
  skills_unavailable: 404,
  name_taken: 409,
  // The runtime's listing failed or timed out; asking again later may work.
  runtime_unavailable: 503,
};

const ID_MAX = 1024;

function badRequest(message: string): SkillLibraryError {
  return new SkillLibraryError('invalid_argument', message);
}

function notFound(message = 'Skill not found'): SkillLibraryError {
  return new SkillLibraryError('not_found', message);
}

function route(fn: (req: Request, res: Response) => Promise<void> | void) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res);
    } catch (error) {
      if (error instanceof SkillLibraryError) {
        res.status(STATUS_FOR_CODE[error.code]).json({
          error: error.message,
          code: error.code,
          ...(error.code === 'invalid_skill' ? { problems: error.problems } : {}),
        });
        return;
      }
      const configError = jsonConfigErrorResponse(error);
      if (configError) {
        res.status(configError.status).json(configError.body);
        return;
      }
      log.error('http', 'skills request failed', { method: req.method, path: req.path, error: (error as Error).message });
      res.status(500).json({ error: 'Skills request failed' });
    }
  };
}

/** A JSON object body holding only `allowed` keys. */
function jsonBody(req: Request, allowed: readonly string[]): Record<string, unknown> {
  const body: unknown = req.body ?? {};
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw badRequest('Request body must be a JSON object');
  const unknownKey = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknownKey) throw badRequest(`Unsupported field: ${unknownKey}`);
  return body as Record<string, unknown>;
}

function queryString(req: Request, name: string): string | undefined {
  const value = req.query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw badRequest(`${name} must be given once`);
  return value.trim() || undefined;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw badRequest(`${key} must be a string`);
  return value;
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw badRequest(`${key} must be true or false`);
  return value;
}

function skillIdOf(value: unknown): string {
  if (typeof value !== 'string' || value.length > ID_MAX || !parseSkillId(value)) throw badRequest('id is not a skill id');
  return value;
}

function owner(req: Request): string | null {
  return req.user?.id ?? null;
}

/** The folder the workspace's chats run in; undefined without a workspace; not_found for one that is not the caller's. */
function workspaceFolder(req: Request, workspaceId: unknown): string | null | undefined {
  if (workspaceId === undefined) return undefined;
  if (typeof workspaceId !== 'string' || !workspaceId.trim() || workspaceId.length > 200) throw badRequest('workspaceId is invalid');
  const workspace = workspaceSkillFolder(workspaceId.trim(), owner(req));
  if (!workspace) throw notFound('Workspace not found');
  return workspace.cwd;
}

async function skillDetail(req: Request, id: string, cwd: string | null | undefined): Promise<SkillDetail> {
  const parsed = parseSkillId(id);
  if (parsed?.kind === 'library') {
    const skill = getLibrarySkill(parsed.name);
    const content = skill ? readLibrarySkillContent(skill.name) : null;
    if (!skill || content === null) throw notFound();
    return { ...librarySkillSummary(skill), content, files: listSkillFiles(skill.dir) };
  }
  if (parsed?.kind === 'builtin') {
    const skill = getBuiltinSkill(parsed.name);
    if (!skill) throw notFound();
    return { ...builtinSkillSummary(skill), content: skill.content, files: [] };
  }
  const runtime = parsed?.kind === 'runtime' ? getRuntime(parsed.runtimeId) : undefined;
  if (!runtime?.listSkills || !cwd) throw notFound();
  let skill;
  try {
    skill = await findListedRuntimeSkill(runtime, { cwd, ownerUserId: owner(req) }, id);
  } catch (error) {
    throw new SkillLibraryError('runtime_unavailable', `${runtime.label} couldn’t list its skills: ${(error as Error).message}`);
  }
  if (!skill) throw notFound();
  // A lone command file's folder holds other commands, not this skill's files.
  const folder = skill.path && path.basename(skill.path) === 'SKILL.md' ? path.dirname(skill.path) : null;
  return {
    ...runtimeSkillSummary(runtime.id, skill),
    content: (skill.path && readSkillMarkdown(skill.path)) || '',
    files: folder ? listSkillFiles(folder) : [],
  };
}

export function setupSkillRoutes(): express.Router {
  const router = express.Router();
  router.use('/skills', requireRequestAccess, (req, res, next) => {
    if (!skillsAvailable() && !(req.method === 'GET' && req.path === '/catalog')) {
      res.status(404).json({ error: 'Skills are not available on this backend', code: 'skills_unavailable' });
      return;
    }
    next();
  });

  // The Skills page: the library, then each runtime's own skills for the workspace folder.
  router.get('/skills', route(async (req, res) => {
    const cwd = workspaceFolder(req, queryString(req, 'workspaceId'));
    res.json(await listSkillCatalog({ cwd: cwd ?? null, ownerUserId: owner(req), refresh: queryString(req, 'refresh') === '1' }));
  }));

  // The / menu of one runtime in one workspace.
  router.get('/skills/catalog', route(async (req, res) => {
    const runtimeId = queryString(req, 'runtimeId');
    const workspaceId = queryString(req, 'workspaceId');
    if (!runtimeId || !workspaceId) throw badRequest('runtimeId and workspaceId are required');
    const runtime = getRuntime(runtimeId);
    if (!runtime) throw notFound('Runtime not found');
    const cwd = workspaceFolder(req, workspaceId);
    res.json(await runtimeSkillCatalog(runtime, { cwd: cwd ?? null, ownerUserId: owner(req) }));
  }));

  router.get('/skills/detail', route(async (req, res) => {
    const id = skillIdOf(queryString(req, 'id'));
    res.json({ skill: await skillDetail(req, id, workspaceFolder(req, queryString(req, 'workspaceId'))) });
  }));

  router.post('/skills/library', ...libraryWriter, route((req, res) => {
    const body = jsonBody(req, ['name', 'content']);
    const name = optionalString(body, 'name');
    const content = optionalString(body, 'content');
    if (name === undefined || content === undefined) throw badRequest('name and content are required');
    res.status(201).json({ skill: librarySkillSummary(createLibrarySkill(name, content)) });
  }));

  router.put('/skills/library/:name', ...libraryWriter, route((req, res) => {
    const name = String(req.params.name ?? '');
    if (!isValidSkillName(name)) throw notFound(`No library skill named "${name}"`);
    const body = jsonBody(req, ['content', 'newName', 'enabled']);
    const content = optionalString(body, 'content');
    const newName = optionalString(body, 'newName');
    const enabled = optionalBoolean(body, 'enabled');
    const skill = updateLibrarySkill(name, {
      ...(content !== undefined ? { content } : {}),
      ...(newName !== undefined ? { newName } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    });
    res.json({ skill: librarySkillSummary(skill) });
  }));

  // A built-in skill can only be turned on or off.
  router.put('/skills/builtin/:name', ...libraryWriter, route((req, res) => {
    const name = String(req.params.name ?? '');
    if (!isValidSkillName(name)) throw notFound(`No built-in skill named "${name}"`);
    const enabled = optionalBoolean(jsonBody(req, ['enabled']), 'enabled');
    if (enabled === undefined) throw badRequest('enabled is required');
    res.json({ skill: builtinSkillSummary(setBuiltinSkillEnabled(name, enabled)) });
  }));

  router.delete('/skills/library/:name', ...libraryWriter, route((req, res) => {
    deleteLibrarySkill(String(req.params.name ?? ''));
    res.status(204).end();
  }));

  return router;
}
