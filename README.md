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
3. In Pi, type `/talk` (or press <kbd>Alt</kbd>+<kbd>V</kbd>). The same again stops it.

The first start takes a little longer (up to ~40 s) while the audio helper is built, and macOS asks once for microphone permission.

## Requirements

- macOS 14+, Pi, Node 24+.
- Xcode Command Line Tools (`xcode-select --install`).
- An OpenAI API key with billing (GPT-Live).

## Cost

The package is free (MIT). Two things cost money:

- **The voice:** GPT-Live, $0.05 per minute, billed to your OpenAI API key. A ChatGPT plan does not cover it (OpenAI rejects plan sign-ins for GPT-Live).
- **The work:** whatever your Pi model costs, exactly as when you type. Pi uses your configured provider; no extra model runs in between.

GPT-Live bills per second while a voice connection is open, whether anyone speaks or not. To avoid paying for silence, voice **pauses by itself**: after 15 s of silence while Pi works (it comes back to say the result), or 60 s of silence when nothing is running (`/talk start` resumes); both are [settings](#settings). `/talk mute` keeps the connection open (and billable); `/talk stop` ends it. A result that arrives while voice is off is said at the next `/talk start`.

## How it works

When GPT-Live decides your request needs real work, it hands it off, and pi-voice sends what you said to Pi as a message. While Pi works, its progress reaches the voice silently, so "what's Pi doing?" gets an answer without interrupting it. Saying something else adds to the running task, and "stop" or "cancel" stops it. When Pi finishes, the voice says the result. The voice and Pi are one agent: it talks about the work as its own ("I'm running the tests"), and each `/talk start` picks up where the session is (recent requests and answers, and any task still running, whose result it will announce), so you can stop and restart voice mid-task. While a voice session runs, Pi is told that its answers are spoken, so it ends with a short, speakable summary.

While voice runs, a bar sits above the input; you can keep typing. What you say to the voice and what it says back play in the chat as they are said, flipping in like a split-flap board, and look like the rest of the conversation: your words like a typed message, as they are recognized, and its replies like Pi's, in step with the audio.

When a turn is over, it settles in place and becomes part of Pi's conversation: Pi's model sees it as context (never as a request), so it knows what you and the voice discussed. A reply you talked over keeps only the part you heard, ending in "…". A request handed to Pi shows once, as what you said, in Pi's own message; it carries only what Pi's conversation lacks (what was said while Pi worked). What is said while Pi works (the voice's progress remarks, acknowledgements, status questions) is not shown or kept, since Pi's own messages cover it.

When Pi finishes a voice request, the voice reads the answer out, and the read-out takes the place of Pi's written answer in the chat, playing in as it is said. Pi's written answer sits above it, collapsed like a thinking block: click *Written answer* (or press <kbd>Ctrl</kbd>+<kbd>O</kbd>) to open it, and click again to close it. Answers that only work on screen (code blocks, lists, tables, headings, or more than a few sentences) stay as Pi's text. Until the read-out starts, or if it never does (voice stopped before the result was said), Pi's text shows in its place. Pi's model always keeps its own answer; the read-out is shown, not added to the conversation. Everything kept is saved in the Pi session, so it comes back when you resume.

## Commands

| Command | What it does |
|---|---|
| `/talk` | Start voice, or stop it if it is running. |
| `/talk start` | Start a voice session with this Pi session as the backend, or resume it after a pause. |
| `/talk stop` | End the voice connection. A Pi task keeps running; its result is said at the next `/talk start`. |
| `/talk mute [on\|off]` | Stop or resume the microphone; no argument toggles. `/talk unmute` also resumes it. |
| `/talk check` | Show setup status: audio helper, devices, API key, Pi's backend model, settings, shortcuts. No network or microphone use. |
| `/talk devices` | Show the input and output in use (the macOS defaults). |
| `/talk tone [20-20000]` | Play a test tone (440 Hz by default). |
| `/talk mic-test [1-10]` | Record a short clip (3 s by default), report its level, and play it back. Nothing leaves your Mac. |
| `/talk preview [state\|off]` | Preview the voice bar without a session: `cycle` (default), `idle`, `listening`, `thinking`, `speaking`, `error`. |
| `/talk help` | List the commands and shortcuts. |

<kbd>Tab</kbd> completes subcommands and their values. While voice is in use, Pi's footer shows `voice on`, `voice muted`, or `voice paused`, and how many results are waiting to be said.

### Shortcuts

| Action | Default | Does |
|---|---|---|
| `pi-voice.toggle` | `alt+v` | Start or stop voice, like `/talk`. |
| `pi-voice.mute` | `alt+m` | Mute or unmute the microphone. |

Change them in Pi's `keybindings.json` (`~/.pi/agent/keybindings.json`), next to Pi's own actions, then run `/reload`. Use a key or a list of keys; `[]` turns a shortcut off:

```json
{
  "pi-voice.toggle": "ctrl+shift+v",
  "pi-voice.mute": []
}
```

On macOS, <kbd>Alt</kbd> shortcuts need your terminal to send Option as Meta (iTerm2: Profiles → Keys → Left Option key: Esc+; Terminal: Settings → Profiles → Keyboard → Use Option as Meta key; Ghostty: `macos-option-as-alt = true`). Otherwise Option+V types `√`.

## API key

Set `OPENAI_API_KEY`, or store the key in your login keychain as `openai-api-key` (the environment variable wins if both exist). OpenAI keys are too long for the `security` prompt, so copy the key, then run:

```sh
security add-generic-password -U -s "openai-api-key" -a "$USER" -l "OpenAI API key" -w "$(pbpaste)" && pbcopy </dev/null
```

Keys are read only when a session starts and are never logged. Audio and transcripts are not stored.

## Settings

Put a `"pi-voice"` object in Pi's `settings.json` (`~/.pi/agent/settings.json`, or a project's `.pi/settings.json`, which overrides it). Any setting can also be set with its environment variable, which wins over the file. `/talk check` shows each value and where it came from.

```json
{
  "pi-voice": {
    "autoPause": 15,
    "idlePause": 60,
    "echoCancellation": true
  }
}
```

| Setting | Environment variable | Default | Effect |
|---|---|---|---|
| `autoPause` | `PI_VOICE_AUTOPAUSE` | `15` | Seconds of silence while Pi works before voice pauses (it comes back with the result). `0` = never. |
| `idlePause` | `PI_VOICE_IDLE_PAUSE` | `60` | Seconds of silence while nothing runs before voice pauses (`/talk start` resumes). `0` = never. |
| `echoCancellation` | `PI_VOICE_AEC` | `true` | Apple's voice processing. Turn off only with headphones, or the agent hears itself. |

`PI_VOICE_CONFIG_DIR` sets where your voice and persona overrides live (see below).

## Voice and persona

The backend model is Pi's: switch it with `/model` as usual. For the voice, put files in `~/.pi/agent/pi-voice/openai-live/` (under `$PI_CODING_AGENT_DIR` if you set it, or `$PI_VOICE_CONFIG_DIR/openai-live/`). `/talk check` shows the directory.

- `session.json`: only the top-level keys you set change. To pick a voice, use `{ "voice": "<built-in voice name>" }`, or a custom voice: `{ "voice": { "id": "voice_…", "description": "<its design prompt>" } }`.
- `instructions.md`: replaces the voice persona and its rules for handing work to Pi.

The defaults are in [`providers/openai-live/`](providers/openai-live).

## Troubleshooting

- **The agent hears itself and loops:** make sure echo cancellation is on (`/talk check`; the `echoCancellation` setting or `PI_VOICE_AEC`).
- **No sound:** run `/talk tone` and check the output in Sound settings.
- **The agent never hears you:** run `/talk mic-test`. Below about -40 dBFS means the wrong input device or no microphone permission. Another app holding the mic (e.g. a call) can also block it.
- **Bluetooth sounds bad:** using AirPods as the microphone lowers their audio quality. Use the Mac's microphone for input and AirPods for output.

## Development

```sh
git clone https://github.com/lprsrts/pi-voice && cd pi-voice
npm test
pi -e .   # run Pi with your checkout (pi remove the npm package first)
node scripts/live/run.mjs all --quiet   # live scenarios: real GPT-Live and Pi (costs a little; see scripts/live)
```

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

MIT
