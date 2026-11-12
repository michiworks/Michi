import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  MEMORY_BODY_MAX_CHARS, MEMORY_TOPIC_MAX_CHARS, isSystemWorkspaceSettings, type MemoryImportSource, type MemoryKind, type MemoryRecord,
  type MemoryScope,
} from 'michi-shared';
import { claudeProjectSlug } from 'michi-runtime/internal/adapters/claude/claudeProjectsPath';
import { resolveClaudeConfigDir } from '../agentConfig';
import { LOCAL_AGENT_OWNER_ID } from '../agentOwner';
import { getDb } from '../db';
import { listWorkspaces, parseFolders } from '../dbRepository';
import { log } from '../logger';
import { memoryBodyHash } from './extractionRepository';
import { activeMemoryBodies, findMemory, memoryTransaction } from './memoryRepository';
import {
  createMemory, deleteMemory, getMemorySettings, removeImportCopy, updateMemory, type MemoryCaller,
} from './memoryService';
import { containsCredential } from './secrets';

/**
 * One-way import of the runtimes' own memories into Michi Memory. The
 * sessions Michi spawns keep none of their own (RuntimeConfigPort.features.nativeMemory),
 * so what Claude Code, Codex and Kiro remembered before, and what the user's
 * sessions outside Michi go on remembering, is read from their files (never
 * written) and becomes ordinary Michi memories marked with their source
 * (memories.import_source and import_ref, migration 0075):
 *
 * - Claude Code's auto memory, <config>/projects/<project>/memory, for the
 *   folders of the owner's workspaces (the folder, and the git working tree
 *   and main repository holding it, as Claude names the project): each topic
 *   file, and each note MEMORY.md holds itself (its index lines name topic
 *   files and give their titles), into that workspace, or into the user
 *   scope when two or more workspaces share the project (the home folder, a
 *   repository and its worktree).
 * - Codex memories, $CODEX_HOME/memories: memory_summary.md and MEMORY.md, a
 *   note per # and ## section, in the user scope.
 * - Kiro's, <kiro home>/identities/<identity>/memories/memories.db: a Global
 *   one in the user scope, a repo:<provider>/<path> one in the workspace
 *   whose folder has that origin remote, or in the user scope when two or
 *   more have it. The database is read from a copy.
 *
 * Each item is one memory in one scope. Its rows in the other scopes it may
 * have been in (the copies earlier versions imported into each workspace
 * sharing a folder, or the scope it had before a workspace opened or closed
 * the folder) fold into that one on the next pass: a copy the user deleted
 * keeps the item deleted and one they changed keeps it theirs; otherwise
 * one imported copy moves there. The import's other copies go without a
 * tombstone.
 *
 * A note longer than a memory may be is split at paragraphs, each part headed
 * by the note's title. Every item keeps a row in memory_import_items that
 * outlives its memory: a memory deleted in Michi, by whatever path (Settings,
 * memory_delete, a reset), is not imported again, and one changed in Michi
 * (edited, corrected, moved) is Michi's own from then on. Otherwise the
 * memory follows its source: a changed item updates it in place, a removed
 * one removes it. A body the owner already has (normalized, memoryBodyHash)
 * is not stored twice, and a credential (secrets.ts) not at all. Imported
 * memories are facts, recalled when related rather than pinned (Claude Code
 * itself keeps only the index resident), except Kiro's user preferences; all
 * are origin extracted.
 *
 * Desktop only: a cloud backend's home directory holds none of its users'
 * memories. Runs shortly after the backend listens and every
 * IMPORT_INTERVAL_MS, and reads only the files whose size or modification
 * time, or the workspaces they are imported for, changed since. A reset that
 * deletes the owner's memories leaves the rows, so nothing comes back;
 * purgeOwnerMemories (a deleted account) and purgeWorkspaceMemories remove
 * them too.
 */

const IMPORT_INTERVAL_MS = 10 * 60_000;
/** A larger file is not a memory note; it is skipped. */
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES_PER_DIR = 200;
const MAX_KIRO_MEMORIES = 2000;
/** Longest title a part of a split note repeats. */
const MAX_TITLE_CHARS = 300;

export interface NativeMemoryImportOptions {
  /** Claude Code's config directory; null skips Claude. Default: Michi's claudeConfigDir, CLAUDE_CONFIG_DIR, ~/.claude. */
  claudeConfigDir?: string | null;
  /** Codex's home; null skips Codex. Default: CODEX_HOME, ~/.codex. */
  codexHome?: string | null;
  /** Kiro's home; null skips Kiro. Default: KIRO_HOME, ~/.kiro. */
  kiroHome?: string | null;
  /** What each file looked like when it was last imported; a file that still does is not read. Default: the module's. */
  seen?: Map<string, string>;
}

export interface NativeMemoryImportSummary {
  filesRead: number;
  created: number;
  updated: number;
  removed: number;
  /** Items whose body the owner already had. */
  duplicates: number;
  /** Copies of an item in another scope than its own, moved to its scope or removed. */
  collapsed: number;
  failed: number;
}

