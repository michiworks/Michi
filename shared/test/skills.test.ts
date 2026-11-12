import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  formatSkillFile,
  isValidSkillName,
  builtinSkillId,
  librarySkillId,
  liveSkillId,
  parseAgentCommands,
  parseSessionState,
  parseSkillFile,
  parseSkillId,
  parseSlashInvocation,
  readSkillFileInfo,
  runtimeSkillId,
  validateLibrarySkill,
  withSkillFileFields,
  withSkillFileName,
} from '../src/index';

describe('skill names and ids', () => {
  test('follow the Agent Skills name rule', () => {
    for (const name of ['a', 'pdf', 'code-review', 'v2-notes', 'x'.repeat(64)]) assert.equal(isValidSkillName(name), true, name);
    for (const name of ['', 'Code', '-a', 'a-', 'a--b', 'a_b', 'a/b', '..', 'a b', 'x'.repeat(65), 'plugin:skill']) {
      assert.equal(isValidSkillName(name), false, name);
    }
  });

  test('round-trip through parseSkillId', () => {
    assert.deepEqual(parseSkillId(librarySkillId('pdf')), { kind: 'library', name: 'pdf' });
    assert.deepEqual(parseSkillId(builtinSkillId('compare')), { kind: 'builtin', name: 'compare' });
    assert.equal(parseSkillId('builtin:Not A Name'), null);
    assert.deepEqual(parseSkillId(runtimeSkillId('claude', 'plugin', 'example:build-package')),
      { kind: 'runtime', runtimeId: 'claude', scope: 'plugin', nativeName: 'example:build-package' });
    assert.deepEqual(parseSkillId(runtimeSkillId('kiro', undefined, 'check')), { kind: 'runtime', runtimeId: 'kiro', scope: '', nativeName: 'check' });
    assert.deepEqual(parseSkillId(liveSkillId('claude', 'example:build-package')), { kind: 'live', runtimeId: 'claude', nativeName: 'example:build-package' });
    for (const bad of ['', 'library:../x', 'library:A', 'runtime:claude', 'runtime::x:y', 'runtime:claude:user:', 'live:claude', 'live::x', 'other:x']) {
      assert.equal(parseSkillId(bad), null, bad);
    }
  });
});

describe('slash invocations', () => {
  test('read the name and the text after it', () => {
    assert.deepEqual(parseSlashInvocation('/pdf'), { name: 'pdf', args: '' });
    assert.deepEqual(parseSlashInvocation('/pdf  merge a.pdf b.pdf '), { name: 'pdf', args: 'merge a.pdf b.pdf' });
    assert.deepEqual(parseSlashInvocation('/example:build-package build\nthe package'), { name: 'example:build-package', args: 'build\nthe package' });
    assert.deepEqual(parseSlashInvocation('/review\nfirst line'), { name: 'review', args: 'first line' });
  });

  test('ignore text that is not a command at the start', () => {
    for (const text of ['pdf', ' /pdf', '/', '/ pdf', '/pdf,now', 'see /pdf', '//x']) assert.equal(parseSlashInvocation(text), null, text);
  });
});

describe('SKILL.md frontmatter', () => {
  test('reads scalars, quotes, folded and literal blocks, and gives lists and maps no value', () => {
    const parsed = parseSkillFile([
      '---',
      'name: build-package',
      'description: >-',
      '  Example build system.',
      '  Use for builds.',
      '',
      '  Second paragraph.',
      'license: "Apache-2.0"',
      "summary: 'It''s fine'",
      'notes: |',
      '  line one',
      '    indented',
      'tags:',
      '- skill',
      '- build-package',
      'aliases: [a, "b c"]',
      'metadata:',
      '  author: someone',
      '  version: "1.0"',
      'user-invocable: false',
      'disable-model-invocation: true',
      'argument-hint: <package> [target]   # shown in menus',
      'plain: first part',
      '  continued here',
      '# a comment',
      'empty:',
      '---',
      '',
      '# Body',
      'Text.',
    ].join('\n'));
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.data.name, 'build-package');
    assert.equal(parsed.data.description, 'Example build system. Use for builds.\nSecond paragraph.');
    assert.equal(parsed.data.license, 'Apache-2.0');
    assert.equal(parsed.data.summary, "It's fine");
    assert.equal(parsed.data.notes, 'line one\n  indented\n');
    assert.equal(parsed.data.tags, null);
    assert.equal(parsed.data.aliases, '[a, "b c"]');
    assert.equal(parsed.data.metadata, null);
    assert.equal(parsed.data['user-invocable'], false);
    assert.equal(parsed.data['disable-model-invocation'], true);
    assert.equal(parsed.data['argument-hint'], '<package> [target]');
    assert.equal(parsed.data.plain, 'first part continued here');
    assert.equal(parsed.data.empty, null);
    assert.equal(parsed.body, '\n# Body\nText.');
  });

  test('reads a description written on the next lines, or starting with a bracket, as text', () => {
    const parsed = parseSkillFile('---\nname: x\ndescription:\n  Runs the release\n  checks.\ntitle: [WIP] Release check\n---\n');
    assert.equal(parsed.data.description, 'Runs the release checks.');
    assert.equal(parsed.data.title, '[WIP] Release check');
  });

  test('reports a missing or unclosed block instead of throwing', () => {
    assert.match(parseSkillFile('# no frontmatter').error ?? '', /no frontmatter/);
    assert.match(parseSkillFile('---\nname: x\n').error ?? '', /not closed/);
    assert.equal(parseSkillFile('﻿---\r\nname: x\r\ndescription: "a \\"b\\""\r\n---\r\nbody').data.description, 'a "b"');
  });

  test('readSkillFileInfo applies host defaults', () => {
    const info = readSkillFileInfo('---\ndescription: Does things\n---\n\nBody\n', 'folder-name');
    assert.equal(info.name, 'folder-name');
    assert.equal(info.userInvocable, true);
    assert.equal(info.modelInvocable, true);
    assert.equal(info.body, 'Body\n');
    assert.ok(info.warnings.some((warning) => /no name/.test(warning)));
    const off = readSkillFileInfo('---\nname: x\ndescription: d\nuser-invocable: "false"\ndisable-model-invocation: true\n---\n', 'x');
    assert.equal(off.userInvocable, false);
    assert.equal(off.modelInvocable, false);
  });
});

