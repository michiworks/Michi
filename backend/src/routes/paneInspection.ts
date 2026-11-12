/**
 * Pane Presence — HTTP route layer.
 *
 * Thin on purpose: this file validates input, builds a server-derived caller context, calls the
 * presence registry, and maps the result/error to an HTTP response. No business logic, no
 * database access beyond the workspace ownership check, no projection lives here.
 *
 * Mounted now:
 *   PUT    /api/panes/presence            -> PanePresenceRegistry.submitPresence
 *   DELETE /api/panes/presence            -> PanePresenceRegistry.removePresence
 *   POST   /api/panes/presence/keepalive  -> PanePresenceRegistry.keepalive
 *   POST   /api/panes/presence/allocate   -> PanePresenceRegistry.allocateSurfaceRegistration
 *
 * The agent tools (inspect_pane, read_pane_output, wait_pane, list_panes) read panes through the
 * pane-inspection services in-process (backend/src/agents/paneInspectionTools.ts); they have no
 * HTTP routes.
 *
 * `presence_keepalive` is an independent semantic heartbeat (deliberately NOT the same
 * thing as a native WebSocket ping/pong — a browser cannot observe those frames at the JS layer,
 * so a keepalive that only renewed a lease on ping/pong would silently never renew from the
 * client side at all). It is an ordinary authenticated HTTP route mounted in THIS file, not a
 * bespoke WebSocket frame type: `streamTransport.ts` is a protocol-agnostic multiplexer that
 * reuses already-guarded HTTP routes over a shared WebSocket, and it has no pane-specific framing
 * of its own (see that module's own comment on `STREAM_PATH`) — teaching it a `presence_keepalive`
 * message type would put Pane-specific business logic into a transport shared by chat streams,
 * agent-run subscriptions and digests. Route ownership of this exact path is instead ADDED to
 * `streamTransport.ts`'s existing allowlist (`STREAM_PATH`) as a normal forwarded POST, so a
 * renderer reaches it either directly via `fetch` (old gateways, no WebSocket multiplexer) or
 * tunneled through the same socket as its other stream traffic (new gateways) — this route
 * handler itself is unaware of which transport carried the request; authentication is preserved
 * either way because streamTransport.ts forwards the caller's original cookie/authorization
 * headers to this same internal HTTP path rather than re-deriving identity from the socket.
 *
 * `POST /api/panes/presence/allocate` is ordinary HTTP only — it is not added to
 * `streamTransport.ts`'s allowlist, matching `PUT`/`DELETE /panes/presence` above (allocation is a
 * one-shot mutation with an immediate response, not a long-lived stream).
 *
 * Caller identity is ALWAYS server-derived, never taken from query parameters or the body. The
 * workspaceId a presence request names in its body is only a claim: `getWorkspace(id,
 * ownerUserId)` returns null the moment that workspace is not owned by the caller, which is what
 * actually enforces the boundary (see resolvePresenceWorkspaceId).
 */

import express, { type Request, type Response } from 'express';
import {
  PaneInspectionError,
  type PaneInspectionErrorCode,
  type PresenceKeepaliveRequest,
  type RemovePresenceRequest,
  type SubmitPresenceRequest,
  type SurfacePaneKind,
} from 'michi-shared';
import {
  PanePresenceRegistry,
  panePresenceRegistry,
  type PresenceCaller,
} from '../services/panePresence';
import { SURFACE_PANE_KINDS } from '../services/paneInspectionProjection.surface';
import { getWorkspace } from '../services/dbRepository';
import { requestAgentOwner } from '../services/agentOwner';

// ---------------------------------------------------------------------------
// The single shared registry instance now lives in panePresence.ts, the module that owns the
// class — a service importing a singleton from routes/ would invert the dependency direction.
// Re-exported here under the same name so existing importers of this module keep working (used
// by the presence routes below).
//
// This replaces a real end-to-end break: this file and paneInspection.ts each constructed their
// own registry, so views submitted through PUT /api/panes/presence landed in one instance while
// inspect() read the other — every descriptor reported coverage: 'unknown' regardless of what a
// renderer registered, and a `surface:` locator could never resolve.
// ---------------------------------------------------------------------------

export { panePresenceRegistry };

