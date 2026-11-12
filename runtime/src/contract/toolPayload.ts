/**
 * Inline images in tool results, as Michi's UI and persistence keep them.
 *
 * A tool result can carry a whole image: Anthropic content blocks
 * ({type:'image', source:{type:'base64', media_type, data}}), MCP and pi-ai
 * image content ({type:'image', mimeType, data}), Kiro's
 * {Image:{format, source:{kind:'bytes', data:[…bytes]}}} or a data: URL. A
 * tool chip cannot show it, and the 16 KB payload cap cuts it into invalid
 * JSON. These helpers put a short placeholder such as
 * `[image image/png 412 KB omitted]` where the image data was and keep the
 * surrounding JSON valid.
 *
 * Display and storage only: they return copies and never mutate their input,
 * so what the agent and model receive is unchanged.
 */

/** The most of a tool's input or output a chip and its stored row keep, in UTF-16 units. */
export const TOOL_PAYLOAD_MAX = 16 * 1024;

/**
 * A tool's input or output as chip text: strings as they are, other values as
 * JSON (String() when JSON cannot encode them), cut at {@link TOOL_PAYLOAD_MAX}.
 * Undefined when there is nothing to show.
 */
export function truncateToolPayload(value: unknown): string | undefined {
  if (value == null) return undefined;
  let text: string | undefined;
  if (typeof value === 'string') text = value;
  else {
    try { text = JSON.stringify(value); } catch { text = String(value); }
  }
  if (!text) return undefined;
  return text.length > TOOL_PAYLOAD_MAX ? text.slice(0, TOOL_PAYLOAD_MAX) : text;
}

/** Every placeholder {@link imagePlaceholder} writes. */
export const IMAGE_PLACEHOLDER_PATTERN = /^\[image(?: image\/[\w.+-]+)?(?: \d+(?:\.\d)? (?:B|KB|MB))? omitted\]$/;

/** Shorter base64 strings are left alone: they are not worth a placeholder, or not images. */
const MIN_IMAGE_DATA_CHARS = 64;
/** Outside valid JSON, a quoted run after an image marker must be this long to count as image data. */
const MIN_CUT_RUN_CHARS = 1000;
/** How far after an image marker its data key may start. */
const DATA_KEY_WINDOW = 400;
const MAX_DEPTH = 64;

const MARKERS = ['"type":"image"', '"type": "image"', '"Image":{', '"Image": {', 'data:image/'];
/** Templates: each scan makes its own global copy. */
const MARKER_PATTERN = /"type"\s*:\s*"image"|"Image"\s*:\s*\{/;
const DATA_KEY_PATTERN = /"(?:data|bytes|Bytes)"\s*:\s*/;
const DATA_URL_PATTERN = /data:(image\/[\w.+-]{1,40});base64,([A-Za-z0-9+/]+={0,2})/g;
const MIME_KEY_PATTERN = /"(?:media_type|mimeType|mime_type)"\s*:\s*"(image\/[\w.+-]{1,40})"/;
const FORMAT_KEY_PATTERN = /"format"\s*:\s*"([A-Za-z]{2,8})"/;
/** The body of a JSON-quoted base64 string: base64 characters and the escapes \n, \r and \/. */
const QUOTED_BASE64_RUN = /(?:[A-Za-z0-9+/=]+|\\[nr/])*/y;
const BYTE_ARRAY_RUN = /[\d,\s]*/y;
const BASE64_TEXT = /^[A-Za-z0-9+/\r\n]+={0,2}[\r\n]*$/;

const BASE64_SIGNATURES: ReadonlyArray<readonly [string, string]> = [
  ['iVBORw0KGgo', 'image/png'], ['/9j/', 'image/jpeg'], ['R0lGOD', 'image/gif'], ['UklGR', 'image/webp'],
];
const BYTE_SIGNATURES: ReadonlyArray<readonly [readonly number[], string]> = [
  [[137, 80, 78, 71], 'image/png'], [[255, 216, 255], 'image/jpeg'], [[71, 73, 70, 56], 'image/gif'], [[82, 73, 70, 70], 'image/webp'],
];

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `[image image/png 412 KB omitted]`; the MIME type and size are left out when unknown. */
export function imagePlaceholder(mimeType?: string, bytes?: number): string {
  const mime = typeof mimeType === 'string' && /^image\/[\w.+-]{1,40}$/i.test(mimeType) ? ` ${mimeType.toLowerCase()}` : '';
  const size = typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes > 0 ? ` ${formatBytes(bytes)}` : '';
  return `[image${mime}${size} omitted]`;
}

/** Cheap check before any parsing: could this text hold an inline image? */
export function hasInlineImageMarker(text: string): boolean {
  return MARKERS.some((marker) => text.includes(marker));
}

function isBase64Data(value: unknown): value is string {
  return typeof value === 'string' && value.length >= MIN_IMAGE_DATA_CHARS && BASE64_TEXT.test(value);
}

/** Decoded size of base64 text; line breaks and padding carry no data. */
function base64Bytes(data: string): number {
  const breaks = data.includes('\n') || data.includes('\r') ? data.match(/[\r\n]/g)!.length : 0;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor(((data.length - breaks - padding) * 3) / 4);
}

function isByteArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.length >= 16
    && value.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255);
}

