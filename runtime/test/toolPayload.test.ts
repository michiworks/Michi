import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    IMAGE_PLACEHOLDER_PATTERN, TOOL_PAYLOAD_MAX, hasInlineImageMarker, imagePlaceholder, omitInlineImages, omitInlineImagesInText,
    truncateToolPayload,
} from '../src/contract/toolPayload';

/** base64 of `bytes` bytes that starts with the PNG signature. */
function pngBase64(bytes: number): string {
    const data = Buffer.alloc(bytes, 7);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
    return data.toString('base64');
}

const PNG = pngBase64(30_000);

describe('imagePlaceholder', () => {
    it('names the type and size when known', () => {
        assert.equal(imagePlaceholder('image/png', 412 * 1024), '[image image/png 412 KB omitted]');
        assert.equal(imagePlaceholder('image/jpeg', 812), '[image image/jpeg 812 B omitted]');
        assert.equal(imagePlaceholder('image/webp', 3 * 1024 * 1024 + 200_000), '[image image/webp 3.2 MB omitted]');
        assert.equal(imagePlaceholder(undefined, undefined), '[image omitted]');
        assert.equal(imagePlaceholder('text/html', 10), '[image 10 B omitted]');
        for (const text of ['[image image/png 412 KB omitted]', '[image omitted]', '[image image/png omitted]', '[image 3.2 MB omitted]']) {
            assert.match(text, IMAGE_PLACEHOLDER_PATTERN);
        }
    });
});

describe('omitInlineImages on a tool result before serialization', () => {
    it('replaces an Anthropic image block in mixed content and leaves the text and the input alone', () => {
        const content = [
            { type: 'text', text: 'Screenshot follows' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
        ];
        const before = structuredClone(content);
        const result = omitInlineImages(content) as typeof content;
        assert.deepEqual(content, before, 'the model-bound value is never mutated');
        assert.deepEqual(result, [
            { type: 'text', text: 'Screenshot follows' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '[image image/png 29 KB omitted]' } },
        ]);
    });

    it('replaces MCP and pi-ai image content and sniffs a missing type', () => {
        const result = omitInlineImages({
            content: [{ type: 'image', data: PNG, mimeType: 'image/png' }, { type: 'image', data: PNG }],
            details: { path: 'shot.png' },
        });
        assert.deepEqual(result, {
            content: [
                { type: 'image', data: '[image image/png 29 KB omitted]', mimeType: 'image/png' },
                { type: 'image', data: '[image image/png 29 KB omitted]' },
            ],
            details: { path: 'shot.png' },
        });
    });

    it('replaces a Kiro byte-array image and keeps its other items', () => {
        const bytes = [...Buffer.from(pngBase64(3000), 'base64')];
        const result = omitInlineImages({ items: [{ Text: 'read 1 image' }, { Image: { format: 'png', source: { kind: 'bytes', data: bytes } } }] });
        assert.deepEqual(result, {
            items: [{ Text: 'read 1 image' }, { Image: { format: 'png', source: { kind: 'bytes', data: '[image image/png 3 KB omitted]' } } }],
        });
    });

    it('replaces data: URLs inside strings', () => {
        const result = omitInlineImages({ html: `<img src="data:image/png;base64,${PNG}"> done` });
        assert.deepEqual(result, { html: '<img src="[image image/png 29 KB omitted]"> done' });
    });

    it('returns values without images unchanged, by reference', () => {
        const value = { items: [{ Text: 'hi' }], data: [1, 2, 3], image: { url: 'https://example.com/a.png' } };
        assert.equal(omitInlineImages(value), value);
        assert.equal(omitInlineImages(null), null);
        assert.equal(omitInlineImages(42), 42);
        // An image block without inline data, or with too little to be one, stays.
        const small = [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }, { type: 'image', data: 'abc' }];
        assert.equal(omitInlineImages(small), small);
    });
});

