import { WINDOW_ID_HEADER } from 'michi-shared';
import { backendRequestUrl, connectionIdFromApiUrl, mapBackendPayload } from '../../config/backendIdentity';
import {
  backendConnectionGeneration, backendConnectionProvisional, backendConnectionUnavailable, whenBackendConnectionConfirmed,
} from '../../config/backendConnectionState';
import { ORIGIN_WINDOW_ID } from '../../config/windowIdentity';
import { confirmBackendConnectionUnavailable } from './backendReachability';
import { parseSseBlock } from './sseParser';
import { LOCAL_BACKEND_CONNECTION_ID } from '../../config/backendConnections';

export function backendRequestOptions(url: string, options: RequestInit = {}): RequestInit {
  if (typeof options.body !== 'string') return options;
  const connectionId = connectionIdFromApiUrl(url);
  // Only JSON API bodies carry entity references. Binary uploads stay opaque.
  let body: unknown;
  try { body = JSON.parse(options.body); } catch { return options; }
  return { ...options, body: JSON.stringify(mapBackendPayload(body, connectionId, 'server')) };
}

/**
 * Writes name this window, so the structure changes they make come back on
 * the background feed tagged as its own (workspace_structure_changed).
 * Plain-object headers stay plain objects.
 */
function withWindowIdentity(options: RequestInit | undefined): RequestInit | undefined {
  const method = options?.method?.toUpperCase();
  if (!ORIGIN_WINDOW_ID || !method || method === 'GET' || method === 'HEAD') return options;
  const windowId = ORIGIN_WINDOW_ID;
  const headers = options?.headers;
  if (headers instanceof Headers) {
    const next = new Headers(headers);
    if (!next.has(WINDOW_ID_HEADER)) next.set(WINDOW_ID_HEADER, windowId);
    return { ...options, headers: next };
  }
  if (Array.isArray(headers)) {
    if (headers.some(([name]) => name.toLowerCase() === WINDOW_ID_HEADER)) return options;
    return { ...options, headers: [...headers, [WINDOW_ID_HEADER, windowId]] };
  }
  if (headers && Object.keys(headers).some((name) => name.toLowerCase() === WINDOW_ID_HEADER)) return options;
  return { ...options, headers: { ...headers, [WINDOW_ID_HEADER]: windowId } };
}

/**
 * Before a write: one to a remote still shown from the local cache waits
 * (bounded) for its own data, and none goes to an unavailable remote.
 */
export async function beforeBackendWrite(connectionId: string, signal?: AbortSignal | null): Promise<void> {
  if (backendConnectionProvisional(connectionId)) await whenBackendConnectionConfirmed(connectionId, undefined, signal);
  if (backendConnectionUnavailable(connectionId)) throw new Error('Remote connection is unavailable');
}

/**
 * The connection captured in the request also owns every returned reference.
 * `windowIdentity: false` leaves a request untagged (streams: they write no structure).
 * `mapPayload: false` leaves JSON bodies and responses as written, for DTOs
 * with opaque ids the generic transform would misread (by field name, e.g. every
 * `nodes[].id`): the caller maps their references itself. URLs are still mapped.
 */
export async function backendFetch(url: string, options?: RequestInit,
  request: { windowIdentity?: boolean; mapPayload?: boolean } = {}): Promise<Response> {
  const connectionId = connectionIdFromApiUrl(url);
  // Awaited only when it has something to do, so a write to a ready
  // connection reaches fetch synchronously (a cancel is sent before cancel() returns).
  if (options?.method && !['GET', 'HEAD'].includes(options.method.toUpperCase())
    && (backendConnectionProvisional(connectionId) || backendConnectionUnavailable(connectionId))) {
    await beforeBackendWrite(connectionId, options.signal);
  }
  const generation = backendConnectionGeneration(connectionId);
  const init = request.windowIdentity === false ? options : withWindowIdentity(options);
  let response: Response;
  const mapPayload = request.mapPayload !== false;
  try { response = await globalThis.fetch(backendRequestUrl(url), mapPayload ? backendRequestOptions(url, init) : init); }
  catch (error) {
    if (error instanceof TypeError) await confirmBackendConnectionUnavailable(connectionId, options?.signal, generation);
    throw error;
  }
  if ([502, 503, 504].includes(response.status)) await confirmBackendConnectionUnavailable(connectionId, options?.signal, generation);
  if (connectionId === LOCAL_BACKEND_CONNECTION_ID) return response;
  const json = response.json.bind(response);
  Object.defineProperty(response, 'json', {
    value: async () => {
      let body: unknown;
      try { body = await json(); }
      catch (error) {
        if (error instanceof TypeError) await confirmBackendConnectionUnavailable(connectionId, options?.signal, generation);
        throw error;
      }
      if (response.ok && generation !== backendConnectionGeneration(connectionId)) {
        throw new DOMException('Remote connection changed while reading data', 'AbortError');
      }
      return mapPayload ? mapBackendPayload(body, connectionId, 'renderer') : body;
    },
  });
  return response;
}

/** Keep streamed references in the same connection scope as ordinary JSON (unless `mapPayload` is false, as for backendFetch). */
export function backendStreamResponse(response: Response, connectionId: string,
  generation = backendConnectionGeneration(connectionId), signal?: AbortSignal | null, mapPayload = true): Response {
  if (connectionId === LOCAL_BACKEND_CONNECTION_ID || !response.ok || !response.body) return response;
  const reader = response.body.getReader();
  const source = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close(); else controller.enqueue(value);
      } catch (error) {
        await confirmBackendConnectionUnavailable(connectionId, signal, generation);
        controller.error(error);
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';
  const stream = source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (generation !== backendConnectionGeneration(connectionId)) {
        throw new DOMException('Remote connection changed while streaming', 'AbortError');
      }
      if (!mapPayload) { controller.enqueue(chunk); return; }
      pending += decoder.decode(chunk, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const { data, otherLines } = parseSseBlock(frame);
        let mapped = frame;
        if (data) {
          let parsed: unknown;
          try { parsed = JSON.parse(data); } catch { controller.enqueue(encoder.encode(frame + '\n\n')); continue; }
          mapped = otherLines.join('\n') + '\ndata: ' + JSON.stringify(mapBackendPayload(parsed, connectionId, 'renderer'));
        }
        controller.enqueue(encoder.encode(mapped + '\n\n'));
      }
    },
    flush(controller) { if (pending) controller.enqueue(encoder.encode(pending + decoder.decode())); },
  }));
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}