/**
 * Injectable dependencies, defaulting to the real registry/repository singletons.
 * Exists so `backend/test/paneInspectionRoutes.test.ts` can stub the presence registry and assert
 * on the exact `PresenceCaller` this router built — the same DI shape
 * `setupAgentRunRoutes`/`setupFilesRoutes` already use in this codebase
 * (backend/src/routes/agentRuns.ts, backend/src/routes/files.ts).
 */
export interface PaneInspectionRouteDeps {
  presenceRegistry: PanePresenceRegistry;
  getWorkspace: typeof getWorkspace;
}

const defaultDeps: PaneInspectionRouteDeps = {
  presenceRegistry: panePresenceRegistry,
  getWorkspace,
};

// ---------------------------------------------------------------------------
// Error mapping — one helper, shared by every route.
// ---------------------------------------------------------------------------

const ERROR_STATUS: Record<PaneInspectionErrorCode, number> = {
  INVALID_ARGUMENT: 400,
  NOT_FOUND: 404,
  NAVIGATION_DISABLED: 403,
  // UNSUPPORTED: 400 rather than 501. 501 says the server does not implement the method; an
  // UNSUPPORTED PaneInspectionError is a fact about the request's target, which is what 400 means.
  UNSUPPORTED: 400,
  OUTPUT_CHANGED: 409,
  OUTPUT_UNAVAILABLE: 410,
  SOURCE_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
};

/** Response body shape for every PaneInspectionError and for the unexpected-error fallback.
 *  `code` is the machine-readable discriminator (the agent tools use the same error codes;
 *  callers must not parse natural language). `message` is human-readable detail for
 *  the KNOWN PaneInspectionError case only — the unexpected-error fallback below never places
 *  internal detail (no stack, no SQL, no filesystem path) into this field. */
interface PaneInspectionErrorBody {
  code: PaneInspectionErrorCode | 'INTERNAL';
  message: string;
}

/** Maps a thrown error to an HTTP response. A `PaneInspectionError` maps via the table above,
 *  with its own `code`+message (the message is server-authored, from a fixed set of literals in
 *  the service/shared layer — never request-echoed content or a raw exception message). Any
 *  other thrown value becomes a 500 with a fixed, generic body: no `err.message`, no `err.stack`,
 *  nothing derived from the caught value at all, so nothing internal (SQL, a filesystem path, a
 *  stack frame) can leak through this path by accident.
 *
 * `NOT_FOUND` byte-identity requirement: every `PaneInspectionError('NOT_FOUND',
 * path, 'target not found')` throw site in the service layer already uses the exact same message
 * literal ('target not found') regardless of *why* — wrong owner, wrong workspace, truly absent
 * row, or an unresolvable surface registration. This handler does not special-case any of them:
 * it reads `code` + `message` off the caught error and serializes them verbatim, so it cannot
 * reintroduce a difference the service layer deliberately erased.
 */
function sendError(res: Response, err: unknown): void {
  if (err instanceof PaneInspectionError) {
    const status = ERROR_STATUS[err.code];
    const body: PaneInspectionErrorBody = { code: err.code, message: err.message };
    res.status(status).json(body);
    return;
  }
  const body: PaneInspectionErrorBody = { code: 'INTERNAL', message: 'internal error' };
  res.status(500).json(body);
}

// ---------------------------------------------------------------------------
// Caller resolution — server-derived only.
// ---------------------------------------------------------------------------

function resolveOwnerUserId(req: Request): string {
  return requestAgentOwner(req.user?.id);
}

/** Builds the session-bound PresenceCaller for the presence routes (panePresence.ts's own
 *  `PresenceCaller` shape — a smaller, presence-specific type, not `PaneInspectionCaller`).
 *  `connectionId` is always 'local': these routes are only ever reached directly (this process's
 *  own Express app), never through the `/backend-connections/:id/proxy` remote-connection path —
 *  a remote caller reaching this route already went through that proxy's own request rewriting
 *  upstream, so by the time a request lands in this handler it is always local from this
 *  process's point of view. */
function buildPresenceCaller(req: Request, workspaceId: string): PresenceCaller {
  return {
    ownerUserId: resolveOwnerUserId(req),
    workspaceId,
    connectionId: 'local',
  };
}

