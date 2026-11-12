import fs from 'node:fs';
import path from 'node:path';
import { isMemoryKind, type MemoryKind } from 'michi-shared';

/**
 * Typed loader and validator for the memory extraction fixtures in
 * test/fixtures/memoryExtraction/. Each file is an array of cases:
 *   { id, description, turns: [{ role, text, untrusted? }],
 *     expected: { candidates: [{ kind, about, bodyIncludes, quote, eventDate? }],
 *                 rejected?: [{ kind, about, body, quote, reason }] } }
 * `untrusted` marks a turn whose content came from a web page, tool or file;
 * only tool and assistant turns may carry it. A candidate is what the
 * extractor should keep (extraction v2's payload memory): `about` user or
 * project, `quote` words of one of the case's user turns, `eventDate` the
 * day it resolves a relative date to (the cases are sent on Tuesday
 * 2026-11-03). `rejected` is an attempt the host must drop whatever the
 * model says: a quote that is not the user's own words ('quote_not_found')
 * or a credential ('secret'). What the user asked not to remember is the
 * extractor's to leave out, not the host's; so is telling a correction from
 * an ordinary message (correction.json's cases correct something said
 * before).
 */

export type ExtractionFixtureRole = 'user' | 'assistant' | 'tool';
export type ExtractionFixtureAbout = 'user' | 'project';
export type ExtractionFixtureRejection = 'quote_not_found' | 'secret';

export interface ExtractionFixtureTurn {
  role: ExtractionFixtureRole;
  text: string;
  untrusted?: boolean;
}

export interface ExtractionFixtureCandidate {
  kind: MemoryKind;
  about: ExtractionFixtureAbout;
  bodyIncludes: string[];
  quote: string;
  eventDate?: string;
}

export interface ExtractionFixtureRejected {
  kind: MemoryKind;
  about: ExtractionFixtureAbout;
  body: string;
  quote: string;
  reason: ExtractionFixtureRejection;
}

export interface ExtractionFixtureCase {
  id: string;
  description: string;
  turns: ExtractionFixtureTurn[];
  expected: {
    candidates: ExtractionFixtureCandidate[];
    rejected?: ExtractionFixtureRejected[];
  };
}

export type ExtractionFixtureSet = 'positive' | 'negative' | 'correction';

const ROLES: readonly string[] = ['user', 'assistant', 'tool'];
const ABOUT: readonly string[] = ['user', 'project'];
const REJECTIONS: readonly string[] = ['quote_not_found', 'secret'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CASE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'memoryExtraction');

function fail(where: string, message: string): never {
  throw new Error(`${where}: ${message}`);
}

function record(value: unknown, where: string, keys: { required: string[]; optional?: string[] }): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(where, 'must be an object');
  const allowed = new Set([...keys.required, ...(keys.optional ?? [])]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(where, `unexpected key "${key}"`);
  for (const key of keys.required) if (!(key in value)) fail(where, `missing "${key}"`);
  return value as Record<string, unknown>;
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(where, 'must be a non-empty string');
  return value;
}

function array(value: unknown, where: string, { nonEmpty }: { nonEmpty: boolean }): unknown[] {
  if (!Array.isArray(value)) fail(where, 'must be an array');
  if (nonEmpty && value.length === 0) fail(where, 'must not be empty');
  return value;
}

function turn(value: unknown, where: string): ExtractionFixtureTurn {
  const raw = record(value, where, { required: ['role', 'text'], optional: ['untrusted'] });
  if (typeof raw.role !== 'string' || !ROLES.includes(raw.role)) fail(`${where}.role`, `must be one of ${ROLES.join(', ')}`);
  const role = raw.role as ExtractionFixtureRole;
  const result: ExtractionFixtureTurn = { role, text: text(raw.text, `${where}.text`) };
  if ('untrusted' in raw) {
    if (typeof raw.untrusted !== 'boolean') fail(`${where}.untrusted`, 'must be a boolean');
    if (role === 'user') fail(`${where}.untrusted`, 'user turns are the user\'s own words and cannot be untrusted');
    result.untrusted = raw.untrusted;
  }
  return result;
}

function about(value: unknown, where: string): ExtractionFixtureAbout {
  if (typeof value !== 'string' || !ABOUT.includes(value)) fail(where, `must be one of ${ABOUT.join(', ')}`);
  return value as ExtractionFixtureAbout;
}

