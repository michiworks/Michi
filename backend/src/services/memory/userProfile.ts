import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import type { MemoryKind, MemoryProfileResponse } from 'michi-shared';
import { getDb, prepareCached } from '../db';
import { MEMORY_PROFILE_TOOL_NAME } from './extractionProfile';
import { turnLanguage } from './extractionV2';
import { memoryTransaction, profileMemoryRows, readScopeVersion, storedMemories, type StoredMemory } from './memoryRepository';
import { memoryDay, memoryRef, parseRef } from './memoryRefs';
import { getMemorySettings, onMemoryRemoved } from './memoryService';
import { normalizeText } from './memoryTerms';
import { containsCredential } from './secrets';
import { vouchedForRecall } from './typedText';

/**
 * Michi's profile of the user: a short summary of what Michi knows about
 * them (their facts, preferences, constraints and standing situation: "the
 * kitchen has only an air fryer and a microwave", "night owl", "INFJ, dislikes
 * crowds"), in their dominant language, grouped by topic, every line citing
 * the memories it rests on. Every memory pack pins it as "About the user"
 * (contextBuilder.ts), so an answer, a recommendation or a plan fits the user
 * without a question having to share a word with what they said.
 *
 * It is built from the user's active user-scope memories that Michi saved
 * itself (memoryRepository.profileMemoryRows; the user's own saved memories
 * are pinned word for word anyway), never from a memory that may not be
 * recalled (typedText.vouchedForRecall), holds a credential or a sensitive
 * category (health, religion, ethnicity, politics, sexuality, a precise
 * address or phone number). A background automatic memory run rebuilds it
 * (extractionRun.profileRebuildDue: after PROFILE_LIMITS.changes changed
 * notes, or a day after anything changed, when the store is idle, or at once
 * when the user asks), with one direct structured call or one memory_profile
 * call; until then a pack still shows what is new among the preferences and
 * conventions, Recent conversations and related notes. The seam is shared by
 * production and evaluations, as extraction's is:
 *
 *  - buildProfilePrompt: the instructions and the notes, with refs.
 *  - PROFILE_PAYLOAD_SCHEMA / validateProfilePayload: the answer (a direct
 *    call's JSON, or the memory_profile call's arguments): every line cites
 *    listed notes only, is in the profile's language, says nothing of the
 *    sensitive categories, and every number of two or more digits it writes
 *    is in the notes it cites; an answer over PROFILE_LIMITS.maxTokens is
 *    trimmed here, never sent back for it.
 *  - commitProfilePayload: stores it, each line with the versions of the
 *    memories it cites.
 *
 * A pack shows a line only while every memory it cites is still active at
 * that version (currentProfileLines), so a correction, an edit or a deletion
 * takes a line out at once; removing a memory also removes the lines citing
 * it from the stored profile (installUserProfileHooks), and the next rebuild
 * writes the profile again without it.
 */

export const PROFILE_LIMITS = Object.freeze({
  /** Tokens the profile's lines hold at most (CJK characters one each, other text four characters per token). */
  maxTokens: 450,
  /** Notes a profile needs: with fewer there is nothing to sum up, and no rebuild runs. */
  minSources: 3,
  /** Notes one prompt lists at most, and their tokens. */
  maxSources: 400,
  sourceTokens: 12_000,
  /** A rebuild follows this many changed notes since the last one started ... */
  changes: 5,
  /** ... or this long (ms) after it, when anything changed. */
  intervalMs: 24 * 60 * 60_000,
});

/** Memories read when the notes are picked (newest said first), before the filters and limits. */
const SOURCE_ROWS = 1_500;

export type ProfileLanguage = 'zh' | 'en';

/** A note the profile prompt lists. */
export interface ProfileSource {
  /** m:<row>v<version>: the version listed; a line citing it rests on that version. */
  ref: string;
  memoryId: string;
  rowId: number;
  version: number;
  kind: MemoryKind;
  body: string;
  /** When the user said it (ms). */
  observedAt: number;
  /** When the event it describes happens or happened (ms), or null. */
  eventAt: number | null;
  /** The memory's keywords (Chinese and English): a line may name what they name ("Leeds" for a note that says 利兹). Not listed in the prompt. */
  keywords?: string[];
  /** What the note is about (MemoryRecord.topic): its section's name, when it has one. */
  topic?: string | null;
}

/** A memory version a stored line rests on. */
export interface ProfileCitation {
  id: string;
  rowId: number;
  version: number;
}

/** One line of the profile, as stored and shown. */
export interface ProfileLine {
  topic: string;
  text: string;
  refs: ProfileCitation[];
}

export interface UserProfile {
  /** Goes up with every rebuild. */
  version: number;
  language: ProfileLanguage | null;
  lines: ProfileLine[];
  /** The user scope's memory version the lines were built from. */
  sourceVersion: number | null;
  builtAt: number | null;
}

// ── text ─────────────────────────────────────────────────────────────────────

