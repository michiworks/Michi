/**
 * The message and code in a failed response's body, in any shape a Michi route
 * answers with: { error } with an optional code, { ok: false, error },
 * { error: { code, message } } (Pages), { code, message }, and
 * { error: code, message } (Agent Run actions). A desktop and a remote backend
 * can run different versions, so none of these shapes can be dropped.
 */
export function readApiError(body: unknown): { message?: string; code?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const raw = body as Record<string, unknown>;
  const nested = raw.error && typeof raw.error === 'object' ? raw.error as Record<string, unknown> : null;
  const message = nested ? nested.message : typeof raw.message === 'string' ? raw.message : raw.error;
  const code = nested ? nested.code : typeof raw.message === 'string' && raw.code === undefined ? raw.error : raw.code;
  return {
    ...(typeof message === 'string' ? { message } : {}),
    ...(typeof code === 'string' ? { code } : {}),
  };
}
