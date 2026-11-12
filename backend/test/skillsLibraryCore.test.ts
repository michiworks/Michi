import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatSkillFile, librarySkillId, liveSkillId, runtimeSkillId, SKILL_LIBRARY_FOLDER_NAME } from 'michi-shared';
import type { RuntimeSkillListing } from 'michi-runtime';
import { skillLibraryRoot, skillMountsRoot, skillStatePath } from '../src/services/skills/paths';
import { enabledLibrarySkills, listLibrarySkills } from '../src/services/skills/library';
import { readSkillsState, updateSkillsState } from '../src/services/skills/state';
import { librarySkillDirs, resetSkillMountsForTests, skillMountRoot } from '../src/services/skills/mounts';
import { setBuiltinSkillsForTests } from '../src/services/skills/builtin';
import { notifySkillLibraryChanged, onSkillLibraryChanged } from '../src/services/skills/events';
import { parseSkillInvocationRequest, resolveSkillInvocation, SkillInvocationError, skillMessageMetadata } from '../src/services/skills/invocation';
import { listRuntimeSkills, listSkillCatalog, setSkillListingTimingForTests } from '../src/services/skills/catalog';
import { michiSkillsTool } from '../src/services/skills/michiSkillsTool';

function writeSkill(name: string, description = `About ${name}`, body = `Do ${name} for $ARGUMENTS.`): string {
  const dir = path.join(skillLibraryRoot(), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), formatSkillFile({ name, description, body }));
  return dir;
}

function reset(): void {
  fs.rmSync(skillLibraryRoot(), { recursive: true, force: true });
  fs.rmSync(skillMountsRoot(), { recursive: true, force: true });
  fs.rmSync(skillStatePath(), { force: true });
  resetSkillMountsForTests();
  // Built-in skills have their own tests (skillsBuiltin.test.ts).
  setBuiltinSkillsForTests([]);
}

const isCode = (code: string) => (error: unknown) => error instanceof SkillInvocationError && error.code === code;