const CJK = /[⺀-鿿가-힯豈-﫿＀-￯]/u;
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Rough token count, as the memory pack counts it: a CJK character is one token, other text four characters per token. */
export function profileTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK.test(char)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

function collapse(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * Sensitive categories that stay out of the profile even when a note says
 * them (the extraction policy keeps them out of automatic memories unless the
 * user asked): health (conditions, allergies, treatment, pregnancy), religion,
 * ethnicity, politics, sex life or orientation, a precise address or phone
 * number. Credentials are secrets.containsCredential's. Words, not inference:
 * a note this misses is still covered by the instructions' rule.
 */
const SENSITIVE: readonly RegExp[] = [
  /\b(?:allerg(?:y|ies|ic)|asthma|diabet(?:es|ic)|hypertension|blood\s+pressure|cancer|tumou?rs?|chemo\w*|depress(?:ion|ed|ive)|anxiety\s+(?:disorder|attacks?)|panic\s+attacks?|bipolar|adhd|autis\w*|ocd|ptsd|insomnia|migraines?|epilep\w*|arthritis|c[o]?eliac|lactose[\s-]intoleran\w*|crohn'?s|hiv|pregnan\w*|miscarriage|ivf|surger(?:y|ies)|diagnos\w*|medications?|antidepressants?|therap(?:y|ist)|psychiatr\w*|disabilit(?:y|ies)|disabled|wheelchair)\b/iu,
  /过敏|哮喘|糖尿病|高血压|血压|癌症|癌|肿瘤|化疗|抑郁|焦虑症|惊恐发作|双相|多动症|自闭症|强迫症|失眠|偏头痛|癫痫|关节炎|乳糖不耐|艾滋|怀孕|孕期|流产|试管婴儿|手术|确诊|慢性病|吃药|服药|药物|心理咨询|心理治疗|精神科|残疾|轮椅|生病|住院/u,
  /\b(?:religio\w*|christian\w*|catholic\w*|protestant|muslim|islam\w*|buddhis\w*|hindu\w*|jewish|judaism|atheis\w*|church|mosque|synagogue|pray(?:s|ed|ing|ers?)?|bible|quran|koran)\b/iu,
  /宗教|信仰|基督|天主教|新教|穆斯林|伊斯兰|佛教|信佛|印度教|犹太|无神论|教堂|清真寺|做礼拜|祷告|祈祷|圣经|古兰经/u,
  /\b(?:ethnic\w*|racial|democrats?|democratic\s+party|republicans?|labou?r\s+party|conservative\s+party|liberal\s+party|communis[mt]\w*|socialis[mt]\w*|political\s+(?:views?|party|parties|affiliation|leanings?)|vot(?:e|es|ed|ing)\s+for)\b/iu,
  /民族|种族|汉族|回族|藏族|维吾尔|政治|政党|党员|共产党|民主党|共和党|国民党|投票给|左派|右派/u,
  /\b(?:gay|lesbian|bisexual|transgender|queer|lgbt\w*|sexual\s+orientation|sex\s+life|asexual|non-?binary)\b/iu,
  /同性恋|双性恋|跨性别|性取向|性生活|出柜/u,
  /\b\d{1,5}\s+(?:[A-Z][\w'’-]*\s+){1,3}(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Boulevard|Blvd|Drive|Dr|Court|Ct|Way|Place|Pl)\b/u,
  /(?:路|街|道|巷|弄)\s*\d+\s*号|\d+\s*(?:号楼|栋|幢|单元)|\d{3,4}\s*室/u,
  /(?<!\d)1[3-9]\d{9}(?!\d)|(?<![\d-])\+\d{1,3}[\s-]?\(?\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}(?![\d-])|(?<![\d-])\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\d-])/u,
];

/** Whether a text says something of a sensitive category (SENSITIVE) or holds a secret. */
export function sensitiveForProfile(text: string): boolean {
  const folded = (text ?? '').normalize('NFKC');
  return containsCredential(folded) || SENSITIVE.some((pattern) => pattern.test(folded));
}

// ── the notes ────────────────────────────────────────────────────────────────

function vouched(stored: StoredMemory): boolean {
  const { record } = stored;
  return vouchedForRecall({ body: record.body, sourceRisk: record.sourceRisk, nodeId: record.source?.nodeId ?? null, turnId: record.source?.turnId ?? null });
}

function sourceOf(stored: StoredMemory): ProfileSource {
  const { record } = stored;
  return {
    ref: memoryRef(stored.rowId, record.version), memoryId: record.id, rowId: stored.rowId, version: record.version, kind: record.kind,
    body: collapse(record.body), observedAt: record.observedAt ?? record.createdAt, eventAt: record.eventAt ?? null,
    keywords: (record.keywords ?? []).filter((keyword) => typeof keyword === 'string' && keyword.trim()),
    topic: record.topic ?? null,
  };
}

/**
 * The notes a profile may rest on (see the module comment): standing notes
 * (no event date) first, then dated ones, newest said first in each, within
 * PROFILE_LIMITS.maxSources and sourceTokens; listed newest said first.
 */
export function profileSources(ownerUserId: string): ProfileSource[] {
  const eligible = profileMemoryRows(ownerUserId, SOURCE_ROWS).filter((stored) => vouched(stored) && !sensitiveForProfile(stored.record.body));
  const ordered = [...eligible.filter((stored) => stored.record.eventAt == null), ...eligible.filter((stored) => stored.record.eventAt != null)];
  const picked: ProfileSource[] = [];
  let tokens = 0;
  for (const stored of ordered) {
    if (picked.length >= PROFILE_LIMITS.maxSources) break;
    const source = sourceOf(stored);
    const cost = profileTokens(source.body) + 12;
    if (tokens + cost > PROFILE_LIMITS.sourceTokens) continue;
    tokens += cost;
    picked.push(source);
  }
  return picked.sort((a, b) => b.observedAt - a.observedAt || b.rowId - a.rowId);
}

/**
 * The notes a run's prompt listed (refs and memory ids, as the run recorded
 * them), as they read now: a memory changed since then is listed at its old
 * version with its current text, so a line citing it fails at commit.
 */
export function listedProfileSources(ownerUserId: string, listed: ReadonlyArray<{ ref: string; memoryId: string }>): ProfileSource[] {
  const stored = new Map(storedMemories(ownerUserId, listed.map((entry) => entry.memoryId)).map((entry) => [entry.record.id, entry]));
  return listed.flatMap((entry) => {
    const parsed = parseRef(entry.ref);
    const found = stored.get(entry.memoryId);
    if (!found || parsed?.kind !== 'memory' || parsed.version === null) return [];
    return [{ ...sourceOf(found), ref: entry.ref, version: parsed.version }];
  });
}

/** The language most notes are written in (a tie goes to the newest note's). */
export function profileLanguage(sources: readonly Pick<ProfileSource, 'body'>[]): ProfileLanguage {
  let zh = 0;
  let en = 0;
  let first: ProfileLanguage | null = null;
  for (const source of sources) {
    const lang = turnLanguage(source.body);
    if (lang === 'zh') zh += 1;
    else if (lang === 'en') en += 1;
    first ??= lang;
  }
  if (zh !== en) return zh > en ? 'zh' : 'en';
  return first ?? 'en';
}

// ── the prompt ───────────────────────────────────────────────────────────────

const ANSWER_SHAPE = '{ "sections": [{ "topic": "…", "lines": [{ "text": "…", "refs": ["m:…"] }] }] }';

/** The profile writer's system instructions; toolName null: answered with the JSON object (a direct model call). */
export function buildProfileInstructions(options: { toolName?: string | null } = {}): string {
  const tool = options.toolName === undefined ? MEMORY_PROFILE_TOOL_NAME : options.toolName;
  return [
    'You write Michi\'s short profile of the user from the notes Michi keeps about them. Michi shows it at the start of every conversation as "About the user", so that answers fit the user.',
    '',
    '- Use only the listed notes: each line says what the notes it cites (by ref, m:…) say, and nothing they do not say.',
    '- Keep what lasts and keeps shaping what the user asks for; leave out one-off events and plans whose date has passed, unless they changed the user\'s situation.',
    '- Never include health, religion, ethnicity, politics, sex life or orientation, a precise address or phone number, government ids, account numbers or passwords, even when a note says them.',
    '- When notes disagree, keep the one said later; notes that say the same thing become one line citing all of them.',
    '- Group the lines under 2-8 short topics; a note\'s topic, when it has one, names its section. One fact per line, as a short phrase that keeps the names and numbers as the notes write them.',
    `- At most ${PROFILE_LIMITS.maxTokens} tokens in all (about ${PROFILE_LIMITS.maxTokens * 3} English characters, or ${PROFILE_LIMITS.maxTokens} Chinese characters): when there is more, keep what later requests are most likely to need.`,
    '- Write in the language the prompt names.',
    '',
    tool
      ? `Answer by calling \`${tool}\` exactly once with ${ANSWER_SHAPE}, then stop. With nothing worth keeping, call it with "sections": [].`
      : `Answer with the JSON object only: ${ANSWER_SHAPE} ("sections": [] when nothing is worth keeping).`,
  ].join('\n');
}

/** The system instructions of an automatic memory session that rebuilds the profile (chatManager), answered with memory_profile. */
export function memoryProfileBootstrapInstructions(): string {
  return buildProfileInstructions({ toolName: MEMORY_PROFILE_TOOL_NAME });
}

export interface ProfilePromptInput {
  /** The memory owner, already resolved (requestAgentOwnerOrNull: the local user on the desktop). */
  ownerUserId: string;
  /** Default Date.now(): today's date in the prompt. */
  now?: number;
  /** The writer's tool; default memory_profile. null: a direct model call answered with the JSON object. */
  toolName?: string | null;
  /** The notes to list; absent: profileSources. */
  sources?: readonly ProfileSource[];
}

export interface ProfilePrompt {
  system: string;
  prompt: string;
  /** The notes it lists: what validateProfilePayload and commitProfilePayload check the answer against. */
  sources: ProfileSource[];
  language: ProfileLanguage;
  /** The user scope's memory version when it was built (commitProfilePayload's ctx.sourceVersion). */
  sourceVersion: number;
}

function sourceLine(source: ProfileSource): string {
  const marks = [source.kind, ...(source.topic ? [`topic ${JSON.stringify(source.topic)}`] : []), `said ${memoryDay(source.observedAt)}`,
    ...(source.eventAt !== null ? [`event ${memoryDay(source.eventAt)}`] : [])];
  return `- ${source.ref} · ${marks.join(' · ')}: ${collapse(source.body)}`;
}

/**
 * The writer's instructions and the prompt listing the owner's notes, or null
 * when there are fewer than PROFILE_LIMITS.minSources (nothing to sum up).
 * Database reads only.
 */
export function buildProfilePrompt(input: ProfilePromptInput): ProfilePrompt | null {
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const sourceVersion = readScopeVersion(input.ownerUserId, null);
  const sources = [...(input.sources ?? profileSources(input.ownerUserId))];
  if (sources.length < PROFILE_LIMITS.minSources) return null;
  const toolName = input.toolName === undefined ? MEMORY_PROFILE_TOOL_NAME : input.toolName;
  const language = profileLanguage(sources);
  const lines = [
    `Michi Memory profile · today ${memoryDay(now)} (${WEEKDAYS[new Date(now).getDay()] ?? 'unknown day'}) · ${sources.length} notes`,
    '',
    'Notes about the user, newest first (ref · kind · when the user said it · when the event is, if it is dated: the note):',
    ...sources.map(sourceLine),
    '',
    `Write the profile in ${language === 'zh' ? 'Chinese' : 'English'}.`,
    toolName ? `Call ${toolName} once with it, then stop.` : 'Reply with the JSON object only.',
  ];
  return { system: buildProfileInstructions({ toolName }), prompt: lines.join('\n'), sources, language, sourceVersion };
}

// ── the answer ───────────────────────────────────────────────────────────────

const TOPIC_MAX = 40;
const LINE_MAX = 240;
const REF_MAX = 40;
const SECTIONS_MAX = 12;
const LINES_MAX = 16;
const REFS_MAX = 8;
/** An answer a little over the limit (the writer counts tokens roughly) is not sent back for it. */
const TOKEN_SLACK = 1.15;

function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

/** The answer, strict: every object closed, every field typed and bounded (a memory_profile call or a direct call's JSON). */
export const PROFILE_PAYLOAD_SCHEMA: Readonly<Record<string, unknown>> = frozen({
  type: 'object',
  additionalProperties: false,
  required: ['sections'],
  properties: {
    sections: {
      type: 'array',
      maxItems: SECTIONS_MAX,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['topic', 'lines'],
        properties: {
          topic: { type: 'string', minLength: 1, maxLength: TOPIC_MAX },
          lines: {
            type: 'array',
            maxItems: LINES_MAX,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['text', 'refs'],
              properties: {
                text: { type: 'string', minLength: 1, maxLength: LINE_MAX },
                refs: { type: 'array', minItems: 1, maxItems: REFS_MAX, items: { type: 'string', minLength: 1, maxLength: REF_MAX } },
              },
            },
          },
        },
      },
    },
  },
});

