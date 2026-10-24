# pi-voice

![pi-voice: the voice bar listening, thinking, and speaking](https://raw.githubusercontent.com/lprsrts/pi-voice/main/assets/cover.png)

**Talk to your coding agent.** Full-duplex voice for [Pi](https://pi.dev) on macOS. OpenAI GPT-Live is the voice; your Pi session is its backend. Say what you want and Pi does it with its own model, tools, and local environment, then the voice tells you the outcome.

- **Pi is the brain:** your words go straight to the Pi session in your terminal. It works with whatever model you picked (`/model`), all its tools, and its permission prompts, and every request shows up in the session.
- **GPT-Live is the voice:** realtime, full-duplex speech. Ask what Pi is doing, add to the task, or say "stop" while it works.
- **Use your speakers:** echo cancellation keeps the agent from hearing itself. Headphones are optional.
- **Interrupt any time:** talk over the agent and it stops. Switching audio devices (e.g. AirPods connecting) mid-session just works.

For local speech-to-text into the editor, use the official `@earendil-works/pi-voice` instead. The two install side by side; this package's command is `/talk`.

## Quick start

1. Install:
   ```sh
   pi install npm:@lprsrts/pi-voice
   ```
2. Add your OpenAI API key (see [API key](#api-key)).
3. In Pi:
   ```text
   /talk start
   ```

The first start takes a little longer (up to ~40 s) while the audio helper is built, and macOS asks once for microphone permission.

## Requirements

- macOS 14+, Pi, Node 24+.
- Xcode Command Line Tools (`xcode-select --install`).
- An OpenAI API key with billing (GPT-Live).

## Cost

The package is free (MIT). Two things cost money:

- **The voice:** GPT-Live, $0.05 per minute, billed to your OpenAI API key. A ChatGPT plan does not cover it (OpenAI rejects plan sign-ins for GPT-Live).
- **The work:** whatever your Pi model costs, exactly as when you type. Pi uses your configured provider; no extra model runs in between.

`/talk mute` keeps the session open (and billable); `/talk stop` ends it.

## How it works

When GPT-Live decides your request needs real work, it hands it off, and pi-voice sends what you said to Pi as a message. While Pi works, its progress reaches the voice silently, so "what's Pi doing?" gets an answer without interrupting it. Saying something else adds to the running task, and "stop" or "cancel" stops it. When Pi finishes, the voice says the result. The voice and Pi are one agent: it talks about the work as its own ("I'm running the tests"), and each `/talk start` picks up where the session is (recent requests and answers, and any task still running, whose result it will announce), so you can stop and restart voice mid-task. While a voice session runs, Pi is told that its answers are spoken, so it ends with a short, speakable summary.

## Commands

| Command | What it does |
|---|---|
| `/talk start` | Start a voice session with this Pi session as the backend. |
| `/talk stop` | End the session. A Pi task it started keeps running. |
| `/talk mute` / `/talk unmute` | Stop or resume the microphone. |
| `/talk captions [on\|off]` | Show what the agent is saying, phrase by phrase, timed to the audio the speaker actually plays. Off by default; no argument toggles. |
| `/talk check` | Show setup status: audio helper, devices, API key, Pi's backend model, settings. No network or microphone use. |
| `/talk devices` | Show the input and output in use (the macOS defaults). |
| `/talk tone [hz]` | Play a test tone. |
| `/talk mic-test [seconds]` | Record a short clip, report its level, and play it back. Nothing leaves your Mac. |
| `/talk-preview [listening\|thinking\|speaking\|…\|off]` | Preview the voice bar without a session. |

## API key

Set `OPENAI_API_KEY`, or store the key in your login keychain as `openai-api-key` (the environment variable wins if both exist). OpenAI keys are too long for the `security` prompt, so copy the key, then run:

```sh
security add-generic-password -U -s "openai-api-key" -a "$USER" -l "OpenAI API key" -w "$(pbpaste)" && pbcopy </dev/null
```

Keys are read only when a session starts and are never logged. Audio and transcripts are not stored.

## Settings

| Environment variable | Effect |
|---|---|
| `PI_VOICE_CAPTIONS=1` | Start with captions on. |
| `PI_VOICE_AEC=0` | Turn off echo cancellation (headphones only, or the agent hears itself). |
| `PI_VOICE_CONFIG_DIR` | Where your overrides live (see below). |

## Voice and persona

The backend model is Pi's: switch it with `/model` as usual. For the voice, put files in `~/.pi/agent/pi-voice/openai-live/` (under `$PI_CODING_AGENT_DIR` if you set it, or `$PI_VOICE_CONFIG_DIR/openai-live/`). `/talk check` shows the directory.

- `session.json`: only the top-level keys you set change. To pick a voice, use `{ "voice": "<built-in voice name>" }`, or a custom voice: `{ "voice": { "id": "voice_…", "description": "<its design prompt>" } }`.
- `instructions.md`: replaces the voice persona and its rules for handing work to Pi.

The defaults are in [`providers/openai-live/`](providers/openai-live).

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
