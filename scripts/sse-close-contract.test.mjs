import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// An SSE subscriber cleans up on res.on('close'). A request's 'close' fires
// once its body has been read, while the response stream is still open, so
// req.on('close') would drop a subscriber that is still connected (AGENTS.md,
// Backend and streaming). Code is parsed, so comments that name it do not count.

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const backendSrc = join(root, 'backend/src');
const LISTEN = new Set(['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']);

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(path);
    return /\.(?:[cm]?[jt]s|tsx)$/.test(entry.name) ? [path] : [];
  });
}

/** Lines of `req.on('close', ...)` and the like in a module's code. */
function requestCloseListeners(file, text) {
  if (!/\breq\b/.test(text) || !/close/.test(text)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'req'
      && LISTEN.has(node.expression.name.text)
      && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === 'close') {
      lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

test('backend code listens for an SSE disconnect on res, never on req', () => {
  const found = sources(backendSrc).flatMap((file) => requestCloseListeners(file, readFileSync(file, 'utf8'))
    .map((line) => `${relative(root, file)}:${line}`));
  assert.deepEqual(found, [], "Use res.on('close') for SSE subscriber cleanup.");
});

test('the check finds req close listeners in code and ignores comments and strings', () => {
  const code = [
    "// req.on('close') is wrong here",
    "/** never `req.on('close')` */",
    "const text = \"req.on('close')\";",
    "res.on('close', cleanup);",
    "request.on('close', () => clearTimeout(timer));",
    "req.on('close', cleanup);",
    'req.once("close", cleanup);',
    'req?.on(`close`, cleanup);',
    "req.on('end', cleanup);",
  ].join('\n');
  assert.deepEqual(requestCloseListeners('example.ts', code), [6, 7, 8]);
});
