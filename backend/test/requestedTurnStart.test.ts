import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { isRegisteredLiveSession, SessionChangedError, startUnderRestoreLock } from '../src/agents/requestedTurnStart';
import { clearAllSessions, dropSession, registerSession } from '../src/agents/sessionRegistry';
import type { AgentSession } from '../src/agents/types';

const session = (id: string) => ({ id, runtimeId: 'kiro', getHistory: () => [], getPendingAssistant: () => undefined, send: () => { throw new Error('unused'); }, cancel: () => {} }) as unknown as AgentSession;
afterEach(() => clearAllSessions());

test('releases the restore lock after starting, and turns a synchronous throw into a rejection', async () => {
  let released = 0;
  assert.equal(await startUnderRestoreLock(() => { released++; }, session('a'), () => true, async () => 'started'), 'started');
  assert.equal(released, 1);
  await assert.rejects(startUnderRestoreLock(() => { released++; }, session('a'), undefined, () => { throw new Error('boom'); }), /boom/);
  assert.equal(released, 2);
});

test('starts nothing on a session that is no longer the live one', async () => {
  const opened = session('chat');
  registerSession(opened, null);
  assert.equal(isRegisteredLiveSession(opened), true);
  let starts = 0;
  const start = async () => { starts++; };

  dropSession('chat');
  assert.equal(isRegisteredLiveSession(opened), false);
  await assert.rejects(startUnderRestoreLock(() => {}, opened, isRegisteredLiveSession, start), SessionChangedError);

  registerSession(session('chat'), null);
  await assert.rejects(startUnderRestoreLock(() => {}, opened, isRegisteredLiveSession, start), SessionChangedError);
  assert.equal(starts, 0);
});
