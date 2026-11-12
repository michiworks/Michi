import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * `better-auth` is the schema Better Auth 1.6's default migrations
 * (runAuthMigrations) create; `snake-case` has the column names of older
 * deployments, which the admin routes still read.
 */
export type AuthSchema = 'better-auth' | 'snake-case';

const BETTER_AUTH_TABLES = `
  CREATE TABLE IF NOT EXISTS "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);
  CREATE TABLE IF NOT EXISTS "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);
  CREATE TABLE IF NOT EXISTS "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);
`;

function snakeCase(identifier: string): string {
  return identifier.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** Creates the auth tables if needed, then a user with one session and one account. */
export function createAuthUser(dataDir: string, id: string, schema: AuthSchema = 'better-auth'): void {
  const column = schema === 'better-auth' ? (name: string) => name : snakeCase;
  const db = new DatabaseSync(path.join(dataDir, 'auth.sqlite'));
  try {
    db.exec(schema === 'better-auth' ? BETTER_AUTH_TABLES
      : BETTER_AUTH_TABLES.replace(/"([a-z]+[A-Z][A-Za-z]*)"/g, (_match, name: string) => `"${snakeCase(name)}"`));
    db.prepare(`INSERT INTO "user" (id, name, email, "${column('emailVerified')}", "${column('createdAt')}",
      "${column('updatedAt')}") VALUES (?, ?, ?, 1, 1, 1)`).run(id, id, `${id}@example.com`);
    db.prepare(`INSERT INTO "session" (id, "${column('expiresAt')}", token, "${column('createdAt')}",
      "${column('updatedAt')}", "${column('userId')}") VALUES (?, 1, ?, 1, 1, ?)`).run(`session-${id}`, `token-${id}`, id);
    db.prepare(`INSERT INTO "account" (id, "${column('accountId')}", "${column('providerId')}", "${column('userId')}",
      "${column('createdAt')}", "${column('updatedAt')}") VALUES (?, ?, 'google', ?, 1, 1)`).run(`account-${id}`, id, id);
  } finally {
    db.close();
  }
}

/** Rows left for this user in each auth table. */
export function authRowsFor(dataDir: string, id: string): { user: number; session: number; account: number } {
  const db = new DatabaseSync(path.join(dataDir, 'auth.sqlite'));
  try {
    const userIdColumn = (table: string) => (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
      .some((entry) => entry.name === 'userId') ? 'userId' : 'user_id';
    const count = (sql: string) => (db.prepare(sql).get(id) as { count: number }).count;
    return {
      user: count('SELECT COUNT(*) AS count FROM "user" WHERE id = ?'),
      session: count(`SELECT COUNT(*) AS count FROM "session" WHERE "${userIdColumn('session')}" = ?`),
      account: count(`SELECT COUNT(*) AS count FROM "account" WHERE "${userIdColumn('account')}" = ?`),
    };
  } finally {
    db.close();
  }
}