/** One item of a runtime's memory, as it should stand in Michi. */
interface ImportItem {
  ref: string;
  body: string;
  kind: MemoryKind;
  observedAt: number | null;
  /** The note's title as its topic (every part of a split note shares it), clipped as memoryService stores it; null without one. */
  topic: string | null;
}

/** An item and the scope it goes to (null: the user's). */
type ScopedItem = ImportItem & { workspaceId: string | null };

/** One file of a runtime's memory (Kiro: one identity's database). */
interface SourceFile<Item = ScopedItem> {
  /** The ref of the file; its items' refs are it, or it followed by '#'. */
  ref: string;
  /** What the file looks like (sizes and modification times), and what decides its items' scopes; it is read again when this changes. */
  signature: string;
  /** Its items now, or null when it cannot be read: nothing changes then. */
  read(): Item[] | null;
}

/** A runtime's memory directory: its files, or null when it is missing or unreadable. */
interface SourceDir {
  source: MemoryImportSource;
  /** The scopes its items may be in (null: the user's): the user scope and each workspace it is imported for. */
  scopes: Array<string | null>;
  /** The refs of its files start with this. */
  prefix: string;
  files(): SourceFile[] | null;
}

interface ImportWorkspace {
  id: string;
  folders: string[];
}

const defaultSeen = new Map<string, string>();

// ── reading files (read-only) ──────────────────────────────────────────────

function statSignature(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

function readSmall(file: string): string | null {
  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, '');
  } catch {
    return null;
  }
}

function mtimeOf(file: string): number | null {
  try { return Math.floor(fs.statSync(file).mtimeMs); } catch { return null; }
}

/** The directory's Markdown files (not hidden, not symlinks), sorted; null when it cannot be listed. */
function markdownFiles(dir: string): string[] | null {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('.'))
      .map((entry) => entry.name).sort().slice(0, MAX_FILES_PER_DIR);
  } catch {
    return null;
  }
}

/** A ref segment: '#' separates parts of a ref, so a name's own '#' (and '%') is escaped. */
function refSegment(name: string): string {
  return name.replace(/%/gu, '%25').replace(/#/gu, '%23');
}

function shortHash(text: string): string {
  return createHash('sha256').update(text.normalize('NFKC').replace(/\s+/gu, ' ').trim(), 'utf8').digest('hex').slice(0, 12);
}

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try { return String(JSON.parse(value)); } catch { return value.slice(1, -1); }
  }
  return value.length >= 2 && value.startsWith('\'') && value.endsWith('\'') ? value.slice(1, -1) : value;
}

/** A leading YAML front matter's `key: value` lines (nested keys too, the first of a name wins) and the text after it. */
function frontMatter(text: string): { fields: Record<string, string>; body: string } {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(text);
  if (!match) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const field = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.+?)\s*$/u.exec(line);
    if (field && !(field[1] in fields)) fields[field[1]] = unquote(field[2]);
  }
  return { fields, body: text.slice(match[0].length) };
}

// ── notes to items ─────────────────────────────────────────────────────────

