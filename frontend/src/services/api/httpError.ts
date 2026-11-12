import { readApiError } from 'michi-shared';

/** Preserve the response status so background callers can distinguish invalid
 * configuration from a Backend that is still starting. */
export class HttpResponseError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = 'HttpResponseError';
  }
}

export async function responseError(response: Response, operation: string): Promise<HttpResponseError> {
  const { message, code } = readApiError(await response.json().catch(() => null));
  return new HttpResponseError(message ?? `${operation} failed: ${response.status}`, response.status, code);
}

/** The response's JSON body (null when unreadable); its error message (or the status) as an HttpResponseError when not ok. */
export async function jsonResponse(response: Response, operation: string): Promise<unknown> {
  if (!response.ok) throw await responseError(response, operation);
  return response.json().catch(() => null);
}

export function shouldRetryRequest(error: unknown): boolean {
  if (error instanceof HttpResponseError) {
    return error.status >= 500 || [408, 425, 429].includes(error.status);
  }
  // Network failures have no HTTP response and may recover during cold start.
  return true;
}

export function requestRetryDelay(failedAttempts: number): number {
  return Math.min(500 * 2 ** (failedAttempts - 1), 5_000);
}
