# Contributing

Bug reports, provider additions, and fixes are welcome.

## Setup

```sh
git clone https://github.com/lprsrts/pi-voice && cd pi-voice
npm test                 # offline: fake sockets, a fake Pi, a stand-in audio helper
pi remove npm:@lprsrts/pi-voice   # if installed, so /talk is not registered twice
pi -e .                  # run Pi with your checkout
```

Requirements match the package: macOS 14+, Node 24+, Pi, and `swiftc` (`xcode-select --install`).

## Guidelines

- Keep runtime dependencies at zero; Pi provides its own modules (declared as `peerDependencies`).
- Tests must not need credentials, network, or audio devices. Live behaviour (a real session, the Swift helper) is checked by hand; say in the pull request what you tried.
- Never log or persist API keys, audio, or transcripts.
- Provider defaults live in `providers/<name>/`. A new provider needs a session class (see `realtime.ts`, `live.ts`), an entry in `providers.ts`, and tests against a fake socket.
- Match the surrounding code style; there is no formatter config.

## Reporting audio problems

Include the output of `/talk check` and, if the agent can't hear you, `/talk mic-test`. Neither reads your API key or sends audio anywhere.
