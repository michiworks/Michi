/**
 * The check-in write detector (DESIGN-v2 §2.6.2): every block, column and
 * view type is registered, every URL field a block schema has is classified,
 * and each page write tool a check-in has refuses content that loads from or
 * links outside Michi.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MICHI_DB_COLUMN_TYPES, MICHI_DB_VIEW_TYPES, PAGE_BLOCK_TYPES, PAGE_TEMPLATES, materializePageTemplate, pageBlockInputSchema,
  taskDatabaseColumns, taskDatabaseViews,
} from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { createDatabase } from '../src/services/pages/repository';
import {
  BLOCK_REMOTE_RULES, CHECKIN_LINK_HOSTS, CHECKIN_PAGE_WRITE_TOOLS, COLUMN_REMOTE_RULES, VIEW_REMOTE_RULES,
  blockRemoteProblem, checkinWriteProblem, databaseRemoteProblem, isAllowedCheckinLink, remoteTextProblem, valuesAtPath,
  type CheckinPageWriteTool, type RemoteContentProblem,
} from '../src/services/pages/remoteMedia';
// The renderer's own rules, as the oracle these checks must agree with.
import { rehypeAutolinkBareUrls } from '../../frontend/src/components/rehypeAutolinkBareUrls';
import { COMPANION_LINK_HOSTS } from '../../frontend/src/state/companion/companionLinks';

const OWNER = 'alice';
const EVIL = 'https://tracker.example/pixel.png';
const ALLOWED = 'https://reviews.example.com/reviews/CR-1';
const sorted = (values: Iterable<string>) => [...values].sort();

type Schema = Record<string, unknown>;

/** Each block type's JSON schema, by type. */
function blockSchemas(): Map<string, Schema> {
  const schemas = new Map<string, Schema>();
  for (const branch of pageBlockInputSchema().oneOf) {
    const type = (branch.properties as Record<string, Schema> | undefined)?.type;
    const name = (type?.const ?? (type?.enum as unknown[] | undefined)?.[0]) as string | undefined;
    if (name) schemas.set(name, branch);
  }
  return schemas;
}

/** Every string field of a schema, as a rule path (`items[].url`), with its description. */
function stringFields(schema: Schema, at = ''): Array<{ path: string; description: string }> {
  const out: Array<{ path: string; description: string }> = [];
  if (schema.type === 'string') out.push({ path: at, description: typeof schema.description === 'string' ? schema.description : '' });
  for (const [key, value] of Object.entries((schema.properties as Record<string, Schema> | undefined) ?? {})) {
    if (key !== 'type' && key !== 'interaction') out.push(...stringFields(value, at ? `${at}.${key}` : key));
  }
  if (schema.items && typeof schema.items === 'object') out.push(...stringFields(schema.items as Schema, `${at}[]`));
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    for (const branch of (schema[key] as Schema[] | undefined) ?? []) out.push(...stringFields(branch, at));
  }
  return out;
}

/** A URL field by what the schema says (the rich blocks' `https URL`) or by its name. */
const URL_NAMED = /(^|\.|\[\])(url|src|href|image|images|avatar|cover|poster|thumbnail|icon|logo|picture|photo)$/i;
const looksLikeUrl = (field: { path: string; description: string }) => /https? URL|https address/i.test(field.description) || URL_NAMED.test(field.path.replace(/\[\]$/, ''));

/** `{type, ...}` with `value` at a rule path, one item in each list on the way: `items[].url` → `{items: [{url}]}`. */
function setAt(root: Record<string, unknown>, rulePath: string, value: unknown): Record<string, unknown> {
  const wrap = (lists: number, inner: unknown): unknown => (lists === 0 ? inner : [wrap(lists - 1, inner)]);
  const build = (steps: string[]): Record<string, unknown> => {
    const [step, ...rest] = steps;
    const name = step!.replace(/(\[\])+$/, '');
    return { [name]: wrap((step!.length - name.length) / 2, rest.length ? build(rest) : value) };
  };
  return { ...root, ...build(rulePath.split('.')) };
}

