# pi-voice

![pi-voice: the voice bar listening, thinking, and speaking](https://raw.githubusercontent.com/lprsrts/pi-voice/main/assets/cover.png)

**Talk to your coding agent.** Full-duplex, speech-to-speech voice for [Pi](https://pi.dev) on macOS. Say what you want; a realtime voice model hands the work to the Pi session in your terminal and tells you the outcome when it is done.

- **Not dictation.** You talk to a voice model (ElevenLabs Eleven Realtime or OpenAI GPT-Live) that delegates to Pi through three tools: `ask_pi`, `pi_status`, `cancel_pi`. Pi's own tools, permission prompts, and transcript work exactly as in the TUI.
- **Use your speakers.** Audio runs through Apple's VoiceProcessingIO, the echo canceller FaceTime uses, so the agent doesn't hear itself. Headphones are optional.
- **Interrupt any time.** Barge-in cuts the agent off mid-sentence, and the session follows device switches such as AirPods connecting.
- **Nothing to install but Pi.** No npm dependencies and no ffmpeg; a small Swift audio helper is compiled from source on first use.

For local speech-to-text into the editor, use the official `@earendil-works/pi-voice` instead. The two install side by side; this package's command is `/talk`.

## Quick start

1. Install:
   ```sh
   pi install npm:@lprsrts/pi-voice
   ```
2. Add an API key for one provider (see [Requirements](#requirements)), e.g. `export ELEVENLABS_API_KEY=…` or store it in the login keychain.
3. In Pi:
   ```text
   /talk check             # helper, devices, API-key status: no network, no microphone
   /talk start             # ElevenLabs (default); /talk start openai-live for GPT-Live
   /talk stop
   ```

The first `/talk` command that needs audio builds the native helper (a few seconds, up to ~40 s). macOS asks once for microphone permission for your terminal.

## What it costs

The package is free (MIT). Voice sessions are billed by the provider to your own API key:

- **ElevenLabs:** Eleven Realtime per-minute pricing plus Realtime tokens, on your ElevenLabs plan.
- **OpenAI GPT-Live:** $0.05 per minute of voice, plus tokens for the backend model that calls Pi. Needs API billing; a ChatGPT plan does not cover it.

Sessions end after 60 minutes (`max_duration_seconds`). `/talk mute` stops the microphone but keeps the session open (and billable); `/talk stop` ends it.

## Requirements

- macOS 14+ (Apple Silicon or Intel), Pi, Node 24+.
- `swiftc` from Xcode Command Line Tools (`xcode-select --install`): the native audio helper is compiled from source on first use.
- Microphone permission for your terminal app.
- An API key for the provider you use, as an environment variable or in the login keychain:

| Provider | Environment | Keychain service |
|---|---|---|
| `elevenlabs` | `ELEVENLABS_API_KEY` | `elevenlabs-api-key` |
| `openai-live` | `OPENAI_API_KEY` | `openai-api-key` |

To store a key in the keychain (the environment variable wins if both are set):

```sh
security add-generic-password -U -s "elevenlabs-api-key" -a "$USER" -l "ElevenLabs API key" -w
# OpenAI keys are longer than the 128-character limit of that prompt: copy the key, then
security add-generic-password -U -s "openai-api-key" -a "$USER" -l "OpenAI API key" -w "$(pbpaste)" && pbcopy </dev/null
```

The key is read only during `/talk start` and is never logged; `/talk check` reports where it would come from without reading it. GPT-Live needs API billing (a ChatGPT plan does not cover it).

Environment settings:

- `PI_VOICE_PROVIDER`: default provider when `/talk start` names none.
- `PI_VOICE_AEC=0`: bypass Apple's voice processing (echo cancellation, noise suppression, AGC) for raw mic audio. Only safe with headphones, and the raw built-in mic is quiet (~-34 dBFS peak on loud speech).
- `PI_VOICE_CAPTIONS=1`: start with the caption line shown (`/talk captions` toggles it).
- `PI_VOICE_CONFIG_DIR`: where your config overrides live (see below).

## Configuration

Each provider's model, voice, turn settings, and prompts ship in `providers/<name>/`. To change them, put files with the same names in your override directory, `$PI_VOICE_CONFIG_DIR/<provider>/` or by default `pi-voice/<provider>/` in Pi's agent directory (`~/.pi/agent/pi-voice/elevenlabs/`, or under `$PI_CODING_AGENT_DIR`):

- `session.json` is merged key by key over the default, so a file containing only a voice is enough:
  - ElevenLabs: `{ "voice": "<voice id>" }` (default: the premade voice "George").
  - GPT-Live: `{ "voice": "<built-in name>" }` (default `vesper`), or a custom voice as `{ "voice": { "id": "voice_…", "description": "<the prompt it was designed from>" } }`; the description is appended to the instructions, as OpenAI recommends.
- `instructions.md` (voice persona) and, for GPT-Live, `backend.md` (the delegate model's prompt) replace the default when present.

`/talk check` prints the override directory in use.

## Commands

- `/talk check`: echo-cancellation mode, helper/swiftc status, current default devices, and the API-key source (keychain item present, or env override) without reading the secret; no network or microphone access.
- `/talk devices`: shows the macOS default input and output that sessions use.
- `/talk tone [hz]`: plays a local 2-second test tone on the default output — no microphone, no network.
- `/talk mic-test [seconds]`: records a short local clip through the session's voice-processing path, reports peak/RMS level in dBFS, and plays it back; nothing leaves this Mac.
- `/talk start`: asks for consent, mints a short-lived client secret for the session config, connects, then starts audio.
- `/talk stop`: ends the voice session and releases audio. A Pi task it started keeps running.
- `/talk mute`: mutes the microphone inside the voice unit (output/conversation remain active and may still incur charges).
- `/talk unmute`: resumes capture.
- `/talk captions [on|off]`: shows or hides the caption line under the bar (no argument toggles). Defaults to off; `PI_VOICE_CAPTIONS=1` starts with captions on.
- `/talk-preview [cycle|idle|listening|thinking|speaking|error|off]`: offline, simulated visual design mode. Stop live voice first.

The bar is text-free, foreground-only, and below the editor. Every state is the same centered, stationary Gaussian beam. Thinking runs a fixed carrier with an evolving phase. Listening (mic) and speaking (agent) set the beam's height from the frame's level (adaptive gain, recent-peak normalization) and its carrier density from the frame's dominant frequency: 80 Hz–4 kHz on a log scale maps to 4–20 cycles across the bar. That frequency is found with a Hann-windowed Goertzel scan of each 20 ms frame, and it glides over ~90 ms. Below the bar, one centered line shows the phrase the agent is saying, from the provider's output transcript. Phrases break at commas, semicolons, colons, dashes, and sentence ends; a break inside a sentence shows as "…" ("Twenty pass…", "…two fail."). Each transcript chunk is spread over the voiced audio that follows it, and silence and breaths don't count, so the line moves with the voice rather than with text arrival. A phrase wider than the bar is shown in whole-word chunks, joined by the same ellipses. The last phrase stays for 2.5 s after the agent stops. State/color weights ease over ~750ms. Preview audio is synthetic. Live output samples are measured at the playback pipe, not from a hardware playback clock, so visual/audio alignment is approximate.

## Troubleshooting audio

1. **Agent loops with speakers (speaks, hears itself, answers, repeats)?** That is acoustic echo. Check that `PI_VOICE_AEC` is not set to `0` (`/talk check`); with echo cancellation on, speakers should be safe.
2. **No sound from the agent?** Run `/talk tone`, and check the default output in Sound settings (`/talk devices`).
3. **Agent never "hears" you (stuck listening, flat waveform)?** Run `/talk mic-test` and read the levels:
   - below about -40 dBFS: wrong input device or missing macOS microphone permission;
   - -25 to -6 dBFS: healthy; near 0: clipping.
   Another app holding the mic (e.g. a muted WhatsApp call) can also starve it.
4. **Bluetooth quality:** activating an AirPods microphone can force the whole headset into a low-quality bidirectional profile. Prefer Mac microphone for input and AirPods for output.
5. **Agent cuts in too early or waits too long?** Tune `turn_detection.eagerness` (`low`/`medium`/`high`) in `providers/elevenlabs/session.json`.

Startup, microphone stalls, socket inactivity, and playback queue sizes are bounded. No automatic reconnect or microphone startup on extension load. Audio/transcripts/credentials are not logged or persisted locally by this extension. ElevenLabs' own retention and billing settings still apply.

## How it works

### Providers

Pick one per session: `/talk start [elevenlabs|openai-live]`, else `PI_VOICE_PROVIDER`, else `elevenlabs`.
Each provider's defaults live in `providers/<name>/`, overridable as described under Configuration.

| | `elevenlabs` (default) | `openai-live` |
|---|---|---|
| Model | Eleven Realtime v1 Max, speech-to-speech | OpenAI GPT-Live-1, full duplex |
| Protocol | OpenAI-compatible Realtime (`realtime.ts`) | GPT-Live (`live.ts`), `wss://api.openai.com/v1/live/sessions` |
| Pi tools | Called by the voice model | Called by a backend Responses model (`backend.md`, `session.json` `backend.model`) that GPT-Live delegates to via `<|SpawnThinking|>` |
| Pi updates | Labelled user item + `response.create` | `session.commentary.append` (spoken), `session.thinking.append` (silent progress) |
| Key | `ELEVENLABS_API_KEY` / `elevenlabs-api-key` | `OPENAI_API_KEY` / `openai-api-key` |
| Cost | per minute + Realtime tokens | $0.05/min voice + backend model tokens |

GPT-Live notes: there is no interruption event; the model yields by itself, and the client drops its
locally queued audio when the user's transcript shows speech over playback. `/talk stop` sends
`session.close` so usage is finalized.

### Talking to Pi (`pi-bridge.ts`)

| Tool | What happens |
|---|---|
| `ask_pi(request, when?)` | Returns at once. Pi idle: the request becomes a normal user message in this Pi session. Pi busy: `when: "now"` steers the running task, `"after"` (default) queues it as a follow-up. |
| `pi_status()` | Current request, last tool Pi ran, elapsed time, latest text, queued requests, pending terminal prompt; answered from Pi's events without disturbing it. |
| `cancel_pi()` | Aborts Pi's running task and reports whether queued messages remain. |

- When a run that voice asked for settles, its final answer is sent to the model, which speaks it at
  the next moment nobody is talking (never over you). Pi waiting on a terminal prompt is announced
  the same way; the voice model cannot answer Pi's prompts.
- Pi's tools, permission prompts, and transcript are exactly as in the TUI: every voice request is
  visible in the session.
- Eleven Realtime ignores `system` conversation items (measured: the model stalled or invented a
  result). Pi updates are therefore `user` items prefixed "(Automatic update from Pi, not spoken by
  the user.)", which the instructions explain.

### Native audio (`native/VoiceIO.swift`)

All audio goes through one small Swift program built on Apple's VoiceProcessingIO audio
unit, the echo canceller FaceTime uses. It always uses the **macOS default input and
output** (Sound settings or the menu-bar Sound control), like any other Mac app.

- `session`: one process owns both directions (stdin PCM -> speaker, mic PCM -> stdout,
  `flush`/`mute` lines on fd 3), so the canceller sees exactly what is playing: no delay
  estimation or cross-process clock drift. Full-duplex and voice barge-in stay intact, and
  speakers work without the agent hearing itself.
- Follows default-device switches mid-session (e.g. AirPods connecting): the unit is rebuilt
  on the new route and Pi shows an "Audio switched" notice.
- `play`, `record`, and `devices` back `/talk tone`, `/talk mic-test`, and `/talk devices`,
  so diagnostics exercise the same path a session uses.
- Built on first use with `swiftc` (a few seconds to ~40s) into
  `$XDG_CACHE_HOME/pi-voice/voice-io-<source hash>`; no binary lives in the repo, and editing
  the Swift source triggers a rebuild.
- VoiceProcessingIO needs one sample rate on both buses, so the unit runs at the agent's
  output rate and the helper resamples the mic to the uplink rate (`AVAudioConverter`).
- `/talk mute` mutes inside the unit; the mic stays open (the macOS indicator stays on).

Measured on MacBook Pro speakers (4 s of speech-like noise): the former ffmpeg path captured
the agent at -32.6 dBFS (hence the loops); voice processing leaves -108 dBFS, below the room
noise floor. Apple's AGC also brings normal speech on the built-in mic to a healthy level
(`/talk mic-test`: peak -10.5 dBFS), so the extension applies no gain of its own.

### Realtime protocol (`realtime.ts`)

1. `POST /v1/convai/realtime/client_secrets` with the `xi-api-key` and the session config
   (`session.json` + `instructions.md` from the provider config + the Pi tools); the secret expires in 60 s.
2. `wss://api.elevenlabs.io/v1/convai/realtime` authenticated with the secret as subprotocol
   `openai-insecure-api-key.<secret>`; the API key itself never touches the socket.
3. Mic: native helper (voice-processed) -> PCM16 24 kHz -> 20 ms frames -> `input_audio_buffer.append`, unchanged.
4. Speaker: `response.output_audio.delta` -> bounded queue -> wall-clock-paced helper stdin, 24 kHz.
5. Barge-in (`input_audio_buffer.speech_started`, semantic VAD with `interrupt_response`): queued
   audio is flushed locally and in the helper, the item is truncated to what was actually played
   (`conversation.item.truncate`), and late deltas of that item are dropped.
6. Function calls arrive in `response.done`; their outputs go back as `function_call_output`, and
   `response.create` is only sent when no response is active and the user is not speaking.
   A `response.create` that races a server-created response is retried after that one finishes.
   Eleven Realtime creates a response by itself about 1 s after a `function_call_output` the client
   did not follow up (OpenAI does not). After `ask_pi`/`cancel_pi` that the model already
   acknowledged ("Checking."), that automatic response is cancelled and its audio dropped, so each
   task gets one acknowledgement.
7. The session ends at `max_duration_seconds` (3600; the API allows up to 7200). No auto-reconnect.

## Development

```sh
git clone https://github.com/lprsrts/pi-voice && cd pi-voice
npm test
pi -e .   # try a local checkout (pi remove the npm package first, or /talk registers twice)
```

Tests cover framing, keychain resolution (incl. truncated long keys), provider selection, the GPT-Live session (header auth, session.start, audio, delegated function calls and continuation, commentary/thinking updates, graceful close), device-route parsing, level math, the native helper session protocol (with a stand-in helper), the Realtime session (secret minting, socket auth, audio, barge-in truncation, function calls, response gating) against a fake socket, and the Pi bridge (start/steer/queue, status, cancel, announcements) against a fake Pi. No live credentials or audio devices are used. The Swift helper and the live Realtime protocol were exercised by hand.

References:
- https://elevenlabs.io/docs/eleven-agents/customization/realtime-models
- https://elevenlabs.io/docs/eleven-agents/guides/openai-realtime-compatibility
- https://developer.apple.com/documentation/audiotoolbox/kaudiounitsubtype_voiceprocessingio

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Releases are listed in [CHANGELOG.md](CHANGELOG.md).

## License

MIT