/**
 * Resolves and authorises the workspaceId a presence PUT/DELETE is scoped to. Per
 * panePresence.ts's own mounting note ("workspaceId: <from body or route, validated the same way
 * other workspace-scoped routes do>"), presence's workspaceId travels in the REQUEST BODY (there
 * is no `:workspaceId` route param for these two flat `/panes/presence` paths) — mirroring
 * `requireWorkspaceOwner`'s own `req.body.workspaceId` fallback (backend/src/routes/middleware
 * /ownership.ts) rather than trying to derive a workspace from view paneIds, which would leave a
 * brand-new lease's first (legitimately empty) submission with nothing to resolve from.
 *
 * Ownership is checked exactly like `requireWorkspaceOwner`: `getWorkspace(id, ownerUserId)`
 * returns null the moment the resolved row is not owned by this caller (or does not exist),
 * which is what actually enforces the boundary — never inferred from anything else in the body.
 */
function resolvePresenceWorkspaceId(deps: PaneInspectionRouteDeps, req: Request, ownerUserId: string): string | null {
  const raw = req.body && typeof req.body === 'object' ? (req.body as { workspaceId?: unknown }).workspaceId : undefined;
  if (typeof raw !== 'string' || !raw) return null;
  const workspace = deps.getWorkspace(raw, process.env.MICHI_CLOUD === '1' ? ownerUserId : undefined);
  return workspace ? workspace.id : null;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** `agentRunEvents` is accepted and ignored: only the removed subscribe and wait routes read it,
 *  and server.ts still passes it. Drop it here and at that call site together. */
export function setupPaneInspectionRoutes(
  overrides: Partial<PaneInspectionRouteDeps> & { agentRunEvents?: unknown } = {},
): express.Router {
  const deps: PaneInspectionRouteDeps = { ...defaultDeps, ...overrides };
  const router = express.Router();

  // PUT /api/panes/presence — renderer-only; never exposed to the agent tools layer.
  // Body: SubmitPresenceRequest & { workspaceId: string }. workspaceId travels in the body (see
  // resolvePresenceWorkspaceId's doc comment) and is validated server-side against the session's
  // ownerUserId before anything is handed to the registry — never trusted verbatim.
  router.put('/panes/presence', (req, res) => {
    try {
      const body = req.body as SubmitPresenceRequest | undefined;
      if (!body || typeof body !== 'object' || !Array.isArray(body.views)) {
        res.status(400).json({ code: 'INVALID_ARGUMENT', message: 'views must be an array' } satisfies PaneInspectionErrorBody);
        return;
      }
      const ownerUserId = resolveOwnerUserId(req);
      const workspaceId = resolvePresenceWorkspaceId(deps, req, ownerUserId);
      if (workspaceId === null) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'target not found' } satisfies PaneInspectionErrorBody);
        return;
      }
      const caller = buildPresenceCaller(req, workspaceId);
      const result = deps.presenceRegistry.submitPresence(caller, body);
      if (result.ok) {
        res.status(200).json(result);
        return;
      }
      if (result.code === 'STALE_REVISION') { res.status(409).json(result); return; }
      if (result.code === 'WRONG_WINDOW') { res.status(403).json(result); return; }
      res.status(200).json(result); // EMPTY_SNAPSHOT_IGNORED — not an error, a no-op.
    } catch (err) {
      sendError(res, err);
    }
  });

  // DELETE /api/panes/presence — Body: RemovePresenceRequest & { workspaceId: string }.
  router.delete('/panes/presence', (req, res) => {
    try {
      const body = req.body as RemovePresenceRequest | undefined;
      if (!body || typeof body !== 'object' || typeof body.rendererLeaseId !== 'string' || !body.rendererLeaseId) {
        res.status(400).json({ code: 'INVALID_ARGUMENT', message: 'rendererLeaseId is required' } satisfies PaneInspectionErrorBody);
        return;
      }
      const ownerUserId = resolveOwnerUserId(req);
      const workspaceId = resolvePresenceWorkspaceId(deps, req, ownerUserId);
      if (workspaceId === null) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'target not found' } satisfies PaneInspectionErrorBody);
        return;
      }
      const caller = buildPresenceCaller(req, workspaceId);
      const result = deps.presenceRegistry.removePresence(caller, body);
      if (result.ok) { res.status(200).json(result); return; }
      if (result.code === 'WRONG_WINDOW') { res.status(403).json(result); return; }
      res.status(404).json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/panes/presence/keepalive — the independent semantic heartbeat (see this
  // file's own header comment for why it is HTTP, tunneled through streamTransport.ts's allowlist,
  // rather than a WebSocket message type). Body: PresenceKeepaliveRequest & { workspaceId: string
  // }. Caller identity is server-derived exactly like PUT/DELETE presence above — never trusted
  // from the body beyond the workspaceId used to resolve+authorise the target workspace.
  //
  // NOT_FOUND without leaking ownership: `PanePresenceRegistry.keepalive`
  // already folds "no such lease" and "lease exists but belongs to a different
  // owner/workspace/connection" into the exact same `{ ok: false, code: 'NOT_FOUND' }` shape (see
  // that method's own guard) — this handler does not add a distinguishing branch on top of it, so
  // a caller cannot probe for the existence of someone else's lease by comparing 403 vs. 404.
  router.post('/panes/presence/keepalive', (req, res) => {
    try {
      const body = req.body as PresenceKeepaliveRequest | undefined;
      if (!body || typeof body !== 'object' || typeof body.rendererLeaseId !== 'string' || !body.rendererLeaseId) {
        res.status(400).json({ code: 'INVALID_ARGUMENT', message: 'rendererLeaseId is required' } satisfies PaneInspectionErrorBody);
        return;
      }
      const ownerUserId = resolveOwnerUserId(req);
      const workspaceId = resolvePresenceWorkspaceId(deps, req, ownerUserId);
      if (workspaceId === null) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'target not found' } satisfies PaneInspectionErrorBody);
        return;
      }
      const caller = buildPresenceCaller(req, workspaceId);
      const result = deps.presenceRegistry.keepalive(caller, body);
      if (result.ok) { res.status(200).json(result); return; }
      res.status(404).json({ code: 'NOT_FOUND', message: 'target not found' } satisfies PaneInspectionErrorBody);
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/panes/presence/allocate — allocates a surface pane registration (the registry's
  // `allocateSurfaceRegistration`). Body: { workspaceId: string; kind: string }. Ordinary HTTP
  // only — not added to streamTransport.ts's allowlist (see this file's header comment): a
  // one-shot allocation with an immediate response has no reason to ride the long-lived stream
  // multiplexer. `kind` is validated against `SURFACE_PANE_KINDS` BEFORE calling into the
  // registry, so an unsupported kind never reaches (and never pollutes) the registry's
  // `registrations` map with a value nothing can ever satisfy.
  //
  // Caller identity is server-derived exactly like PUT/DELETE presence and keepalive above (never
  // trusted from the body beyond the workspaceId used to resolve+authorise the target workspace):
  // the resulting `PresenceCaller` is what the registration is BOUND to (panePresence.ts's own
  // `allocateSurfaceRegistration` doc comment), so a submit/resolve from a different
  // owner/workspace/connection can never claim or inspect it later. A `RATE_LIMITED`
  // `PaneInspectionError` thrown once this caller's scope is at capacity falls through to the
  // shared `sendError` helper below, which already maps it to 429 via `ERROR_STATUS` — no
  // special-casing needed here.
  router.post('/panes/presence/allocate', (req, res) => {
    try {
      const body = req.body as { kind?: unknown } | undefined;
      const kind = body && typeof body === 'object' ? body.kind : undefined;
      if (typeof kind !== 'string' || !SURFACE_PANE_KINDS.includes(kind as SurfacePaneKind)) {
        res.status(400).json({ code: 'INVALID_ARGUMENT', message: 'kind must be one of the supported surface pane kinds' } satisfies PaneInspectionErrorBody);
        return;
      }
      const ownerUserId = resolveOwnerUserId(req);
      const workspaceId = resolvePresenceWorkspaceId(deps, req, ownerUserId);
      if (workspaceId === null) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'target not found' } satisfies PaneInspectionErrorBody);
        return;
      }
      const caller = buildPresenceCaller(req, workspaceId);
      const result = deps.presenceRegistry.allocateSurfaceRegistration(caller, kind);
      res.status(200).json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
