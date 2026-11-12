import { WINDOW_ID_HEADER } from './structureEvents';

/** Request header naming one operation, so a retried write runs once (lower-case, as Node reads it). */
export const IDEMPOTENCY_KEY_HEADER = 'x-idempotency-key';

/**
 * Michi's own request headers a renderer may send: CORS admits them and the
 * desktop proxy forwards them to a remote backend.
 */
export const MICHI_REQUEST_HEADERS = [WINDOW_ID_HEADER, IDEMPOTENCY_KEY_HEADER] as const;
