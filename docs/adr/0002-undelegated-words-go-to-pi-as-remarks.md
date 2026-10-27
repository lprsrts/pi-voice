# Words GPT-Live does not hand off go to Pi as remarks

GPT-Live sometimes acknowledges something said while Pi works ("Noted", "I'll pivot to that") without handing it off, and then reads the result out as if it had been done. Words not handed off within 3.5 s of being said are sent to the running task as a **remark**: a steer framed so that Pi applies it only if it corrects or adds to the task and otherwise ignores it. If Pi finished first, the result is read out with a note that those words did not reach it, so the voice says which part was not done.

## Considered Options

- Filtering on the client (cue words, or GPT-Live's acknowledgement): rejected, because GPT-Live answers corrections and small talk with the same words, and cue words catch thinking aloud ("we might also move to vitest someday").
- Reminding GPT-Live to hand off: tried; it answered "Sure" and still did not.
- A setting to turn remarks off: not added until someone asks.

## Consequences

Small talk said while Pi works reaches Pi's session as remarks, costing tokens; Pi occasionally re-checks its work after one. Stop and status words are never sent as remarks (ADR-0003).
