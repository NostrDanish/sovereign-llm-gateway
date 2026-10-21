// sovereign-llm-gateway: NIP-17 DM -> local LLM -> gift-wrapped reply
import { NDK } from '@nostr-dev-kit/ndk';
import { execFile } from 'child_process';

const ndk = new NDK({ explicitRelayUrls: ['wss://relay.damus.io','wss://nos.lol'] });
await ndk.connect();

// --- Access control (audit fix) ---------------------------------------------
// Previously ANY gift wrap executed on the local LLM and auto-published a
// reply. Now a requester must be allowlisted AND under a per-pubkey rate
// limit before anything touches ollama.

// Minimal bech32 decode (BIP-173) so ALLOWED_PUBKEYS accepts npub entries
// without adding a dependency.
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bech32DecodeToHex(bech) {
  const s = bech.toLowerCase();
  if (!/^npub1[02-9ac-hj-np-z]+$/.test(s)) return null;
  const pos = s.lastIndexOf('1');
  const data = [];
  for (let i = pos + 1; i < s.length - 6; i++) {
    const v = BECH32_CHARSET.indexOf(s[i]);
    if (v < 0) return null;
    data.push(v);
  }
  // convert 5-bit words to 8-bit bytes
  let acc = 0, bits = 0; const bytes = [];
  for (const v of data) {
    acc = (acc << 5) | v; bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); }
  }
  if (bytes.length !== 32) return null;
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
}

function normalizePubkey(entry) {
  const e = entry.trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(e)) return e;
  if (e.startsWith('npub1')) return bech32DecodeToHex(e);
  return null;
}

// ALLOWED_PUBKEYS: comma-separated hex pubkeys / npubs. Fail closed: when
// unset, nobody may trigger the LLM.
const ALLOWED = new Set(
  (process.env.ALLOWED_PUBKEYS || '')
    .split(',')
    .map(normalizePubkey)
    .filter(Boolean),
);
if (ALLOWED.size === 0) {
  console.warn('[gw] ALLOWED_PUBKEYS not set — all DM triggers will be rejected');
}

// Simple in-memory per-pubkey rate limit (fixed window).
const RATE_LIMIT_MAX = parseInt(process.env.DM_RATE_LIMIT_MAX || '5', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.DM_RATE_LIMIT_WINDOW_MS || '60000', 10);
const rateHits = new Map(); // pubkey -> { count, resetAt }
function isRateLimited(pubkey) {
  const now = Date.now();
  let e = rateHits.get(pubkey);
  if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS }; rateHits.set(pubkey, e); }
  e.count++;
  if (rateHits.size > 10000) rateHits.clear(); // bound memory under flood
  return e.count > RATE_LIMIT_MAX;
}

ndk.subscribe({ kinds: [1059] }).on('event', async (ev) => {
  const sender = ev.pubkey;
  if (!ALLOWED.has(sender)) {
    console.warn(`[gw] rejected non-allowlisted sender ${sender.slice(0, 12)}…`);
    return;
  }
  if (isRateLimited(sender)) {
    console.warn(`[gw] rate-limited ${sender.slice(0, 12)}… (${RATE_LIMIT_MAX}/${RATE_LIMIT_WINDOW_MS}ms)`);
    return;
  }
  const prompt = ev.content; // decrypted by NDK gift-wrap
  console.log('[gw] prompt:', prompt.slice(0,80));
  execFile('ollama', ['run','llama3.2', prompt], async (e, out) => {
    if (e) return console.error(e);
    const reply = await ndk.giftWrap(ndk.signer, ev.pubkey, out.trim());
    await reply.publish();
    console.log('[gw] replied');
  });
});
console.log('[gw] listening on kind 1059');
