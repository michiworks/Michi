import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  createRemoteAccessMiddleware,
  isInternalRuntimeRequest,
  isLoopbackHost,
  resolveListenHost,
  selfLoopbackBase,
  validateRemoteAccessConfiguration,
} from '../src/services/remoteAccess';
import { isLocalControlRequest, isLoopbackListenHost } from '../src/routes/middleware/localControl';
import { McpSlotRegistry, mountMcp } from '../src/services/mcpServer';

const ENV_NAMES = [
  'MICHI_REMOTE_ACCESS',
  'MICHI_REMOTE_TOKEN',
  'MICHI_REQUIRE_AUTH',
  'MICHI_BIND_HOST',
  'MICHI_CLOUD',
  'MICHI_LOCAL_AUTH_EMAIL',
] as const;
const original = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function setEnv(values: Partial<Record<(typeof ENV_NAMES)[number], string>>): void {
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, values);
}

const TOKEN = 'long-enough-remote-token';
const UNAUTHENTICATED_WIDE_BIND = /^Error: Michi will not listen on .+: without authentication, anyone who can reach that address could use its API, agent shell tools included\. .*unset MICHI_BIND_HOST or set it to 127\.0\.0\.1.*MICHI_REMOTE_ACCESS=1 with a MICHI_REMOTE_TOKEN of at least 16 characters.*MICHI_REQUIRE_AUTH=true/;

describe('remote access token middleware', () => {
  test('requires a strong token and rejects cloud auth combination', () => {
    process.env.MICHI_REMOTE_ACCESS = '1';
    delete process.env.MICHI_REMOTE_TOKEN;
    assert.throws(validateRemoteAccessConfiguration, /requires MICHI_REMOTE_TOKEN/);
    process.env.MICHI_REMOTE_TOKEN = 'short';
    assert.throws(validateRemoteAccessConfiguration, /at least 16/);
    process.env.MICHI_REMOTE_TOKEN = 'long-enough-remote-token';
    process.env.MICHI_REQUIRE_AUTH = 'true';
    assert.throws(validateRemoteAccessConfiguration, /cannot be enabled together/);
  });

  test('accepts only the configured bearer token', () => {
    process.env.MICHI_REMOTE_ACCESS = '1';
    process.env.MICHI_REMOTE_TOKEN = 'long-enough-remote-token';
    delete process.env.MICHI_REQUIRE_AUTH;
    validateRemoteAccessConfiguration();
    const middleware = createRemoteAccessMiddleware();
    let status = 0;
    let body: unknown;
    let nextCalls = 0;
    const response = {
      locals: {},
      status(code: number) { status = code; return this; },
      json(value: unknown) { body = value; return this; },
    } as any;
    middleware({ headers: { authorization: 'Bearer wrong' } } as any, response, () => { nextCalls += 1; });
    assert.equal(status, 401);
    assert.deepEqual(body, { error: 'invalid remote access token' });
    middleware({ headers: { authorization: 'Bearer long-enough-remote-token' } } as any, response, () => { nextCalls += 1; });
    assert.equal(nextCalls, 1);
  });

  test('bypasses bearer only for loopback internal-runtime paths', () => {
    process.env.MICHI_REMOTE_ACCESS = '1';
    process.env.MICHI_REMOTE_TOKEN = 'long-enough-remote-token';
    const middleware = createRemoteAccessMiddleware();

    const invoke = (path: string, remoteAddress: string) => {
      let status = 0;
      let nextCalls = 0;
      const response = {
        locals: {},
        status(code: number) { status = code; return this; },
        json() { return this; },
      } as any;
      middleware({
        path,
        socket: { remoteAddress },
        headers: {},
      } as any, response, () => { nextCalls += 1; });
      return { status, nextCalls };
    };

    assert.deepEqual(invoke('/mcp/slot-1', '127.0.0.1'), { status: 0, nextCalls: 1 });
    assert.deepEqual(invoke('/mcp-session/group-1', '127.0.0.1'), { status: 0, nextCalls: 1 });
    assert.deepEqual(invoke('/codex-hooks/slot-1/stop', '::1'), { status: 401, nextCalls: 0 });
    assert.deepEqual(invoke('/mcp/slot-1', '10.0.0.42'), { status: 401, nextCalls: 0 });
    assert.deepEqual(invoke('/mcp-session/group-1', '10.0.0.42'), { status: 401, nextCalls: 0 });
    assert.deepEqual(invoke('/workspaces/all', '127.0.0.1'), { status: 401, nextCalls: 0 });
  });

  test('keeps external APIs protected while loopback MCP reaches slot validation', async () => {
    process.env.MICHI_REMOTE_ACCESS = '1';
    process.env.MICHI_REMOTE_TOKEN = 'long-enough-remote-token';

    const app = express();
    app.use(express.json());
    app.use('/api', createRemoteAccessMiddleware());
    const router = express.Router();
    const registry = new McpSlotRegistry();
    const slot = registry.create('remote-auth-test', process.cwd(), null, {
      onSpawnBranches: async () => [],
      onSaveArtifact: () => null,
      onUpdateArtifact: () => null,
      onShowImage: () => ({ error: 'unsupported in test' }),
    });
    mountMcp(router, registry);
    app.use('/api', router);
    app.get('/api/protected', (_req, res) => res.json({ ok: true }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const protectedResponse = await fetch(`http://127.0.0.1:${port}/api/protected`);
      assert.equal(protectedResponse.status, 401);

      const initializeResponse = await fetch(`http://127.0.0.1:${port}/api/mcp/${slot.slotId}`, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'remote-auth-test', version: '1.0.0' },
          },
        }),
      });
      assert.equal(initializeResponse.status, 200);

      const unknownSlotResponse = await fetch(`http://127.0.0.1:${port}/api/mcp/unknown-slot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      assert.equal(unknownSlotResponse.status, 404);
      assert.deepEqual(await unknownSlotResponse.json(), { error: 'unknown mcp slot' });

      const authorizedResponse = await fetch(`http://127.0.0.1:${port}/api/protected`, {
        headers: { authorization: 'Bearer long-enough-remote-token' },
      });
      assert.equal(authorizedResponse.status, 200);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });
});

