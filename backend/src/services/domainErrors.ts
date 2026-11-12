export type DomainErrorKind = 'invalid_argument' | 'not_found' | 'conflict';

/** Where in the request the error arose (e.g. a batch's failing command); safe to return to its caller. */
export type DomainErrorDetails = Readonly<Record<string, string | number>>;

/** Stable classification travels separately from user-facing wording. */
export class DomainError extends Error {
  readonly name = 'DomainError';

  constructor(readonly kind: DomainErrorKind, readonly code: string, message: string, readonly details?: DomainErrorDetails) {
    super(message);
  }
}

export interface SerializedDomainError {
  kind: DomainErrorKind;
  code: string;
}

export function serializeDomainError(error: unknown): SerializedDomainError | undefined {
  return error instanceof DomainError ? { kind: error.kind, code: error.code } : undefined;
}
