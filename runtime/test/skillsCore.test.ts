import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandSkillPrompt, hostSkillsPrefix, renderSkillBlock, scanSkillRoots, skillHistoryText, substituteSkillArguments } from '../src/core/skills';
import type { SkillTurnInvocation } from '../src/contract/types';

const skill = (over: Partial<SkillTurnInvocation> = {}): SkillTurnInvocation => ({
  id: 'library:notes', name: 'notes', origin: 'library', path: '/lib/notes/SKILL.md', body: 'Write notes about $ARGUMENTS.\n', args: 'the build', ...over,
});

describe('skill expansion', () => {
  it('renders the Agent Skills block with the skill folder and the arguments filled in', () => {
    assert.equal(renderSkillBlock(skill()),
      '<skill name="notes" location="/lib/notes/SKILL.md">\nReferences are relative to /lib/notes.\n\nWrite notes about the build.\n</skill>');
    assert.equal(renderSkillBlock(skill({ path: undefined, name: 'a"b' })), '<skill name="a&quot;b">\nWrite notes about the build.\n</skill>');
    assert.equal(substituteSkillArguments('x ${ARGUMENTS} $ARGUMENTS $ARGUMENTS[0] $1 $0.00', '$&'), 'x $& $& $ARGUMENTS[0] $1 $0.00');
  });

  it('puts the turn text after the block, without the arguments the body already holds, and falls back to the command when there is no body', () => {
    assert.match(expandSkillPrompt(skill(), 'ctx\n\nthe build'), /about the build\.\n<\/skill>\n\nctx$/);
    assert.match(expandSkillPrompt(skill(), 'the build'), /<\/skill>$/);
    assert.match(expandSkillPrompt(skill({ body: 'Write notes.' }), 'ctx\n\nthe build'), /<\/skill>\n\nctx\n\nthe build$/);
    assert.match(expandSkillPrompt(skill({ args: '' }), ''), /<\/skill>$/);
    assert.equal(expandSkillPrompt(skill({ body: undefined, nativeName: 'example:notes' }), 'the build'), '/example:notes the build');
    assert.equal(expandSkillPrompt(skill({ body: undefined }), ''), '/notes');
  });
});

describe('skillHistoryText', () => {
  it("keeps a skill turn as its context, then the command the person ran", () => {
    const attached = '[Attached files: shot.png — /d/shot.png]';
    const cases: Array<[string, Partial<SkillTurnInvocation>, string, string]> = [
      ['plain arguments', { args: 'the build' }, 'the build', '/notes the build'],
      ['attachments first, as the composer sends them', { args: 'fix the bug' },
        `${attached}\n\nfix the bug`, `${attached}\n\n/notes fix the bug`],
      ['attachments after arguments that repeat a file name', { args: 'shot.png' },
        `Look at this comment:\n\nshot.png\n\n${attached}`, `Look at this comment:\n\n${attached}\n\n/notes shot.png`],
      ['a quote the reply follows', { args: 'check it' },
        "> the failing step\n\nUser's reply:\ncheck it", "> the failing step\n\nUser's reply:\n\n/notes check it"],
      ['a mentioned chat ahead of the arguments', { args: 'sum it up' },
        '<chat title="Plan">\nthe plan\n</chat>\n\nsum it up', '<chat title="Plan">\nthe plan\n</chat>\n\n/notes sum it up'],
      ['no arguments, with attachments', { args: '' }, attached, `${attached}\n\n/notes`],
      ['no text at all', { args: '' }, '', '/notes'],
      ['a native name', { args: 'go', nativeName: 'example:notes' }, 'go', '/example:notes go'],
    ];
    for (const [label, over, text, expected] of cases) assert.equal(skillHistoryText(skill(over), text), expected, label);
  });
});

describe('scanSkillRoots', () => {
  it('reads child SKILL.md folders, follows symlinks, keeps the first of a name and skips the rest', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-scan-'));
    try {
      const write = (dir: string, content: string) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'SKILL.md'), content); };
      write(path.join(tmp, 'project', 'review'), '---\nname: review\ndescription: Project review\nargument-hint: <pr>\n---\nbody');
      write(path.join(tmp, 'user', 'review'), '---\nname: review\ndescription: User review\n---\nbody');
      write(path.join(tmp, 'user', 'exampleish'), '---\nname: exampleish\ndescription: d\ndisable-model-invocation: true\n---\n');
      fs.writeFileSync(path.join(tmp, 'user', 'exampleish', '.example-managed'), '');
      write(path.join(tmp, 'elsewhere', 'linked'), '---\ndescription: Linked\nuser-invocable: false\n---\n');
      fs.symlinkSync(path.join(tmp, 'elsewhere', 'linked'), path.join(tmp, 'user', 'linked'));
      fs.mkdirSync(path.join(tmp, 'user', 'no-skill-md'));
      fs.mkdirSync(path.join(tmp, 'user', '.hidden'));
      const listing = await scanSkillRoots([
        { dir: path.join(tmp, 'project'), scope: 'project' },
        { dir: path.join(tmp, 'user'), scope: 'user' },
        { dir: path.join(tmp, 'missing'), scope: 'user' },
      ]);
      assert.equal(listing.errors, undefined);
      assert.deepEqual(listing.skills.map((s) => [s.name, s.scope, s.description]), [
        ['review', 'project', 'Project review'], ['exampleish', 'user', 'd'], ['linked', 'user', 'Linked'],
      ]);
      const [review, exampleish, linked] = listing.skills;
      assert.equal(review.argumentHint, '<pr>');
      assert.equal(review.path, path.join(tmp, 'project', 'review', 'SKILL.md'));
      assert.equal(exampleish.managedBy, undefined);
      assert.equal(exampleish.modelInvocable, false);
      assert.equal(linked.userInvocable, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('hostSkillsPrefix', () => {
  const profiles = {
    isRestricted: (profile: { restricted?: boolean } | null | undefined) => profile?.restricted === true,
    isMaintenance: (profile: { maintenance?: boolean } | null | undefined) => (profile as { maintenance?: boolean } | null | undefined)?.maintenance === true,
  };
  it('asks the host to name skills only for an ordinary chat, saying whether the session lists the library itself', () => {
    assert.deepEqual(hostSkillsPrefix(profiles, { interactive: true, toolProfile: undefined, librarySkillsLoaded: true }), { hostSkills: { librarySkillsLoaded: true } });
    assert.deepEqual(hostSkillsPrefix(profiles, { interactive: true, toolProfile: null, librarySkillsLoaded: false }), { hostSkills: { librarySkillsLoaded: false } });
    for (const input of [
      { interactive: false, toolProfile: undefined },
      { interactive: true, toolProfile: { assistant: true } },
      { interactive: true, toolProfile: { restricted: true } },
      { interactive: true, toolProfile: { maintenance: true } },
    ]) assert.deepEqual(hostSkillsPrefix(profiles, { ...input, librarySkillsLoaded: true } as never), {}, JSON.stringify(input));
  });
});