/** The text in pieces of at most `budget` characters: cut at blank lines, then at line ends, then anywhere. */
function splitText(text: string, budget: number): string[] {
  const pieces: string[] = [];
  let current = '';
  const add = (unit: string, separator: string) => {
    if (!current) current = unit;
    else if (current.length + separator.length + unit.length <= budget) current += separator + unit;
    else { pieces.push(current); current = unit; }
  };
  for (const paragraph of text.split(/\n[ \t]*\n/u).filter((part) => part.trim())) {
    if (paragraph.length <= budget) { add(paragraph, '\n\n'); continue; }
    for (const line of paragraph.split('\n')) {
      if (line.length <= budget) { add(line, '\n'); continue; }
      for (let start = 0; start < line.length;) {
        let end = Math.min(line.length, start + budget);
        // Never between the two halves of a surrogate pair.
        const last = line.charCodeAt(end - 1);
        if (end < line.length && last >= 0xD800 && last <= 0xDBFF) end -= 1;
        add(line.slice(start, end), '');
        start = end;
      }
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/**
 * A note as items: one, its title and text, when it fits a memory; else its
 * text cut at paragraphs, each part headed by the title and its number. The
 * first part keeps `ref`, a later one adds '#<n>'. `name`: the note's short
 * name, its topic (default the title).
 */
function noteItems(ref: string, title: string, text: string, kind: MemoryKind, observedAt: number | null, name = title): ImportItem[] {
  let head = title.replace(/\s+/gu, ' ').trim();
  if (head.length > MAX_TITLE_CHARS) head = `${head.slice(0, MAX_TITLE_CHARS - 1)}…`;
  const body = text.replace(/\r\n?/gu, '\n').trim();
  const whole = [head, body].filter(Boolean).join('\n\n');
  if (!whole) return [];
  const short = name.replace(/\s+/gu, ' ').trim();
  const topic = short ? Array.from(short).slice(0, MEMORY_TOPIC_MAX_CHARS).join('').trim() : null;
  if (whole.length <= MEMORY_BODY_MAX_CHARS) return [{ ref, body: whole, kind, observedAt, topic }];
  // Room for the head's " (12/34)" and the blank line after it.
  const parts = splitText(body, MEMORY_BODY_MAX_CHARS - head.length - 12);
  return parts.map((part, index) => ({
    ref: index === 0 ? ref : `${ref}#${index + 1}`,
    body: head ? `${head} (${index + 1}/${parts.length})\n\n${part}` : part,
    kind,
    observedAt,
    topic,
  }));
}

/** A file whose items all go to one scope; `placement`, what decided it, is part of its signature. */
function placed(file: SourceFile<ImportItem>, workspaceId: string | null, placement = ''): SourceFile {
  return {
    ref: file.ref,
    signature: `${file.signature}|${placement}`,
    read: () => file.read()?.map((item) => ({ ...item, workspaceId })) ?? null,
  };
}

// ── Claude Code ────────────────────────────────────────────────────────────

const LIST_ITEM = /^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+/u;
const LINK = /\[([^\]\n]+)\]\(<?([^)\s>]+)>?\)/u;

/**
 * MEMORY.md's blocks (list items and paragraphs; headings dropped): one that
 * links a topic file of the directory is its index line and gives its title,
 * any other is a note of its own.
 */
function readClaudeIndex(text: string, topics: ReadonlySet<string>): { titles: Map<string, string>; notes: string[] } {
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const block = current.join('\n').trim();
    if (block) blocks.push(block);
    current = [];
  };
  for (const line of frontMatter(text).body.split(/\r?\n/u)) {
    if (!line.trim() || /^\s{0,3}#/u.test(line)) { flush(); continue; }
    if (LIST_ITEM.test(line)) flush();
    current.push(line);
  }
  flush();
  const titles = new Map<string, string>();
  const notes: string[] = [];
  for (const block of blocks) {
    const link = LINK.exec(block);
    let target = '';
    if (link) {
      try { target = decodeURIComponent(link[2]); } catch { target = link[2]; }
      target = target.replace(/^\.\//u, '');
    }
    if (link && topics.has(target)) {
      if (!titles.has(target)) titles.set(target, link[1].trim());
    } else {
      notes.push(block.replace(LIST_ITEM, '').trim());
    }
  }
  return { titles, notes };
}

/** A topic file as items: titled by its index line, else its front matter name, and its description. */
function claudeTopicItems(ref: string, file: string, name: string, title: string | undefined): ImportItem[] | null {
  const text = readSmall(file);
  if (text === null) return null;
  const { fields, body } = frontMatter(text);
  const heading = title || fields.name || name.replace(/\.md$/u, '');
  const header = fields.description ? `${heading}: ${fields.description}` : heading;
  return noteItems(ref, header, body, 'fact', parseTime(fields.modified) ?? mtimeOf(file), heading);
}

/** The files of one project's auto memory directory (`project`: its directory name, the refs' first segment). */
function claudeFiles(dir: string, project: string): SourceFile<ImportItem>[] | null {
  const names = markdownFiles(dir);
  if (names === null) return null;
  const topics = names.filter((name) => name !== 'MEMORY.md');
  const indexFile = path.join(dir, 'MEMORY.md');
  const indexSignature = statSignature(indexFile);
  let index: ReturnType<typeof readClaudeIndex> | null | undefined;
  // Read once per pass, and only when a file of the directory changed.
  const readIndex = () => {
    if (index === undefined) {
      const text = indexSignature === 'missing' ? '' : readSmall(indexFile);
      index = text === null ? null : readClaudeIndex(text, new Set(topics));
    }
    return index;
  };
  const files: SourceFile<ImportItem>[] = topics.map((name) => ({
    ref: `${project}/${refSegment(name)}`,
    // Its title comes from the index.
    signature: `${statSignature(path.join(dir, name))}|${indexSignature}`,
    read: () => {
      const read = readIndex();
      return read && claudeTopicItems(`${project}/${refSegment(name)}`, path.join(dir, name), name, read.titles.get(name));
    },
  }));
  if (indexSignature !== 'missing') {
    files.push({
      ref: `${project}/MEMORY.md`,
      // Which blocks are index lines depends on the topic files there are.
      signature: `${indexSignature}|${topics.join('/')}`,
      read: () => {
        const read = readIndex();
        const observedAt = mtimeOf(indexFile);
        return read && read.notes.flatMap((note) => noteItems(`${project}/MEMORY.md#${shortHash(note)}`, '', note, 'fact', observedAt));
      },
    });
  }
  return files;
}

function readGitFile(file: string): string {
  return readSmall(file) ?? '';
}

/**
 * The git working tree holding `folder`, walking up to its .git, and the
 * main repository's directory when that is a linked worktree's file; null
 * outside a repository.
 */
function gitRepository(folder: string): { workTree: string; mainTree: string | null; commonDir: string } | null {
  let dir = path.resolve(folder);
  for (let depth = 0; depth < 64; depth += 1) {
    const dotGit = path.join(dir, '.git');
    let stat: fs.Stats | null = null;
    try { stat = fs.statSync(dotGit); } catch { /* not here */ }
    if (stat?.isDirectory()) return { workTree: dir, mainTree: dir, commonDir: dotGit };
    if (stat?.isFile()) {
      const pointer = /^gitdir:\s*(.+?)\s*$/mu.exec(readGitFile(dotGit))?.[1];
      if (!pointer) return null;
      const gitDir = path.resolve(dir, pointer);
      const common = readGitFile(path.join(gitDir, 'commondir')).trim();
      const commonDir = common ? path.resolve(gitDir, common) : gitDir;
      return { workTree: dir, mainTree: path.basename(commonDir) === '.git' ? path.dirname(commonDir) : null, commonDir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** The directories Claude Code may name a folder's project by: the folder (as given and resolved) and its working tree and main repository. */
function claudeProjectRoots(folder: string): string[] {
  const roots = new Set<string>([path.resolve(folder)]);
  try { roots.add(fs.realpathSync(folder)); } catch { /* a folder that is gone still names its project */ }
  for (const root of [...roots]) {
    const repository = gitRepository(root);
    if (repository) roots.add(repository.workTree);
    if (repository?.mainTree) roots.add(repository.mainTree);
  }
  return [...roots];
}

function claudeDirs(configDir: string, workspaces: readonly ImportWorkspace[]): SourceDir[] {
  // The workspaces each project is the folder of: one keeps it, two or more share it in the user scope.
  const projects = new Map<string, string[]>();
  for (const workspace of workspaces) {
    for (const project of new Set(workspace.folders.flatMap(claudeProjectRoots).map(claudeProjectSlug))) {
      projects.set(project, [...(projects.get(project) ?? []), workspace.id]);
    }
  }
  return [...projects].map(([project, workspaceIds]): SourceDir => {
    const workspaceId = workspaceIds.length === 1 ? workspaceIds[0] : null;
    const placement = [...workspaceIds].sort().join(',');
    return {
      source: 'claude',
      scopes: [null, ...workspaceIds],
      prefix: `${project}/`,
      files: () => claudeFiles(path.join(configDir, 'projects', project, 'memory'), project)
        ?.map((file) => placed(file, workspaceId, placement)) ?? null,
    };
  });
}

// ── Codex ──────────────────────────────────────────────────────────────────

/** A Codex memory file as notes, one per # and ## section, titled by its headings ("v1", the summary's format line, dropped). */
function codexItems(fileRef: string, text: string, label: string, observedAt: number | null): ImportItem[] {
  const lines = text.split(/\r?\n/u);
  if (lines[0]?.trim() === 'v1') lines.shift();
  const items: ImportItem[] = [];
  const occurrences = new Map<string, number>();
  let top = '';
  let title = label;
  let body: string[] = [];
  const flush = () => {
    const content = body.join('\n').trim();
    body = [];
    if (!content) return;
    const count = (occurrences.get(title) ?? 0) + 1;
    occurrences.set(title, count);
    items.push(...noteItems(`${fileRef}#${shortHash(title)}${count > 1 ? `-${count}` : ''}`, title, content, 'fact', observedAt));
  };
  for (const line of lines) {
    const heading = /^(#{1,2})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (!heading) { body.push(line); continue; }
    flush();
    if (heading[1].length === 1) title = top = heading[2];
    else title = top ? `${top} — ${heading[2]}` : heading[2];
  }
  flush();
  return items;
}

const CODEX_FILES: ReadonlyArray<{ name: string; label: string }> = [
  { name: 'memory_summary.md', label: 'Codex memory summary' },
  { name: 'MEMORY.md', label: 'Codex memory' },
];

function codexDirs(codexHome: string): SourceDir[] {
  const dir = path.join(codexHome, 'memories');
  return [{
    source: 'codex',
    scopes: [null],
    prefix: 'memories/',
    files: () => {
      const names = markdownFiles(dir);
      if (names === null) return null;
      return CODEX_FILES.filter(({ name }) => names.includes(name)).map(({ name, label }) => placed({
        ref: `memories/${name}`,
        signature: statSignature(path.join(dir, name)),
        read: () => {
          const file = path.join(dir, name);
          const text = readSmall(file);
          return text === null ? null : codexItems(`memories/${name}`, text, label, mtimeOf(file));
        },
      }, null));
    },
  }];
}

// ── Kiro ───────────────────────────────────────────────────────────────────

interface KiroMemoryRow {
  id: string;
  memory_type: string;
  scopes: string;
  title: string;
  summary: string;
  content: string;
  why: string | null;
  how_to_apply: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Kiro's memories, read from a copy of its database (and write-ahead log),
 * so the database is never opened in place; null when it cannot be read.
 */
function readKiroMemories(database: string): KiroMemoryRow[] | null {
  let copyDir: string | null = null;
  try {
    copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-kiro-memories-'));
    const copy = path.join(copyDir, 'memories.db');
    fs.copyFileSync(database, copy);
    if (fs.existsSync(`${database}-wal`)) fs.copyFileSync(`${database}-wal`, `${copy}-wal`);
    const db = new DatabaseSync(copy);
    try {
      return db.prepare(`SELECT id, memory_type, scopes, title, summary, content, why, how_to_apply, created_at, updated_at
        FROM memories ORDER BY created_at, id LIMIT ?`).all(MAX_KIRO_MEMORIES) as unknown as KiroMemoryRow[];
    } finally {
      db.close();
    }
  } catch {
    return null;
  } finally {
    if (copyDir) fs.rmSync(copyDir, { recursive: true, force: true });
  }
}

function kiroScopes(stored: string): string[] {
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((scope): scope is string => typeof scope === 'string') : [];
  } catch {
    return [];
  }
}

/** A repo scope's repository path ('repo:<provider>/<owner>/<name>' → '<owner>/<name>'), lower case; null for any other scope. */
function kiroRepoPath(scope: string): string | null {
  if (!scope.startsWith('repo:')) return null;
  const repository = scope.slice('repo:'.length).split('/').slice(1).join('/').toLowerCase();
  return repository || null;
}

/** The repository path of a remote URL (scp-like or URL form, '.git' dropped), lower case. */
function remoteRepoPath(url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/u, '').replace(/\.git$/u, '');
  const scp = /^[^/@:\s]+@[^/:\s]+:(.+)$/u.exec(trimmed);
  let repository: string;
  if (scp) repository = scp[1];
  else {
    try { repository = new URL(trimmed).pathname; } catch { return null; }
  }
  repository = repository.replace(/^\/+/u, '').toLowerCase();
  return repository.includes('/') ? repository : null;
}

/** The repository paths of the folders' origin remotes. */
function originRepoPaths(folders: readonly string[]): Set<string> {
  const paths = new Set<string>();
  for (const folder of folders) {
    const repository = gitRepository(folder);
    if (!repository) continue;
    const config = readGitFile(path.join(repository.commonDir, 'config'));
    const origin = /\[remote\s+"origin"\]([^[]*)/u.exec(config)?.[1] ?? '';
    const url = /^\s*url\s*=\s*(.+?)\s*$/mu.exec(origin)?.[1];
    const repoPath = url ? remoteRepoPath(url) : null;
    if (repoPath) paths.add(repoPath);
  }
  return paths;
}

function kiroItems(fileRef: string, rows: readonly KiroMemoryRow[], inScope: (scopes: string[]) => boolean): ImportItem[] {
  return rows.filter((row) => inScope(kiroScopes(row.scopes))).flatMap((row) => {
    const title = String(row.title ?? '').trim();
    const summary = String(row.summary ?? '').trim();
    const content = String(row.content ?? '').trim();
    const header = summary && summary !== title ? (title ? `${title}: ${summary}` : summary) : title;
    const text = [
      content !== summary ? content : '',
      row.why?.trim() ? `Why: ${row.why.trim()}` : '',
      row.how_to_apply?.trim() ? `How to apply: ${row.how_to_apply.trim()}` : '',
    ].filter(Boolean).join('\n\n');
    return noteItems(`${fileRef}#${refSegment(String(row.id))}`, header, text, row.memory_type === 'USER_PREFERENCE' ? 'preference' : 'fact',
      parseTime(row.updated_at) ?? parseTime(row.created_at), title);
  });
}

function kiroDirs(kiroHome: string, workspaces: readonly ImportWorkspace[]): SourceDir[] {
  let identities: string[];
  try {
    identities = fs.readdirSync(path.join(kiroHome, 'identities'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
  // A Global memory is the user's; a repo one belongs to the workspace whose folders have that origin remote, or to the
  // user scope when two or more workspaces have it; any other is not imported.
  const repositories = workspaces.map((workspace) => ({ id: workspace.id, paths: originRepoPaths(workspace.folders) }))
    .filter((workspace) => workspace.paths.size > 0);
  const scopeOf = (scopes: string[]): string | null | undefined => {
    if (scopes.includes('Global')) return null;
    const ids = repositories.filter((workspace) => scopes.some((scope) => workspace.paths.has(kiroRepoPath(scope) ?? '')))
      .map((workspace) => workspace.id);
    return ids.length > 1 ? null : ids[0];
  };
  const targets = [null, ...repositories.map((workspace) => workspace.id)];
  const placement = repositories.map((workspace) => `${workspace.id}:${[...workspace.paths].sort().join(',')}`).sort().join(';');
  return identities.map((identity): SourceDir => {
    const database = path.join(kiroHome, 'identities', identity, 'memories', 'memories.db');
    const fileRef = `${refSegment(identity)}/memories.db`;
    return {
      source: 'kiro',
      scopes: targets,
      prefix: `${refSegment(identity)}/`,
      files: () => fs.existsSync(database) ? [{
        ref: fileRef,
        signature: `${statSignature(database)}|${statSignature(`${database}-wal`)}|${placement}`,
        read: () => {
          const all = readKiroMemories(database);
          return all && targets.flatMap((workspaceId) => kiroItems(fileRef, all, (scopes) => scopeOf(scopes) === workspaceId)
            .map((item) => ({ ...item, workspaceId })));
        },
      }] : null,
    };
  });
}

// ── storage ────────────────────────────────────────────────────────────────

interface ItemRow {
  /** The scope's key: '' is the user scope. */
  workspace_id: string;
  import_ref: string;
  memory_id: string | null;
  body_hash: string;
  version: number | null;
}

function scopeKey(workspaceId: string | null): string {
  return workspaceId ?? '';
}

function memoryScope(workspaceId: string | null): MemoryScope {
  return workspaceId === null ? { kind: 'user' } : { kind: 'workspace', workspaceId };
}

/** The rows of a file's items in these scopes. */
function itemRows(ownerUserId: string, scopes: ReadonlyArray<string | null>, source: MemoryImportSource, fileRef: string): ItemRow[] {
  return getDb().prepare(`SELECT workspace_id, import_ref, memory_id, body_hash, version FROM memory_import_items
    WHERE owner_user_id = ? AND workspace_id IN (SELECT value FROM json_each(?)) AND import_source = ?
      AND (import_ref = ? OR substr(import_ref, 1, ?) = ?) ORDER BY import_ref, workspace_id`)
    .all(ownerUserId, JSON.stringify(scopes.map(scopeKey)), source, fileRef, fileRef.length + 1, `${fileRef}#`) as unknown as ItemRow[];
}

/** The files under `prefix` that items were imported from into these scopes. */
function importedFileRefs(ownerUserId: string, scopes: ReadonlyArray<string | null>, source: MemoryImportSource, prefix: string): string[] {
  const rows = getDb().prepare(`SELECT import_ref FROM memory_import_items
    WHERE owner_user_id = ? AND workspace_id IN (SELECT value FROM json_each(?)) AND import_source = ? AND substr(import_ref, 1, ?) = ?`)
    .all(ownerUserId, JSON.stringify(scopes.map(scopeKey)), source, prefix.length, prefix) as Array<{ import_ref: string }>;
  return [...new Set(rows.map((row) => row.import_ref.split('#')[0]))];
}

function saveRow(ownerUserId: string, workspaceId: string | null, source: MemoryImportSource, ref: string,
  memoryId: string | null, bodyHash: string, version: number | null): void {
  getDb().prepare(`INSERT INTO memory_import_items (owner_user_id, workspace_id, import_source, import_ref, memory_id, body_hash, version, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (owner_user_id, workspace_id, import_source, import_ref) DO UPDATE SET
      memory_id = excluded.memory_id, body_hash = excluded.body_hash, version = excluded.version, updated_at = excluded.updated_at`)
    .run(ownerUserId, scopeKey(workspaceId), source, ref, memoryId, bodyHash, version, Date.now());
}

function deleteRow(ownerUserId: string, workspaceId: string | null, source: MemoryImportSource, ref: string): void {
  getDb().prepare('DELETE FROM memory_import_items WHERE owner_user_id = ? AND workspace_id = ? AND import_source = ? AND import_ref = ?')
    .run(ownerUserId, scopeKey(workspaceId), source, ref);
}

/**
 * Whether a memory with this body was imported and then deleted in Michi
 * (under any ref) where one in this scope would show: in this workspace or
 * the user scope, and for the user scope in any workspace.
 */
function deletedInMichi(ownerUserId: string, workspaceId: string | null, bodyHash: string): boolean {
  return !!getDb().prepare(`SELECT 1 FROM memory_import_items i WHERE i.owner_user_id = ? AND i.body_hash = ?
      AND (? = '' OR i.workspace_id IN ('', ?))
      AND i.memory_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = i.memory_id) LIMIT 1`)
    .get(ownerUserId, bodyHash, scopeKey(workspaceId), scopeKey(workspaceId));
}

function markImported(ownerUserId: string, memoryId: string, source: MemoryImportSource, ref: string): void {
  getDb().prepare('UPDATE memories SET import_source = ?, import_ref = ? WHERE id = ? AND owner_user_id = ?')
    .run(source, ref, memoryId, ownerUserId);
}

/**
 * What became of the memory a row names: still as the import left it
 * (imported), deleted or changed in Michi (the user's now), or none stored
 * because the owner had the body (duplicate).
 */
function rowState(ownerUserId: string, row: ItemRow): { state: 'imported' | 'deleted' | 'changed' | 'duplicate'; memory: MemoryRecord | null } {
  if (row.memory_id === null) return { state: 'duplicate', memory: null };
  const stored = findMemory(ownerUserId, row.memory_id);
  if (!stored) return { state: 'deleted', memory: null };
  return stored.status === 'active' && stored.version === row.version ? { state: 'imported', memory: stored } : { state: 'changed', memory: null };
}

/**
 * An item's rows in other scopes than its own become one row in its scope.
 * What the user did to a copy decides: a deleted one keeps the item deleted,
 * else a changed one keeps it theirs; else an imported copy, the one in its
 * scope first, moves there. The import's other copies go (removeImportCopy:
 * no tombstone), and so do the other rows; a changed copy stays the user's.
 * Returns the row the item keeps, or null, and how many copies were moved or
 * removed. Call inside a transaction.
 */
function collapseRows(caller: MemoryCaller, source: MemoryImportSource, item: ScopedItem, rows: readonly ItemRow[]):
  { row: ItemRow | null; collapsed: number } {
  const own = scopeKey(item.workspaceId);
  const copies = rows.map((row) => ({ row, ...rowState(caller.ownerUserId, row) }))
    .sort((a, b) => Number(b.row.workspace_id === own) - Number(a.row.workspace_id === own));
  const keep = copies.find((copy) => copy.state === 'deleted') ?? copies.find((copy) => copy.state === 'changed')
    ?? copies.find((copy) => copy.state === 'imported') ?? copies.find((copy) => copy.row.workspace_id === own);
  let collapsed = 0;
  for (const copy of copies) {
    if (copy === keep) continue;
    if (copy.memory) {
      removeImportCopy(caller, copy.memory.id);
      collapsed += 1;
    }
    deleteRow(caller.ownerUserId, copy.row.workspace_id || null, source, item.ref);
  }
  if (!keep || keep.row.workspace_id === own) return { row: keep?.row ?? null, collapsed };
  let version = keep.row.version;
  if (keep.memory) {
    version = updateMemory(caller, keep.memory.id, { scope: memoryScope(item.workspaceId) }, keep.memory.version).version;
    collapsed += 1;
  }
  deleteRow(caller.ownerUserId, keep.row.workspace_id || null, source, item.ref);
  saveRow(caller.ownerUserId, item.workspaceId, source, item.ref, keep.row.memory_id, keep.row.body_hash, version);
  return { row: { ...keep.row, workspace_id: own, version }, collapsed };
}

/**
 * Brings the memories from one file, in every scope it is imported into, in
 * line with its items; false when an item failed (it is tried again next
 * time).
 */
function reconcile(ownerUserId: string, source: MemoryImportSource, fileRef: string, scopes: ReadonlyArray<string | null>,
  items: readonly ScopedItem[], summary: NativeMemoryImportSummary): boolean {
  const caller = { ownerUserId };
  const wanted = new Map(items.filter((item) => !containsCredential(item.body)).map((item) => [item.ref, item]));
  const fresh: ScopedItem[] = [];
  let ok = true;
  const attempt = (what: string, write: () => void) => {
    try {
      memoryTransaction(write);
      return true;
    } catch (error) {
      ok = false;
      summary.failed += 1;
      log.warn('workspace', 'memory: a native memory import step failed', { source, what, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };
  const rowsByRef = new Map<string, ItemRow[]>();
  for (const row of itemRows(ownerUserId, scopes, source, fileRef)) {
    rowsByRef.set(row.import_ref, [...(rowsByRef.get(row.import_ref) ?? []), row]);
  }
  for (const [ref, rows] of rowsByRef) {
    const item = wanted.get(ref);
    wanted.delete(ref);
    if (!item) {
      for (const row of rows) {
        // Gone from the source: so is its memory, unless that is the user's now.
        const { state, memory } = rowState(ownerUserId, row);
        if (state === 'deleted' || state === 'changed') continue;
        if (attempt('remove', () => {
          if (memory) deleteMemory(caller, memory.id);
          deleteRow(ownerUserId, row.workspace_id || null, source, ref);
        }) && memory) summary.removed += 1;
      }
      continue;
    }
    const { workspaceId } = item;
    let row: ItemRow | null = rows[0];
    if (rows.length > 1 || row.workspace_id !== scopeKey(workspaceId)) {
      const folded = { row: null as ItemRow | null, collapsed: 0 };
      if (!attempt('collapse', () => Object.assign(folded, collapseRows(caller, source, item, rows)))) continue;
      summary.collapsed += folded.collapsed;
      row = folded.row;
    }
    if (!row) {
      fresh.push(item);
      continue;
    }
    const { state, memory } = rowState(ownerUserId, row);
    const bodyHash = memoryBodyHash(item.body);
    if (state === 'duplicate') {
      if (bodyHash !== row.body_hash) fresh.push(item);
      continue;
    }
    // Topics compare as memoryService spells them (one spelling per owner, any case).
    const sameTopic = (memory?.topic ?? '').toLowerCase() === (item.topic ?? '').toLowerCase();
    if (!memory || (bodyHash === row.body_hash && memory.kind === item.kind && sameTopic)) continue;
    if (attempt('update', () => {
      const updated = updateMemory(caller, memory.id, { body: item.body, kind: item.kind, topic: item.topic }, memory.version);
      saveRow(ownerUserId, workspaceId, source, item.ref, memory.id, bodyHash, updated.version);
    })) summary.updated += 1;
  }
  fresh.push(...wanted.values());
  if (fresh.length === 0) return ok;
  // The bodies each scope already has, a workspace's including the user scope's.
  const owned = new Map<string, Set<string>>();
  const ownedIn = (workspaceId: string | null) => {
    const key = scopeKey(workspaceId);
    if (!owned.has(key)) owned.set(key, new Set(activeMemoryBodies(ownerUserId, workspaceId).map(memoryBodyHash)));
    return owned.get(key)!;
  };
  // The user scope's items first: a workspace's with the same body is then a duplicate of one.
  for (const item of [...fresh].sort((a, b) => Number(a.workspaceId !== null) - Number(b.workspaceId !== null))) {
    const { workspaceId } = item;
    const bodyHash = memoryBodyHash(item.body);
    // The same text deleted in Michi before, from another file or under another ref.
    if (deletedInMichi(ownerUserId, workspaceId, bodyHash)) continue;
    if (ownedIn(workspaceId).has(bodyHash)) {
      if (attempt('duplicate', () => saveRow(ownerUserId, workspaceId, source, item.ref, null, bodyHash, null))) summary.duplicates += 1;
      continue;
    }
    const scope = memoryScope(workspaceId);
    if (attempt('create', () => {
      const record = createMemory(caller, {
        scope, kind: item.kind, body: item.body, status: 'active', origin: 'extracted', observedAt: item.observedAt, topic: item.topic,
      });
      markImported(ownerUserId, record.id, source, item.ref);
      saveRow(ownerUserId, workspaceId, source, item.ref, record.id, bodyHash, record.version);
    })) {
      ownedIn(workspaceId).add(bodyHash);
      summary.created += 1;
    }
  }
  return ok;
}

// ── passes ─────────────────────────────────────────────────────────────────

/** The owner's workspaces a runtime's memory can belong to: not in Trash, not Michi's own, with their folders. */
function importWorkspaces(): ImportWorkspace[] {
  return listWorkspaces()
    .filter((workspace) => !workspace.deleted_at && !isSystemWorkspaceSettings(workspace.settings))
    .map((workspace) => ({ id: workspace.id, folders: parseFolders(workspace).map((folder) => folder.path).filter(Boolean) }))
    .filter((workspace) => workspace.folders.length > 0);
}

function defaultClaudeConfigDir(): string {
  return resolveClaudeConfigDir() ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
}

/**
 * One import pass for the desktop's owner: every source file whose size or
 * modification time, or the workspaces it is imported for, changed since it
 * was last imported is read again, and the owner's memories from it are
 * brought in line. Nothing happens in cloud mode or while the owner's memory
 * is off.
 */
export function syncNativeMemories(options: NativeMemoryImportOptions = {}): NativeMemoryImportSummary {
  const summary: NativeMemoryImportSummary = { filesRead: 0, created: 0, updated: 0, removed: 0, duplicates: 0, collapsed: 0, failed: 0 };
  if (process.env.MICHI_CLOUD === '1') return summary;
  const ownerUserId = LOCAL_AGENT_OWNER_ID;
  if (getMemorySettings(ownerUserId).mode === 'off') return summary;
  const seen = options.seen ?? defaultSeen;
  const workspaces = importWorkspaces();
  const claudeConfigDir = options.claudeConfigDir === undefined ? defaultClaudeConfigDir() : options.claudeConfigDir;
  const codexHome = options.codexHome === undefined ? process.env.CODEX_HOME || path.join(os.homedir(), '.codex') : options.codexHome;
  const kiroHome = options.kiroHome === undefined ? process.env.KIRO_HOME || path.join(os.homedir(), '.kiro') : options.kiroHome;
  const dirs = [
    ...(claudeConfigDir ? claudeDirs(claudeConfigDir, workspaces) : []),
    ...(codexHome ? codexDirs(codexHome) : []),
    ...(kiroHome ? kiroDirs(kiroHome, workspaces) : []),
  ];
  for (const dir of dirs) {
    // A missing or unreadable directory changes nothing: its memories stay as they are.
    const files = dir.files();
    if (files === null) continue;
    const seenKey = (ref: string) => [ownerUserId, dir.source, ref].join('\u0000');
    for (const file of files) {
      if (seen.get(seenKey(file.ref)) === file.signature) continue;
      const items = file.read();
      summary.filesRead += 1;
      if (items !== null && reconcile(ownerUserId, dir.source, file.ref, dir.scopes, items, summary)) {
        seen.set(seenKey(file.ref), file.signature);
      }
    }
    // A file removed from a directory that is still there takes its memories with it.
    const present = new Set(files.map((file) => file.ref));
    for (const ref of importedFileRefs(ownerUserId, dir.scopes, dir.source, dir.prefix)) {
      if (present.has(ref)) continue;
      reconcile(ownerUserId, dir.source, ref, dir.scopes, [], summary);
      seen.delete(seenKey(ref));
    }
  }
  return summary;
}

/** The first pass waits this long, so it does not compete with the windows loading their workspaces at startup. */
const FIRST_PASS_DELAY_MS = 15_000;
let importTimer: NodeJS.Timeout | null = null;

/**
 * Imports shortly after startup and then every IMPORT_INTERVAL_MS (the
 * timers do not keep the process alive); desktop only. MICHI_MEMORY_IMPORT=0
 * turns it off, for an instance that must not see the machine's other
 * memories (an evaluation).
 */
export function startNativeMemoryImport(): void {
  if (importTimer || process.env.MICHI_CLOUD === '1' || process.env.MICHI_MEMORY_IMPORT === '0') return;
  const run = () => {
    try {
      const summary = syncNativeMemories();
      if (summary.created || summary.updated || summary.removed || summary.collapsed || summary.failed) {
        log.info('workspace', 'memory: imported the runtimes\' own memories', { ...summary });
      }
    } catch (error) {
      log.warn('workspace', 'memory: native memory import failed', { error: error instanceof Error ? error.message : String(error) });
    }
  };
  importTimer = setTimeout(() => {
    run();
    importTimer = setInterval(run, IMPORT_INTERVAL_MS);
    importTimer.unref();
  }, FIRST_PASS_DELAY_MS);
  importTimer.unref();
}
