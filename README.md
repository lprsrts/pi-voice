# pi-voice

![pi-voice: the voice bar listening, thinking, and speaking](https://raw.githubusercontent.com/lprsrts/pi-voice/main/assets/cover.png)

**Talk to your coding agent.** Full-duplex voice for [Pi](https://pi.dev) on macOS. Say what you want; a realtime voice model hands the work to the Pi session in your terminal and tells you the outcome when it's done.

- **Not dictation:** a conversation. The voice model starts, steers, checks on, and cancels Pi tasks for you. Every request shows up in the Pi session, and Pi's permission prompts work as usual.
- **Use your speakers:** echo cancellation keeps the agent from hearing itself. Headphones are optional.
- **Interrupt any time:** talk over the agent and it stops. Switching audio devices (e.g. AirPods connecting) mid-session just works.
- **Two providers:** ElevenLabs Eleven Realtime or OpenAI GPT-Live.

For local speech-to-text into the editor, use the official `@earendil-works/pi-voice` instead. The two install side by side; this package's command is `/talk`.

## Quick start

1. Install:
   ```sh
   pi install npm:@lprsrts/pi-voice
   ```
2. Add an API key for one provider (see [API keys](#api-keys)).
3. In Pi:
   ```text
   /talk start
   ```

The first start takes a little longer (up to ~40 s) while the audio helper is built, and macOS asks once for microphone permission.

## Requirements

- macOS 14+, Pi, Node 24+.
- Xcode Command Line Tools (`xcode-select --install`).
- An ElevenLabs or OpenAI API key.

## Cost

The package is free (MIT). Voice sessions are billed by the provider to your API key:

- **ElevenLabs:** Eleven Realtime per-minute pricing plus tokens, on your ElevenLabs plan.
- **OpenAI GPT-Live:** $0.05 per minute plus model tokens. Needs API billing; a ChatGPT plan does not cover it.

ElevenLabs sessions end after 60 minutes. `/talk mute` keeps the session open (and billable); `/talk stop` ends it.

## Commands

| Command | What it does |
|---|---|
| `/talk start [elevenlabs\|openai-live]` | Start a voice session (default: ElevenLabs). |
| `/talk stop` | End the session. A Pi task it started keeps running. |
| `/talk mute` / `/talk unmute` | Stop or resume the microphone. |
| `/talk captions [on\|off]` | Show what the agent is saying, phrase by phrase, timed to the audio the speaker actually plays. Off by default; no argument toggles. |
| `/talk check` | Show setup status: audio helper, devices, API keys, settings. No network or microphone use. |
| `/talk devices` | Show the input and output in use (the macOS defaults). |
| `/talk tone [hz]` | Play a test tone. |
| `/talk mic-test [seconds]` | Record a short clip, report its level, and play it back. Nothing leaves your Mac. |
| `/talk-preview [listening\|thinking\|speaking\|…\|off]` | Preview the voice bar without a session. |

## API keys

Set an environment variable, or store the key in your login keychain (the environment variable wins if both exist):

| Provider | Environment variable | Keychain service |
|---|---|---|
| ElevenLabs | `ELEVENLABS_API_KEY` | `elevenlabs-api-key` |
| OpenAI GPT-Live | `OPENAI_API_KEY` | `openai-api-key` |

```sh
security add-generic-password -U -s "elevenlabs-api-key" -a "$USER" -l "ElevenLabs API key" -w
# OpenAI keys are too long for that prompt: copy the key, then
security add-generic-password -U -s "openai-api-key" -a "$USER" -l "OpenAI API key" -w "$(pbpaste)" && pbcopy </dev/null
```

Keys are read only when a session starts and are never logged. Audio and transcripts are not stored.

## Settings

| Environment variable | Effect |
|---|---|
| `PI_VOICE_PROVIDER` | Provider for `/talk start` without an argument (`elevenlabs` or `openai-live`). |
| `PI_VOICE_CAPTIONS=1` | Start with captions on. |
| `PI_VOICE_AEC=0` | Turn off echo cancellation (headphones only, or the agent hears itself). |
| `PI_VOICE_CONFIG_DIR` | Where your overrides live (see below). |

## Voice and persona

Override a provider's defaults by putting files in `~/.pi/agent/pi-voice/<provider>/` (under `$PI_CODING_AGENT_DIR` if you set it, or `$PI_VOICE_CONFIG_DIR/<provider>/`). `/talk check` shows the directory.

- `session.json`: only the top-level keys you set change. To pick a voice:
  - ElevenLabs: `{ "voice": "<voice id>" }`
  - GPT-Live: `{ "voice": "<built-in voice name>" }`, or a custom voice: `{ "voice": { "id": "voice_…", "description": "<its design prompt>" } }`
  - ElevenLabs turn-taking: set `eagerness` to `"low"` if the agent cuts in too early, `"high"` if it waits too long. Keep the other fields, since the whole `turn_detection` object is replaced:
    ```json
    { "turn_detection": { "type": "semantic_vad", "eagerness": "low", "create_response": true, "interrupt_response": true } }
    ```
- `instructions.md`: replaces the voice persona.
- `backend.md` (GPT-Live only): replaces the prompt of the model that talks to Pi.

The defaults are in [`providers/`](providers).

## Troubleshooting

- **The agent hears itself and loops:** make sure `PI_VOICE_AEC` isn't `0` (`/talk check`).
- **No sound:** run `/talk tone` and check the output in Sound settings.
- **The agent never hears you:** run `/talk mic-test`. Below about -40 dBFS means the wrong input device or no microphone permission. Another app holding the mic (e.g. a call) can also block it.
- **Bluetooth sounds bad:** using AirPods as the microphone lowers their audio quality. Use the Mac's microphone for input and AirPods for output.

## Development

```sh
git clone https://github.com/lprsrts/pi-voice && cd pi-voice
npm test
pi -e .   # run Pi with your checkout (pi remove the npm package first)
```

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

MIT
