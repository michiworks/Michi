import { describe, expect, it } from 'vitest';
import { HttpResponseError, responseError } from './httpError';

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('responseError', () => {
  it('keeps the status, message and code of every error body shape', async () => {
    const cases: Array<[unknown, string, string | undefined]> = [
      [{ error: 'workspace not found' }, 'workspace not found', undefined],
      [{ code: 'turn_active', error: 'Session is busy' }, 'Session is busy', 'turn_active'],
      [{ error: { code: 'invalid', message: 'Invalid request body' } }, 'Invalid request body', 'invalid'],
      [{ ok: false, error: 'Invalid expectedRuntime' }, 'Invalid expectedRuntime', undefined],
      [{ code: 'internal_error', message: 'Could not read conversation updates' }, 'Could not read conversation updates', 'internal_error'],
      [{ error: 'conflict', message: 'operation op was reused with a different payload' }, 'operation op was reused with a different payload', 'conflict'],
    ];
    for (const [body, message, code] of cases) {
      const error = await responseError(reply(409, body), 'readThing');
      expect(error).toBeInstanceOf(HttpResponseError);
      expect({ status: error.status, message: error.message, code: error.code }).toEqual({ status: 409, message, code });
    }
  });

  it('names the operation and status when the body has no message', async () => {
    const error = await responseError(new Response('Bad Gateway', { status: 502 }), 'readThing');
    expect({ status: error.status, message: error.message, code: error.code })
      .toEqual({ status: 502, message: 'readThing failed: 502', code: undefined });
  });
});
