# Contributing

Bug reports, provider additions, and fixes are welcome.

## Setup

```sh
git clone https://github.com/lprsrts/pi-voice && cd pi-voice
npm install              # Pi's packages (peer dependencies), needed by the tests
npm test                 # offline: fake sockets, a fake Pi, a stand-in audio helper
pi remove npm:@lprsrts/pi-voice   # if installed, so /talk is not registered twice
pi -e .                  # run Pi with your checkout
```

Requirements match the package: macOS 14+, Node 24+, Pi, and `swiftc` (`xcode-select --install`).

## Guidelines

- Keep runtime dependencies at zero; Pi provides its own modules (declared as `peerDependencies`).
- `npm test` must not need credentials, network, or audio devices. Live behaviour is covered by `scripts/live/` (real GPT-Live, a real Pi session, scripted speech; see its README); say in the pull request which scenarios you ran.
- Never log or persist API keys, audio, or transcripts.
- The voice is GPT-Live (`live.ts`, defaults in `providers/openai-live/`); the backend is the Pi session, reached through `pi-bridge.ts`. Protocol changes need tests against the fake socket in `tests/`.
- Match the surrounding code style; there is no formatter config.

## Reporting audio problems

Include the output of `/talk check` and, if the agent can't hear you, `/talk mic-test`. Neither reads your API key or sends audio anywhere.
