import { Router } from 'express';
import type { Request } from 'express';
import { HOME_CONVERSATION_LIST_LIMITS, HOME_SECTION_KEYS, PAGE_BLOCK_LIMITS, THREAD_STATE_LIMITS, type HomeSectionKey } from 'michi-shared';
import { LOCAL_AGENT_OWNER_ID } from '../services/agentOwner';
import { PageWriteError } from '../services/pages/core';
import {
  getSpacesHome, getWorkspaceHome, listWorkspaceHomes, setWorkspaceHomeHidden,
} from '../services/pages/homePages';
import {
  actOnHomeReminder, getSpacesHomeLook, homeConversations, homeSections, markSpacesHomeLooked, threadCards, threadStates, type HomeLiveWaitReader,
} from '../services/pages/homeSections';
import { allTasks, editAllTasksViews } from '../services/pages/allTasks';
import { spaceActivity } from '../services/pages/homeActivity';
import { homeSource } from '../services/pages/homeSources';
import { addLayoutRule, deleteLayoutRule, getLayoutPreferences, listLayoutRules, saveLayoutPreferences } from '../services/pages/layoutRules';
import {
  createProgressCard, dismissProgressCard, listHomeProgressCards, listPageProgressCards, markProgressCardSeen,
} from '../services/pages/progressCards';
import { pageBody as body, pageErrors, pageId as id, pageQuery as query, route } from './pageRouteKit';

const owner = (req: Request): string => (req as Request & { user?: { id?: string } }).user?.id ?? LOCAL_AGENT_OWNER_ID;
const integer = (value: unknown, name: string): number => {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n)) throw new PageWriteError(400, 'invalid', `Invalid ${name}`);
  return n;
};

export interface SpacesHomeRouteDeps {
  /** What a running conversation waits for (ChatHub's pending approval or question); none without it. */
  liveWait?: HomeLiveWaitReader;
  clock?: () => number;
}

/** `a,b,c`: the conversations a page's thread cards name, at most a block's worth. */
const nodeIdList = (value: unknown): string[] => {
  if (typeof value !== 'string') throw new PageWriteError(400, 'invalid', 'Invalid nodeIds');
  const ids = value.split(',').map((part) => id(part, 'nodeIds'));
  if (ids.length > PAGE_BLOCK_LIMITS.threadNodes) throw new PageWriteError(400, 'invalid', 'Too many nodeIds');
  return ids;
};

/** The conversations a task board names, each once: at most a board's worth. */
const stateIdList = (value: unknown): string[] => {
  if (!Array.isArray(value)) throw new PageWriteError(400, 'invalid', 'Invalid nodeIds');
  const ids = value.map((item) => id(item, 'nodeIds'));
  if (ids.length > THREAD_STATE_LIMITS.nodeIds) throw new PageWriteError(400, 'invalid', 'Too many nodeIds');
  if (new Set(ids).size !== ids.length) throw new PageWriteError(400, 'invalid', 'Duplicate nodeIds');
  return ids;
};

const sectionKey = (value: unknown): HomeSectionKey | null => {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !HOME_SECTION_KEYS.includes(value as HomeSectionKey)) throw new PageWriteError(400, 'invalid', 'Invalid state');
  return value as HomeSectionKey;
};