const kind = (found: RemoteContentProblem | null) => found?.kind ?? null;

/** Every path in a schema that holds an object of any shape (`{"type":"object"}` and nothing more), as a rule path. */
function opaqueObjectPaths(schema: Schema, at = ''): string[] {
  const out: string[] = [];
  const shapeless = schema.type === 'object' && !schema.properties && !schema.additionalProperties && !schema.anyOf && !schema.oneOf && !schema.allOf;
  if (shapeless) out.push(at);
  for (const [key, value] of Object.entries((schema.properties as Record<string, Schema> | undefined) ?? {})) {
    if (key !== 'type') out.push(...opaqueObjectPaths(value, at ? `${at}.${key}` : key));
  }
  if (schema.items && typeof schema.items === 'object') out.push(...opaqueObjectPaths(schema.items as Schema, `${at}[]`));
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') out.push(...opaqueObjectPaths(schema.additionalProperties as Schema, `${at}{}`));
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    for (const branch of (schema[key] as Schema[] | undefined) ?? []) out.push(...opaqueObjectPaths(branch, at));
  }
  return out;
}

type Hast = { type: string; tagName?: string; value?: string; properties?: { href?: string }; children?: Hast[] };
/** The links the page's autolinker (frontend rehypeAutolinkBareUrls) makes of a text, as text or inside code. */
function rendererLinks(value: string, code: boolean): string[] {
  const text: Hast = { type: 'text', value };
  const tree: Hast = { type: 'root', children: [code ? { type: 'element', tagName: 'code', children: [text] } : text] };
  rehypeAutolinkBareUrls()(tree as never);
  const hrefs: string[] = [];
  const walk = (node: Hast) => { if (node.tagName === 'a' && node.properties?.href) hrefs.push(node.properties.href); node.children?.forEach(walk); };
  walk(tree);
  return hrefs;
}

/** `levels` objects deep with `leaf` at the bottom. */
const nested = (levels: number, leaf: unknown): unknown => (levels === 0 ? leaf : { inner: nested(levels - 1, leaf) });

let dir: string;
let priorData: string | undefined;

beforeEach(() => {
  priorData = process.env.MICHI_DATA_DIR;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-remote-media-'));
  process.env.MICHI_DATA_DIR = dir;
  closeDb();
  initDb();
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws', 'Workspace', OWNER);
});