function sniffBase64(data: string): string | undefined {
  return BASE64_SIGNATURES.find(([prefix]) => data.startsWith(prefix))?.[1];
}

function sniffBytes(bytes: readonly number[]): string | undefined {
  return BYTE_SIGNATURES.find(([signature]) => signature.every((byte, i) => bytes[i] === byte))?.[1];
}

function formatMime(format: unknown): string | undefined {
  if (typeof format !== 'string' || !/^[A-Za-z]{2,8}$/.test(format)) return undefined;
  const lower = format.toLowerCase();
  return `image/${lower === 'jpg' ? 'jpeg' : lower}`;
}

function mimeOf(declared: unknown, data: string): string | undefined {
  return typeof declared === 'string' && declared.startsWith('image/') ? declared : sniffBase64(data);
}

function base64Placeholder(declaredMime: unknown, data: string): string {
  return imagePlaceholder(mimeOf(declaredMime, data), base64Bytes(data));
}

function omitDataUrls(text: string): string {
  if (!text.includes('data:image/')) return text;
  return text.replace(DATA_URL_PATTERN, (match, mime: string, data: string) =>
    data.length < MIN_IMAGE_DATA_CHARS ? match : imagePlaceholder(mime, base64Bytes(data)));
}

/** The image block with its data replaced, or undefined when `record` is not an image block. */
function imageBlock(record: JsonRecord): JsonRecord | undefined {
  if (record.type === 'image') {
    // Anthropic: { type: 'image', source: { type: 'base64', media_type, data } }
    const source = record.source;
    if (isRecord(source) && isBase64Data(source.data)) {
      return { ...record, source: { ...source, data: base64Placeholder(source.media_type ?? source.mimeType, source.data) } };
    }
    // MCP and pi-ai: { type: 'image', data, mimeType }
    if (isBase64Data(record.data)) {
      return { ...record, data: base64Placeholder(record.mimeType ?? record.mime_type ?? record.media_type, record.data) };
    }
  }
  // Kiro: { Image: { format, source: { kind: 'bytes', data: [137, 80, …] } } }
  const image = record.Image;
  if (isRecord(image) && isRecord(image.source)) {
    const source = image.source;
    for (const key of ['data', 'bytes', 'Bytes']) {
      const data = source[key];
      const placeholder = isByteArray(data) ? imagePlaceholder(formatMime(image.format) ?? sniffBytes(data), data.length)
        : isBase64Data(data) ? base64Placeholder(formatMime(image.format), data) : undefined;
      if (placeholder) return { ...record, Image: { ...image, source: { ...source, [key]: placeholder } } };
    }
  }
  return undefined;
}

function omitInValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return omitDataUrls(value);
  if (!value || typeof value !== 'object' || depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    let copy: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const next = omitInValue(value[i], depth + 1);
      if (next !== value[i]) (copy ??= value.slice())[i] = next;
    }
    return copy ?? value;
  }
  const record = value as JsonRecord;
  const image = imageBlock(record);
  if (image) return image;
  let copy: JsonRecord | undefined;
  for (const [key, child] of Object.entries(record)) {
    const next = omitInValue(child, depth + 1);
    if (next !== child) (copy ??= { ...record })[key] = next;
  }
  return copy ?? value;
}

interface ImageRun {
  /** Index after the run (and its closing quote or bracket), or the text length when the text ends inside it. */
  end: number;
  closed: boolean;
  bytes: number;
  mime?: string;
}

