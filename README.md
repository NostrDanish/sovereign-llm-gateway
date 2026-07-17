# sovereign-llm-gateway

Local LLM (ollama) behind a Nostr inbox. NIP-17 gift-wrapped DMs trigger inference,
reply is gift-wrapped back. No cloud, no API keys leaked. State on relays.

## Setup
```
ollama pull llama3.2
npm install @nostr-dev-kit/ndk
node gateway.js
```
Set NSEC in env. Gateway listens for kind:1059, runs ollama, replies kind:1059.
