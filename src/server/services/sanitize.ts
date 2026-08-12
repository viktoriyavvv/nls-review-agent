/**
 * Redact secrets from text before it is stored in a job log / streamed to the
 * GUI. Two layers:
 *  1. exact-match replacement of known secret values (env tokens);
 *  2. pattern-based masking of Authorization / Bearer / Basic headers and
 *     `token=`/`password=` query-ish fragments, in case a value we don't know
 *     shows up (e.g. embedded in a URL or a curl echo).
 */

const REDACTED = '***';

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const HEADER_PATTERNS: RegExp[] = [
  // Authorization: Bearer <token> / Authorization: Basic <b64>
  /\b(authorization\s*[:=]\s*)(bearer|basic)\s+\S+/gi,
  // bare "Bearer <token>" / "Basic <b64>"
  /\b(bearer|basic)\s+[A-Za-z0-9._\-+/=]{8,}/gi,
  // token= / access_token= / password= / api_token= (query or kv style)
  /\b((?:api[_-]?)?(?:access[_-]?)?token|password|pwd|secret)(["']?\s*[:=]\s*["']?)([^\s"'&]+)/gi,
  // https://user:password@host  ->  keep user, drop password
  /(https?:\/\/[^/\s:@]+):([^@\s/]+)@/gi,
];

/** Build a reusable masker that redacts the given secret values + patterns. */
export function createSanitizer(secrets: Array<string | undefined | null>): (text: string) => string {
  const values = secrets
    .map((s) => (s ?? '').trim())
    .filter((s) => s.length >= 4) // ignore trivially short / empty values
    .sort((a, b) => b.length - a.length); // redact longer secrets first
  const valueRes = values.map((v) => new RegExp(escapeRegExp(v), 'g'));

  return (text: string): string => {
    if (!text) return text;
    let out = text;
    for (const re of valueRes) out = out.replace(re, REDACTED);
    out = out.replace(HEADER_PATTERNS[0], `$1$2 ${REDACTED}`);
    out = out.replace(HEADER_PATTERNS[1], `$1 ${REDACTED}`);
    out = out.replace(HEADER_PATTERNS[2], `$1$2${REDACTED}`);
    out = out.replace(HEADER_PATTERNS[3], '$1@'); // drop the embedded password entirely
    return out;
  };
}

/** One-shot convenience wrapper. */
export function maskSecrets(text: string, secrets: Array<string | undefined | null>): string {
  return createSanitizer(secrets)(text);
}