describe('omitInlineImagesInText on an output string', () => {
    it('keeps valid JSON valid', () => {
        const text = JSON.stringify([{ type: 'text', text: 'one' }, { type: 'image', source: { type: 'base64', data: PNG, media_type: 'image/png' } }]);
        const result = omitInlineImagesInText(text);
        assert.deepEqual(JSON.parse(result), [
            { type: 'text', text: 'one' },
            { type: 'image', source: { type: 'base64', data: '[image image/png 29 KB omitted]', media_type: 'image/png' } },
        ]);
        assert.equal(omitInlineImagesInText(result), result, 'idempotent');
    });

    it('repairs a Claude Read output the 16 KB cap cut inside its image', () => {
        const stored = `[{"type":"image","source":{"type":"base64","data":"${PNG}`.slice(0, 16 * 1024);
        const result = omitInlineImagesInText(stored);
        assert.deepEqual(JSON.parse(result), [{ type: 'image', source: { type: 'base64', data: '[image image/png omitted]' } }]);
    });

    it('repairs a Kiro output cut inside its byte array', () => {
        const bytes = [...Buffer.from(pngBase64(20_000), 'base64')].join(',');
        const stored = `{"items":[{"Image":{"format":"png","source":{"kind":"bytes","data":[${bytes}`.slice(0, 16 * 1024);
        const result = omitInlineImagesInText(stored);
        assert.deepEqual(JSON.parse(result), { items: [{ Image: { format: 'png', source: { kind: 'bytes', data: '[image image/png omitted]' } } }] });
    });

    it('keeps the text of a cut mixed output', () => {
        const stored = `[{"type":"text","text":"Read \\"a.png\\": 1 image"},{"type":"image","source":{"type":"base64","data":"${PNG.slice(0, 5000)}`;
        assert.deepEqual(JSON.parse(omitInlineImagesInText(stored)), [
            { type: 'text', text: 'Read "a.png": 1 image' },
            { type: 'image', source: { type: 'base64', data: '[image image/png omitted]' } },
        ]);
    });

    it('replaces a complete image before a cut that falls in later text', () => {
        const stored = `[{"type":"image","source":{"type":"base64","data":"${PNG}","media_type":"image/png"}},{"type":"text","text":"the rest is cu`;
        assert.equal(omitInlineImagesInText(stored),
            '[{"type":"image","source":{"type":"base64","data":"[image image/png 29 KB omitted]","media_type":"image/png"}},{"type":"text","text":"the rest is cu');
    });

    it('passes through text without inline images unchanged', () => {
        const outputs = [
            '{"ok":true}',
            'plain shell output\nexit 0',
            // Long base64 with no image marker (e.g. a printed archive).
            `${PNG}`,
            // Source code that mentions image blocks.
            "if (block.type === 'image') return { \"type\":\"image\", \"data\": data };",
            "const url = `data:image/png;base64,${buf.toString('base64')}`;",
            `{"note":"\\"type\\":\\"image\\" is escaped here","data":"${PNG.slice(0, 2000)}"}`,
        ];
        for (const output of outputs) assert.equal(omitInlineImagesInText(output), output);
        assert.equal(hasInlineImageMarker('{"ok":true}'), false);
    });

    it('treats a string passed to omitInlineImages as text', () => {
        const stored = `[{"type":"image","source":{"type":"base64","data":"${PNG.slice(0, 3000)}`;
        assert.equal(omitInlineImages(stored), omitInlineImagesInText(stored));
    });
});

describe('truncateToolPayload', () => {
    it('keeps text up to the 16 KB cap and cuts what is longer', () => {
        const atCap = 'a'.repeat(TOOL_PAYLOAD_MAX);
        assert.equal(truncateToolPayload(atCap), atCap);
        assert.equal(truncateToolPayload(`${atCap}b`), atCap);
    });

    it('encodes other values as JSON before the cut', () => {
        assert.equal(truncateToolPayload({ path: 'a.ts' }), '{"path":"a.ts"}');
        assert.equal(truncateToolPayload(['x'.repeat(TOOL_PAYLOAD_MAX)])?.length, TOOL_PAYLOAD_MAX);
        assert.equal(truncateToolPayload(0), '0');
    });

    it('has nothing for null, undefined, empty text or a value JSON cannot encode', () => {
        assert.equal(truncateToolPayload(null), undefined);
        assert.equal(truncateToolPayload(undefined), undefined);
        assert.equal(truncateToolPayload(''), undefined);
        assert.equal(truncateToolPayload(() => 1), undefined);
    });
});

describe('truncateToolPayload on a value JSON cannot encode', () => {
    it('never throws on a cyclic or BigInt value', () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        assert.equal(truncateToolPayload(cyclic), '[object Object]');
        assert.equal(truncateToolPayload(10n), '10');
    });
});
