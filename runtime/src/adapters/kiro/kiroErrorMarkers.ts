/**
 * Lowercase substrings that name a kind of Kiro error. kiro-cli collapses its
 * failures into one JSON-RPC error, so its text is all Michi can read. Data
 * only, with no imports: the Crew adapter bundle and the backend read it too.
 */

/** SSO/OIDC tokens that need the user to sign in again. */
export const KIRO_SIGN_IN_MARKERS: readonly string[] = [
    "expiredtokenexception",
    "invalidgrantexception",
    "unauthorizedclientexception",
    "notauthorizedexception",
];

/** Re-authentication needed: the sign-in markers, and a device login not yet finished. */
export const KIRO_AUTH_MARKERS: readonly string[] = [
    ...KIRO_SIGN_IN_MARKERS,
    "authorizationpendingexception",
];

/** Usage caps and capacity. */
export const KIRO_QUOTA_MARKERS: readonly string[] = [
    "monthlyrequestcount",
    "dailyrequestcount",
    "insufficientmodelcapacity",
];

/** Service-side and transient: the connection is fine, a same-session resend clears it. */
export const KIRO_TRANSIENT_MARKERS: readonly string[] = [
    "throttl", // throttled / ThrottlingError
    "modeltemporarilyunavailable",
    "model_temporarily_unavailable",
    "internalserver", // InternalServerError / InternalServerException
    "failed to generate a response",
];

/** The connection or transport is dead and the request never completed. */
export const KIRO_CONNECTION_MARKERS: readonly string[] = [
    "dispatch failure",
    "dispatchfailure",
    "response stream", // "Encountered an error in the response stream: ..."
    "timed out",
    "request has timed out",
    "timeouterror",
    "providertimedout",
    "stalledstream",
    "connection reset",
    "host unreachable",
    "responseerror",
];