afterEach(() => {
  closeDb();
  if (priorData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = priorData;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the registry covers every type the code knows (ratchet)', () => {
  test('every block, column and view type is registered, and nothing else', () => {
    assert.deepEqual(sorted(Object.keys(BLOCK_REMOTE_RULES)), sorted(PAGE_BLOCK_TYPES));
    assert.deepEqual(sorted(Object.keys(COLUMN_REMOTE_RULES)), sorted(MICHI_DB_COLUMN_TYPES));
    assert.deepEqual(sorted(Object.keys(VIEW_REMOTE_RULES)), sorted(MICHI_DB_VIEW_TYPES));
  });

  test('every URL field in a block schema is registered as one it loads or one the user may click', () => {
    const schemas = blockSchemas();
    assert.deepEqual(sorted(schemas.keys()), sorted(PAGE_BLOCK_TYPES), 'every block type has a schema branch');
    const unregistered: string[] = [];
    for (const [type, schema] of schemas) {
      const rule = BLOCK_REMOTE_RULES[type as keyof typeof BLOCK_REMOTE_RULES];
      if (rule.kind === 'blocked') continue;
      const registered = new Set(rule.kind === 'urls' ? [...rule.loads, ...rule.links] : []);
      for (const field of stringFields(schema).filter(looksLikeUrl)) {
        if (!registered.has(field.path)) unregistered.push(`${type}.${field.path}`);
      }
    }
    assert.deepEqual(unregistered, [], 'register these in BLOCK_REMOTE_RULES (backend/src/services/pages/remoteMedia.ts)');
  });

  test('every registered field and nested-block path exists in its block schema', () => {
    const schemas = blockSchemas();
    for (const [type, rule] of Object.entries(BLOCK_REMOTE_RULES)) {
      const fields = new Set(stringFields(schemas.get(type)!).map((field) => field.path));
      if (rule.kind === 'urls') for (const field of [...rule.loads, ...rule.links]) assert.ok(fields.has(field), `${type}.${field} is a string field`);
      if (rule.kind === 'container') {
        for (const child of rule.children) {
          const sample = setAt({ type }, child, { type: 'image', url: EVIL });
          assert.equal(valuesAtPath(sample, child).length, 1, `${type}.${child} reaches one nested block`);
        }
      }
    }
  });

  test('every list of nested blocks in a block schema is registered as a container path', () => {
    // Nested blocks are shapeless objects in the schemas: a type that holds some
    // must be a container (each child checked by its own type) or blocked, never inert.
    const unregistered: string[] = [];
    for (const [type, schema] of blockSchemas()) {
      const rule = BLOCK_REMOTE_RULES[type as keyof typeof BLOCK_REMOTE_RULES];
      if (rule.kind === 'blocked') continue;
      const children = new Set(rule.kind === 'container' ? rule.children : []);
      for (const at of opaqueObjectPaths(schema)) if (!children.has(at)) unregistered.push(`${type}.${at}`);
      for (const child of children) assert.ok(opaqueObjectPaths(schema).includes(child), `${type}.${child} holds blocks in the schema`);
    }
    assert.deepEqual(unregistered, [], 'register these as containers (or block the type) in BLOCK_REMOTE_RULES');
  });

  test('the templates and the task database a check-in can make are clean', () => {
    for (const key of Object.keys(PAGE_TEMPLATES) as Array<keyof typeof PAGE_TEMPLATES>) {
      const made = materializePageTemplate(key, { workspaceId: 'ws', now: 1 });
      for (const block of made.blocks) assert.equal(blockRemoteProblem(block), null, `${key} template block ${block.type}`);
      for (const database of made.databases) assert.equal(databaseRemoteProblem(database), null, `${key} template database`);
    }
    assert.equal(databaseRemoteProblem({ columns: taskDatabaseColumns(), views: taskDatabaseViews() }), null);
  });
});

describe('every registered field is enforced', () => {
  test('a field a block loads is refused whatever address it holds; a link field takes only the allowed places', () => {
    for (const [type, rule] of Object.entries(BLOCK_REMOTE_RULES)) {
      if (rule.kind !== 'urls') continue;
      for (const field of rule.loads) {
        for (const address of [EVIL, ALLOWED]) {
          const found = blockRemoteProblem(setAt({ type }, field, address));
          assert.equal(kind(found), 'loads', `${type}.${field} = ${address}`);
          assert.match(found!.message, /propose it to the user/);
        }
      }
      for (const field of rule.links) {
        assert.equal(kind(blockRemoteProblem(setAt({ type }, field, 'https://evil.example/x'))), 'link', `${type}.${field} evil`);
        assert.equal(blockRemoteProblem(setAt({ type }, field, ALLOWED)), null, `${type}.${field} allowed`);
      }
    }
  });

  test('a container is checked through every nesting it has', () => {
    for (const [type, rule] of Object.entries(BLOCK_REMOTE_RULES)) {
      if (rule.kind !== 'container') continue;
      for (const child of rule.children) {
        const found = blockRemoteProblem(setAt({ type }, child, { type: 'image', url: EVIL }));
        assert.equal(kind(found), 'loads', `${type}.${child}`);
        assert.equal(blockRemoteProblem(setAt({ type }, child, { type: 'markdown', text: 'fine' })), null, `${type}.${child} plain`);
      }
    }
    assert.equal(kind(blockRemoteProblem({ type: 'tabs', tabs: [{ label: '![x](https://a.example/b.png)', blocks: [] }] })), 'loads', 'a tab label is text too');
  });

  test('a library component, a place card, a custom view and an unknown type are refused outright', () => {
    assert.equal(kind(blockRemoteProblem({ type: 'component', componentId: 'cmp', props: {} })), 'blocked');
    // Its card links "Open in maps" to Apple Maps with the name or address in the query.
    assert.equal(kind(blockRemoteProblem({ type: 'place', name: 'SECRET-DATA', address: 'token=abc123' })), 'blocked');
    assert.equal(kind(blockRemoteProblem({ type: 'not-a-block', url: EVIL })), 'blocked');
    assert.equal(kind(checkinWriteProblem('read_page', { pageId: 'p' }, OWNER)), 'blocked', 'only the write tools');
  });
});

describe('text is read as Markdown wherever it is', () => {
  const text = (value: string) => kind(blockRemoteProblem({ type: 'callout', text: value }));

  test('pictures and raw HTML media are refused, whatever the address', () => {
    assert.equal(text(`See ![chart](${ALLOWED})`), 'loads');
    assert.equal(text('![x][ref]\n\n[ref]: https://a.example/b.png'), 'loads');
    // What a Markdown parser reads as a picture, though a pattern would not.
    assert.equal(text('![a [b] c](https://reviews.example.com/x.png)'), 'loads');
    assert.equal(text('[x]: https://reviews.example.com/a.png\n\n![x]'), 'loads');
    assert.equal(text('[x]: https://reviews.example.com/a.png\n\nhello ![x] world'), 'loads');
    // A picture only the page's math-aware reading makes ($]x$ is a formula there).
    assert.equal(text('![a $]x$](https://reviews.example.com/x.png)'), 'loads');
    assert.equal(text('<img src="https://a.example/b.png">'), 'loads');
    assert.equal(text('<IFRAME src=x>'), 'loads');
    assert.equal(text('<div style="background:url(https://a.example/b.png)">x</div>'), 'loads');
    assert.equal(text('<p data="https://a.example">x</p>'), 'loads');
  });

  test('links go only to Michi, in-page anchors and the allowed sites', () => {
    assert.equal(text('[report](https://evil.example/r)'), 'link');
    assert.equal(text('see https://evil.example/r'), 'link');
    assert.equal(text('see www.evil.example'), 'link');
    assert.equal(text('<https://evil.example>'), 'link');
    assert.equal(text('[x]: https://evil.example'), 'link');
    assert.equal(text('<a href="https://evil.example">x</a>'), 'link');
    assert.equal(text('[x](//evil.example/r)'), 'link');
    assert.equal(text('[x](javascript:alert(1))'), 'link');
    assert.equal(text('http://reviews.example.com/reviews/CR-1'), 'link', 'https only');
    assert.equal(text('https://reviews.example.com.evil.example/x'), 'link', 'the exact host');
    assert.equal(text('https://user@reviews.example.com/x'), 'link');
    assert.equal(text(`Merged in ${ALLOWED}.`), null, 'a sentence ending after an allowed address');
    assert.equal(text(`[CR-1](${ALLOWED}) and [pipeline](https://builds.example.com/pipelines/Michi)`), null);
    assert.equal(text('[mail](https://outlook.office.com/mail/inbox) [m2](https://outlook.office365.com/x)'), null);
    assert.equal(text('[Tasks](michi://page/pg-1) and [details](#view/plan)'), null);
    assert.equal(text('Plain words, 3 tasks done; alice@ reviewed.'), null);
  });

  test('a link that looks allowed but opens another site is refused, as the browser reads it', () => {
    // Markdown turns `\@` and `&#64;` into `@`, and renderers percent-encode a
    // `\` before the browser reads the link: the site is then evil.example.
    assert.equal(text('[CR](https://reviews.example.com\\@evil.example/x)'), 'link');
    assert.equal(text('[CR][r]\n\n[r]: https://reviews.example.com\\@evil.example/x'), 'link');
    assert.equal(text('<https://reviews.example.com\\@evil.example/x>'), 'link');
    assert.equal(text('[y](https://reviews.example.com&#64;evil.example/)'), 'link');
    // GFM's bare addresses run past a quote or a backtick, so the link opens evil.example.
    assert.equal(text("see https://reviews.example.com'@evil.example/x now"), 'link');
    assert.equal(text('see https://reviews.example.com"@evil.example/x now'), 'link');
    assert.equal(text('see https://reviews.example.com`@evil.example/x now'), 'link');
    // A link only the page's math-aware reading makes, and an address written with entities.
    assert.equal(text('[a $](b$](https&#58;//evil.example)'), 'link');
    assert.equal(text('see https&#58;//evil.example/x'), 'link');
    // Text the renderer joins across inline HTML it drops.
    assert.equal(text('see evil</b>.example/x'), 'link');
    assert.equal(text('see https:</b>//evil.example/x'), 'link');
    // Raw HTML is read as the browser reads it: attributes and text with their entities decoded.
    assert.equal(text('<a href="https://reviews.example.com&#64;evil.example/">CR</a>'), 'link');
    assert.equal(text('<a href="https&#58;//evil.example/">CR</a>'), 'link');
    assert.equal(text('<div>\nsee evil&#46;example/x\n</div>'), 'link');
    assert.equal(text('<div>\nsee <b>reviews.example.com/reviews/CR-1</b>\n</div>'), null);
    for (const link of ['https://reviews.example.com\\@evil.example/x', 'https://reviews.example.com%40evil.example/', 'https://reviews.example.com:443/x',
      "https://reviews.example.com'@evil.example/x", 'https://reviews.example.com./x']) {
      assert.equal(isAllowedCheckinLink(link), false, link);
    }
  });

  test('a link without a scheme, which the page autolinks, goes only to the allowed sites too', () => {
    assert.equal(text('see evil.example/x?d=SECRET'), 'link');
    assert.equal(text('Open docs.evil.example/leak?q=1 now'), 'link');
    assert.equal(text('see evil&#46;example/x'), 'link', 'an entity the renderer decodes before it autolinks');
    assert.equal(text('mail attacker@evil.example'), 'link', 'GFM makes a mailto: link of a bare address');
    assert.equal(text('Reviewed in reviews.example.com/reviews/CR-1.'), null);
    assert.equal(text('Edited backend/src/services/pages.ts and `src/index.css`.'), null);
  });

  test('whatever link the page\'s autolinker makes of a text, the check refuses it unless it is allowed (frontend parity)', () => {
    const corpus = [
      'see evil.example/x', 'docs.evil.example/a?b=1.', 'https://evil.example/x', 'www.evil.example', 'www.evil.example/path',
      'https://reviews.example.com/reviews/CR-1', 'reviews.example.com/reviews/CR-1', 'builds.example.com/pipelines/Michi',
      'https://reviews.example.com.evil.example/x', 'sub.reviews.example.com/x', 'a.b.c.example.org/x/y', 'http://reviews.example.com/x',
      'see (evil.example/x) now', 'evil.example/x, then www.reviews.example.com/y', 'x@evil.example/y', 'file.ts/notes', 'https://reviews.example.com/x"y',
    ];
    for (const value of corpus) {
      for (const code of [false, true]) {
        const refusedByRenderer = rendererLinks(value, code).filter((href) => !isAllowedCheckinLink(href));
        if (!refusedByRenderer.length) continue;
        const markdown = code ? `\`${value}\`` : value;
        assert.notEqual(remoteTextProblem(markdown, 'text'), null, `${markdown} renders a link to ${refusedByRenderer.join(', ')}`);
      }
    }
  });

  test('the allowed sites are the conversation link renderer\'s work sites', () => {
    assert.deepEqual([...CHECKIN_LINK_HOSTS], [...COMPANION_LINK_HOSTS], 'the same list as frontend/src/state/companion/companionLinks.ts');
    assert.equal(isAllowedCheckinLink('https://REVIEWS.example.com/x'), true);
    assert.equal(isAllowedCheckinLink('https://reviews.example.com:8443/x'), false);
  });

  test('a value nested too deeply to read is refused, not left unread', () => {
    const deep = nested(40, 'https://evil.example/x');
    assert.equal(kind(blockRemoteProblem({ type: 'callout', text: 'fine', extra: deep })), 'blocked');
    assert.equal(kind(blockRemoteProblem({ type: 'callout', text: 'fine', extra: nested(40, 7) })), 'blocked', 'whatever is at the bottom');
    assert.equal(kind(blockRemoteProblem({ type: 'callout', text: 'fine', extra: nested(10, 'https://evil.example/x') })), 'link');
  });
});

describe('each page write tool a check-in has refuses what would load or link outside Michi', () => {
  let databaseId = '';
  beforeEach(() => {
    databaseId = createDatabase({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Links', now: 1,
      columns: [{ id: 'name', name: 'Name', type: 'text' }, { id: 'site', name: 'Site', type: 'url' }, { id: 'shot', name: 'Shot', type: 'image' }],
      views: [{ id: 'table', name: 'Table', type: 'table', position: 0, config: { filters: [], match: 'all', sorts: [] } }] }).id;
  });

  /** One write per tool that would load from the internet once drawn; open_task_database can write none. */
  const LOADING_WRITES: Record<CheckinPageWriteTool, (() => Record<string, unknown>) | null> = {
    edit_page: () => ({ pageId: 'pg', ops: [{ op: 'insert', after: null, block: { type: 'image', url: EVIL } }] }),
    create_page: () => ({ workspaceId: 'ws', title: `Notes ![x](${EVIL})` }),
    edit_database: () => ({ databaseId, ops: [{ op: 'row.add', values: { name: 'A', shot: EVIL } }] }),
    create_database: () => ({ workspaceId: 'ws', title: 'Shots', columns: [{ name: 'Shot', type: 'image' }] }),
    configure_database: () => ({ databaseId, revision: 1, ops: [{ op: 'column.add', column: { name: 'Shot', type: 'image' } }] }),
    open_task_database: null,
  };

  test('one loading write per tool, all refused', () => {
    assert.deepEqual(sorted(Object.keys(LOADING_WRITES)), sorted(CHECKIN_PAGE_WRITE_TOOLS));
    for (const tool of CHECKIN_PAGE_WRITE_TOOLS) {
      const args = LOADING_WRITES[tool];
      if (!args) {
        assert.equal(checkinWriteProblem(tool, { workspaceId: 'ws' }, OWNER), null, `${tool} writes only the clean task database`);
        continue;
      }
      const found = checkinWriteProblem(tool, args(), OWNER);
      assert.equal(kind(found), 'loads', tool);
      assert.match(found!.message, /propose it to the user/, tool);
    }
  });

  test('edit_page checks every op block, an update as much as an insert', () => {
    const ops = (block: unknown, op: Record<string, unknown> = { op: 'insert', after: null }) => ({ pageId: 'pg', ops: [{ op: 'delete', id: 'b0', expectRev: 1 }, { ...op, block }] });
    assert.equal(checkinWriteProblem('edit_page', ops({ type: 'markdown', text: `Done: ${ALLOWED}` }), OWNER), null);
    const found = checkinWriteProblem('edit_page', ops({ type: 'markdown', text: `![x](${EVIL})` }, { op: 'update', id: 'b1', expectRev: 2 }), OWNER);
    assert.deepEqual([found?.kind, found?.path], ['loads', 'ops[1].block.text']);
    assert.equal(kind(checkinWriteProblem('edit_page', ops({ type: 'embed', url: 'https://www.youtube.com/embed/x' }), OWNER)), 'loads');
    assert.equal(kind(checkinWriteProblem('edit_page', ops({ type: 'link', url: 'https://evil.example', title: 'x' }), OWNER)), 'link');
    assert.equal(kind(checkinWriteProblem('edit_page', ops({ type: 'columns', columns: [[{ type: 'video', url: EVIL }]] }), OWNER)), 'loads');
  });

  test('create_page checks its title and its template', () => {
    assert.equal(checkinWriteProblem('create_page', { workspaceId: 'ws', title: 'Release notes', template: 'release' }, OWNER), null);
    assert.equal(kind(checkinWriteProblem('create_page', { workspaceId: 'ws', title: 'See https://evil.example' }, OWNER)), 'link');
  });

  test('edit_database checks each cell by its column, and the row body', () => {
    const row = (values: Record<string, unknown>, body?: string) => ({ databaseId, ops: [{ op: 'row.update', id: 'r', expectRev: 1, values, ...(body === undefined ? {} : { body }) }] });
    assert.equal(checkinWriteProblem('edit_database', row({ name: 'Review', site: ALLOWED }, `See [CR](${ALLOWED})`), OWNER), null);
    assert.equal(kind(checkinWriteProblem('edit_database', row({ site: 'https://evil.example/x' }), OWNER)), 'link');
    assert.equal(kind(checkinWriteProblem('edit_database', row({ shot: ALLOWED }), OWNER)), 'loads', 'a picture cell loads even an allowed address');
    assert.equal(checkinWriteProblem('edit_database', row({ shot: '' }), OWNER), null, 'clearing a picture loads nothing');
    assert.equal(kind(checkinWriteProblem('edit_database', row({ name: 'x' }, `![x](${EVIL})`), OWNER)), 'loads');
    assert.equal(kind(checkinWriteProblem('edit_database', row({ name: 'https://evil.example' }), OWNER)), 'link');
    assert.equal(kind(checkinWriteProblem('edit_database', row({ site: 'https://reviews.example.com\\@evil.example/x' }), OWNER)), 'link', 'a link cell that only looks allowed');
    assert.equal(kind(checkinWriteProblem('edit_database', row({ name: nested(40, 'https://evil.example') }), OWNER)), 'blocked', 'a cell nested too deeply');
    assert.equal(checkinWriteProblem('edit_database', { databaseId, ops: [{ op: 'row.delete', id: 'r', expectRev: 1 }] }, OWNER), null);
    assert.equal(kind(checkinWriteProblem('edit_database', { databaseId: 'db-missing', ops: [{ op: 'row.add', values: {} }] }, OWNER)), 'blocked');
  });

  test('create_database and configure_database refuse picture columns, gallery covers and custom views', () => {
    assert.equal(checkinWriteProblem('create_database', { workspaceId: 'ws', title: 'Reviews', columns: [{ name: 'Link', type: 'url' }, { name: 'Who', type: 'text' }] }, OWNER), null);
    const configure = (op: Record<string, unknown>) => checkinWriteProblem('configure_database', { databaseId, revision: 1, ops: [op] }, OWNER);
    assert.equal(kind(configure({ op: 'column.update', id: 'name', patch: { type: 'image' } })), 'loads');
    assert.equal(kind(configure({ op: 'view.save', view: { name: 'Shots', type: 'gallery', config: { filters: [], match: 'all', sorts: [], cover: 'shot' } } })), 'loads');
    assert.equal(configure({ op: 'view.save', view: { name: 'Cards', type: 'gallery', config: { filters: [], match: 'all', sorts: [] } } }), null);
    assert.equal(kind(configure({ op: 'view.save', view: { name: 'C', type: 'custom', config: { filters: [], match: 'all', sorts: [], componentId: 'cmp' } } })), 'blocked');
    assert.equal(configure({ op: 'option.add', id: 'name', option: { value: 'done' } }), null);
  });
});
