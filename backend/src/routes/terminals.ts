import express from 'express';
import {
  TERMINAL_ERROR_CODES,
  type TerminalListResponse,
  type TerminalStreamEvent,
  type TerminalUnavailableReason,
} from 'michi-shared';
import { isPhoneRequest } from '../services/accessLog';
import { createSseObserver } from '../services/httpSse';
import { TerminalError, type TerminalHost } from '../services/terminalHost';

const CLIENT_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const KEEPALIVE_MS = 15_000;

export interface TerminalAccess {
  /** Signed-in or multi-user backends run no terminals. */
  hosted: boolean;
  /** Settings › Phone access › Terminal on this machine. */
  phoneAllowed(): boolean;
}

const MESSAGES: Record<TerminalUnavailableReason, string> = {
  'phone-off': 'Terminals are off for phones on this machine. Turn them on in Settings › Phone access on your computer.',
  hosted: 'Terminals are not available on hosted Michi backends.',
  unsupported: '',
};

/**
 * Terminals run as the backend's user with its full access. Every route
 * passes the /api guards first (local origin, remote token); here a phone
 * also needs the owner's Terminal setting, which only the desktop can change
 * (the phone gateway refuses /mobile-access).
 */
export function setupTerminalRoutes(host: TerminalHost, access: TerminalAccess): express.Router {
  const router = express.Router();
  const denial = (req: express.Request): TerminalUnavailableReason | null => {
    if (access.hosted) return 'hosted';
    if (isPhoneRequest(req.headers) && !access.phoneAllowed()) return 'phone-off';
    if (!host.supported) return 'unsupported';
    return null;
  };
  const message = (reason: TerminalUnavailableReason) => MESSAGES[reason] || host.unsupportedReason;
  const fail = (res: express.Response, error: unknown) => {
    if (error instanceof TerminalError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
    res.status(500).json({ error: (error as Error).message || 'Terminal request failed' });
  };
  const clientId = (value: unknown): string | null => typeof value === 'string' && CLIENT_ID.test(value) ? value : null;

  router.use('/terminals', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    // The list reports why terminals are unavailable instead of failing.
    if (req.method === 'GET' && req.path === '/') return next();
    const reason = denial(req);
    if (reason) {
      res.status(reason === 'unsupported' ? 503 : 403).json({ error: message(reason), code: TERMINAL_ERROR_CODES[reason] });
      return;
    }
    next();
  });

  router.get('/terminals', (req, res) => {
    const reason = denial(req);
    const body: TerminalListResponse = reason
      ? { available: false, reason, message: message(reason), terminals: [] }
      : { available: true, terminals: host.list() };
    res.json(body);
  });

  router.post('/terminals', (req, res) => {
    const client = clientId(req.body?.clientId);
    if (!client) { res.status(400).json({ error: 'clientId is required' }); return; }
    try { res.json(host.create({ ...req.body, clientId: client })); } catch (error) { fail(res, error); }
  });

  router.get('/terminals/:id/stream', (req, res) => {
    const client = clientId(req.query.clientId);
    if (!client) { res.status(400).json({ error: 'clientId is required' }); return; }
    if (!host.get(req.params.id)) { fail(res, new TerminalError(TERMINAL_ERROR_CODES.notFound, 404, 'This terminal is no longer running')); return; }
    const after = typeof req.query.after === 'string' && /^-?\d+$/.test(req.query.after) ? Number(req.query.after) : -1;
    const instance = typeof req.query.instance === 'string' ? req.query.instance : undefined;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const observer = createSseObserver(res);
    if (!observer.write(': connected\n\n')) return;
    const send = (event: TerminalStreamEvent) => observer.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    try {
      observer.addCleanup(host.attach(req.params.id, {
        clientId: client,
        phone: isPhoneRequest(req.headers),
        send,
        close: () => { observer.close(); res.end(); },
      }, after, instance));
    } catch (error) {
      if (error instanceof TerminalError) send({ type: 'closed', reason: 'closed' });
      observer.close(); res.end();
      return;
    }
    observer.heartbeat(': keepalive\n\n', KEEPALIVE_MS);
  });

  router.post('/terminals/:id/input', (req, res) => {
    const client = clientId(req.body?.clientId);
    if (!client) { res.status(400).json({ error: 'clientId is required' }); return; }
    try { host.write(req.params.id, client, req.body?.data); res.json({ ok: true }); } catch (error) { fail(res, error); }
  });

  router.post('/terminals/:id/resize', (req, res) => {
    const client = clientId(req.body?.clientId);
    if (!client) { res.status(400).json({ error: 'clientId is required' }); return; }
    try { host.resize(req.params.id, client, req.body?.cols, req.body?.rows); res.json({ ok: true }); } catch (error) { fail(res, error); }
  });

  router.post('/terminals/:id/restart', (req, res) => {
    const client = clientId(req.body?.clientId);
    if (!client) { res.status(400).json({ error: 'clientId is required' }); return; }
    try { res.json(host.restart(req.params.id, client)); } catch (error) { fail(res, error); }
  });

  router.delete('/terminals/:id', (req, res) => {
    const client = clientId(req.query.clientId);
    if (!client) { res.status(400).json({ error: 'clientId is required' }); return; }
    res.json(host.close(req.params.id, client));
  });

  return router;
}
