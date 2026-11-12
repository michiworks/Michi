import { KIRO_SIGN_IN_MARKERS } from './kiroErrorMarkers';

/** Never includes CLI output or credential material. */
export class KiroSignedOutError extends Error {
  /** `message`: a launch-override agent's own explanation, with how to sign in. */
  constructor(message = 'Kiro is not signed in. Run kiro-cli login, then try again. Background starts are paused until sign-in changes.') {
    super(message);
    this.name = 'KiroSignedOutError';
  }
}

const SIGN_IN_PATTERN = new RegExp(['not (?:logged|signed) in', 'please log in', 'kiro(?: cli)? setup or sign-in is required',
  ...KIRO_SIGN_IN_MARKERS].join('|'), 'i');

export function isKiroSignInError(value: unknown): boolean {
  const text = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  return SIGN_IN_PATTERN.test(text);
}
