import type { NextFunction, Request, Response } from 'express';
import { log } from '../services/logger';
import { PageWriteError, assertPageRequestSize } from '../services/pages/core';

// Request checks and the `{ error: { code, message } }` answer the Pages-family routers share.

export type Obj = Record<string, unknown>;

export const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

export function pageId(value: unknown, name = 'id'): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new PageWriteError(400, 'invalid', `Invalid ${name}`);
  return value;
}

/** The body, holding only `keys`; none at all when a route takes no keys. `sizeCap` applies the 1 MB Pages write limit. */
export function pageBody(req: Request, keys: readonly string[], { sizeCap = true }: { sizeCap?: boolean } = {}): Obj {
  if (req.body === undefined && keys.length === 0) return {};
  if (!isObject(req.body) || !Object.keys(req.body).every((key) => keys.includes(key))) {
    throw new PageWriteError(400, 'invalid', 'Invalid request body');
  }
  if (sizeCap) assertPageRequestSize(req.body);
  return req.body;
}

export function pageQuery(req: Request, allowed: readonly string[]): void {
  if (!Object.keys(req.query).every((key) => allowed.includes(key))) throw new PageWriteError(400, 'invalid', 'Unknown query parameter');
}

/** Sends a handler's throw or rejection to the router's error middleware, so an async failure answers 500. */
export function route(fn: (req: Request, res: Response) => unknown) {
  return (req: Request, res: Response, next: NextFunction) => { Promise.resolve().then(() => fn(req, res)).catch(next); };
}

type ErrorAnswer = { status: number; code: string; message: string };

/**
 * The error middleware: a PageWriteError, or what `classify` maps an error
 * to, answers with its status and code; anything else is logged and
 * answered 500 with `fallbackMessage`.
 */
export function pageErrors(fallbackMessage: string, classify?: (error: unknown) => ErrorAnswer | null) {
  return (error: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const answer: ErrorAnswer | null = error instanceof PageWriteError ? error : classify?.(error) ?? null;
    if (answer) { res.status(answer.status).json({ error: { code: answer.code, message: answer.message } }); return; }
    log.error('http', fallbackMessage, {
      route: `${req.method} ${req.path}`,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
    res.status(500).json({ error: { code: 'internal_error', message: fallbackMessage } });
  };
}
