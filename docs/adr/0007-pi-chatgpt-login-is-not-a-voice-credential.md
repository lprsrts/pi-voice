# Pi's ChatGPT login is not a voice credential

Pi's newer OpenAI login, Sign in with ChatGPT (an OAuth choice under `/login openai`, next to an API key), looked like a way to use voice without an API key. It is not. Probed on 2026-11-03 with a fresh token from that login, and checked against an API key on the same requests:

- GPT-Live (`wss://api.openai.com/v1/live/sessions`) refuses the WebSocket upgrade: 401 `rejected_by_access_enforcement`, code `no_matching_rule`. The API key upgrades.
- The Realtime API (`/v1/realtime`, `gpt-realtime`, `gpt-realtime-2`, `gpt-realtime-mini`) takes the connection, but every response ends `failed` with `server_error` and no audio. The API key gets audio.
- The Responses API takes it only for Codex models ("not supported when using Codex with a ChatGPT account"), and Pi's own provider notes that these tokens only reach the Responses API.

So pi-voice keeps the API key (env, then keychain) as its only credential and never sends the ChatGPT token anywhere. When the key is missing and Pi has that login, the error and `/talk check` say why it is not used, read through `modelRegistry.isUsingOAuth` without touching the token.

## Consequences

The older Codex login (`/login openai-codex`, which Pi labels legacy) reportedly reaches ChatGPT's private Codex voice service, over WebRTC per the Codex CLI source ([iter2 notes](../rnd/2026-10-27-iter2.md)) and as `@nothumanwork/pi-voice` does; this was not probed here. That is a different, undocumented provider, not a credential for GPT-Live; if pi-voice adds it, it comes as a separate, opt-in alpha provider (and, per ADR-0005, is the second implementation the provider contract waits for). Re-run the probe if OpenAI opens GPT-Live to ChatGPT tokens.
