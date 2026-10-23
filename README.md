# pi-voice

Full-duplex, speech-to-speech voice for [Pi](https://pi.dev) on macOS. You talk to a realtime voice model (**ElevenLabs Eleven Realtime v1 Max** or **OpenAI GPT-Live**); it hands real work to the Pi session in your terminal through three tools (`ask_pi`, `pi_status`, `cancel_pi`) and tells you the outcome. Barge-in works, and Apple's echo canceller lets you use speakers instead of headphones.

This is not dictation: for local speech-to-text into the editor, see the official `@earendil-works/pi-voice`. The two packages can be installed together (this one uses `/talk`).

## Install

```sh
pi install npm:@lprsrts/pi-voice
```

Then, inside Pi:

```text
/talk check          # helper, devices, API-key status
/talk start          # ElevenLabs (default)
/talk start openai-live
/talk stop
```

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

No npm runtime dependencies or ffmpeg are required.

Environment settings:

- `PI_VOICE_PROVIDER`: default provider when `/talk start` names none.
- `PI_VOICE_AEC=0`: bypass Apple's voice processing (echo cancellation, noise suppression, AGC) for raw mic audio. Only safe with headphones, and the raw built-in mic is quiet (~-34 dBFS peak on loud speech).
- `PI_VOICE_CONFIG_DIR`: where your config overrides live (see below).

## Configuration

Each provider's model, voice, turn settings, and prompts ship in `providers/<name>/`. To change them, put files with the same names in your override directory, `$PI_VOICE_CONFIG_DIR/<provider>/` or by default `pi-voice/<provider>/` in Pi's agent directory (`~/.pi/agent/pi-voice/elevenlabs/`, or under `$PI_CODING_AGENT_DIR`):

- `session.json` is merged key by key over the default, so a file containing only a voice is enough:
  - ElevenLabs: `{ "voice": "<voice id>" }` (default: the premade voice "George").
  - GPT-Live: `{ "voice": "<built-in name>" }` (default `vesper`), or a custom voice as `{ "voice": { "id": "voice_…", "description": "<the prompt it was designed from>" } }`; the description is appended to the instructions, as OpenAI recommends.
- `instructions.md` (voice persona) and, for GPT-Live, `backend.md` (the delegate model's prompt) replace the default when present.

`/talk check` prints the override directory in use.

## Native audio (`native/VoiceIO.swift`)

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

## Commands

- `/talk check`: echo-cancellation mode, helper/swiftc status, current default devices, and the API-key source (keychain item present, or env override) without reading the secret; no network or microphone access.
- `/talk devices`: shows the macOS default input and output that sessions use.
- `/talk tone [hz]`: plays a local 2-second test tone on the default output — no microphone, no network.
- `/talk mic-test [seconds]`: records a short local clip through the session's voice-processing path, reports peak/RMS level in dBFS, and plays it back; nothing leaves this Mac.
- `/talk start`: asks for consent, mints a short-lived client secret for the session config, connects, then starts audio.
- `/talk stop`: ends the voice session and releases audio. A Pi task it started keeps running.
- `/talk mute`: mutes the microphone inside the voice unit (output/conversation remain active and may still incur charges).
- `/talk unmute`: resumes capture.
- `/talk-preview [cycle|idle|listening|thinking|speaking|error|off]`: offline, simulated visual design mode. Stop live voice first.

The bar is text-free, foreground-only, and below the editor. Every state is the same centered, stationary Gaussian beam. Thinking runs a fixed carrier with an evolving phase. Listening (mic) and speaking (agent) set the beam's height from the frame's level (adaptive gain, recent-peak normalization) and its carrier density from the frame's dominant frequency: 80 Hz–4 kHz on a log scale maps to 4–20 cycles across the bar. That frequency is found with a Hann-windowed Goertzel scan of each 20 ms frame, and it glides over ~90 ms. State/color weights ease over ~750ms. Preview audio is synthetic. Live output samples are measured at the playback pipe, not from a hardware playback clock, so visual/audio alignment is approximate.

## Providers

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

## Talking to Pi (`pi-bridge.ts`)

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

## Realtime protocol (`realtime.ts`)

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

## Tests / validation

```sh
git clone https://github.com/lprsrts/pi-voice && cd pi-voice
npm test
pi -e .   # try a local checkout without installing
```

Tests cover framing, keychain resolution (incl. truncated long keys), provider selection, the GPT-Live session (header auth, session.start, audio, delegated function calls and continuation, commentary/thinking updates, graceful close), device-route parsing, level math, the native helper session protocol (with a stand-in helper), the Realtime session (secret minting, socket auth, audio, barge-in truncation, function calls, response gating) against a fake socket, and the Pi bridge (start/steer/queue, status, cancel, announcements) against a fake Pi. No live credentials or audio devices are used. The Swift helper and the live Realtime protocol were exercised by hand.

References:
- https://elevenlabs.io/docs/eleven-agents/customization/realtime-models
- https://elevenlabs.io/docs/eleven-agents/guides/openai-realtime-compatibility
- https://developer.apple.com/documentation/audiotoolbox/kaudiounitsubtype_voiceprocessingio

## License

MIT
