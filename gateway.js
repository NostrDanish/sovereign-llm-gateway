// sovereign-llm-gateway: NIP-17 DM -> local LLM -> gift-wrapped reply
import { NDK } from '@nostr-dev-kit/ndk';
import { execFile } from 'child_process';

const ndk = new NDK({ explicitRelayUrls: ['wss://relay.damus.io','wss://nos.lol'] });
await ndk.connect();

ndk.subscribe({ kinds: [1059] }).on('event', async (ev) => {
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