describe('skill library core', () => {
  beforeEach(reset);
  afterEach(() => { delete process.env.MICHI_CLOUD; reset(); });

  test('lists valid skill folders, on unless turned off', () => {
    writeSkill('alpha');
    writeSkill('beta');
    fs.mkdirSync(path.join(skillLibraryRoot(), 'Not-Valid'), { recursive: true });
    fs.writeFileSync(path.join(skillLibraryRoot(), 'Not-Valid', 'SKILL.md'), formatSkillFile({ name: 'x', description: 'd', body: '' }));
    fs.mkdirSync(path.join(skillLibraryRoot(), 'empty'), { recursive: true });
    // An older build's settings: everything but enabled: false is ignored, and the next write drops it.
    fs.writeFileSync(skillStatePath(), JSON.stringify({
      version: 1, hidden: ['library:alpha'], library: { alpha: { runtimes: ['codex'], importedFrom: { path: '/x' } }, beta: { enabled: false, runtimes: null } },
    }));
    assert.deepEqual(listLibrarySkills().map((skill) => [skill.name, skill.enabled]), [['alpha', true], ['beta', false]]);
    assert.deepEqual(enabledLibrarySkills().map((skill) => skill.name), ['alpha']);
    assert.deepEqual(librarySkillDirs(), [path.join(skillLibraryRoot(), 'alpha')]);
    updateSkillsState((state) => state);
    assert.deepEqual(JSON.parse(fs.readFileSync(skillStatePath(), 'utf8')), { version: 1, library: { beta: { enabled: false } }, builtin: {} });
  });

  test('an unreadable state file turns every library skill off for runtimes', async () => {
    writeSkill('alpha');
    fs.writeFileSync(skillStatePath(), '{not json');
    assert.throws(() => readSkillsState());
    const page = await listSkillCatalog({ cwd: null });
    assert.deepEqual(page.skills.map((skill) => [skill.id, skill.enabled]), [['library:alpha', false]], 'the Skills page still lists it, as off');
    assert.match(page.errors[0]?.message ?? '', /skills-state\.json could not be read/);
    assert.deepEqual(fs.readdirSync(skillMountRoot('codex', 'flat')!), []);
    assert.deepEqual(librarySkillDirs(), []);
    assert.deepEqual(JSON.parse(michiSkillsTool({ action: 'list' }).content[0].text).skills, []);
    await assert.rejects(resolveSkillInvocation({
      request: { id: librarySkillId('alpha'), name: 'alpha', args: '' }, runtime: { id: 'claude', label: 'Claude' }, cwd: '/tmp',
    }), isCode('skill_not_found'));
  });

  test('mounts link the enabled skills in each layout and follow library changes', () => {
    writeSkill('alpha');
    writeSkill('beta');
    updateSkillsState((state) => ({ ...state, library: { beta: { enabled: false } } }));
    const claude = skillMountRoot('claude', 'claude-add-dir')!;
    const claudeSkills = path.join(claude, '.claude', 'skills');
    const workspace = skillMountRoot('kiro', 'kiro-workspace')!;
    const flat = skillMountRoot('codex', 'flat')!;
    // Claude names a library skill that clashes with a personal one after the folder.
    assert.equal(path.basename(claude), SKILL_LIBRARY_FOLDER_NAME);
    assert.deepEqual(fs.readdirSync(claudeSkills), ['alpha']);
    assert.deepEqual(fs.readdirSync(path.join(workspace, '.kiro', 'skills')), ['alpha']);
    assert.deepEqual(fs.readdirSync(flat), ['alpha']);
    assert.match(fs.readFileSync(path.join(claudeSkills, 'alpha', 'SKILL.md'), 'utf8'), /name: alpha/);

    const seen: string[] = [];
    const stop = onSkillLibraryChanged(() => seen.push(fs.readdirSync(claudeSkills).sort().join(',')));
    writeSkill('gamma');
    fs.rmSync(path.join(skillLibraryRoot(), 'alpha'), { recursive: true });
    // Anything Michi did not put in a mount goes at the next sync: runtimes load all of it in every session.
    fs.writeFileSync(path.join(claudeSkills, 'planted.txt'), 'x');
    fs.writeFileSync(path.join(claude, 'CLAUDE.md'), 'x');
    fs.mkdirSync(path.join(claude, '.claude', 'agents'));
    fs.mkdirSync(path.join(path.dirname(claude), 'other'));
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'x');
    fs.mkdirSync(path.join(workspace, '.kiro', 'steering'));
    fs.mkdirSync(path.join(flat, 'planted-skill'));
    notifySkillLibraryChanged();
    stop();
    assert.deepEqual(seen, ['gamma']);
    assert.deepEqual(fs.readdirSync(path.dirname(claude)), [SKILL_LIBRARY_FOLDER_NAME]);
    assert.deepEqual(fs.readdirSync(claude), ['.claude']);
    assert.deepEqual(fs.readdirSync(path.join(claude, '.claude')), ['skills']);
    assert.deepEqual(fs.readdirSync(workspace), ['.kiro']);
    assert.deepEqual(fs.readdirSync(path.join(workspace, '.kiro')), ['skills']);
    assert.ok(fs.existsSync(path.join(skillLibraryRoot(), 'gamma', 'SKILL.md')), 'pruning never reaches the library');
    assert.deepEqual(fs.readdirSync(flat), ['gamma']);
    assert.equal(skillMountRoot('claude', 'claude-add-dir'), claude, 'the path never changes');
  });

  test('a mount folder replaced by a link loses the link; what it pointed to is left alone', (t) => {
    writeSkill('alpha');
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-mount-victim-'));
    t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
    fs.writeFileSync(path.join(elsewhere, 'keep.txt'), 'keep');
    const flat = skillMountRoot('codex', 'flat')!;
    const claudeSkills = path.join(skillMountRoot('claude', 'claude-add-dir')!, '.claude', 'skills');
    for (const dir of [flat, claudeSkills]) {
      fs.rmSync(dir, { recursive: true });
      fs.symlinkSync(elsewhere, dir, 'dir');
    }
    notifySkillLibraryChanged();
    assert.deepEqual(fs.readdirSync(elsewhere), ['keep.txt']);
    assert.equal(fs.readFileSync(path.join(elsewhere, 'keep.txt'), 'utf8'), 'keep');
    for (const dir of [flat, claudeSkills]) {
      assert.equal(fs.lstatSync(dir).isSymbolicLink(), false);
      assert.deepEqual(fs.readdirSync(dir), ['alpha']);
    }
  });

  test('Codex and Kiro mounts leave out skills only a person may run; Claude\'s keeps them', () => {
    writeSkill('alpha');
    const dir = path.join(skillLibraryRoot(), 'user-only');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: user-only\ndescription: d\ndisable-model-invocation: true\n---\nBody\n');
    assert.deepEqual(fs.readdirSync(path.join(skillMountRoot('claude', 'claude-add-dir')!, '.claude', 'skills')).sort(), ['alpha', 'user-only']);
    assert.deepEqual(fs.readdirSync(path.join(skillMountRoot('kiro', 'kiro-workspace')!, '.kiro', 'skills')), ['alpha']);
    assert.deepEqual(fs.readdirSync(skillMountRoot('codex', 'flat')!), ['alpha']);
  });

  test('a mount leaves out the names its runtime keeps for its own, as they are at each sync', () => {
    writeSkill('alpha');
    writeSkill('beta');
    let own = ['beta'];
    const skills = path.join(skillMountRoot('claude', 'claude-add-dir', { leaveOut: () => own })!, '.claude', 'skills');
    assert.deepEqual(fs.readdirSync(skills), ['alpha']);
    own = [];
    notifySkillLibraryChanged();
    assert.deepEqual(fs.readdirSync(skills).sort(), ['alpha', 'beta']);
  });

  test('cloud mode keeps no library and no mounts', () => {
    writeSkill('alpha');
    process.env.MICHI_CLOUD = '1';
    assert.deepEqual(listLibrarySkills(), []);
    assert.equal(skillMountRoot('claude', 'claude-add-dir'), null);
    assert.deepEqual(librarySkillDirs(), []);
  });
});

