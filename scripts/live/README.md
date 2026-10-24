# Live tests

Real-life voice scenarios against real GPT-Live and a real Pi agent session as the backend. They run the shipped code paths (the bridge, the session briefing, run adoption, and the voice prompt section for Pi) with scripted speech instead of a person. Each scenario reports what Pi received and did, what the voice said, pass/fail checks, and timing.

```sh
node scripts/live/run.mjs --help                  # list scenarios
node scripts/live/run.mjs all --quiet             # every scenario once
node scripts/live/run.mjs multi-turn-context --runs 3
node scripts/live/run.mjs quick-answer --model ollama-cloud/kimi-k3   # compare backend models
```

| Option | Effect |
|---|---|
| `--audio inject` (default) | The default configuration: the real audio helper with voice processing on and speaker playback; only the microphone's samples are scripted. |
| `--audio acoustic` | Lines are played through the speakers and heard by the real microphone. Voice processing is turned off, because it cancels anything the Mac itself plays. Use speakers, not headphones. |
| `--audio silent` | No audio devices; timing is taken when audio arrives instead of when it plays. |
| `--model provider/id` | The Pi model to use as the backend (default: your Pi default). |
| `--cwd DIR` | Where Pi works. The default is a disposable copy of this repository, since scenarios may change files. |
| `--runs N` | Repeat each scenario, to see how consistent a model is. |
| `--quiet` | Show only speech, requests, tools, and results in the timeline. |

Requirements are the package's (macOS, Pi on `PATH` or `PI_SDK_DIR`, an OpenAI API key as for `/talk`). Runs cost money: GPT-Live voice time ($0.05/min, printed at the end), text-to-speech for scripted lines (cached in `~/.cache/pi-voice/live-tts`), and your Pi model's tokens. The exit code is non-zero when a check fails.

Scenarios are in `scenarios.mjs`: each lists voice sessions of timed lines and checks over the recorded run. Add one when a real conversation goes wrong, using the words that were actually said.
