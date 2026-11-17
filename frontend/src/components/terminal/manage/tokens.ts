// File-type badges of the WorkspaceManage resource list (ContextList). Each
// type family takes a palette text token on that hue's opaque soft fill
// (TK-35), so a badge follows the palette and its label reads at 4.5:1 or
// more in every palette, whatever the row's hover or selection fill. A new
// type joins one of these families.

/** A badge's label colour and its fill. */
interface BadgeTone {
  text: string;
  fill: string;
}

const PLAIN: BadgeTone = { text: 'var(--term-mid)', fill: 'var(--term-alt2)' };
const DANGER: BadgeTone = { text: 'var(--term-danger-text)', fill: 'var(--term-danger-f)' };
const DIGEST: BadgeTone = { text: 'var(--term-digest)', fill: 'var(--term-digest-f)' };
const ACCENT: BadgeTone = { text: 'var(--term-accent-text)', fill: 'var(--term-accent-f)' };
const WAITING: BadgeTone = { text: 'var(--term-waiting-text)', fill: 'var(--term-waiting-f)' };
const MAUVE: BadgeTone = { text: 'var(--term-mauve)', fill: 'var(--term-mauve-f)' };

const FILETYPE_LABEL: Record<string, string> = {
  md: 'md', mdx: 'md', markdown: 'md',
  txt: 'txt', log: 'txt', rtf: 'txt',
  pdf: 'pdf', xls: 'xls', xlsx: 'xls', xlsm: 'xls',
  csv: 'csv', tsv: 'csv',
  doc: 'doc', docx: 'doc',
  json: 'json', yaml: 'yml', yml: 'yml', toml: 'toml',
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx',
  py: 'py', rs: 'rs', go: 'go', rb: 'rb', sh: 'sh',
  png: 'img', jpg: 'img', jpeg: 'img', gif: 'img', webp: 'img', svg: 'img', heic: 'img', avif: 'img',
  html: 'html', htm: 'html', xml: 'html',
};

/** Types not listed here (txt, doc, unknown) are plain. */
const FILETYPE_TONE: Record<string, BadgeTone> = {
  md: PLAIN, mdx: PLAIN, markdown: PLAIN, sh: PLAIN,
  pdf: DANGER, rs: DANGER, rb: DANGER, html: DANGER, htm: DANGER, xml: DANGER,
  csv: DIGEST, tsv: DIGEST, xls: DIGEST, xlsx: DIGEST, py: DIGEST,
  ts: ACCENT, tsx: ACCENT, go: ACCENT,
  js: WAITING, jsx: WAITING, json: WAITING, yaml: WAITING, yml: WAITING, toml: WAITING,
  png: MAUVE, jpg: MAUVE, jpeg: MAUVE, gif: MAUVE, webp: MAUVE, svg: MAUVE, heic: MAUVE, avif: MAUVE,
};

export interface ManageFileType extends BadgeTone {
  label: string;
  ext: string;
}

/** A link's badge, in the accent family with ts, tsx and go. */
export const MANAGE_LINK_TYPE: ManageFileType = { label: 'url', ext: '', ...ACCENT };

export function manageFileType(filePathOrName: string): ManageFileType {
  const m = filePathOrName.toLowerCase().match(/\.([^./\\]+)$/);
  const ext = m?.[1] ?? '';
  return {
    ext,
    label: FILETYPE_LABEL[ext] ?? (ext.slice(0, 3) || '·'),
    ...(FILETYPE_TONE[ext] ?? PLAIN),
  };
}
