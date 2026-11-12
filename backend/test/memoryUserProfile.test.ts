// Michi's profile of the user (services/memory/userProfile.ts): which notes it
// rests on (never one from a turn the user had Michi forget), the prompt, the
// answer's rules (only listed citations, the profile's language, no sensitive
// categories, every number of two or more digits in the notes it cites; its
// size is trimmed here and never costs a repair), the commit with the versions
// a line cites, removal propagating at once, and when a rebuild is due
// (extractionRun.profileRebuildDue: one cadence rule, or the user's request).
import { afterEach, beforeEach, describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MemoryRecord } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { PROFILE_RUN_ID_PREFIX, profileRebuildDue } from '../src/services/memory/extractionRun';
import { setExtractionPaused } from '../src/services/memory/extractionRepository';
import { installMemoryExtractionHooks } from '../src/services/memory/extractionService';
import { memoryRef } from '../src/services/memory/memoryRefs';
import {
  createMemory, deleteMemory, forgetMemory, setMemorySettings, supersedeMemory, updateMemory, type CreateMemoryInput,
} from '../src/services/memory/memoryService';
import { storedMemories } from '../src/services/memory/memoryRepository';
import {
  buildProfilePrompt, commitProfilePayload, currentProfileLines, installUserProfileHooks, PROFILE_LIMITS, ProfilePayloadError, remapProfileCitations,
  memoryProfileView, profileLineMemoryIds, profileRebuildState, profileTokens, readUserProfile, recordProfileAttempt, requestProfileRebuild,
  sensitiveForProfile, validateProfilePayload, type ProfilePrompt,
} from '../src/services/memory/userProfile';

const ME = LOCAL_AGENT_OWNER_ID;
const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60_000;
/** Sunday 2026-11-08, noon local time. */
const NOW = new Date(2026, 10, 8, 12).getTime();
const saved = { data: process.env.MICHI_DATA_DIR, cloud: process.env.MICHI_CLOUD };
let dataDir: string;
let uninstall: (() => void) | null = null;
let serial = 0;

function note(body: string, extra: Partial<CreateMemoryInput> = {}, ownerUserId = ME): MemoryRecord {
  serial += 1;
  return createMemory({ ownerUserId }, {
    scope: { kind: 'user' }, kind: 'fact', body, status: 'active', origin: 'extracted', observedAt: NOW - 30 * DAY + serial * MINUTE, ...extra,
  });
}

function refOf(record: MemoryRecord): string {
  const row = getDb().prepare('SELECT row_id, version FROM memories WHERE id = ?').get(record.id) as { row_id: number; version: number };
  return memoryRef(row.row_id, row.version);
}

/** Notes the prompt listed, as refs. */
function listed(prompt: ProfilePrompt): string[] {
  return prompt.sources.map((source) => source.ref);
}

function answer(...sections: Array<[string, Array<[string, string[]]>]>) {
  return { sections: sections.map(([topic, lines]) => ({ topic, lines: lines.map(([text, refs]) => ({ text, refs })) })) };
}

function commit(prompt: ProfilePrompt, payload: unknown) {
  const validated = validateProfilePayload(payload, { sources: prompt.sources, language: prompt.language });
  return commitProfilePayload(validated, { ownerUserId: ME, sources: prompt.sources, sourceVersion: prompt.sourceVersion, language: prompt.language, now: NOW });
}