describe('backend listen host', () => {
  test('defaults local mode to loopback', () => {
    delete process.env.MICHI_REMOTE_ACCESS;
    delete process.env.MICHI_CLOUD;
    delete process.env.MICHI_BIND_HOST;
    assert.equal(resolveListenHost(), '127.0.0.1');
  });

  test('keeps remote access on loopback unless a bind host is set', () => {
    setEnv({ MICHI_REMOTE_ACCESS: '1', MICHI_REMOTE_TOKEN: TOKEN });
    assert.equal(resolveListenHost(), '127.0.0.1');
    process.env.MICHI_BIND_HOST = '0.0.0.0';
    assert.equal(resolveListenHost(), '0.0.0.0');
  });

  test('binds all interfaces only for the cloud container', () => {
    setEnv({ MICHI_CLOUD: '1', MICHI_REQUIRE_AUTH: 'true' });
    assert.equal(resolveListenHost(), '0.0.0.0');
    for (const value of ['true', '0']) {
      process.env.MICHI_CLOUD = value;
      assert.equal(resolveListenHost(), '127.0.0.1', value);
    }
  });

  test('honors an explicit loopback binding and rejects malformed hosts', () => {
    process.env.MICHI_REMOTE_ACCESS = '1';
    process.env.MICHI_BIND_HOST = '127.0.0.1';
    assert.equal(resolveListenHost(), '127.0.0.1');
    process.env.MICHI_BIND_HOST = 'bad host/name';
    assert.throws(resolveListenHost, /invalid/);
  });

  // server.ts calls validateRemoteAccessConfiguration before it opens databases or listens.
  test('refuses an address beyond loopback while nothing authenticates callers', () => {
    for (const host of ['0.0.0.0', '::', '[::]', '192.168.1.20', '100.64.0.10', 'fe80::1%eth0', 'michi.example.com', '127.1']) {
      setEnv({ MICHI_BIND_HOST: host });
      assert.throws(resolveListenHost, UNAUTHENTICATED_WIDE_BIND, host);
      assert.throws(validateRemoteAccessConfiguration, UNAUTHENTICATED_WIDE_BIND, host);
    }
    // MICHI_REQUIRE_AUTH has to be exactly true, and remote access needs its token.
    for (const values of [
      { MICHI_REQUIRE_AUTH: '1' },
      { MICHI_REQUIRE_AUTH: 'yes' },
      { MICHI_REMOTE_ACCESS: '1' },
      { MICHI_REMOTE_ACCESS: '1', MICHI_REMOTE_TOKEN: 'fifteen-chars!!' },
      { MICHI_REMOTE_ACCESS: 'true', MICHI_REMOTE_TOKEN: TOKEN },
      { MICHI_REMOTE_TOKEN: TOKEN },
    ]) {
      setEnv({ ...values, MICHI_BIND_HOST: '0.0.0.0' });
      assert.throws(resolveListenHost, UNAUTHENTICATED_WIDE_BIND, JSON.stringify(values));
    }
    setEnv({ MICHI_REMOTE_ACCESS: '1', MICHI_REMOTE_TOKEN: 'fifteen-chars!!', MICHI_BIND_HOST: '0.0.0.0' });
    assert.throws(validateRemoteAccessConfiguration, /at least 16/, 'the token error comes first');
  });

  test('a loopback address needs no authentication', () => {
    for (const host of ['127.0.0.1', '127.0.0.2', '127.255.255.254', 'localhost', 'LOCALHOST', '::1', '[::1]',
      '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::1%lo']) {
      setEnv({ MICHI_BIND_HOST: host });
      assert.equal(resolveListenHost(), host);
      assert.doesNotThrow(validateRemoteAccessConfiguration, host);
      assert.equal(isLoopbackListenHost(host), true, `the local origin guard agrees: ${host}`);
    }
    for (const host of ['0.0.0.0', '::', '::ffff:10.0.0.1', '128.0.0.1', 'localhost.example.com']) {
      assert.equal(isLoopbackHost(host), false, host);
    }
  });

  test('a peer is this host by the MCP host rule: 127.0.0.0/8, ::1 and IPv4-mapped 127.x', () => {
    const local = (remoteAddress: string | undefined) => isLocalControlRequest(
      { headers: { host: '127.0.0.1:3000' }, socket: { remoteAddress } } as never, { locals: {} } as never);
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.2', '::FFFF:127.9.9.9']) {
      assert.equal(isInternalRuntimeRequest('/mcp/slot', address), true, address);
      assert.equal(local(address), true, address);
    }
    for (const address of [undefined, '10.0.0.5', '::ffff:10.0.0.1', '0.0.0.0', '::']) {
      assert.equal(isInternalRuntimeRequest('/mcp/slot', address), false, String(address));
      assert.equal(local(address), false, String(address));
    }
  });

  test('the backend dials its own listener over loopback, or not at all', () => {
    for (const [host, base] of [
      ['127.0.0.1', 'http://127.0.0.1:3000'], ['0.0.0.0', 'http://127.0.0.1:3000'], ['::', 'http://[::1]:3000'],
      ['[::]', 'http://[::1]:3000'], ['::1', 'http://[::1]:3000'], ['[::1]', 'http://[::1]:3000'],
      ['0:0:0:0:0:0:0:1', 'http://[::1]:3000'], ['::1%lo', 'http://[::1]:3000'], ['127.0.0.2', 'http://127.0.0.2:3000'],
      ['::ffff:127.0.0.1', 'http://127.0.0.1:3000'], ['localhost', 'http://127.0.0.1:3000'],
      ['10.0.0.8', null], ['100.64.0.10', null], ['michi.example.com', null],
    ] as const) {
      assert.equal(selfLoopbackBase(host, 3000), base, host);
    }
  });

  test("agents' MCP URLs reach a backend listening on ::1", () => {
    const callbacks = { onSpawnBranches: async () => [], onSaveArtifact: () => null, onUpdateArtifact: () => null,
      onShowImage: () => ({ error: 'unsupported in test' }) };
    const url = (registry: McpSlotRegistry) => registry.endpoint(registry.create('slot', process.cwd(), null, callbacks).slotId).url;
    assert.match(url(new McpSlotRegistry({ mcpPort: 4100, mcpHost: () => '::1' })), /^http:\/\/\[::1\]:4100\/api\/mcp\//);
    assert.match(url(new McpSlotRegistry({ mcpPort: 4100 })), /^http:\/\/127\.0\.0\.1:4100\/api\/mcp\//);
  });

  test('a wider address is allowed when the remote token or session auth verifies every caller', () => {
    setEnv({ MICHI_REMOTE_ACCESS: '1', MICHI_REMOTE_TOKEN: TOKEN, MICHI_BIND_HOST: '0.0.0.0' });
    assert.equal(resolveListenHost(), '0.0.0.0');
    validateRemoteAccessConfiguration();

    setEnv({ MICHI_REQUIRE_AUTH: 'true', MICHI_LOCAL_AUTH_EMAIL: 'me@example.com', MICHI_BIND_HOST: '100.64.0.10' });
    assert.equal(resolveListenHost(), '100.64.0.10');
    validateRemoteAccessConfiguration();

    setEnv({ MICHI_CLOUD: '1', MICHI_REQUIRE_AUTH: 'TRUE', MICHI_BIND_HOST: '::' });
    assert.equal(resolveListenHost(), '::');

    // An incomplete auth setup is not authentication.
    setEnv({ MICHI_REQUIRE_AUTH: 'true', MICHI_BIND_HOST: '0.0.0.0' });
    assert.throws(resolveListenHost, /Local authentication requires one MICHI_LOCAL_AUTH_EMAIL/);
    setEnv({ MICHI_CLOUD: '1' });
    assert.throws(resolveListenHost, /MICHI_CLOUD=1 requires MICHI_REQUIRE_AUTH=true/);
  });
});
