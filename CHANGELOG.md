# Changelog

## Unreleased

### Spoken history

- **Your conversation with the voice stays in the chat.** Your words and the voice's replies are written into the Pi session once the voice goes quiet, so they show in the transcript and come back when you resume. A reply you talked over keeps only the part you heard, marked *(interrupted)*. What is said while Pi works (progress remarks, acknowledgements, status questions) and the voice reading out Pi's result are not written, since Pi's own messages cover them. Pi's model does not see these entries; it gets each request as a message.
- A spoken request Pi received shows as what you said (`› make it four`) instead of the transcript framing and the conversation appended for Pi.
- The voice's briefing at `/talk start` includes the spoken history, so a conversation that never reached Pi is remembered across voice sessions.
- **Live line above the input.** The voice bar now sits above the input (you can keep typing), and its live line, on top and left-aligned like a transcript, shows your words as they are recognized and the voice's current phrase, flipping in like a split-flap board and settling with a short glow.
- Captions (the live line) are on by default; `"captions": false` or `/talk captions off` hides them.

### Breaking changes

- `/talk-preview` is now `/talk preview [state|off]`.

### Command interface

- **`/talk` alone starts voice, or stops it if it is running.** `/talk mute` toggles the microphone (`/talk mute on|off` sets it), and `/talk help` lists every command and shortcut.
- **Shortcuts:** <kbd>Alt</kbd>+<kbd>V</kbd> starts or stops voice and <kbd>Alt</kbd>+<kbd>M</kbd> mutes it. They are the actions `pi-voice.toggle` and `pi-voice.mute` in Pi's `keybindings.json`, where you can change or turn them off; `/talk check` shows them.
- **Footer status:** while voice is in use, Pi's footer shows `voice on`, `voice muted`, or `voice paused`, and how many results are waiting to be said.
- <kbd>Tab</kbd> completes `/talk` subcommands and their values.
- Arguments are checked: `/talk tone abc`, `/talk mic-test 99`, or `/talk stop now` show the usage instead of quietly using a default, and a mistyped subcommand suggests the closest one (`/talk strat` → "Did you mean /talk start?").
- `/talk stop` confirms that voice stopped (and that a running task continues), or says voice was not running.

## 0.2.0 (2026-10-24)

### Breaking changes

- **GPT-Live is the only voice provider.** ElevenLabs Eleven Realtime, the provider argument to `/talk start`, and `PI_VOICE_PROVIDER` have been removed.
- **Pi is the backend.** GPT-Live now hands work to the Pi session itself (client delegation): what you said goes to Pi as a message, Pi works with its own model (`/model`), tools, and environment, its progress reaches the voice silently, and its result is spoken on the same delegation. The separate OpenAI-hosted backend model and its configuration (`backend.md`, `session.json` `backend`) have been removed.

### Features

