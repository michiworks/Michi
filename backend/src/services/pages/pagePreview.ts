import { randomBytes } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { containsTaskView } from 'michi-shared';
import { getDb } from '../db';
import { isLoopbackAddress } from '../remoteAccess';
import { getPage } from './repository';
import { PageWriteError } from './core';

/**
 * Read-only preview links that let an agent open one Page in its own browser
 * and look at it. The tool hands out
 * `http://127.0.0.1:<port>/api/page-preview/<ticket>`; opening it sets a
 * cookie for that ticket and redirects to the web UI's standalone page view.
 *
 * The ticket is a capability for one page, like the per-session MCP URL: it
 * is honoured only from loopback and only for GET reads of that page, its
 * change list and the databases it shows. Everything else, writes included,
 * still meets the remote-access token. Tickets live in memory, so a restart
 * revokes them all; each read re-checks that the page still exists in the
 * same workspace.
 */

const TICKET_TTL_MS = 24 * 60 * 60_000;
const MAX_TICKETS = 256;
const COOKIE_PREFIX = 'michi_pp_';
const OPEN_PATH = /^\/page-preview\/([a-f0-9]{64})$/;
const PALETTE_PARAM = /^[a-z][a-z0-9-]{0,31}$/;

interface PreviewTicket {
  ticket: string;
  ownerUserId: string;
  workspaceId: string;
  pageId: string;
  expiresAt: number;
}

const tickets = new Map<string, PreviewTicket>();
const byPage = new Map<string, string>();
let previewBase: string | null = null;
let rendererOrigin: string | null = null;

/**
 * Where the preview lives: `apiBase` is this backend's loopback address,
 * `renderer` the web UI's origin when another server serves it (`npm run dev`),
 * or '' when this backend serves the built UI itself. Null disables previews.
 */
export function configurePagePreview(options: { apiBase: string; renderer: string } | null): void {
  previewBase = options?.apiBase.replace(/\/$/, '') ?? null;
  rendererOrigin = options ? options.renderer.replace(/\/$/, '') : null;
}

function pageKey(ownerUserId: string, workspaceId: string, pageId: string): string {
  return JSON.stringify([ownerUserId, workspaceId, pageId]);
}

function prune(now: number): void {
  for (const [ticket, entry] of tickets) {
    if (entry.expiresAt > now) continue;
    tickets.delete(ticket);
    byPage.delete(pageKey(entry.ownerUserId, entry.workspaceId, entry.pageId));
  }
}

/** One live link per page: asking again returns the same one. */
export function issuePagePreview(ownerUserId: string, workspaceId: string, pageId: string, now = Date.now()): { url: string; expiresAt: number } {
  if (previewBase === null) {
    throw new PageWriteError(409, 'invalid', 'Page previews need the web UI: build it with npm run build and restart this backend.');
  }
  prune(now);
  const key = pageKey(ownerUserId, workspaceId, pageId);
  let entry = tickets.get(byPage.get(key) ?? '');
  if (!entry) {
    if (tickets.size >= MAX_TICKETS) {
      const oldest = [...tickets.values()].sort((a, b) => a.expiresAt - b.expiresAt)[0];
      tickets.delete(oldest.ticket);
      byPage.delete(pageKey(oldest.ownerUserId, oldest.workspaceId, oldest.pageId));
    }
    entry = { ticket: randomBytes(32).toString('hex'), ownerUserId, workspaceId, pageId, expiresAt: now + TICKET_TTL_MS };
    tickets.set(entry.ticket, entry);
    byPage.set(key, entry.ticket);
  }
  return { url: `${previewBase}/api/page-preview/${entry.ticket}`, expiresAt: entry.expiresAt };
}

/** The ticket's page, or null when the ticket expired or the page left its workspace. */
function livePage(ticket: string, now: number) {
  const entry = tickets.get(ticket);
  if (!entry || entry.expiresAt <= now) return null;
  try {
    const page = getPage(entry.pageId, entry.ownerUserId);
    return page.workspaceId === entry.workspaceId ? { entry, page } : null;
  } catch {
    return null;
  }
}

function previewCookies(req: Request): string[] {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return [];
  return header.split(';').flatMap((part) => {
    const [name, value] = part.trim().split('=');
    return name?.startsWith(COOKIE_PREFIX) && value && /^[a-f0-9]{64}$/.test(value) ? [value] : [];
  });
}

/** Whether `path` (relative to /api) is a read this ticket's page view needs. */
function allows(path: string, ticket: string, now: number): boolean {
  const live = livePage(ticket, now);
  if (!live) return false;
  const { entry, page } = live;
  const pageRead = /^\/pages\/([^/]+)(?:\/(?:changes|activity-seen))?$/.exec(path);
  if (pageRead) return pageRead[1] === entry.pageId;
  const databaseRead = /^\/databases\/([^/]+)(?:\/task-activity)?$/.exec(path);
  if (databaseRead) {
    return !!getDb().prepare('SELECT 1 FROM page_database_refs WHERE page_id=? AND database_id=?').get(entry.pageId, databaseRead[1]);
  }
  const taskDatabase = /^\/workspaces\/([^/]+)\/task-database$/.exec(path);
  if (taskDatabase) return taskDatabase[1] === entry.workspaceId && containsTaskView(page.blocks);
  return false;
}

function openPreview(req: Request, res: Response, ticket: string, now: number): void {
  const live = livePage(ticket, now);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!live || rendererOrigin === null) {
    res.status(404).type('text/plain').send('This page preview link has expired or its page is gone. Ask preview_page for a new one.');
    return;
  }
  const { entry } = live;
  const maxAge = Math.max(1, Math.floor((entry.expiresAt - now) / 1000));
  // One cookie per page, so previews of several pages can share a browser.
  const name = `${COOKIE_PREFIX}${entry.pageId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  res.setHeader('Set-Cookie', `${name}=${entry.ticket}; Path=/api; Max-Age=${maxAge}; HttpOnly; SameSite=Strict`);
  const target = new URLSearchParams({ pagePreview: entry.pageId, workspace: entry.workspaceId });
  const palette = typeof req.query.palette === 'string' ? req.query.palette : '';
  if (PALETTE_PARAM.test(palette)) target.set('palette', palette);
  res.redirect(302, `${rendererOrigin}/?${target.toString()}`);
}

/**
 * Mount at /api before the remote-access token middleware. Opens preview
 * links, and marks a loopback GET that a preview cookie covers with
 * `res.locals.pagePreviewRead`, which that middleware accepts in place of the
 * bearer token. A request carrying a bearer token is left to it untouched.
 */
export function createPagePreviewMiddleware(now: () => number = Date.now): RequestHandler {
  return (req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !isLoopbackAddress(req.socket?.remoteAddress)) return next();
    const open = OPEN_PATH.exec(req.path);
    if (open) { openPreview(req, res, open[1], now()); return; }
    if (req.headers.authorization) return next();
    const at = now();
    if (previewCookies(req).some((ticket) => allows(req.path, ticket, at))) res.locals.pagePreviewRead = true;
    next();
  };
}

/**
 * Tests only.
 * @testonly
 */
export function resetPagePreviewsForTests(): void {
  tickets.clear();
  byPage.clear();
  previewBase = null;
  rendererOrigin = null;
}