/** A validated answer: lines trimmed, refs the listed notes' own (m:<row>v<version>), duplicates and empty topics gone. */
export interface ProfilePayload {
  sections: Array<{ topic: string; lines: Array<{ text: string; refs: string[] }> }>;
}

/** An answer that breaks PROFILE_PAYLOAD_SCHEMA or a rule; problems name each field (sections[0].lines[1] …). */
export class ProfilePayloadError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('; '));
    this.name = 'ProfilePayloadError';
  }
}

let payloadCheck: ((value: unknown) => { valid: boolean; errorMessage?: string }) | null = null;

/** Ajv's "data/sections/0/topic must …" as "sections[0].topic must …". */
function schemaProblems(errorMessage: string | undefined): string[] {
  return (errorMessage || 'the arguments do not match the schema').split(/,\s+(?=data\b)/u).map((part) =>
    part.replace(/^data((?:\/[^\s/]+)*)/u, (_match, path: string) => {
      const segments = path.split('/').filter(Boolean).map((segment) => (/^\d+$/u.test(segment) ? `[${segment}]` : `.${segment}`));
      return segments.length ? segments.join('').replace(/^\./u, '') : 'the arguments';
    }));
}

/** sections left out (or null) is none; an MCP client's own metadata (_meta) is no part of the answer. */
function withDefaults(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { _meta: _ignored, ...answer } = value as Record<string, unknown>;
  return { ...answer, sections: answer.sections ?? [] };
}