- **Auto-pause.** GPT-Live bills per second while connected, so voice closes its connection after 15 s of silence while Pi works (`PI_VOICE_AUTOPAUSE`) and comes back by itself to say the result; after 60 s of silence with nothing running (`PI_VOICE_IDLE_PAUSE`) it pauses until `/talk start`. Measured live: a 56 s wait billed 31 s instead of 56 s.
- **Results are never lost.** A talk session (`talk.ts`) owns the Pi bridge across voice connections: a result that arrives while voice is paused, connecting, or stopped by the user is said as soon as a connection is open. The consent prompt is shown once per Pi session.
- **Memory across voice sessions.** Each `/talk start` briefs the new voice session from the Pi session: the latest compaction summary, recent spoken and typed requests with the answers, and any task still running, so after restarting voice mid-task it knows what it is doing. A task still running when voice starts is adopted, so its result is announced in the new session.
- **Requests carry the conversation.** A handoff sends your latest turn as the request together with everything said since the previous one (your earlier turns and the voice's replies), so a question like "does that single line addition work?" reaches Pi with the explanation it refers to. Pi's voice prompt explains the format. The voice lets you think aloud and explain over several turns without handing off, and Pi answers questions about a change instead of making it unless asked.
- **Settings.** `autoPause`, `idlePause`, `captions`, and `echoCancellation` can be set in a `"pi-voice"` object in Pi's `settings.json` (global or per project), each overridable by its environment variable (`PI_VOICE_AUTOPAUSE`, `PI_VOICE_IDLE_PAUSE`, `PI_VOICE_CAPTIONS`, `PI_VOICE_AEC`). `/talk check` shows every value, its source, and any value it ignored as invalid.

### Improvements and fixes

- **One agent, one voice.** The voice speaks about the work in the first person ("I'm running the tests", "I stopped it"), never as "Pi" or a backend: the voice prompt, every update it receives (results, progress, status, cancellation), and Pi's own voice-mode prompt now treat the voice and the Pi session as one agent.
- While Pi works, "stop"/"cancel" aborts it and "what's Pi doing?" is answered from Pi's state without interrupting it; anything else is added to the running task. Short replies ("yes, do that") carry what the voice had just said.
- While a voice session runs, Pi's system prompt gets a voice section: requests are speech transcripts, and answers should end with a short, speakable summary.
- Late transcript fragments of your own request no longer interrupt the voice's acknowledgement.
- A handoff goes to Pi the moment its transcript is complete (the last fragment reaches the handoff point), instead of after a fixed 350 ms wait; the wait remains only for requests whose last words are still in flight.
- A handoff takes only your latest turn: a question the voice answered by itself (e.g. a status question) no longer leaks into the next request, which had turned "stop that" into a status check. Short replies carry your previous turn and the voice's last words as context.

### Testing

- **Live test scripts** (`scripts/live/`): real-life scenarios (quick answer, status and stop, restart memory, multi-turn explanation, correction mid-task) against real GPT-Live and a real Pi session, with checks, timing, model comparison (`--model`), and three audio modes.
- Live scenarios `autopause` and `result-after-stop`; the harness runs through the shipped talk session and reports billed voice time.

## 0.1.4 (2026-10-24)

- GPT-Live: Pi results and progress are clipped by a pessimistic token estimate instead of 1800 characters, so long, code-heavy results (paths, versions, hashes) no longer exceed GPT-Live's 500-token append limit and get dropped with "Context append text must not exceed 500 tokens".

## 0.1.3 (2026-10-24)

- Live captions: the agent's current phrase is shown centered below the bar, split at commas, semicolons, colons, dashes, and sentence ends ("…" marks where a sentence continues), and paced by voiced audio so breaths keep the current phrase up (both providers; ElevenLabs delivery tags such as `[Tone]` are removed).
- Captions are paced by the speaker, not the write queue: the audio helper reports its playout position over fd 4, so helper buffering, event-loop stalls, and device latency no longer make captions run ahead of the audio — when the device stalls, the caption holds with the sound instead of racing on (both providers).
- A transcript burst ahead of its audio no longer collapses onto its last delta, and a streaming response no longer races its caption to the end: deltas sharing an audio stamp pace together, spans close on the next stamp or the item's audio-done and then pace exactly, and a still-open span advances by the session's calibrated speaking rate — the audio queued so far tracks delivery pace, not sentence length. GPT-Live fragments pace by their server-provided `start_ms`/`end_ms` ranges; since primary-socket audio carries no timing, each turn anchors the session timeline to its first speech onset after the user spoke, so a late first frame, dropped frames, or audio flushed on barge-in no longer make captions lag. Within a turn the cursor never moves backward.
- ElevenLabs barge-in truncates the item to the audio the speaker actually played for it (device-reported), not the audio written to the helper, and no longer counts the previous item's tail.
- `/talk captions [on|off]` toggles the caption line; captions are off by default, and `PI_VOICE_CAPTIONS=1` starts with them on.

## 0.1.2 (2026-10-23)

- Docs only: README leads with a cover image, quick start, and costs; gallery preview image; CHANGELOG, CONTRIBUTING, and issue templates.

## 0.1.1 (2026-10-23)

- The voice bar draws listening and speaking as Gaussian beams like thinking: height follows loudness, carrier density follows the dominant frequency of each 20 ms frame (80 Hz–4 kHz).

## 0.1.0 (2026-10-23)

First public release.

- Full-duplex voice for Pi on macOS with two providers: ElevenLabs Eleven Realtime v1 Max (default) and OpenAI GPT-Live.
- The voice model delegates to Pi through `ask_pi`, `pi_status`, and `cancel_pi`; Pi results are spoken when nobody is talking.
- Native audio through Apple's VoiceProcessingIO: echo cancellation, barge-in, and default-device following.
- Per-provider config overrides in `pi-voice/<provider>/` in Pi's agent directory.
- Diagnostics: `/talk check`, `/talk devices`, `/talk tone`, `/talk mic-test`, and `/talk-preview`.
