import { describe, expect, it } from 'vitest';
import { markBackendConnectionReady } from '../../config/backendConnectionState';
import { backendEntityId } from '../../config/backendIdentity';
import { backendStreamResponse } from './backendRequest';
import { readSseStream } from './sseParser';

function body(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body!;
}

async function frames(stream: ReadableStream<Uint8Array>): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  await readSseStream(stream.getReader(), (event, data) => { out.push([event, data]); });
  return out;
}

describe('SSE frames', () => {
  it('joins a frame\'s data lines with a newline, as the spec says', async () => {
    expect(await frames(body('event: note\ndata: a\ndata:  b\n\n'))).toEqual([['note', 'a\n b']]);
  });

  it('reads remote frames the same after the connection scope rewrites them', async () => {
    const connectionId = 'remote-sse';
    markBackendConnectionReady(connectionId);
    const raw = [
      ': keepalive\n\n',
      `event: node\ndata: ${JSON.stringify({ nodeId: 'n1' })}\n\n`,
      'event: text\ndata: {"text":\ndata: "a"}\n\n',
      'event: plain\ndata: a\ndata: b\n\n',
    ].join('');
    const scoped = backendStreamResponse(new Response(body(raw)), connectionId);
    expect(await frames(scoped.body!)).toEqual([
      ['node', JSON.stringify({ nodeId: backendEntityId(connectionId, 'n1') })],
      ['text', JSON.stringify({ text: 'a' })],
      ['plain', 'a\nb'],
    ]);
    const passed = await backendStreamResponse(new Response(body(raw)), connectionId).text();
    expect(passed.startsWith(': keepalive\n\n')).toBe(true);
  });
});