describe('runtime skill listings', () => {
  afterEach(() => setSkillListingTimingForTests());

  /** A runtime whose listings answer when the test says. */
  function slowRuntime() {
    const calls: Array<{ refresh?: boolean; answer: (listing: RuntimeSkillListing) => void; fail: (error: Error) => void }> = [];
    const runtime = {
      id: 'claude' as const,
      listSkills: (opts: { refresh?: boolean }) => new Promise<RuntimeSkillListing>((answer, fail) => { calls.push({ refresh: opts.refresh, answer, fail }); }),
    };
    return { runtime, calls };
  }
  const listing = (...names: string[]): RuntimeSkillListing => ({ skills: names.map((name) => ({ name, description: '', scope: 'user' })) });
  const names = (result: { listing: RuntimeSkillListing | null }) => result.listing?.skills.map((skill) => skill.name) ?? null;
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  test('a stale listing is served at once and renewed in the background; a late answer still lands', async () => {
    setSkillListingTimingForTests({ timeoutMs: 20, staleMs: 0 });
    const { runtime, calls } = slowRuntime();
    const options = { cwd: '/tmp/swr' };
    const first = await listRuntimeSkills(runtime, options);
    assert.deepEqual([names(first), first.error?.includes('took longer than')], [null, true], 'the caller stops waiting');
    calls[0].answer(listing('one'));
    await flush();
    const second = await listRuntimeSkills(runtime, options);
    assert.deepEqual([names(second), second.error, calls.length], [['one'], null, 2], 'the late answer was kept; a renewal started');
    calls[1].answer(listing('two'));
    await flush();
    assert.deepEqual(names(await listRuntimeSkills(runtime, options)), ['two']);
  });

  test('a failed listing is reported but never replaces one that answered; refresh asks the runtime anew', async () => {
    setSkillListingTimingForTests({ timeoutMs: 1_000, staleMs: 60_000 });
    const { runtime, calls } = slowRuntime();
    const options = { cwd: '/tmp/failing' };
    const pending = listRuntimeSkills(runtime, options);
    await flush();
    calls[0].answer(listing('kept'));
    assert.deepEqual(names(await pending), ['kept']);
    assert.deepEqual(names(await listRuntimeSkills(runtime, options)), ['kept']);
    assert.equal(calls.length, 1, 'a fresh listing is not asked for again');
    const refreshed = listRuntimeSkills(runtime, { ...options, refresh: true });
    await flush();
    assert.equal(calls[1].refresh, true);
    calls[1].fail(new Error('app-server exited'));
    const result = await refreshed;
    assert.deepEqual([names(result), result.error], [['kept'], 'app-server exited']);
    assert.deepEqual(names(await listRuntimeSkills(runtime, options)), ['kept']);
  });
});

