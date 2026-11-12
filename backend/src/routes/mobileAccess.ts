import express from 'express';
import type { MobileAccessProvider, MobileAccessStatus } from 'michi-shared';
import type { MobileAccessController } from '../services/mobileAccessManager';
import { requireLocalControlRequest } from './middleware/localControl';

/** Settings › Phone access › Terminal: whether phones may open terminals here. */
export interface PhoneTerminalSetting {
  enabled(): boolean;
  set(enabled: boolean): void;
}

/** `remember` records the owner's Settings choice. Shutdown stops access
 * through the service directly, so it never clears that choice. The phone
 * gateway refuses every /mobile-access path, so only the desktop reaches these. */
export function setupMobileAccessRoutes(access: MobileAccessController, options: {
  remember?: (enabled: boolean, provider?: MobileAccessProvider) => void;
  terminal?: PhoneTerminalSetting;
} = {}): express.Router {
  const router = express.Router();
  const withTerminal = (status: MobileAccessStatus): MobileAccessStatus => options.terminal ? { ...status, terminal: options.terminal.enabled() } : status;
  router.use('/mobile-access', requireLocalControlRequest, (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/mobile-access', async (_req, res) => { res.json(withTerminal(await access.status())); });
  router.post('/mobile-access/terminal', async (req, res) => {
    const enabled = req.body?.enabled;
    if (!options.terminal || typeof enabled !== 'boolean') { res.status(400).json({ error: 'Update this Michi backend to use terminals from your phone.' }); return; }
    try { options.terminal.set(enabled); }
    catch (error) { res.status(500).json({ error: `Could not save the Terminal setting: ${(error as Error).message}` }); return; }
    res.json(withTerminal(await access.status()));
  });
  router.post('/mobile-access/start', async (_req, res) => {
    let status;
    try { status = await access.start(); }
    catch (error) { res.status(409).json({ error: (error as Error).message }); return; }
    options.remember?.(['starting', 'connected', 'reconnecting'].includes(status.state), status.provider);
    res.json(withTerminal(status));
  });
  router.post('/mobile-access/stop', async (_req, res) => {
    const status = await access.stop();
    options.remember?.(false, status.provider);
    res.json(withTerminal(status));
  });
  router.post('/mobile-access/link', (_req, res) => {
    try { res.json(access.link()); }
    catch (error) { res.status(409).json({ error: (error as Error).message }); }
  });
  router.post('/mobile-access/provider', async (req, res) => {
    const provider = req.body?.provider;
    if (provider !== 'tailscale' || !access.select) {
      res.status(400).json({ error: 'Choose a supported phone access method.' }); return;
    }
    try {
      const status = await access.select(provider);
      options.remember?.(['starting', 'connected', 'reconnecting'].includes(status.state), status.provider);
      res.json(withTerminal(status));
    } catch (error) { res.status(409).json({ error: (error as Error).message }); }
  });
  for (const action of ['login', 'open-app'] as const) router.post(`/mobile-access/${action}`, async (_req, res) => {
    try {
      const operation = action === 'login' ? access.login : access.openApp;
      if (!operation) throw new Error('Update this Michi backend to connect Tailscale.');
      res.json(await operation.call(access));
    } catch (error) { res.status(409).json({ error: (error as Error).message }); }
  });
  return router;
}
