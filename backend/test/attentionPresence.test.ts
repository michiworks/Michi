import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodePaneId, PANE_INSPECTION_LIMITS, type PaneTarget, type PresenceViewInput } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import {
  PanePresenceRegistry,
  WINDOW_FOCUS_FRESH_MS,
  type PresenceCaller,
} from '../src/services/panePresence';
import type { AgentRunsRepository } from '../src/services/agentRunsRepository';
import { AttentionFeed } from '../src/services/attention/attentionFeed';
import { AttentionService } from '../src/services/attention/attentionService';
import { manualClock, permission, records } from './helpers/attentionHarness';

// Window focus on presence (windowFocused on submit/keepalive): stored per
// window, read by the attention service, and never part of a pane's presence
// section, so it cannot advance a pane-inspection revision.

const OWNER = 'local-user';
let dir: string;
let previousData: string | undefined;
let now = 0;

const runs = { getRun: () => null } as unknown as AgentRunsRepository;
const caller = (overrides: Partial<PresenceCaller> = {}): PresenceCaller =>
  ({ ownerUserId: OWNER, workspaceId: 'ws-1', connectionId: 'local', ...overrides });
const node = { kind: 'node' as const, nodeId: 'n-1' };
const view = (windowId: string, visible: boolean): PresenceViewInput =>
  ({ paneId: encodePaneId(node), windowId, uiPaneId: 'n-1', treeId: 't-1', visible, openedAtClient: 1 });

function registry(): PanePresenceRegistry {
  return new PanePresenceRegistry(runs, { now: () => now, ttlMs: 60_000, keepaliveIntervalMs: 20_000 });
}

function submit(presence: PanePresenceRegistry, windowId: string, visible: boolean, windowFocused?: boolean, leaseId?: string, revision = 1) {
  const result = presence.submitPresence(caller(), {
    rendererLeaseId: leaseId, viewRevision: revision, windowId, views: [view(windowId, visible)],
    ...(windowFocused === undefined ? {} : { windowFocused }),
  });
  assert.equal(result.ok, true);
  return (result as { rendererLeaseId: string }).rendererLeaseId;
}

beforeEach(() => {
  previousData = process.env.MICHI_DATA_DIR;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-attention-presence-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  getDb().prepare("INSERT INTO workspaces(id,name,created_at,updated_at) VALUES ('ws-1','W',1,1)").run();
  getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES ('n-1','ws-1','chat','idle',1)").run();
  now = 1_000;
});

