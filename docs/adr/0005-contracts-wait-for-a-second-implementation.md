# Provider and host contracts wait for a second implementation

pi-voice has two seams: the voice provider (today GPT-Live, behind `openai-live-wire.ts`) and the agent host (today Pi, behind `PiBridge`). Neither is formalized as a contract yet. A contract designed against GPT-Live alone did not fit it once checked against the code (timing on the session clock, a hand-off that carries no text, results tied to a hand-off), and the likely second provider (the standard Realtime protocol, hosted or a local turn-based server) and second host (OpenCode) differ again. Each contract will be designed from the real second implementation when one is built.

## Consequences

The Agent Client Protocol was considered as a host bridge to many agents at once and set aside: it has no mid-turn steering, which corrections and remarks (ADR-0002) depend on.