/** A quoted base64 string or a byte array starting at `start`, as a cut-off output holds it. */
function imageRun(text: string, start: number): ImageRun | undefined {
  if (text[start] === '"') {
    QUOTED_BASE64_RUN.lastIndex = start + 1;
    const raw = QUOTED_BASE64_RUN.exec(text)?.[0] ?? '';
    const i = start + 1 + raw.length;
    const closed = i < text.length;
    // JSON escapes a base64 string may carry.
    const data = raw.includes('\\') ? raw.replace(/\\[nr]/g, '').replace(/\\\//g, '/') : raw;
    if (closed && (text[i] !== '"' || data.length < MIN_CUT_RUN_CHARS)) return undefined;
    return { end: closed ? i + 1 : text.length, closed, bytes: base64Bytes(data), mime: sniffBase64(data) };
  }
  if (text[start] === '[') {
    BYTE_ARRAY_RUN.lastIndex = start + 1;
    const i = start + 1 + (BYTE_ARRAY_RUN.exec(text)?.[0].length ?? 0);
    const closed = i < text.length;
    const body = text.slice(start + 1, i);
    if (closed && (text[i] !== ']' || body.length < MIN_CUT_RUN_CHARS)) return undefined;
    const numbers = body.split(',').filter((part) => part.trim() !== '').map(Number);
    if (numbers.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
    return { end: closed ? i + 1 : text.length, closed, bytes: numbers.length, mime: sniffBytes(numbers) };
  }
  return undefined;
}

function declaredMime(segment: string): string | undefined {
  return MIME_KEY_PATTERN.exec(segment)?.[1] ?? formatMime(FORMAT_KEY_PATTERN.exec(segment)?.[1]);
}

/** Closes the arrays, objects and string a cut-off JSON text left open; undefined when it still does not parse. */
function closeJson(text: string): string | undefined {
  const stack: string[] = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inString) return undefined;
  const closed = text.replace(/[\s,]+$/, '') + stack.reverse().join('');
  try {
    JSON.parse(closed);
    return closed;
  } catch {
    return undefined;
  }
}

/**
 * Image data in text that is not valid JSON, such as a stored output the
 * 16 KB cap cut inside its image: the base64 string or byte array after each
 * image marker becomes a placeholder. When the text ended inside that image,
 * what it left open is closed so the result parses again.
 */
function omitCutImages(text: string): string {
  let out = '';
  let pos = 0;
  let cutInImage = false;
  const markers = new RegExp(MARKER_PATTERN.source, 'g');
  const dataKeys = new RegExp(DATA_KEY_PATTERN.source, 'g');
  for (let marker = markers.exec(text); marker; marker = markers.exec(text)) {
    const afterMarker = marker.index + marker[0].length;
    dataKeys.lastIndex = afterMarker;
    const key = dataKeys.exec(text);
    if (!key || key.index > afterMarker + DATA_KEY_WINDOW) continue;
    const valueStart = key.index + key[0].length;
    const run = imageRun(text, valueStart);
    if (!run) continue;
    const mime = declaredMime(text.slice(marker.index, valueStart))
      ?? (run.closed ? declaredMime(text.slice(run.end, run.end + DATA_KEY_WINDOW)) : undefined) ?? run.mime;
    out += text.slice(pos, valueStart) + JSON.stringify(imagePlaceholder(mime, run.closed ? run.bytes : undefined));
    pos = run.end;
    markers.lastIndex = pos;
    if (!run.closed) cutInImage = true;
  }
  if (pos === 0) return omitDataUrls(text);
  out = omitDataUrls(out + text.slice(pos));
  if (cutInImage && /^\s*[[{]/.test(out)) return closeJson(out) ?? out;
  return out;
}

/**
 * Inline image data in a tool output string replaced by placeholders. Valid
 * JSON stays valid; text cut inside an image (as older stored outputs are) is
 * repaired where possible. Text without an image marker is returned as is.
 */
export function omitInlineImagesInText(text: string): string {
  if (!hasInlineImageMarker(text)) return text;
  if (/^\s*[[{]/.test(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return omitCutImages(text);
    }
    const next = omitInValue(parsed, 0);
    return next === parsed ? text : JSON.stringify(next);
  }
  return omitCutImages(text);
}

/**
 * A tool result with its inline images replaced by placeholders, for the
 * normalized event payload (UI and persistence) before it is serialized and
 * capped. Objects are copied where they change; the input is never mutated.
 */
export function omitInlineImages(value: unknown): unknown {
  return typeof value === 'string' ? omitInlineImagesInText(value) : omitInValue(value, 0);
}
