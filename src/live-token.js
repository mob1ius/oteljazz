/**
 * Derivation shared by the Worker (src/index.js) and the mint CLI (scripts/mint_live_token.mjs).
 *
 * THE SPLIT. A live session has two names, and which one you hold decides what you can do:
 *
 *   ingest token   64 lowercase hex, 32 random bytes. Private. Grants WRITE.
 *   session id     32 lowercase hex, derived from the token. Public. Grants READ.
 *
 *   sessionId = HMAC-SHA256(LIVE_RELAY_SECRET, DOMAIN + "\n" + token)  -> first 16 bytes as hex
 *
 * WHY THIS ROUTES, which is the part worth understanding before changing any of it. The Durable
 * Object is named by the PUBLIC session id, so a viewer keeps working with nothing but the id, as
 * it did before. Ingest posts to that same id and presents the token, and the Worker re-derives
 * the id from the presented token and requires it to equal the one in the path.
 *
 * That path equality is the whole proof. It is not a formality and it is not defence in depth:
 *
 *   - Someone who invents a token cannot compute its session id, because that needs the secret.
 *     So they do not know what to put in the path, and a guess is a 128-bit guess.
 *   - Someone who knows a session id cannot find a token for it, because HMAC is one-way.
 *   - So a usable (token, id) pair can only come from something holding the secret.
 *
 * That is why the token needs no signature of its own, which an earlier draft of this added: a
 * token IS self-authenticating, as long as its derived id must appear in the path. If a future
 * change ever stops requiring that equality, the token becomes an unverifiable string and this
 * whole property is gone.
 *
 * WHAT IT DOES NOT DO. Nothing here protects the read direction. A session id is still readable
 * by anyone who has it, which is the point for a published demo and exactly wrong for a private
 * session. Keep private ones unpublished.
 *
 * ISSUANCE IS THE CONSTRAINT. Only the secret holder can mint a pair, so there is deliberately no
 * public mint endpoint: one would hand out valid pairs on request and reopen the write door it
 * exists to close. See local/live-relay-hardening.md.
 */

// Domain separation. The same secret could later sign something else, and an HMAC that is not
// bound to its purpose is reusable in a context it was never meant for. This string is part of
// the derivation: changing it invalidates every pair ever issued.
const DOMAIN = 'oteljazz-live-session-v1';

// A token is checked for shape before it is used as HMAC input. Not for security -- HMAC accepts
// any bytes -- but because a 64-hex token is the only thing this ever mints, so anything else is
// a mistake worth refusing early and cheaply, before a crypto call.
export const TOKEN_RE = /^[0-9a-f]{64}$/;

// Must stay in step with SESSION_ID_RE in src/index.js. 32 hex chars is the width committed in
// v1.12.2; see that file's comment for why it is 32 and not client_key's 16.
const SESSION_ID_HEX_CHARS = 32;

let cachedKey = null;          // { secret, key } -- importKey on every request would be wasteful

async function importKey(secret) {
  if (cachedKey && cachedKey.secret === secret) return cachedKey.key;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  cachedKey = { secret, key };
  return key;
}

/** A fresh ingest token. The caller must treat the return value as a credential. */
export function mintToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The public session id for a token, or null if the token is malformed.
 *
 * Throws when the secret is missing. That is deliberate and it is the opposite of the choice
 * src/crawler-log.js makes, where "no secret configured" is a supported state that degrades to a
 * NULL column. Degrading is right there, because the worst case is a less useful log row. Here
 * the worst case is that ingest stops being authenticated at all, so a missing secret must be
 * loud and must fail closed -- see src/index.js's caller, which turns this into a refusal.
 */
export async function deriveSessionId(secret, token) {
  if (!secret) throw new Error('LIVE_RELAY_SECRET is not configured');
  if (!TOKEN_RE.test(token)) return null;
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${DOMAIN}\n${token}`));
  const bytes = new Uint8Array(sig);
  let hex = '';
  for (let i = 0; i < SESSION_ID_HEX_CHARS / 2; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

/**
 * Constant-time equality for two equal-length hex strings.
 *
 * This comparison must not leak, and the reason is specific rather than ritual: the left side is
 * derived from the secret and the right side is supplied by whoever sent the request. A timing
 * oracle on it would let someone submit a token they chose and recover its session id a character
 * at a time, which is precisely the (token, id) pair they cannot otherwise obtain. Leaking it
 * hands over write access.
 *
 * crypto.subtle.timingSafeEqual is a Cloudflare extension and is absent in Node, where the mint
 * CLI runs, so the fallback is a branchless XOR accumulation over the whole input. Both operands
 * are fixed-width here, so the length check cannot leak anything either.
 */
export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (typeof crypto.subtle.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(ab, bb);
  }
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/**
 * Whether `token` is the write credential for `sessionId`. The only question src/index.js asks.
 *
 * Note what this never does: look the session up. There is no store of issued tokens and nothing
 * to read, so the answer is a pure function of the secret and the two strings. That is what makes
 * it safe to answer honestly with a 401 -- the response says nothing about whether that session
 * exists, has ever existed, or has anyone listening to it.
 */
export async function tokenAuthorizes(secret, token, sessionId) {
  const derived = await deriveSessionId(secret, token);
  if (derived === null) return false;
  return constantTimeEqual(derived, sessionId);
}
