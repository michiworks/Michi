/**
 * DESIGN-v2 §1.5: there is no "Meta agent" for the user any more. Its
 * background maintenance is the agent's Pages upkeep, and Settings › Meta
 * agent is part of Settings › <name>. So the reasons, errors and tool
 * results the Pages upkeep services hand on (to Settings, Scheduled, Pages
 * and the agent, which repeats them to the user) never say "Meta agent".
 *
 * Log lines are not shown, and ids, paths and keys (`meta-agent`,
 * `michi-meta-agent-*`) never match. The HELD tool result's prefix is read by
 * the frontend's tool line (frontend/src/state/metaChat/toolLines.ts), which
 * matches the old and the new wording. The restriction-check message comes
 * from agents/metaAgentGuard.ts; the readers here are regular expressions,
 * which this does not count.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { kiroMetaAgentConfig } from '../src/agents/kiro/kiroMetaAgent';

const SRC = path.join(__dirname, '..', 'src');
const META_AGENT = /\bmeta\s+agent\b/i;

/** Pages upkeep's services and its Kiro profile; the chat turn context and the first-run narration have their own owners. */
const FILES = [
  ...fs.readdirSync(path.join(SRC, 'services', 'metaAgent'))
    .filter((name) => name.endsWith('.ts') && name !== 'chatTurnContext.ts' && name !== 'firstRunNarration.ts')
    .map((name) => path.join('services', 'metaAgent', name)),
  path.join('agents', 'kiro', 'kiroMetaAgent.ts'),
];

/** A call whose strings go to the log only: `log.warn(...)` and the like. */
function isLogCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  const target = node.expression.expression;
  return ts.isIdentifier(target) && target.text === 'log';
}

/** Each string, template part or JSX text in `file` that says Meta agent, as `line: text`. */
function shownMetaAgent(file: string): string[] {
  const text = fs.readFileSync(path.join(SRC, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (isLogCall(node)) return;
    const shown = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
    if (shown && META_AGENT.test(node.text)) {
      found.push(`${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('Pages upkeep’s words', () => {
  test('never say Meta agent in what the services hand on', () => {
    assert.ok(FILES.length > 10, 'the services were found');
    const shown = Object.fromEntries(FILES.map((file) => [file, shownMetaAgent(file)]).filter(([, lines]) => lines.length > 0));
    assert.deepEqual(shown, {});
  });

  test('the Kiro profiles describe Pages upkeep and the check-ins, not a Meta agent or the retired Spaces chat window', () => {
    const descriptions = (['maintenance', 'chat', 'memory'] as const).map((toolset) => String(kiroMetaAgentConfig(toolset, ['read_node']).description));
    assert.deepEqual(descriptions, [
      'Michi: Pages upkeep, the background maintenance of Space pages',
      'Michi: private check-in turns',
      'Michi: automatic memory extraction',
    ]);
  });
});