afterEach(() => {
  closeDb();
  if (previousData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = previousData;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('presence window focus', () => {
  test('a target counts as on screen only in a visible slot of a window reporting focus', () => {
    const presence = registry();
    const lease = submit(presence, 'w-1', true);
    assert.equal(presence.isTargetVisibleInFocusedWindow(OWNER, node), false, 'absent focus is unknown, never focused');
    presence.keepalive(caller(), { rendererLeaseId: lease, windowFocused: true });
    assert.equal(presence.isTargetVisibleInFocusedWindow(OWNER, node), true);
    assert.equal(presence.isTargetVisibleInFocusedWindow('someone-else', node), false, 'owner-scoped');
    presence.keepalive(caller(), { rendererLeaseId: lease, windowFocused: false });
    assert.equal(presence.isTargetVisibleInFocusedWindow(OWNER, node), false, 'blur');
    submit(presence, 'w-1', false, true, lease, 2);
    assert.equal(presence.isTargetVisibleInFocusedWindow(OWNER, node), false, 'open in a background slot is not on screen');
    submit(presence, 'w-1', true, true, lease, 3);
    assert.equal(presence.isTargetVisibleInFocusedWindow(OWNER, node), true, 'focus also rides on a submission');
  });

  test('focus is per window, and a stale report stops counting', () => {
    const presence = registry();
    const shown = submit(presence, 'w-shown', true, false);
    submit(presence, 'w-focused', false, true);
    assert.equal(presence.isTargetVisibleInFocusedWindow(OWNER, node), false, 'the focused window does not show it');
    presence.keepalive(caller(), { rendererLeaseId: shown, windowFocused: true });
    assert.equal(presence.isTargetVisibleInFocusedWindow(OWNER, node), true);
    now += 50_000;
    presence.keepalive(caller(), { rendererLeaseId: shown });
    now += 20_000;
    assert.equal(presence.isTargetVisibleInFocusedWindow(OWNER, node), false,
      'a keepalive without focus renews the lease but not a 70s-old focus report');
  });

  test('a focus change neither alters the presence section nor revision-relevant view state', () => {
    const presence = registry();
    const lease = submit(presence, 'w-1', true, false);
    const before = presence.getPresence(node);
    presence.keepalive(caller(), { rendererLeaseId: lease, windowFocused: true });
    presence.keepalive(caller(), { rendererLeaseId: lease, windowFocused: false });
    const after = presence.getPresence(node);
    assert.deepEqual(after, before, 'views, coverage and timestamps are unchanged by focus alone');
    assert.ok(!('windowFocused' in after.views[0]!), 'focus is not part of a view');
  });

  test('signals the owner on submissions and on focus changes only', () => {
    const presence = registry();
    const signals: string[] = [];
    const unsubscribe = presence.subscribeAttentionSignals((owner) => signals.push(owner));
    const lease = submit(presence, 'w-1', true);
    assert.deepEqual(signals, [OWNER]);
    presence.keepalive(caller(), { rendererLeaseId: lease, windowFocused: true });
    presence.keepalive(caller(), { rendererLeaseId: lease, windowFocused: true });
    presence.keepalive(caller(), { rendererLeaseId: lease });
    assert.equal(signals.length, 2, 'an unchanged focus report is not a signal');
    presence.keepalive(caller(), { rendererLeaseId: lease, windowFocused: false });
    assert.equal(signals.length, 3);
    presence.keepalive(caller(), { rendererLeaseId: lease, windowFocused: 'yes' as unknown as boolean });
    assert.equal(signals.length, 3, 'a malformed value is ignored');
    unsubscribe();
    submit(presence, 'w-1', true, true, lease, 2);
    assert.equal(signals.length, 3);
  });

  test('a focus report counts for WINDOW_FOCUS_FRESH_MS, well inside the lease TTL', () => {
    const keepaliveMs = PANE_INSPECTION_LIMITS.presenceKeepaliveSeconds * 1_000;
    assert.ok(WINDOW_FOCUS_FRESH_MS > keepaliveMs && WINDOW_FOCUS_FRESH_MS < PANE_INSPECTION_LIMITS.presenceTtlSeconds * 1_000,
      'longer than the keepalive that repeats it, shorter than the lease TTL');
    const presence = new PanePresenceRegistry(runs, { now: () => now });
    const signals: string[] = [];
    presence.subscribeAttentionSignals((owner) => signals.push(owner));
    const lease = submit(presence, 'w-1', true, true);
    now += WINDOW_FOCUS_FRESH_MS;
    assert.equal(presence.isTargetVisibleInFocusedWindow(OWNER, node), true);
    now += 1;
    assert.equal(presence.isTargetVisibleInFocusedWindow(OWNER, node), false, 'a lost blur stops counting after 25 s');
    assert.equal(presence.hasLiveLease(lease), true, 'while the lease itself lives on');
    presence.keepalive(caller(), { rendererLeaseId: lease, windowFocused: true });
    assert.equal(presence.isTargetVisibleInFocusedWindow(OWNER, node), true);
    assert.equal(signals.length, 2, 'focus reported again after going stale is a change');
  });

  test('a signal carries what the changed window shows, across its leases, and nothing while unfocused', () => {
    getDb().prepare("INSERT INTO workspaces(id,name,created_at,updated_at) VALUES ('ws-2','W2',1,1)").run();
    const nodeRow = getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES (?,?,'chat','idle',1)");
    nodeRow.run('n-2', 'ws-1');
    nodeRow.run('n-3', 'ws-2');
    const presence = registry();
    const signals: string[][] = [];
    presence.subscribeAttentionSignals((_owner, shown) => signals.push(shown.map((target) => encodePaneId(target))));
    const pane = (target: PaneTarget, windowId: string, visible: boolean): PresenceViewInput =>
      ({ paneId: encodePaneId(target), windowId, uiPaneId: encodePaneId(target), treeId: null, visible, openedAtClient: 1 });
    const n1 = { kind: 'node' as const, nodeId: 'n-1' };
    const n2 = { kind: 'node' as const, nodeId: 'n-2' };
    const n3 = { kind: 'node' as const, nodeId: 'n-3' };
    const surface = presence.allocateSurfaceRegistration(caller(), 'terminal');
    const first = presence.submitPresence(caller(), {
      viewRevision: 1, windowId: 'w-1',
      views: [pane(n1, 'w-1', true), pane(n2, 'w-1', false), { ...pane(n1, 'w-1', true), paneId: surface.paneId, uiPaneId: 'term' }],
    });
    assert.equal(first.ok, true);
    const lease = (first as { rendererLeaseId: string }).rendererLeaseId;
    presence.keepalive(caller(), { rendererLeaseId: lease, windowFocused: true });
    presence.submitPresence(caller({ workspaceId: 'ws-2' }), { viewRevision: 1, windowId: 'w-1', views: [pane(n3, 'w-1', true)], windowFocused: true });
    presence.submitPresence(caller(), { viewRevision: 1, windowId: 'w-2', views: [pane(n2, 'w-2', true)], windowFocused: true });
    presence.keepalive(caller(), { rendererLeaseId: lease, windowFocused: false });
    assert.deepEqual(signals, [
      [],
      [encodePaneId(n1)],
      [encodePaneId(n1), encodePaneId(n3)],
      [encodePaneId(n2)],
      [],
    ], 'unknown focus; focus (visible slots only, no surfaces); the window\'s second workspace; another window; blur');
  });

  test('wired as server.ts does, a window coming into focus resolves what it shows and nothing else', () => {
    getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES ('n-2','ws-1','chat','idle',1)").run();
    const presence = registry();
    const clock = manualClock();
    const service = new AttentionService({ presence, feed: new AttentionFeed(), clock, onError: (_message, error) => { throw error; } });
    service.start();
    presence.subscribeAttentionSignals((owner, shown) => service.presenceChanged(owner, shown));
    service.observeChatEvent(permission('n-1', 't-1', 1));
    service.observeChatEvent(permission('n-2', 't-2', 1));
    clock.advance(1_000);
    const pane = (nodeId: string, windowId: string): PresenceViewInput =>
      ({ paneId: encodePaneId({ kind: 'node', nodeId }), windowId, uiPaneId: nodeId, treeId: null, visible: true, openedAtClient: 1 });
    presence.submitPresence(caller(), { viewRevision: 1, windowId: 'w-unfocused', views: [pane('n-2', 'w-unfocused')], windowFocused: false });
    const lease = (presence.submitPresence(caller(), { viewRevision: 1, windowId: 'w-1', views: [pane('n-1', 'w-1')] }) as
      { rendererLeaseId: string }).rendererLeaseId;
    assert.deepEqual(records().map((row) => row.status), ['active', 'active'], 'no focused window shows either yet');
    presence.keepalive(caller(), { rendererLeaseId: lease, windowFocused: true });
    assert.deepEqual(records().map((row) => [row.target_id, row.status, row.resolve_reason]),
      [['n-1', 'resolved', 'seen'], ['n-2', 'active', null]]);
    service.stop();
  });

  test('another lease cannot report focus for a window it does not own', () => {
    const presence = registry();
    const lease = submit(presence, 'w-1', true, false);
    const spoofed = presence.submitPresence(caller(), {
      rendererLeaseId: lease, viewRevision: 2, windowId: 'w-other', views: [view('w-other', true)], windowFocused: true,
    });
    assert.equal(spoofed.ok, false);
    assert.equal(presence.isTargetVisibleInFocusedWindow(OWNER, node), false);
    assert.deepEqual(presence.keepalive(caller({ workspaceId: 'ws-other' }), { rendererLeaseId: lease, windowFocused: true }),
      { ok: false, code: 'NOT_FOUND' });
    assert.equal(presence.isTargetVisibleInFocusedWindow(OWNER, node), false);
  });
});
