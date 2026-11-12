/**
 * The one hard block Michi Memory keeps on what it stores: credentials in a
 * format that cannot be anything else. API keys and tokens with a vendor
 * prefix, private keys, JSON web tokens, card numbers that pass the Luhn
 * check, and Chinese resident id numbers whose check digit is right. Recall
 * shows past conversations elsewhere without them (withoutCredentials). Every
 * other judgement (a password said in words, a PIN, an account number, a
 * sensitive category) is the model's, from the memory tools' and the
 * extraction policy's instructions; nothing here reads intent.
 */

const CREDENTIAL_FORMATS: readonly RegExp[] = [
  // OpenAI/Anthropic-style, AWS access key ids, GitHub, Slack and Google API keys.
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/u,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/u,
  /\bAIza[0-9A-Za-z_-]{30,}/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  // A JSON web token: base64url header and payload, both JSON objects.
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./u,
];

/** A card number written as 13-19 digits, in groups or not. */
const CARD_NUMBER = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/gu;
/** A Chinese resident id number: 17 digits and a check character. */
const CN_RESIDENT_ID = /(?<![\dA-Za-z])\d{17}[\dXx](?![\dA-Za-z])/gu;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK = '10X98765432';

/** ISO 7064 MOD 11-2, as GB 11643 defines the resident id's last character. */
function residentIdChecks(id: string): boolean {
  const sum = ID_WEIGHTS.reduce((total, weight, index) => total + weight * Number(id[index]), 0);
  return ID_CHECK[sum % 11] === id[17].toUpperCase();
}

/** Whether the text holds a credential in one of the formats above; Michi stores none, even when asked. */
export function containsCredential(text: string): boolean {
  if (typeof text !== 'string' || !text) return false;
  const folded = text.normalize('NFKC');
  if (CREDENTIAL_FORMATS.some((pattern) => pattern.test(folded))) return true;
  for (const match of folded.matchAll(CARD_NUMBER)) {
    const digits = match[0].replace(/\D/gu, '');
    // A grouped number of a phone's or a date's length is not a card; 13-19 digits that pass Luhn are.
    if (digits.length >= 13 && digits.length <= 19 && /^[3-6]/u.test(digits) && luhn(digits)) return true;
  }
  for (const match of folded.matchAll(CN_RESIDENT_ID)) {
    if (residentIdChecks(match[0])) return true;
  }
  return false;
}

/** CREDENTIAL_FORMATS as spans to cut out: a private key to its END line, a JSON web token with its signature. */
const CREDENTIAL_SPANS: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/gu,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/gu,
  /\bAIza[0-9A-Za-z_-]{30,}/gu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/gu,
];

const CREDENTIAL_REMOVED = '[credential removed]';

/**
 * The text with every credential containsCredential finds cut out: what the
 * user typed in one conversation that recall shows in another (a memory
 * pack's excerpts, memory_search results) never carries one.
 */
export function withoutCredentials(text: string): string {
  if (typeof text !== 'string' || !containsCredential(text)) return text;
  let out = text.normalize('NFKC');
  for (const pattern of CREDENTIAL_SPANS) out = out.replace(pattern, CREDENTIAL_REMOVED);
  out = out.replace(CARD_NUMBER, (match) => {
    const digits = match.replace(/\D/gu, '');
    return digits.length >= 13 && digits.length <= 19 && /^[3-6]/u.test(digits) && luhn(digits) ? CREDENTIAL_REMOVED : match;
  });
  return out.replace(CN_RESIDENT_ID, (match) => (residentIdChecks(match) ? CREDENTIAL_REMOVED : match));
}