/** A number of two or more digits: what a line may not say unless the notes it cites say it too. */
const MULTI_DIGIT = /\p{Nd}{2,}/gu;

/** The numbers of two or more digits a line writes that the notes it cites (with their dates and keywords) do not. */
function numbersMissing(text: string, cited: string): string[] {
  const haystack = cited.normalize('NFKC');
  return [...new Set([...text.normalize('NFKC').matchAll(MULTI_DIGIT)].map((match) => match[0]))]
    .filter((number) => !haystack.includes(number));
}

export interface ValidateProfileOptions {
  /** The notes the prompt listed (ProfilePrompt.sources, or listedProfileSources for a run). */
  sources: readonly ProfileSource[];
  /** The language every line must be in; absent: the notes' (profileLanguage). */
  language?: ProfileLanguage | null;
  /**
   * true (default) while a repair is left: an answer breaking a rule fails
   * with the problems. false: lines that break a rule are left out and an
   * answer over the limit loses its last lines, so a slip never costs the
   * whole profile.
   */
  strict?: boolean;
}

/**
 * Checks an answer against PROFILE_PAYLOAD_SCHEMA and the rules: every ref is
 * a listed note's (a ref without a version names the listed one), every line
 * in the profile's language, nothing sensitive or secret, and every number of
 * two or more digits a line writes is in the notes it cites; the profile is
 * trimmed to PROFILE_LIMITS.maxTokens. Throws ProfilePayloadError listing the
 * problems (schema problems always; rule problems in strict mode).
 */
