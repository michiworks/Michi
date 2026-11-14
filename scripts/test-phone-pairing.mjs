import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Real gateway + browser cookies/CSP through a local HTTPS stand-in for Serve.
// No Tailscale install, user data, SQLite, real backend or agent processes.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(path.join(tmpdir(), 'michi-phone-pairing-'));
let browser, upstream, proxy, ingress;
try {
  const bundle = path.join(temp, 'gateway.cjs');
  await build({ entryPoints: [path.join(root, 'backend/src/services/mobileAccessGateway.ts')], outfile: bundle,
    bundle: true, platform: 'node', format: 'cjs', target: 'node22' });
  const { listenPairedIngress } = createRequire(import.meta.url)(bundle);
  const key = path.join(temp, 'key.pem');
  const cert = path.join(temp, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
    '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const upstreamRequests = [];
  upstream = createServer((req, res) => {
    upstreamRequests.push({ authorization: req.headers.authorization, cookie: req.headers.cookie });
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Paired Michi</title><p>Phone connected</p>');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  proxy = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
    const forwarded = request(ingress.endpoint + req.url, { method: req.method,
      headers: { ...req.headers, 'tailscale-user-login': 'owner' } }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    forwarded.on('error', () => res.writeHead(502).end());
    req.pipe(forwarded);
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const origin = `https://127.0.0.1:${proxy.address().port}`;
  const options = { target: `http://127.0.0.1:${upstream.address().port}`, token: 'fixture-backend-token',
    owner: 'owner', identityHeader: 'tailscale-user-login', probeToken: 'fixture-probe', publicOrigin: () => origin };
  ingress = await listenPairedIngress(options);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  assert.equal((await page.goto(origin)).status(), 403);
  const link = ingress.gateway.mintLink().url;
  await page.goto(link);
  await page.waitForURL(origin + '/');
  assert.equal(await page.title(), 'Paired Michi');
  assert.equal(await page.evaluate(() => document.cookie), '');
  const cookies = await context.cookies();
  assert.equal(cookies.length, 1);
  assert.equal(cookies[0].httpOnly, true); assert.equal(cookies[0].secure, true);
  assert.equal(cookies[0].sameSite, 'Strict');
  assert.equal((await page.reload()).status(), 200);
  assert.ok(upstreamRequests.every(req => req.authorization === 'Bearer fixture-backend-token' && req.cookie === undefined));
  await context.clearCookies();
  assert.equal((await page.reload()).status(), 403);
  await page.goto(link); await page.waitForURL(origin + '/');
  await ingress.close(); ingress = await listenPairedIngress(options);
  assert.equal((await page.reload()).status(), 403);
  await page.goto(link);
  await page.getByText('Pairing failed. Open the current phone link from Michi.').waitFor();
  await page.goto(ingress.gateway.mintLink().url); await page.waitForURL(origin + '/');
  assert.equal(await page.title(), 'Paired Michi');
  assert.deepEqual(errors, []);
  console.log('PASS: HTTPS browser pairing, CSP, Secure/HttpOnly cookies, reload, cookie clearing, revocation and re-pairing.');
} finally {
  await browser?.close();
  await ingress?.close();
  for (const server of [proxy, upstream]) {
    if (!server) continue;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  await rm(temp, { recursive: true, force: true });
}