/** The lines a pack would show now. */
function shown(): string[] {
  const profile = readUserProfile(ME);
  return profile ? currentProfileLines(ME, profile).lines.map((line) => line.text) : [];
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-user-profile-'));
  process.env.MICHI_DATA_DIR = dataDir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  getDb().prepare(`INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws', 'Home', 1, 1)`).run();
  uninstall = installUserProfileHooks();
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  closeDb();
  if (saved.cloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = saved.cloud;
  if (saved.data === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = saved.data;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('the notes and the prompt', () => {
  test('only active user-scope memories Michi saved itself that may be recalled, without credentials or sensitive categories', () => {
    const kitchen = note('The user\'s kitchen has only an air fryer and a microwave.', { topic: 'Home' });
    const owl = note('The user is a night owl and usually goes to bed after 2 a.m.', { kind: 'preference' });
    const infj = note('The user is an INFJ and dislikes crowds.');
    note('Reply in Chinese.', { kind: 'preference', origin: 'explicit' });
    note('This repo deploys from the release branch.', { scope: { kind: 'workspace', workspaceId: 'ws' }, kind: 'convention' });
    const old = note('The user lives in Boston.');
    supersedeMemory({ ownerUserId: ME }, old.id, { body: 'The user lives in Seattle.', status: 'active', origin: 'extracted' });
    note('The user likes the café on Rue Cler.', { sourceRisk: 'untrusted', source: { nodeId: 'n-web', turnId: 't-web' } });
    note('The user\'s OpenAI key is sk-proj-7h3Qz9XbLmN2pR4tV6wY.');
    note('The user is allergic to peanuts.');
    note('The user goes to church every Sunday.');
    note('用户的手机号是 13812345678。');

    const prompt = buildProfilePrompt({ ownerUserId: ME, now: NOW })!;
    const seattle = getDb().prepare("SELECT id FROM memories WHERE body = 'The user lives in Seattle.'").get() as { id: string };
    assert.deepEqual(prompt.sources.map((source) => source.memoryId).sort(), [kitchen.id, owl.id, infj.id, seattle.id].sort());
    // Newest said first, with kind and dates; the language of most notes.
    assert.deepEqual(listed(prompt), [...prompt.sources].sort((a, b) => b.observedAt - a.observedAt).map((source) => source.ref));
    assert.match(prompt.prompt, new RegExp(`^- ${refOf(owl)} · preference · said \\d{4}-\\d{2}-\\d{2}: The user is a night owl`, 'mu'));
    assert.match(prompt.prompt, new RegExp(`^- ${refOf(kitchen)} · fact · topic "Home" · said `, 'mu'), 'a note\'s topic names its section');
    assert.match(prompt.prompt, /^Michi Memory profile · today 2026-11-08 \(Sunday\) · 4 notes$/mu);
    assert.equal(prompt.language, 'en');
    assert.match(prompt.prompt, /Write the profile in English/);
    assert.match(prompt.prompt, /Call memory_profile once with it, then stop\.$/u);
    for (const rule of [/Use only the listed notes/, /nothing they do not say/, /Never include health/, /keep the one said later/,
      /Group the lines under 2-8 short topics/, /a note's topic, when it has one, names its section/, new RegExp(`At most ${PROFILE_LIMITS.maxTokens} tokens`), /calling `memory_profile` exactly once/]) {
      assert.match(prompt.system, rule);
    }
    // A line keeps the notes' names and numbers, and the limit keeps what later requests need most (prompt diet round 1,
    // LongMemEval e3038f8c: "57 records, 12 figurines, 5 rare books, 25 rare coins" became "57 vinyl records and rare books").
    assert.match(prompt.system, /One fact per line, as a short phrase that keeps the names and numbers as the notes write them\./);
    assert.match(prompt.system, /: when there is more, keep what later requests are most likely to need\./);
    // A direct model call (evaluations) answers with the JSON object.
    const direct = buildProfilePrompt({ ownerUserId: ME, now: NOW, toolName: null })!;
    assert.match(direct.system, /Answer with the JSON object only/);
    assert.match(direct.prompt, /Reply with the JSON object only\.$/u);
  });

  test('too few notes make no prompt; Chinese notes make a Chinese profile; a dated note shows its event date', () => {
    note('用户在杭州的一家游戏公司做策划。');
    note('用户养了一只叫团子的橘猫。');
    assert.equal(buildProfilePrompt({ ownerUserId: ME, now: NOW }), null, `fewer than ${PROFILE_LIMITS.minSources} notes`);
    note('The user is training for a half marathon.');
    const trip = note('用户 2026-12-20 去札幌滑雪。', { eventAt: new Date(2026, 11, 20).getTime() });
    const prompt = buildProfilePrompt({ ownerUserId: ME, now: NOW })!;
    assert.equal(prompt.language, 'zh');
    assert.match(prompt.prompt, /Write the profile in Chinese/);
    assert.match(prompt.prompt, new RegExp(`^- ${refOf(trip)} · fact · said \\d{4}-\\d{2}-\\d{2} · event 2026-12-20: `, 'mu'));
  });

  test('sensitive categories are words, not guesses', () => {
    for (const text of ['allergic to shellfish', '有糖尿病', 'goes to mosque on Fridays', '是党员', 'is bisexual', 'lives at 42 Maple Street',
      '住在中山路 88 号', '住 3 号楼 1203 室', 'call me at +1 415-555-0134', 'the API key is sk-abcdefghijklmnopqrstu']) {
      assert.equal(sensitiveForProfile(text), true, text);
    }
    for (const text of ['works as a nurse at a hospital', 'is training for a race', 'likes party games', 'prefers vegetarian food', '在医院做护士 12 年',
      '租了一套 2室1厅', 'has run 3 marathons since 2019']) {
      assert.equal(sensitiveForProfile(text), false, text);
    }
  });
});

describe('the answer', () => {
  let prompt: ProfilePrompt;
  let kitchen: MemoryRecord;
  let owl: MemoryRecord;
  let infj: MemoryRecord;
  beforeEach(() => {
    kitchen = note('The user\'s kitchen has only an air fryer and a microwave.');
    owl = note('The user is a night owl and usually goes to bed after 2 a.m.', { kind: 'preference' });
    infj = note('The user is an INFJ and dislikes crowds; they have worked as a nurse for 12 years.');
    prompt = buildProfilePrompt({ ownerUserId: ME, now: NOW })!;
  });

  test('a good answer: refs become the listed ones, whitespace collapses, duplicates go', () => {
    const bare = refOf(kitchen).replace(/v\d+$/u, '');
    const payload = validateProfilePayload(answer(
      ['Home', [['Kitchen has only  an air fryer and a microwave', [bare]], ['Kitchen has only an air fryer and a microwave', [refOf(kitchen)]]]],
      ['Personality', [['INFJ; dislikes crowds', [`[${refOf(infj)}]`]]]],
    ), { sources: prompt.sources });
    assert.deepEqual(payload, { sections: [
      { topic: 'Home', lines: [{ text: 'Kitchen has only an air fryer and a microwave', refs: [refOf(kitchen)] }] },
      { topic: 'Personality', lines: [{ text: 'INFJ; dislikes crowds', refs: [refOf(infj)] }] },
    ] });
    // A client's own metadata is ignored, and no sections is an empty profile.
    assert.deepEqual(validateProfilePayload({ _meta: { progressToken: 1 } }, { sources: prompt.sources }), { sections: [] });
  });

  test('rule breaks are problems while a repair is left; the last repair leaves those lines out', () => {
    const bad = answer(['Work', [
      ['Nurse for 15 years', [refOf(infj)]],
      ['Works night shifts at Mercy Hospital', [refOf(infj)]],
      ['Owns an iPhone', [refOf(owl)]],
      ['Cites a note that was never listed', ['m:zzzzv1']],
      ['Night owl', [refOf(owl).replace(/v\d+$/u, 'v9')]],
      ['Allergic to peanuts', [refOf(kitchen)]],
      ['夜猫子，常凌晨两点后睡', [refOf(owl)]],
      ['Nurse for 12 years; INFJ', [refOf(infj)]],
    ]]);
    assert.throws(() => validateProfilePayload(bad, { sources: prompt.sources }), (error: unknown) => {
      assert.ok(error instanceof ProfilePayloadError);
      const problems = error.problems.join('\n');
      for (const expected of [/lines\[0\] says "15", which the notes it cites do not/, /lines\[3\] cites "m:zzzzv1", which is not one of the listed notes/,
        /lines\[4\] cites "m:\w+v9"/, /lines\[5\] says something the profile never holds/, /lines\[6\] is in Chinese, but the profile is in English/]) {
        assert.match(problems, expected);
      }
      // Names are the writer's to keep to its notes (its instructions); no word list judges them.
      assert.doesNotMatch(problems, /lines\[(1|2|7)\]/, 'lines whose numbers and citations hold pass');
      return true;
    });
    assert.deepEqual(validateProfilePayload(bad, { sources: prompt.sources, strict: false }).sections[0]!.lines.map((line) => line.text),
      ['Works night shifts at Mercy Hospital', 'Owns an iPhone', 'Nurse for 12 years; INFJ']);
    // Schema problems fail even the last repair.
    assert.throws(() => validateProfilePayload({ sections: [{ topic: 'Work', lines: [{ text: 'x' }] }] }, { sources: prompt.sources, strict: false }),
      /sections\[0\]\.lines\[0\] must have required property 'refs'/);
  });

  test('at most PROFILE_LIMITS.maxTokens: a longer answer is trimmed here, never sent back; with other problems the repair says it too', () => {
    const line = 'has only an air fryer and a microwave in the kitchen, so recipes must fit those two appliances';
    const lines = (topic: string) => Array.from({ length: 12 }, (_, i) => [`${topic} ${line} ${'again '.repeat(i)}`.trim(), [refOf(kitchen)]] as [string, string[]]);
    const long = answer(['Home', lines('Home')], ['Kitchen', lines('Kitchen')], ['Habits', [['Night owl', [refOf(owl)]]]]);
    const count = (payload: { sections: Array<{ topic: string; lines: Array<{ text: string }> }> }) => payload.sections.reduce((sum, section) => sum
      + profileTokens(section.topic) + section.lines.reduce((total, entry) => total + profileTokens(entry.text), 0), 0);
    for (const strict of [true, false]) {
      const trimmed = validateProfilePayload(long, { sources: prompt.sources, strict });
      assert.ok(count(trimmed) <= PROFILE_LIMITS.maxTokens * 1.15, `${count(trimmed)} tokens`);
      assert.deepEqual(trimmed.sections.map((section) => section.topic), ['Home', 'Kitchen', 'Habits'], 'the longest topics lose lines first; every topic stays');
      assert.ok(trimmed.sections.flatMap((section) => section.lines).length < 25, 'lines went');
    }
    // A repair for an invented number names the size too, so one repair fixes both.
    const invented = answer(['Home', [...lines('Home'), ['Nurse for 15 years', [refOf(infj)]]]], ['Kitchen', lines('Kitchen')]);
    assert.throws(() => validateProfilePayload(invented, { sources: prompt.sources }), (error: unknown) => {
      assert.ok(error instanceof ProfilePayloadError);
      assert.match(error.problems.join('\n'), /says "15"/);
      assert.match(error.problems.join('\n'), /the profile is about \d+ tokens: keep it within 450/);
      return true;
    });
  });

  test('a number of two or more digits must be in the notes a line cites, their dates or keywords; nothing else is matched', () => {
    const trip = note('用户 2027 年五月要和老公去葡萄牙玩两周。', { keywords: ['葡萄牙', 'Portugal', 'May 2027', '旅行'] });
    const run = note('The user runs three times a week and plans a half marathon in September.', { keywords: ['half marathon', '21 km'] });
    const zh = buildProfilePrompt({ ownerUserId: ME, now: NOW })!;
    const ref = (record: MemoryRecord) => zh.sources.find((source) => source.memoryId === record.id)!.ref;
    const ok = validateProfilePayload(answer(
      ['Plans', [['Going to Portugal with her husband in May 2027 for two weeks', [ref(trip)]], ['Half marathon (21 km) in 9月; runs 3 times a week', [ref(run)]]]],
    ), { sources: zh.sources, language: 'en' });
    assert.equal(ok.sections.flatMap((section) => section.lines).length, 2, 'single digits, months and names are not matched');
    for (const [text, record, invented] of [
      ['Going to Portugal in 2028', trip, /says "2028"/], ['Runs 15 km three times a week', run, /says "15"/],
    ] as Array<[string, MemoryRecord, RegExp]>) {
      assert.throws(() => validateProfilePayload(answer(['X', [[text, [ref(record)]]]]), { sources: zh.sources, language: 'en' }), invented, text);
    }
    // The day a note was said counts as what it says.
    const day = zh.sources.find((source) => source.memoryId === trip.id)!;
    const year = new Date(day.observedAt).getFullYear();
    assert.equal(validateProfilePayload(answer(['X', [[`Planning since ${year}`, [ref(trip)]]]]), { sources: zh.sources, language: 'en' }).sections.length, 1);
  });

  test('a Chinese profile is written in Chinese; names and numbers stay as the notes write them', () => {
    note('用户在杭州的一家游戏公司做策划。');
    note('用户养了一只叫团子的橘猫。');
    note('用户每周三晚上踢五人制足球。');
    note('用户用 MacBook Pro 14 写代码。');
    const zh = buildProfilePrompt({ ownerUserId: ME, now: NOW })!;
    assert.equal(zh.language, 'zh');
    const mac = zh.sources.find((source) => source.body.includes('MacBook'))!;
    const cat = zh.sources.find((source) => source.body.includes('团子'))!;
    assert.throws(() => validateProfilePayload(answer(['设备', [['Codes on a MacBook Pro 14', [mac.ref]]]]), { sources: zh.sources }),
      /is in English, but the profile is in Chinese/);
    assert.deepEqual(validateProfilePayload(answer(['设备', [['用 MacBook Pro 14 写代码', [mac.ref]]]], ['宠物', [['橘猫团子', [cat.ref]]]]),
      { sources: zh.sources }).sections.map((section) => section.lines.length), [1, 1]);
  });
});

describe('a forgotten memory', () => {
  test('leaves the profile at once: its lines go, and the next prompt no longer lists it', () => {
    const kept = [note('The user\'s kitchen has only an air fryer and a microwave.'), note('The user is a night owl.', { kind: 'preference' }),
      note('The user is an INFJ and dislikes crowds.')];
    const party = note('The user is planning a surprise party for her husband at The Copper Kettle.');
    const prompt = buildProfilePrompt({ ownerUserId: ME, now: NOW })!;
    assert.equal(prompt.sources.length, 4);
    commit(prompt, answer(['Home', [['Only an air fryer and a microwave', [refOf(kept[0])]]]], ['Plans', [['Surprise party at The Copper Kettle', [refOf(party)]]]]));
    assert.equal(shown().length, 2);
    forgetMemory({ ownerUserId: ME }, party.id);
    assert.deepEqual(shown(), ['Only an air fryer and a microwave']);
    assert.deepEqual(readUserProfile(ME)!.lines.map((line) => line.text), ['Only an air fryer and a microwave'], 'the stored line went too');
    assert.deepEqual(buildProfilePrompt({ ownerUserId: ME, now: NOW })!.sources.map((source) => source.memoryId).sort(), kept.map((record) => record.id).sort());
  });
});

describe('the commit and what packs show', () => {
  test('lines keep the versions they cite; every rebuild is a new version; a note changed since the prompt drops its lines; memory off saves nothing', () => {
    const kitchen = note('The user\'s kitchen has only an air fryer and a microwave.');
    const owl = note('The user is a night owl and usually goes to bed after 2 a.m.', { kind: 'preference' });
    const infj = note('The user is an INFJ and dislikes crowds.');
    const prompt = buildProfilePrompt({ ownerUserId: ME, now: NOW })!;
    const first = commit(prompt, answer(['Home', [['Only an air fryer and a microwave', [refOf(kitchen)]]]], ['Habits', [['Night owl', [refOf(owl)]]]]));
    assert.deepEqual([first.saved, first.version, first.lines, first.dropped], [true, 1, 2, []]);
    const stored = readUserProfile(ME)!;
    assert.deepEqual(stored.lines.map((line) => [line.topic, line.text, line.refs.map((ref) => memoryRef(ref.rowId, ref.version))]), [
      ['Home', 'Only an air fryer and a microwave', [refOf(kitchen)]],
      ['Habits', 'Night owl', [refOf(owl)]],
    ]);
    assert.equal(stored.sourceVersion, prompt.sourceVersion);
    assert.equal(stored.language, 'en');

    // The INFJ note is edited between the prompt and the commit: the line citing its old version is left out.
    const second = buildProfilePrompt({ ownerUserId: ME, now: NOW })!;
    updateMemory({ ownerUserId: ME }, infj.id, { body: 'The user is an INFJ and dislikes big crowds.' });
    const rebuilt = commit(second, answer(['Personality', [['INFJ', [second.sources.find((s) => s.memoryId === infj.id)!.ref]]]], ['Home', [['Air fryer and microwave only', [refOf(kitchen)]]]]));
    assert.deepEqual([rebuilt.version, rebuilt.lines, rebuilt.dropped], [2, 1, [{ section: 0, line: 0, reason: 'changed' }]]);
    assert.deepEqual(shown(), ['Air fryer and microwave only']);

    setMemorySettings(ME, { mode: 'off' });
    assert.deepEqual(commit(second, answer()), { saved: false, version: null, lines: 0, dropped: [], reason: 'memory_off' });
    assert.equal(readUserProfile(ME)!.version, 2);
  });

  test('forgetting or deleting a cited memory removes its lines from the stored profile at once; a correction hides its line until the next rebuild', () => {
    const kitchen = note('The user\'s kitchen has only an air fryer and a microwave.');
    const owl = note('The user is a night owl and usually goes to bed after 2 a.m.', { kind: 'preference' });
    const card = note('The user parks in the P-3391 bay at the office.');
    const city = note('The user lives in Boston.');
    const prompt = buildProfilePrompt({ ownerUserId: ME, now: NOW })!;
    commit(prompt, answer(
      ['Home', [['Only an air fryer and a microwave', [refOf(kitchen)]], ['Lives in Boston', [refOf(city)]]]],
      ['Work', [['Parks in bay P-3391', [refOf(card)]], ['Night owl who parks at the office', [refOf(owl), refOf(card)]]]],
    ));
    assert.equal(shown().length, 4);
    forgetMemory({ ownerUserId: ME }, card.id);
    const stored = JSON.stringify(readUserProfile(ME)!.lines);
    assert.doesNotMatch(stored, /P-3391|parks/u, 'no text of what was forgotten stays in the profile');
    assert.deepEqual(shown(), ['Only an air fryer and a microwave', 'Lives in Boston']);
    deleteMemory({ ownerUserId: ME }, kitchen.id);
    assert.deepEqual(shown(), ['Lives in Boston']);
    supersedeMemory({ ownerUserId: ME }, city.id, { body: 'The user lives in Seattle.', status: 'active', origin: 'extracted' });
    assert.deepEqual(shown(), [], 'the old value is not shown while the profile still says it');
    assert.equal(readUserProfile(ME)!.version, 1, 'removal takes lines out without a rebuild');
  });
});

describe('consolidation\'s duplicates', () => {
  test('a line citing a note put away as a duplicate cites its into at its current version, when the into may be cited', () => {
    const a = note('The user\'s kitchen has only an air fryer.');
    const b = note('用户厨房里只有一台空气炸锅');
    const c = note('The user is a night owl.', { kind: 'preference' });
    const project = note('This repo builds with an air fryer of a CI box.', { scope: { kind: 'workspace', workspaceId: 'ws' } });
    const prompt = buildProfilePrompt({ ownerUserId: ME, now: NOW })!;
    commit(prompt, answer(['Home', [['Kitchen: air fryer only', [refOf(a)]], ['Night owl', [refOf(c)]]]]));
    const [intoB] = storedMemories(ME, [b.id]);
    const [intoProject] = storedMemories(ME, [project.id]);
    assert.equal(remapProfileCitations(ME, [{ from: { id: c.id, version: 2 }, into: intoB! }]), 0, 'only the version put away moves');
    assert.equal(remapProfileCitations(ME, [{ from: { id: c.id, version: 1 }, into: intoProject! }]), 0, 'a workspace note is never cited');
    assert.equal(remapProfileCitations(ME, [{ from: { id: a.id, version: 1 }, into: intoB! }]), 1);
    const lines = readUserProfile(ME)!.lines;
    assert.deepEqual(lines.map((line) => line.refs.map((ref) => ref.id)), [[b.id], [c.id]]);
    assert.equal(lines[0]!.refs[0]!.version, intoB!.record.version);
  });
});

describe('when a rebuild is due', () => {
  test('one rule: PROFILE_LIMITS.changes changed notes since the last rebuild, or a day after it when anything changed; notes enough, the store idle', (t: TestContext) => {
    let clock = NOW;
    t.mock.method(Date, 'now', () => clock);
    // Removals count by their tombstones (extractionService's hook, installed on every backend).
    t.after(installMemoryExtractionHooks());
    note('The user\'s kitchen has only an air fryer and a microwave.');
    note('The user is a night owl.', { kind: 'preference' });
    assert.equal(profileRebuildDue(ME, clock), false, 'two notes are too few');
    note('The user is an INFJ.');
    assert.equal(profileRebuildDue(ME, clock), true, 'the first profile follows the first few notes');
    recordProfileAttempt(ME, clock);
    assert.equal(profileRebuildDue(ME, clock), false, 'nothing changed since');
    for (let i = 1; i < PROFILE_LIMITS.changes; i += 1) {
      clock += MINUTE;
      note(`The user owns houseplant number ${i}, a fern.`);
      assert.equal(profileRebuildDue(ME, clock), false, `${i} changed`);
    }
    clock += MINUTE;
    deleteMemory({ ownerUserId: ME }, note('The user owns a bonsai.').id);
    assert.equal(profileRebuildDue(ME, clock), true, `${PROFILE_LIMITS.changes} changes, a removal among them`);
    recordProfileAttempt(ME, clock);
    clock += MINUTE;
    note('The user plays five-a-side football on Wednesdays.');
    clock += PROFILE_LIMITS.intervalMs - 2 * MINUTE;
    assert.equal(profileRebuildDue(ME, clock), false, 'one change waits for the day to pass');
    clock += 2 * MINUTE;
    assert.equal(profileRebuildDue(ME, clock), true, 'a day after the last rebuild');

    // A user-saved note is pinned word for word and is no change of the profile's notes.
    recordProfileAttempt(ME, clock);
    clock += PROFILE_LIMITS.intervalMs + MINUTE;
    note('Remember: answer in English.', { origin: 'explicit', kind: 'preference' });
    assert.equal(profileRebuildDue(ME, clock), false);

    // Asked for in Settings › Memory: at once, whatever the cadence says; planning it serves the request.
    requestProfileRebuild(ME, clock);
    assert.equal(profileRebuildDue(ME, clock), true);
    recordProfileAttempt(ME, clock);
    assert.equal(profileRebuildState(ME).requestedAt, null);
    assert.equal(profileRebuildDue(ME, clock), false);

    // A paused automatic memory, memory off, or a cloud backend: never.
    requestProfileRebuild(ME, clock);
    setExtractionPaused(ME, true, clock);
    assert.equal(profileRebuildDue(ME, clock), false, 'automatic memory paused');
    setExtractionPaused(ME, false, clock);
    process.env.MICHI_CLOUD = '1';
    assert.equal(profileRebuildDue(ME, clock), false, 'local backends only');
    delete process.env.MICHI_CLOUD;
    assert.equal(profileRebuildDue(ME, clock), true);
    setMemorySettings(ME, { mode: 'off' });
    assert.equal(profileRebuildDue(ME, clock), false, 'memory off');
    assert.equal(PROFILE_RUN_ID_PREFIX, 'mpr-');
  });
});

describe('Settings › Memory', () => {
  test('the view lists the lines packs show, each with the memories it cites; a line\'s memories are what Remove deletes', () => {
    assert.deepEqual(memoryProfileView(ME), { lines: [], builtAt: null, version: 0, rebuildRequested: false });
    const kitchen = note('The user\'s kitchen has only an air fryer and a microwave.');
    const owl = note('The user is a night owl.', { kind: 'preference' });
    const infj = note('The user is an INFJ and dislikes crowds.');
    const prompt = buildProfilePrompt({ ownerUserId: ME, now: NOW })!;
    commit(prompt, answer(['Home', [['Only an air fryer and a microwave', [refOf(kitchen)]]]], ['Personality', [['Night owl; INFJ', [refOf(owl), refOf(infj)]]]]));
    const view = memoryProfileView(ME);
    assert.equal(view.version, 1);
    assert.equal(view.builtAt, NOW);
    assert.deepEqual(view.lines, [
      { topic: 'Home', text: 'Only an air fryer and a microwave', refs: [{ ref: refOf(kitchen), id: kitchen.id, body: kitchen.body }] },
      { topic: 'Personality', text: 'Night owl; INFJ', refs: [
        { ref: refOf(owl), id: owl.id, body: owl.body }, { ref: refOf(infj), id: infj.id, body: infj.body },
      ] },
    ]);
    assert.deepEqual(profileLineMemoryIds(ME, 1), [owl.id, infj.id]);
    assert.equal(profileLineMemoryIds(ME, 2), null);
    for (const id of profileLineMemoryIds(ME, 1)!) deleteMemory({ ownerUserId: ME }, id);
    assert.deepEqual(memoryProfileView(ME).lines.map((line) => line.text), ['Only an air fryer and a microwave']);
    requestProfileRebuild(ME, NOW);
    assert.equal(memoryProfileView(ME).rebuildRequested, true);
  });
});