export function validateProfilePayload(value: unknown, options: ValidateProfileOptions): ProfilePayload {
  payloadCheck ??= new AjvJsonSchemaValidator().getValidator(PROFILE_PAYLOAD_SCHEMA as Record<string, unknown>);
  const answer = withDefaults(value);
  const checked = payloadCheck(answer);
  if (!checked.valid) throw new ProfilePayloadError(schemaProblems(checked.errorMessage));
  const raw = answer as { sections: Array<{ topic: string; lines: Array<{ text: string; refs: string[] }> }> };
  const strict = options.strict !== false;
  const language = options.language ?? profileLanguage(options.sources);
  const byRow = new Map(options.sources.map((source) => [source.rowId, source]));
  const problems: string[] = [];
  const seen = new Set<string>();
  const sections: ProfilePayload['sections'] = [];
  raw.sections.forEach((section, i) => {
    const topic = collapse(section.topic);
    const lines: ProfilePayload['sections'][number]['lines'] = [];
    section.lines.forEach((line, j) => {
      const where = `sections[${i}].lines[${j}]`;
      const text = collapse(line.text);
      const issues: string[] = [];
      const refs: string[] = [];
      for (const ref of line.refs) {
        const parsed = parseRef(ref);
        const source = parsed?.kind === 'memory' ? byRow.get(parsed.rowId) : undefined;
        if (!source || (parsed?.kind === 'memory' && parsed.version !== null && parsed.version !== source.version)) {
          issues.push(`cites ${JSON.stringify(ref)}, which is not one of the listed notes`);
        } else if (!refs.includes(source.ref)) {
          refs.push(source.ref);
        }
      }
      if (!text) issues.push('is blank');
      if (text && sensitiveForProfile(text)) {
        issues.push('says something the profile never holds (health, religion, ethnicity, politics, sexuality, an address, a phone number or a secret): leave it out');
      }
      if (text && language === 'zh' && !CJK_CHAR.test(text)) issues.push('is in English, but the profile is in Chinese: write it in Chinese (names stay as written)');
      if (text && language === 'en' && turnLanguage(text) === 'zh') issues.push('is in Chinese, but the profile is in English: write it in English (names stay as written)');
      if (text && refs.length > 0) {
        const cited = refs.map((ref) => {
          const source = byRow.get((parseRef(ref) as { rowId: number }).rowId)!;
          // Its keywords too: extraction writes them in both languages (利兹 and Leeds, 博士 and PhD).
          return [source.body, memoryDay(source.observedAt), source.eventAt !== null ? memoryDay(source.eventAt) : '', ...(source.keywords ?? [])].join('\n');
        }).join('\n');
        const missing = numbersMissing(text, cited);
        if (missing.length > 0) {
          issues.push(`says ${missing.map((token) => JSON.stringify(token)).join(', ')}, which the notes it cites do not: cite the note that says it, or leave it out`);
        }
      }
      if (issues.length > 0) {
        if (strict) problems.push(...issues.map((issue) => `${where} ${issue}`));
        return;
      }
      const key = normalizeText(text);
      if (seen.has(key)) return;
      seen.add(key);
      lines.push({ text, refs });
    });
    if (lines.length === 0) return;
    if (!topic) {
      if (strict) problems.push(`sections[${i}].topic must not be blank`);
      return;
    }
    sections.push({ topic, lines });
  });
  const tokens = (list: ProfilePayload['sections']) => list.reduce((sum, section) => sum + profileTokens(section.topic)
    + section.lines.reduce((count, line) => count + profileTokens(line.text), 0), 0);
  if (problems.length > 0) {
    // One repair for everything: the size of the whole answer, the lines it must fix included.
    const whole = raw.sections.reduce((sum, section) => sum + profileTokens(collapse(section.topic))
      + section.lines.reduce((count, line) => count + profileTokens(collapse(line.text)), 0), 0);
    if (whole > PROFILE_LIMITS.maxTokens * TOKEN_SLACK) {
      problems.push(`and the profile is about ${whole} tokens: keep it within ${PROFILE_LIMITS.maxTokens}, keeping what later requests are most likely to need`);
    }
    throw new ProfilePayloadError(problems);
  }
  // Over the limit is never sent back for a repair: the longest topic loses its last line until the profile fits.
  return { sections: withinProfileLimit(sections, tokens) };
}

