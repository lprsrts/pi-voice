# pi-voice

Full-duplex voice for the Pi coding agent: a voice model talks with the user, and the work is done by the user's own Pi session.

## Language

**Voice**:
The spoken side of pi-voice: the voice model (GPT-Live) the user talks with. It speaks in the first person about the work but does not do it.
_Avoid_: assistant, agent, backend

**Pi**:
The user's coding-agent session that does the work the voice hands it.
_Avoid_: backend, worker

**Hand-off**:
The voice passing what the user said to Pi as a request, or into the running task.
_Avoid_: delegation (GPT-Live's protocol term, used only for its events), handoff

**Remark**:
Words said while Pi works that the voice did not hand off, passed to Pi framed so that Pi acts on them only if they change the task.
_Avoid_: steer (the delivery mechanism), fallback

**Read-out**:
The voice saying Pi's result aloud, in place of Pi's written answer in the chat.
_Avoid_: TTS, summary

**Not-done note**:
What the voice is told with a result when something the user said never reached Pi, so it says which part was not done instead of claiming it.
_Avoid_: warning, disclaimer

**Talk**:
One period of voice use from `/talk start` to `/talk stop`, which may span several connections (auto-pause, reconnects).
_Avoid_: call, voice session (a single connection)
