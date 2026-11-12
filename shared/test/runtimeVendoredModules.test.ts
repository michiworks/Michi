import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

// runtime/scripts/build.mjs copies into the runtime package the shared modules
// runtime/src imports names from, and every shared module they import (type
// imports included). It fails on an import from a subdirectory and on the
// product modules that must not ship (EXCLUDED_SHARED_MODULES,
// runtime/scripts/packageLayout.mjs). No shared check runs that build, and W0
// broke it unnoticed: chatStreamEvents and threadMessage imported companion,
// which imports assistant, metaAgentChat, companionStatus and pages/blocks
// (W0b recheck A-2). The build stays the authority; keep these lists in step
// with runtime/src and packageLayout.mjs.

const SRC = join(__dirname, '..', 'src');

/** The shared modules runtime/src imports names from. */
const RUNTIME_IMPORTS = [
  'agentRuns', 'chatPermissions', 'chatStreamEvents', 'crew', 'harness', 'kiroSteering',
  'reasoning', 'runtimeContracts', 'sessionState', 'skills', 'subagents', 'toolPurpose', 'workflowRuns',
];

/**
 * EXCLUDED_SHARED_MODULES, plus companion and companionStatus: the
 * Companion's product contracts, which also name the sign-in tooling that
 * runtime/scripts/pack.mjs refuses in the package.
 */
const MUST_NOT_SHIP = [
  'assistant', 'desktopContracts', 'michiPreamble',
  'metaAgent', 'metaAgentChat', 'metaAgentOverview', 'homeCards', 'pages', 'databaseModel', 'database/viewModel',
  'remoteCredentials', 'remoteDiagnostics', 'remoteSignIn', 'remoteUpdate', 'scheduledJobs',
  'companion', 'companionStatus',
];

/** The specifiers build.mjs follows (its RELATIVE_SPECIFIER), read here from the sources. */
const RELATIVE_SPECIFIER = /(?:\brequire\(\s*|\bfrom\s+|\bimport\(\s*)["'](\.\.?\/[^"']+)["']/g;

/** Every module the build vendors, to the module that first imported it (null for RUNTIME_IMPORTS), and the imports it cannot follow. */
function vendoredModules(): { importedBy: Map<string, string | null>; problems: string[] } {
  const importedBy = new Map<string, string | null>();
  const problems: string[] = [];
  const queue: Array<[string, string | null]> = RUNTIME_IMPORTS.map((module) => [module, null]);
  while (queue.length > 0) {
    const [module, parent] = queue.shift()!;
    if (importedBy.has(module)) continue;
    importedBy.set(module, parent);
    const file = join(SRC, `${module}.ts`);
    if (!existsSync(file)) {
      problems.push(`${module} is not a module of shared/src`);
      continue;
    }
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(RELATIVE_SPECIFIER)) {
      const target = specifier.replace(/^\.\//, '').replace(/\.js$/, '');
      if (target.includes('/') || !existsSync(join(SRC, `${target}.ts`))) problems.push(`${module} imports ${specifier}, which is not a module beside it`);
      else queue.push([target, module]);
    }
  }
  return { importedBy, problems };
}

describe('the shared modules the runtime package vendors (runtime/scripts/build.mjs)', () => {
  const { importedBy, problems } = vendoredModules();
  /** How the build reaches a module: `chatStreamEvents → threadMessage → companion`. */
  const path = (module: string): string => {
    const parent = importedBy.get(module);
    return parent ? `${path(parent)} → ${module}` : module;
  };

  test('import only top-level modules of shared', () => {
    assert.deepEqual(problems, []);
  });

  test("leave out Michi's product code: no excluded module, nor companion or companionStatus", () => {
    assert.deepEqual([...importedBy.keys()].filter((module) => MUST_NOT_SHIP.includes(module)).map(path), []);
  });
});