/** The sections within PROFILE_LIMITS.maxTokens (with TOKEN_SLACK): the last line of the topic with the most tokens goes, one at a time. */
function withinProfileLimit(sections: ProfilePayload['sections'], tokens: (list: ProfilePayload['sections']) => number): ProfilePayload['sections'] {
  const out = sections.map((section) => ({ topic: section.topic, lines: [...section.lines] }));
  while (out.length > 0 && tokens(out) > PROFILE_LIMITS.maxTokens * TOKEN_SLACK) {
    let longest = out.length - 1;
    for (let i = out.length - 1; i >= 0; i -= 1) if (tokens([out[i]]) > tokens([out[longest]])) longest = i;
    out[longest].lines.pop();
    if (out[longest].lines.length === 0) out.splice(longest, 1);
  }
  return out;
}

// ── the commit ───────────────────────────────────────────────────────────────

export interface ProfileCommitContext {
  /** The memory owner, as given to buildProfilePrompt. */
  ownerUserId: string;
  /** The notes the prompt listed (their refs and memory ids): a line may cite only these. */
  sources: ReadonlyArray<{ ref: string; memoryId: string }>;
  /** The user scope's memory version the prompt was built at (ProfilePrompt.sourceVersion). */
  sourceVersion: number;
  language?: ProfileLanguage | null;
  now?: number;
}

export interface ProfileCommitResult {
  saved: boolean;
  /** The profile's version now, when saved. */
  version: number | null;
  /** Lines stored. */
  lines: number;
  /** Lines left out: one cites a note the prompt did not list, or one that changed since (edited, corrected, removed). */
  dropped: Array<{ section: number; line: number; reason: 'unlisted' | 'changed' }>;
  /** Why nothing was saved. */
  reason?: 'memory_off';
}

/** A memory a stored line may cite: active, in the user scope, at the version cited, and recallable. */
function citable(stored: StoredMemory | undefined, version: number): stored is StoredMemory {
  return !!stored && stored.record.status === 'active' && stored.record.scope.kind === 'user' && stored.record.version === version && vouched(stored);
}

/**
 * Stores a validated answer as the owner's profile (a new version), each
 * line with the versions of the memories it cites; a line citing a note the
 * prompt did not list, or one that changed since, is left out. Nothing is
 * saved while memory is off.
 */
export function commitProfilePayload(payload: ProfilePayload, ctx: ProfileCommitContext): ProfileCommitResult {
  const ownerUserId = typeof ctx?.ownerUserId === 'string' ? ctx.ownerUserId.trim() : '';
  if (!ownerUserId) throw new Error('ownerUserId is required');
  if (getMemorySettings(ownerUserId).mode === 'off') return { saved: false, version: null, lines: 0, dropped: [], reason: 'memory_off' };
  const now = Number.isFinite(ctx.now) ? Number(ctx.now) : Date.now();
  return memoryTransaction(() => {
    const listed = new Map(ctx.sources.map((source) => [source.ref, source.memoryId]));
    const ids = [...new Set((payload?.sections ?? []).flatMap((section) => section.lines.flatMap((line) => line.refs.map((ref) => listed.get(ref))))
      .filter((id): id is string => !!id))];
    const current = new Map(storedMemories(ownerUserId, ids).map((stored) => [stored.record.id, stored]));
    const lines: ProfileLine[] = [];
    const dropped: ProfileCommitResult['dropped'] = [];
    (payload?.sections ?? []).forEach((section, i) => section.lines.forEach((line, j) => {
      const refs: ProfileCitation[] = [];
      for (const ref of line.refs) {
        const id = listed.get(ref);
        const parsed = parseRef(ref);
        if (!id || parsed?.kind !== 'memory' || parsed.version === null) { dropped.push({ section: i, line: j, reason: 'unlisted' }); return; }
        const stored = current.get(id);
        if (!citable(stored, parsed.version)) { dropped.push({ section: i, line: j, reason: 'changed' }); return; }
        refs.push({ id, rowId: stored.rowId, version: stored.record.version });
      }
      if (refs.length > 0) lines.push({ topic: section.topic, text: line.text, refs });
    }));
    getDb().prepare(`INSERT INTO memory_user_profiles (owner_user_id, lines, language, version, source_version, built_at, last_error, updated_at)
        VALUES (?, ?, ?, 1, ?, ?, NULL, ?)
      ON CONFLICT(owner_user_id) DO UPDATE SET lines = excluded.lines, language = excluded.language,
        version = memory_user_profiles.version + 1, source_version = excluded.source_version, built_at = excluded.built_at,
        last_error = NULL, updated_at = excluded.updated_at`)
      .run(ownerUserId, JSON.stringify(lines), ctx.language ?? null, ctx.sourceVersion, now, now);
    const version = (getDb().prepare('SELECT version FROM memory_user_profiles WHERE owner_user_id = ?').get(ownerUserId) as { version: number }).version;
    return { saved: true, version, lines: lines.length, dropped };
  });
}

