/**
 * The admin routes read and delete Better Auth users on the schema Michi's
 * auth migrations create (camelCase) and on the snake_case one of older
 * deployments. A user deletion either completes in both databases or fails
 * before it deletes anything.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, test } from 'node:test';
import express from 'express';
import { setupAdminRoutes } from '../src/routes/admin';
import { closeAuditDb, closeDb, getAuditDb, getDb, initDb } from '../src/services/db';
import { saveWorkspace } from '../src/services/dbRepository';
import { authRowsFor, createAuthUser, type AuthSchema } from './helpers/authUsers';

let dataDir: string;
let server: ReturnType<typeof express.application.listen> | undefined;
let baseUrl: string;

async function startApp(): Promise<void> {
  const app = express();
  app.use((req: any, _res, next) => { req.user = { id: 'admin', email: 'admin@example.com', emailVerified: true }; next(); });
  app.use('/api/admin', setupAdminRoutes());
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function request(method: string, route: string) {
  const response = await fetch(`${baseUrl}${route}`, { method });
  return { response, body: await response.json() as any };
}

function workspaceCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS count FROM workspaces WHERE owner_user_id = ?').get('owner-a') as { count: number }).count;
}

describe('admin routes on Better Auth tables', () => {
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-admin-auth-users-'));
    process.env.MICHI_DATA_DIR = dataDir;
    process.env.MICHI_CLOUD = '1';
    process.env.MICHI_REQUIRE_AUTH = 'true';
    process.env.MICHI_ADMIN_EMAILS = 'admin@example.com';
    closeDb(); closeAuditDb(); initDb();
    saveWorkspace({ id: 'ws-a', name: 'Workspace', cwd: null, created_at: 1, updated_at: 1, settings: null, owner_user_id: 'owner-a' });
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    closeDb(); closeAuditDb();
    delete process.env.MICHI_DATA_DIR;
    delete process.env.MICHI_CLOUD;
    delete process.env.MICHI_REQUIRE_AUTH;
    delete process.env.MICHI_ADMIN_EMAILS;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  for (const schema of ['better-auth', 'snake-case'] as AuthSchema[]) {
    test(`list, export and delete a user on the ${schema} schema`, async () => {
      createAuthUser(dataDir, 'owner-a', schema);
      await startApp();

      const listed = await request('GET', '/api/admin/users');
      assert.equal(listed.response.status, 200, JSON.stringify(listed.body));
      assert.deepEqual(listed.body.map((user: any) => [user.id, user.email, user.createdAt, user.workspaceCount]),
        [['owner-a', 'owner-a@example.com', 1, 1]]);

      const workspaces = await request('GET', '/api/admin/workspaces');
      assert.equal(workspaces.response.status, 200, JSON.stringify(workspaces.body));
      assert.equal(workspaces.body[0].ownerEmail, 'owner-a@example.com');

      const exported = await request('POST', '/api/admin/users/owner-a/export');
      assert.equal(exported.response.status, 200, JSON.stringify(exported.body));
      assert.deepEqual(exported.body.user, { id: 'owner-a', email: 'owner-a@example.com', name: 'owner-a', created_at: 1 });

      const deleted = await request('DELETE', '/api/admin/users/owner-a');
      assert.equal(deleted.response.status, 200, JSON.stringify(deleted.body));
      assert.equal(workspaceCount(), 0);
      assert.deepEqual(authRowsFor(dataDir, 'owner-a'), { user: 0, session: 0, account: 0 });
      assert.equal((getAuditDb().prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'admin.user.delete'")
        .get() as { count: number }).count, 1);
    });
  }

  test('a user deletion the auth tables cannot complete deletes nothing', async () => {
    // auth.sqlite before its migrations ran: the user table only.
    const authDb = new DatabaseSync(path.join(dataDir, 'auth.sqlite'));
    authDb.exec('CREATE TABLE "user" (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, "createdAt" INTEGER NOT NULL)');
    authDb.prepare('INSERT INTO "user" (id, email, name, "createdAt") VALUES (?, ?, ?, 1)').run('owner-a', 'owner-a@example.com', 'owner-a');
    authDb.close();
    await startApp();

    const deleted = await request('DELETE', '/api/admin/users/owner-a');
    assert.equal(deleted.response.status, 500);
    assert.equal(workspaceCount(), 1);
    const remaining = new DatabaseSync(path.join(dataDir, 'auth.sqlite'));
    assert.equal((remaining.prepare('SELECT COUNT(*) AS count FROM "user"').get() as { count: number }).count, 1);
    remaining.close();
  });
});