function candidate(value: unknown, where: string, userTexts: readonly string[]): ExtractionFixtureCandidate {
  const raw = record(value, where, { required: ['kind', 'about', 'bodyIncludes', 'quote'], optional: ['eventDate'] });
  if (!isMemoryKind(raw.kind)) fail(`${where}.kind`, 'must be a MemoryKind');
  const bodyIncludes = array(raw.bodyIncludes, `${where}.bodyIncludes`, { nonEmpty: true })
    .map((item, index) => text(item, `${where}.bodyIncludes[${index}]`));
  const quote = text(raw.quote, `${where}.quote`);
  if (!userTexts.some((userText) => userText.includes(quote))) fail(`${where}.quote`, 'must be words of one of the case\'s user turns');
  const result: ExtractionFixtureCandidate = { kind: raw.kind, about: about(raw.about, `${where}.about`), bodyIncludes, quote };
  if ('eventDate' in raw) {
    if (typeof raw.eventDate !== 'string' || !DAY.test(raw.eventDate)) fail(`${where}.eventDate`, 'must be YYYY-MM-DD');
    result.eventDate = raw.eventDate;
  }
  return result;
}

function rejectedAttempt(value: unknown, where: string, userTexts: readonly string[]): ExtractionFixtureRejected {
  const raw = record(value, where, { required: ['kind', 'about', 'body', 'quote', 'reason'] });
  if (!isMemoryKind(raw.kind)) fail(`${where}.kind`, 'must be a MemoryKind');
  if (typeof raw.reason !== 'string' || !REJECTIONS.includes(raw.reason)) fail(`${where}.reason`, `must be one of ${REJECTIONS.join(', ')}`);
  const quote = text(raw.quote, `${where}.quote`);
  if (raw.reason === 'quote_not_found' && userTexts.some((userText) => userText.includes(quote))) {
    fail(`${where}.quote`, 'is words of a user turn; a quote_not_found attempt quotes something else');
  }
  return { kind: raw.kind, about: about(raw.about, `${where}.about`), body: text(raw.body, `${where}.body`), quote,
    reason: raw.reason as ExtractionFixtureRejection };
}

function fixtureCase(value: unknown, where: string): ExtractionFixtureCase {
  const raw = record(value, where, { required: ['id', 'description', 'turns', 'expected'] });
  const id = text(raw.id, `${where}.id`);
  if (!CASE_ID.test(id)) fail(`${where}.id`, 'must be lower-case kebab-case');
  const turns = array(raw.turns, `${where}.turns`, { nonEmpty: true }).map((item, index) => turn(item, `${where}.turns[${index}]`));
  if (!turns.some((item) => item.role === 'user')) fail(`${where}.turns`, 'needs at least one user turn');
  const expected = record(raw.expected, `${where}.expected`, { required: ['candidates'], optional: ['rejected'] });
  const userTexts = turns.filter((item) => item.role === 'user').map((item) => item.text);
  const candidates = array(expected.candidates, `${where}.expected.candidates`, { nonEmpty: false })
    .map((item, index) => candidate(item, `${where}.expected.candidates[${index}]`, userTexts));
  const result: ExtractionFixtureCase = { id, description: text(raw.description, `${where}.description`), turns, expected: { candidates } };
  if ('rejected' in expected) {
    result.expected.rejected = array(expected.rejected, `${where}.expected.rejected`, { nonEmpty: true })
      .map((item, index) => rejectedAttempt(item, `${where}.expected.rejected[${index}]`, userTexts));
  }
  return result;
}

/** Validates one parsed fixture file; throws with the path of the first problem. */
export function validateExtractionFixtures(value: unknown, source: string): ExtractionFixtureCase[] {
  const cases = array(value, source, { nonEmpty: true }).map((item, index) => fixtureCase(item, `${source}[${index}]`));
  const seen = new Set<string>();
  for (const item of cases) {
    if (seen.has(item.id)) fail(source, `duplicate id "${item.id}"`);
    seen.add(item.id);
  }
  return cases;
}

export function loadExtractionFixtures(set: ExtractionFixtureSet): ExtractionFixtureCase[] {
  const file = path.join(FIXTURE_DIR, `${set}.json`);
  return validateExtractionFixtures(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown, `${set}.json`);
}