// ── reading it ───────────────────────────────────────────────────────────────

function parseLines(stored: string | null): ProfileLine[] {
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): ProfileLine[] => {
      if (!entry || typeof entry !== 'object') return [];
      const { topic, text, refs } = entry as Record<string, unknown>;
      if (typeof topic !== 'string' || typeof text !== 'string' || !Array.isArray(refs)) return [];
      const citations = refs.filter((ref): ref is ProfileCitation => !!ref && typeof ref === 'object'
        && typeof (ref as ProfileCitation).id === 'string' && Number.isSafeInteger((ref as ProfileCitation).rowId)
        && Number.isSafeInteger((ref as ProfileCitation).version));
      return citations.length > 0 ? [{ topic, text, refs: citations }] : [];
    });
  } catch {
    return [];
  }
}

const PROFILE_SQL = 'SELECT lines, language, version, source_version, built_at FROM memory_user_profiles WHERE owner_user_id = ?';

/** The owner's stored profile, or null before the first build. */
export function readUserProfile(ownerUserId: string): UserProfile | null {
  const row = prepareCached(PROFILE_SQL).get(ownerUserId) as
    { lines: string; language: string | null; version: number; source_version: number | null; built_at: number | null } | undefined;
  if (!row || row.version <= 0) return null;
  return {
    version: row.version,
    language: row.language === 'zh' || row.language === 'en' ? row.language : null,
    lines: parseLines(row.lines),
    sourceVersion: row.source_version,
    builtAt: row.built_at,
  };
}

/**
 * The lines a pack may show now, in order: every memory a line cites is
 * still active at the version it cites, in the user scope and recallable.
 * cited: those memories, by id.
 */
export function currentProfileLines(ownerUserId: string, profile: UserProfile): { lines: ProfileLine[]; cited: Map<string, StoredMemory> } {
  const ids = [...new Set(profile.lines.flatMap((line) => line.refs.map((ref) => ref.id)))];
  const stored = new Map(storedMemories(ownerUserId, ids).map((entry) => [entry.record.id, entry]));
  const lines = profile.lines.filter((line) => line.refs.length > 0 && line.refs.every((ref) => citable(stored.get(ref.id), ref.version)));
  return { lines, cited: stored };
}

/**
 * Removes the lines citing these memories from the owner's stored profile;
 * returns how many went. The profile's version stays: a pack already leaves
 * such a line out, and the memory version the removal bumped resends the
 * pinned sections without it.
 */
export function dropProfileCitations(ownerUserId: string, memoryIds: readonly string[]): number {
  if (memoryIds.length === 0) return 0;
  const row = getDb().prepare('SELECT lines FROM memory_user_profiles WHERE owner_user_id = ?').get(ownerUserId) as { lines: string } | undefined;
  if (!row) return 0;
  const gone = new Set(memoryIds);
  const lines = parseLines(row.lines);
  const kept = lines.filter((line) => !line.refs.some((ref) => gone.has(ref.id)));
  if (kept.length === lines.length) return 0;
  getDb().prepare('UPDATE memory_user_profiles SET lines = ?, updated_at = ? WHERE owner_user_id = ?').run(JSON.stringify(kept), Date.now(), ownerUserId);
  return lines.length - kept.length;
}

/**
 * Consolidation put notes away as duplicates of others (consolidation.ts):
 * a stored line citing one of them at the version it was put away from cites
 * its into instead, at the into's current version, when the into may be
 * cited (active, in the user scope, recallable); otherwise the line keeps its
 * citation and a pack leaves it out by the version rule (currentProfileLines).
 * The profile's version stays: the merge bumped the memory version, so packs
 * check their pinned sections again. Returns how many citations moved. Call
 * inside the merge's transaction.
 */
export function remapProfileCitations(ownerUserId: string, mapping: ReadonlyArray<{ from: { id: string; version: number }; into: StoredMemory }>): number {
  if (mapping.length === 0) return 0;
  const row = getDb().prepare('SELECT lines FROM memory_user_profiles WHERE owner_user_id = ?').get(ownerUserId) as { lines: string } | undefined;
  if (!row) return 0;
  const lines = parseLines(row.lines);
  let moved = 0;
  const remapped = lines.map((line) => {
    const refs: ProfileCitation[] = [];
    for (const ref of line.refs) {
      const target = mapping.find((entry) => entry.from.id === ref.id && entry.from.version === ref.version)?.into;
      const next = target && citable(target, target.record.version) ? { id: target.record.id, rowId: target.rowId, version: target.record.version } : ref;
      if (next !== ref) moved += 1;
      if (!refs.some((kept) => kept.id === next.id)) refs.push(next);
    }
    return { ...line, refs };
  });
  if (moved === 0) return 0;
  getDb().prepare('UPDATE memory_user_profiles SET lines = ?, updated_at = ? WHERE owner_user_id = ?').run(JSON.stringify(remapped), Date.now(), ownerUserId);
  return moved;
}

