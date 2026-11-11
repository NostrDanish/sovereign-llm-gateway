# Sovereign LLM Gateway

A local-first gateway for Hermes. The new `local-api.js` exposes an OpenAI-compatible, **local Ollama only** API. It does not call hosted providers and has no paid fallback.

## Local API (recommended starting point)

Requirements: Node.js 20+ and a running Ollama instance.

```bash
ollama pull llama3.2
GATEWAY_HOST=127.0.0.1 OLLAMA_MODEL=llama3.2 npm start
```

- Health: `GET http://127.0.0.1:8787/health`
- Models: `GET http://127.0.0.1:8787/v1/models`
- Chat: `POST http://127.0.0.1:8787/v1/chat/completions`

Hermes/OpenAI-compatible client settings:
- Base URL: `http://127.0.0.1:8787/v1`
- API key: any non-empty placeholder when no `GATEWAY_API_KEY` is configured; otherwise use that exact key.
- Model: `llama3.2` (or `OLLAMA_MODEL`).

For a non-loopback bind, `GATEWAY_API_KEY` is mandatory. Keep this API behind localhost, a private VPN, or an authenticated reverse proxy. The adapter enforces a request-body limit, bounded concurrency, request timeout, and does not log prompts.

Current compatibility boundary: non-streaming chat with text messages. Streaming and tool calling are explicitly rejected rather than falsely advertised. Those features must be implemented and tested before selecting this adapter for Hermes profiles that require them.

## Nostr adapter status

`gateway.js` is the original NIP-17 proof of concept. Do not expose it as a public service. A raw kind-1059 subscription is not sufficient proof that a gift-wrapped event has been safely unwrapped and that the authenticated sender has been validated. The Nostr transport remains separate from the local HTTP inference API and must not be enabled for untrusted users until the unwrap/authentication/replay-protection path is independently tested.

## Tests

```bash
npm test
```
