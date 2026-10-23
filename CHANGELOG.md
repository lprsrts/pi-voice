# Changelog

## Unreleased

- Live captions: the agent's current phrase is shown centered below the bar, split at commas, semicolons, colons, dashes, and sentence ends ("…" marks where a sentence continues), and paced by voiced audio so breaths keep the current phrase up (both providers; ElevenLabs delivery tags such as `[Tone]` are removed).
- `/talk captions [on|off]` toggles the caption line; `PI_VOICE_CAPTIONS=0` starts with it off.

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