/** Every removal of a user-scope memory (delete, forget) takes the profile lines citing it, in the removing transaction. Returns an uninstall. */
export function installUserProfileHooks(): () => void {
  return onMemoryRemoved(({ record }) => {
    if (record.scope.kind === 'user') dropProfileCitations(record.ownerUserId, [record.id]);
  });
}

// ── rebuild bookkeeping ──────────────────────────────────────────────────────

export interface ProfileRebuildState {
  /** The user-scope version the stored lines were built from (null: never built). */
  sourceVersion: number | null;
  builtAt: number | null;
  /** When the latest rebuild was planned (null: never). */
  attemptedAt: number | null;
  /** When the user asked for a rebuild still to run (null: none waits). */
  requestedAt: number | null;
  lastError: string | null;
}

export function profileRebuildState(ownerUserId: string): ProfileRebuildState {
  const row = getDb().prepare(`SELECT source_version, built_at, attempted_at, requested_at, last_error
      FROM memory_user_profiles WHERE owner_user_id = ?`).get(ownerUserId) as
    { source_version: number | null; built_at: number | null; attempted_at: number | null; requested_at: number | null; last_error: string | null } | undefined;
  return {
    sourceVersion: row?.source_version ?? null, builtAt: row?.built_at ?? null, attemptedAt: row?.attempted_at ?? null,
    requestedAt: row?.requested_at ?? null, lastError: row?.last_error ?? null,
  };
}

/** A rebuild was planned at `now`: the next follows the cadence from here (extractionRun.profileRebuildDue), and the user's request is served. */
export function recordProfileAttempt(ownerUserId: string, now: number): void {
  getDb().prepare(`INSERT INTO memory_user_profiles (owner_user_id, attempted_at, requested_at, updated_at) VALUES (?, ?, NULL, ?)
    ON CONFLICT(owner_user_id) DO UPDATE SET attempted_at = excluded.attempted_at, requested_at = NULL, updated_at = excluded.updated_at`)
    .run(ownerUserId, now, now);
}

/** A rebuild did not save a profile: why, for Settings › Memory. The next one follows the cadence. */
export function recordProfileFailure(ownerUserId: string, error: string, now: number): void {
  getDb().prepare('UPDATE memory_user_profiles SET last_error = ?, updated_at = ? WHERE owner_user_id = ?').run(error.slice(0, 2000), now, ownerUserId);
}

/** The user asked for a rebuild (Settings › Memory): the next automatic memory run rebuilds the profile, whatever the cadence says. */
export function requestProfileRebuild(ownerUserId: string, now: number): void {
  getDb().prepare(`INSERT INTO memory_user_profiles (owner_user_id, requested_at, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(owner_user_id) DO UPDATE SET requested_at = excluded.requested_at, updated_at = excluded.updated_at`)
    .run(ownerUserId, now, now);
}

// ── Settings › Memory ────────────────────────────────────────────────────────

/**
 * GET /api/memory-profile: the lines a pack shows now (currentProfileLines),
 * in order, each with the memories it cites as refs the user can follow.
 */
export function memoryProfileView(ownerUserId: string): MemoryProfileResponse {
  const profile = readUserProfile(ownerUserId);
  const rebuildRequested = profileRebuildState(ownerUserId).requestedAt !== null;
  if (!profile) return { lines: [], builtAt: null, version: 0, rebuildRequested };
  const { lines, cited } = currentProfileLines(ownerUserId, profile);
  return {
    lines: lines.map((line) => ({
      topic: line.topic,
      text: line.text,
      refs: line.refs.flatMap((ref) => {
        const memory = cited.get(ref.id);
        return memory ? [{ ref: memoryRef(ref.rowId, ref.version), id: ref.id, body: memory.record.body }] : [];
      }),
    })),
    builtAt: profile.builtAt,
    version: profile.version,
    rebuildRequested,
  };
}

/**
 * The memories a line of memoryProfileView cites (by its index there), or
 * null when there is no such line: what Remove deletes before the profile is
 * rebuilt without it.
 */
export function profileLineMemoryIds(ownerUserId: string, index: number): string[] | null {
  const profile = readUserProfile(ownerUserId);
  if (!profile || !Number.isSafeInteger(index) || index < 0) return null;
  const line = currentProfileLines(ownerUserId, profile).lines[index];
  return line ? [...new Set(line.refs.map((ref) => ref.id))] : null;
}