describe('library skill files', () => {
  test('formatSkillFile output validates and reads back', () => {
    const content = formatSkillFile({ name: 'release-notes', description: 'Write release notes: "short"\nand clear', body: '# Steps\n1. Read the log' });
    assert.deepEqual(validateLibrarySkill({ name: 'release-notes', content }), []);
    const info = readSkillFileInfo(content, 'release-notes');
    assert.equal(info.description, 'Write release notes: "short"\nand clear');
    assert.equal(info.body, '# Steps\n1. Read the log\n');
  });

  test('validateLibrarySkill names each problem', () => {
    assert.ok(validateLibrarySkill({ name: 'Bad', content: formatSkillFile({ name: 'Bad', description: 'd', body: '' }) }).some((e) => /lowercase/.test(e)));
    assert.ok(validateLibrarySkill({ name: 'a', content: formatSkillFile({ name: 'b', description: 'd', body: '' }) }).some((e) => /must match/.test(e)));
    assert.ok(validateLibrarySkill({ name: 'a', content: '---\nname: a\n---\n' }).some((e) => /description/.test(e)));
    assert.ok(validateLibrarySkill({ name: 'a', content: formatSkillFile({ name: 'a', description: 'x'.repeat(1025), body: '' }) }).some((e) => /longer/.test(e)));
    assert.ok(validateLibrarySkill({ name: 'a', content: 'no frontmatter' }).some((e) => /frontmatter/.test(e)));
  });

  test('withSkillFileName renames only the top-level name', () => {
    const content = '---\nname: old\ndescription: d\nmetadata:\n  name: keep\n---\nbody';
    assert.equal(withSkillFileName(content, 'new'), '---\nname: new\ndescription: d\nmetadata:\n  name: keep\n---\nbody');
    assert.equal(withSkillFileName('---\ndescription: d\n---\nbody', 'new'), '---\nname: new\ndescription: d\n---\nbody');
  });
});

describe('edit form fields', () => {
  test('withSkillFileFields replaces description, hint and body and keeps other keys', () => {
    const content = '---\nname: notes\ndescription: old\nlicense: MIT\nmetadata:\n  owner: me\nargument-hint: "[a]"\n---\n\nOld body\n';
    const next = withSkillFileFields(content, { description: 'New: text', argumentHint: '', body: 'New body' });
    assert.equal(next, '---\nname: notes\ndescription: "New: text"\nlicense: MIT\nmetadata:\n  owner: me\n---\n\nNew body\n');
    const info = readSkillFileInfo(withSkillFileFields(next, { description: 'd', argumentHint: '<since>', body: 'b' }), 'notes');
    assert.equal(info.argumentHint, '<since>');
    assert.deepEqual(validateLibrarySkill({ name: 'notes', content: next }), []);
  });

  test('formatSkillFile writes an argument hint when there is one', () => {
    assert.equal(readSkillFileInfo(formatSkillFile({ name: 'a', description: 'd', argumentHint: '[x]', body: '' }), 'a').argumentHint, '[x]');
  });
});

describe('agent commands', () => {
  test('keep kind, hint and aliases, and drop malformed entries', () => {
    assert.deepEqual(parseAgentCommands([
      { name: 'build-package', description: 'Build', input: { hint: 'optional context' }, kind: 'skill', source: 'user', _meta: { x: 1 } },
      { name: 'example:check', argumentHint: '<pkg>', aliases: ['check', 3], kind: 'skill' },
      { name: 'compact', input: { type: 'unstructured' } },
      { name: 'weird', kind: 'other' },
      { name: '' },
      null,
      'x',
    ]), [
      { name: 'build-package', description: 'Build', input: { hint: 'optional context' }, kind: 'skill' },
      { name: 'example:check', kind: 'skill', argumentHint: '<pkg>', aliases: ['check'] },
      { name: 'compact', input: { type: 'unstructured' } },
      { name: 'weird' },
    ]);
  });

  test('session state carries the same command fields', () => {
    const state = parseSessionState({ runtimeId: 'kiro', commands: [{ name: 'check', kind: 'skill', input: { hint: 'h' } }] });
    assert.deepEqual(state.commands, [{ name: 'check', kind: 'skill', input: { hint: 'h' } }]);
  });
});

describe('frontmatter parsing cost', () => {
  test('a long line without a colon parses in linear time', () => {
    const line = `x${' '.repeat(250_000)}`;
    const started = Date.now();
    const parsed = parseSkillFile(`---\nname: a\n${line}\nmetadata:\n  ${line}\n---\n`);
    assert.equal(parsed.data.name, 'a');
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
  });
});