/** Spaces Home, workspace home pages, layout rules, Home sections, Space activity and progress cards. Mount at /api. */
export function setupSpacesHomeRoutes(deps: SpacesHomeRouteDeps = {}): Router {
  const router = Router();
  const now = () => (deps.clock ?? Date.now)();

  router.get('/spaces-home', route((req, res) => {
    query(req, []);
    res.json(getSpacesHome(owner(req), now()));
  }));
  router.get('/spaces-home/workspaces', route((req, res) => {
    query(req, []);
    res.json({ items: listWorkspaceHomes(owner(req)) });
  }));
  router.get('/spaces-home/sections', route((req, res) => {
    query(req, ['since']);
    const since = req.query.since === undefined ? undefined : integer(req.query.since, 'since');
    res.json(homeSections({ ownerUserId: owner(req), since, now: now(), live: deps.liveWait }));
  }));
  router.post('/spaces-home/reminders', route((req, res) => {
    query(req, []);
    const data = body(req, ['itemId', 'version', 'action']);
    if (data.action !== 'dismiss' && data.action !== 'snooze' && data.action !== 'restore') throw new PageWriteError(400, 'invalid', 'Invalid action');
    actOnHomeReminder({ ownerUserId: owner(req), itemId: id(data.itemId, 'itemId'), version: id(data.version, 'version'), action: data.action, now: now(), live: deps.liveWait });
    res.json({ ok: true });
  }));
  router.get('/spaces-home/conversations', route((req, res) => {
    query(req, ['state', 'limit', 'workspaceId']);
    const limit = req.query.limit === undefined ? undefined : integer(req.query.limit, 'limit');
    if (limit !== undefined && (limit < 1 || limit > HOME_CONVERSATION_LIST_LIMITS.max)) throw new PageWriteError(400, 'invalid', 'Invalid limit');
    const workspaceId = req.query.workspaceId === undefined ? undefined : id(req.query.workspaceId, 'workspaceId');
    res.json(homeConversations({ ownerUserId: owner(req), state: sectionKey(req.query.state), limit, now: now(), live: deps.liveWait, ...(workspaceId ? { workspaceId } : {}) }));
  }));
  router.get('/spaces-home/thread-cards', route((req, res) => {
    query(req, ['workspaceId', 'nodeIds']);
    res.json({ items: threadCards({ ownerUserId: owner(req), workspaceId: id(req.query.workspaceId, 'workspaceId'), nodeIds: nodeIdList(req.query.nodeIds), now: now(), live: deps.liveWait }) });
  }));
  router.post('/spaces-home/thread-states', route((req, res) => {
    query(req, []);
    const data = body(req, ['nodeIds']);
    res.json({ items: threadStates({ ownerUserId: owner(req), nodeIds: stateIdList(data.nodeIds), now: now(), live: deps.liveWait }) });
  }));
  router.get('/spaces-home/all-tasks', route((req, res) => {
    query(req, []);
    res.json(allTasks(owner(req)));
  }));
  router.post('/spaces-home/all-tasks/views', route((req, res) => {
    query(req, []);
    const data = body(req, ['revision', 'ops']);
    if (typeof data.revision !== 'number') throw new PageWriteError(400, 'invalid', 'Invalid revision');
    res.json(editAllTasksViews({ ownerUserId: owner(req), revision: data.revision, ops: data.ops, now: now() }));
  }));
  router.get('/spaces-home/look', route((req, res) => {
    query(req, []);
    res.json(getSpacesHomeLook(owner(req)));
  }));
  router.post('/spaces-home/look', route((req, res) => {
    query(req, []);
    body(req, []);
    res.json(markSpacesHomeLooked(owner(req), now()));
  }));
  router.get('/spaces-home/activity', route((req, res) => {
    query(req, ['limit']);
    const limit = req.query.limit === undefined ? undefined : integer(req.query.limit, 'limit');
    res.json({ items: spaceActivity(owner(req), { limit, now: now() }) });
  }));
  router.get('/spaces-home/source', route((req, res) => {
    query(req, ['nodeId', 'messageId']);
    const opt = (name: string) => req.query[name] === undefined ? undefined : id(req.query[name], name);
    res.json(homeSource({ ownerUserId: owner(req), nodeId: opt('nodeId'), messageId: opt('messageId') }));
  }));
  router.get('/spaces-home/progress-cards', route((req, res) => {
    query(req, []);
    res.json({ items: listHomeProgressCards(owner(req), now()) });
  }));

  router.get('/workspaces/:workspaceId/home', route((req, res) => {
    query(req, []);
    res.json(getWorkspaceHome(id(req.params.workspaceId, 'workspaceId'), owner(req), now()));
  }));
  router.patch('/workspaces/:workspaceId/home', route((req, res) => {
    query(req, []);
    const data = body(req, ['hidden']);
    if (typeof data.hidden !== 'boolean') throw new PageWriteError(400, 'invalid', 'hidden must be true or false');
    res.json(setWorkspaceHomeHidden(id(req.params.workspaceId, 'workspaceId'), owner(req), data.hidden, now()));
  }));

  router.get('/pages/:pageId/layout-preferences', route((req, res) => {
    query(req, []);
    res.json(getLayoutPreferences(id(req.params.pageId, 'pageId'), owner(req)));
  }));
  router.put('/pages/:pageId/layout-preferences', route((req, res) => {
    query(req, []);
    const data = body(req, ['text', 'expectedRevision']);
    res.json(saveLayoutPreferences({ pageId: id(req.params.pageId, 'pageId'), ownerUserId: owner(req),
      text: data.text, expectedRevision: data.expectedRevision, actor: 'user', now: now() }));
  }));
  router.get('/pages/:pageId/layout-rules', route((req, res) => {
    query(req, []);
    res.json({ items: listLayoutRules(id(req.params.pageId, 'pageId'), owner(req)) });
  }));
  router.post('/pages/:pageId/layout-rules', route((req, res) => {
    query(req, []);
    const data = body(req, ['text', 'sourceMessage', 'sectionLimit']);
    res.status(201).json(addLayoutRule({ pageId: id(req.params.pageId, 'pageId'), ownerUserId: owner(req),
      text: data.text, sourceMessage: data.sourceMessage, sectionLimit: data.sectionLimit, createdBy: 'user', now: now() }));
  }));
  router.delete('/pages/:pageId/layout-rules/:ruleId', route((req, res) => {
    query(req, []);
    body(req, []);
    res.json({ items: deleteLayoutRule(id(req.params.pageId, 'pageId'), owner(req), id(req.params.ruleId, 'ruleId'), now()) });
  }));

  router.get('/pages/:pageId/progress-cards', route((req, res) => {
    query(req, []);
    res.json({ items: listPageProgressCards(id(req.params.pageId, 'pageId'), owner(req), now()) });
  }));
  router.post('/progress-cards', route((req, res) => {
    query(req, []);
    const data = body(req, ['threadNodeId', 'startedFromPageId']);
    res.status(201).json(createProgressCard({ ownerUserId: owner(req), threadNodeId: id(data.threadNodeId, 'threadNodeId'),
      startedFromPageId: id(data.startedFromPageId, 'startedFromPageId'), now: now() }));
  }));
  router.post('/progress-cards/:threadNodeId/seen', route((req, res) => {
    query(req, []);
    body(req, []);
    res.json(markProgressCardSeen(owner(req), id(req.params.threadNodeId, 'threadNodeId'), now()));
  }));
  router.post('/progress-cards/:threadNodeId/dismiss', route((req, res) => {
    query(req, []);
    body(req, []);
    res.json(dismissProgressCard(owner(req), id(req.params.threadNodeId, 'threadNodeId'), now()));
  }));

  router.use(pageErrors('Unable to complete Spaces Home request'));
  return router;
}