describe('skill invocation', () => {
  beforeEach(reset);
  afterEach(() => { setSkillListingTimingForTests(); reset(); });

  const runtime = (skills: Array<Record<string, unknown>> = []) => ({
    id: 'claude' as const,
    label: 'Claude',
    listSkills: async () => ({ skills: skills as never }),
  });

  test('parses the request and rejects malformed ones', () => {
    assert.deepEqual(parseSkillInvocationRequest({ id: librarySkillId('alpha'), name: 'alpha', args: '  go  ' }), { id: 'library:alpha', name: 'alpha', args: 'go' });
    for (const bad of [null, [], { id: 'nope', name: 'x' }, { id: 'library:alpha' }, { id: 'library:alpha', name: 'a', args: 3 }]) {
      assert.throws(() => parseSkillInvocationRequest(bad), isCode('invalid_skill'));
    }
  });

  test('resolves an enabled library skill with its body, on any runtime', async () => {
    writeSkill('alpha');
    const request = { id: librarySkillId('alpha'), name: 'alpha', args: 'x' };
    const resolved = await resolveSkillInvocation({ request, runtime: runtime(), cwd: '/tmp' });
    assert.equal(resolved.origin, 'library');
    assert.equal(resolved.path, path.join(skillLibraryRoot(), 'alpha', 'SKILL.md'));
    assert.match(resolved.body ?? '', /^Do alpha for \$ARGUMENTS\./);
    assert.deepEqual(skillMessageMetadata(resolved, 'claude'), { id: 'library:alpha', name: 'alpha', origin: 'library', args: 'x' });
    assert.equal((await resolveSkillInvocation({ request, runtime: { id: 'codex', label: 'Codex' }, cwd: null })).name, 'alpha');
    updateSkillsState((state) => ({ ...state, library: { alpha: { enabled: false } } }));
    await assert.rejects(resolveSkillInvocation({ request, runtime: runtime(), cwd: '/tmp' }),
      (error) => isCode('skill_not_found')(error) && /^Couldn’t run \/alpha: .*\.$/.test((error as Error).message));
  });

  test('resolves runtime skills from the runtime listing and live commands by name, never another runtime\'s', async (t) => {
    // Outside the library and its mounts, which the listing reports as library skills instead.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-runtime-skill-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const file = path.join(home, 'tool', 'SKILL.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, formatSkillFile({ name: 'tool', description: 'd', body: 'Body' }));
    const listed = runtime([
      { name: 'tool', description: 'd', nativeName: 'example:tool', scope: 'plugin', path: file },
      { name: 'moved', description: 'd', scope: 'user', path: path.join(home, 'moved', 'SKILL.md') },
    ]);
    const id = runtimeSkillId('claude', 'plugin', 'example:tool');
    const resolved = await resolveSkillInvocation({ request: { id, name: 'tool', args: '' }, runtime: listed, cwd: home });
    assert.deepEqual({ ...resolved, body: resolved.body?.trim() }, { id, name: 'tool', origin: 'runtime', nativeName: 'example:tool', path: file, body: 'Body', args: '' });
    assert.deepEqual(skillMessageMetadata(resolved, 'claude').runtimeId, 'claude');
    const live = await resolveSkillInvocation({ request: { id: liveSkillId('claude', 'p:x'), name: 'x', args: 'a' }, runtime: listed, cwd: home });
    assert.deepEqual(live, { id: 'live:claude:p:x', name: 'x', origin: 'runtime', nativeName: 'p:x', args: 'a' });
    for (const [request, why] of [
      [{ id: runtimeSkillId('kiro', 'user', 'tool'), name: 'tool', args: '' }, 'another runtime'],
      [{ id: runtimeSkillId('claude', 'user', 'gone'), name: 'gone', args: '' }, 'not listed'],
      [{ id: runtimeSkillId('claude', 'user', 'moved'), name: 'moved', args: '' }, 'listed, but its SKILL.md is gone'],
    ] as const) {
      await assert.rejects(resolveSkillInvocation({ request, runtime: listed, cwd: home }), isCode('skill_not_found'), why);
    }
  });

  test('a runtime that cannot list its skills is runtime_unavailable, not a missing skill', async () => {
    setSkillListingTimingForTests({ timeoutMs: 20 });
    const request = { id: runtimeSkillId('claude', 'user', 'tool'), name: 'tool', args: '' };
    const failing = { id: 'claude' as const, label: 'Claude', listSkills: async () => { throw new Error('not signed in'); } };
    await assert.rejects(resolveSkillInvocation({ request, runtime: failing, cwd: '/tmp/unlisted' }),
      (error) => isCode('runtime_unavailable')(error) && /Claude couldn’t list its skills \(not signed in\)/.test((error as Error).message));
    const hanging = { id: 'claude' as const, label: 'Claude', listSkills: () => new Promise<never>(() => {}) };
    await assert.rejects(resolveSkillInvocation({ request, runtime: hanging, cwd: '/tmp/hanging' }), isCode('runtime_unavailable'));
  });
});
