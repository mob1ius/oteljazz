#!/usr/bin/env node
/**
 * Mints one live-session credential pair: a private ingest token and the public session id
 * derived from it. Run from the repo root:
 *
 *   node scripts/mint_live_token.mjs
 *   node scripts/mint_live_token.mjs --origin http://localhost:8787
 *
 * The derivation lives in src/live-token.js and is imported, not reimplemented -- the Worker
 * verifies with the same code this mints with, so the two cannot drift. A second copy of the
 * HMAC here would be a slow, silent way to start issuing pairs the relay rejects.
 *
 * NEEDS THE SECRET, which is the design and not an inconvenience: if anyone could derive a
 * session id from a token they invented, the token would not be a credential. The secret is read
 * from LIVE_RELAY_SECRET in the environment, or from .dev.vars (gitignored) if that is absent.
 * It is never printed.
 *
 * There is deliberately no endpoint that does this. A public mint endpoint would hand out valid
 * pairs to anyone who asked, which reopens the unbounded-write path the token exists to close.
 * See local/live-relay-hardening.md.
 */

import { readFileSync } from 'node:fs';
import { mintToken, deriveSessionId } from '../src/live-token.js';

function readSecret() {
  if (process.env.LIVE_RELAY_SECRET) return process.env.LIVE_RELAY_SECRET.trim();
  try {
    for (const line of readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').split('\n')) {
      const m = line.match(/^\s*LIVE_RELAY_SECRET\s*=\s*"?([^"\n]+)"?\s*$/);
      if (m) return m[1].trim();
    }
  } catch { /* no .dev.vars; fall through to the error below */ }
  return null;
}

const args = process.argv.slice(2);
const originIdx = args.indexOf('--origin');
const origin = originIdx >= 0 ? args[originIdx + 1] : 'https://oteljazz.com';

const secret = readSecret();
if (!secret) {
  console.error('LIVE_RELAY_SECRET is not set.\n');
  console.error('Set it in the environment, or put it in .dev.vars (gitignored) as:');
  console.error('  LIVE_RELAY_SECRET="<the same value deployed with `wrangler secret put`>"\n');
  console.error('The deployed secret is write-only -- Cloudflare will not read it back -- so the');
  console.error('local copy is the only way to mint. Losing both means rotating the secret, which');
  console.error('invalidates every pair ever issued.');
  process.exit(1);
}

const token = mintToken();
const session = await deriveSessionId(secret, token);
const wsOrigin = origin.replace(/^http/, 'ws');

process.stdout.write(`
  ingest token   ${token}
                 PRIVATE. Grants write. Treat it like a password: it is one.

  session id     ${session}
                 Public. Grants read. Safe to share with anyone who should listen.

  Export to it (the token goes in a header, never in the URL):

    python3 engine/live_producer.py --trace synthetic --speed 4 \\
      --endpoint ${origin}/live/${session}/v1/traces \\
      --token ${token}

  Or from any OTLP/HTTP exporter:

    endpoint  ${origin}/live/${session}/v1/traces
    header    Authorization: Bearer ${token}
    encoding  application/x-protobuf

  Listen to it:

    ${origin}/?live=${session}
    ${wsOrigin}/live/${session}/ws

`);
