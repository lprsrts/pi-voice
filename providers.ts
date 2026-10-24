import type { AudioPipes } from "./audio.ts";
import { OPENAI_KEY, type KeySpec } from "./keys.ts";
import { LiveVoice } from "./live.ts";
import type { CaptionLine, VoiceState } from "./protocol.ts";

// The voice provider: OpenAI GPT-Live, with the Pi session as its backend.
// Its config is in providers/openai-live/; the code below maps it to the
// session class, the API key, and wording for the TUI.

export type VoiceHooks = {
  state: (state: VoiceState) => void;
  samples: (source: "input" | "output", samples: number[]) => void;
  error: (message: string) => void;
  /** The phrase the agent is saying now and how much of it is spoken, in step with playback ("" clears it). */
  caption?: (line: CaptionLine) => void;
  closed: () => void;
  tool: (name: string, args: Record<string, unknown>) => object;
  busy: () => boolean;
  /** The agent's memory of the Pi session, given to each new voice session. */
  briefing?: () => string;
  /** Someone is talking (user speech or audible playback): resets the auto-pause timer. */
  activity?: () => void;
};

type AudioFactory = (callbacks: ConstructorParameters<typeof AudioPipes>[0]) => AudioPipes;

/** What index.ts drives. */
export type VoiceSession = {
  start(getKey: (signal: AbortSignal) => Promise<string> | string): Promise<void>;
  /** A Pi update to say aloud at the next quiet moment. */
  notify(text: string): void;
  /** Silent context, e.g. Pi's progress. */
  context?(text: string): void;
  mute(value: boolean): void;
  stop(): void;
};

export type Provider = {
  name: string;
  label: string;   // e.g. for the consent prompt
  key: KeySpec;
  create(hooks: VoiceHooks, audio: AudioFactory): VoiceSession;
};

export const PROVIDER: Provider = {
  name: "openai-live",
  label: "OpenAI GPT-Live",
  key: OPENAI_KEY,
  create: (hooks, audio) => new LiveVoice(hooks, audio),
};
