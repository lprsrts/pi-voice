import type { AudioPipes } from "./audio.ts";
import { ELEVENLABS_KEY, OPENAI_KEY, type KeySpec } from "./keys.ts";
import { LiveVoice } from "./live.ts";
import { RealtimeVoice } from "./realtime.ts";
import type { VoiceState } from "./protocol.ts";

// Voice providers. Each has its config under providers/<name>/; the code below
// only maps a name to its session class, API key, and wording for the TUI.

export type VoiceHooks = {
  state: (state: VoiceState) => void;
  samples: (source: "input" | "output", samples: number[]) => void;
  error: (message: string) => void;
  /** The phrase the agent is saying now, in step with playback ("" clears it). */
  caption?: (line: string) => void;
  closed: () => void;
  tool: (name: string, args: Record<string, unknown>) => object;
  busy: () => boolean;
};

type AudioFactory = (callbacks: ConstructorParameters<typeof AudioPipes>[0]) => AudioPipes;

/** What index.ts drives, whichever provider runs underneath. */
export type VoiceSession = {
  start(getKey: (signal: AbortSignal) => Promise<string> | string): Promise<void>;
  /** A Pi update to say aloud at the next quiet moment. */
  notify(text: string): void;
  /** Silent context, when the provider has a channel for it. */
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

export const PROVIDERS: Record<string, Provider> = {
  elevenlabs: {
    name: "elevenlabs",
    label: "ElevenLabs Realtime (Eleven Realtime v1)",
    key: ELEVENLABS_KEY,
    create: (hooks, audio) => new RealtimeVoice(hooks, audio),
  },
  "openai-live": {
    name: "openai-live",
    label: "OpenAI GPT-Live",
    key: OPENAI_KEY,
    create: (hooks, audio) => new LiveVoice(hooks, audio),
  },
};

export const DEFAULT_PROVIDER = "elevenlabs";

/** `/talk start <name>` wins over PI_VOICE_PROVIDER, which wins over the default. */
export function selectProvider(requested?: string): Provider {
  const name = (requested?.trim() || process.env.PI_VOICE_PROVIDER?.trim() || DEFAULT_PROVIDER).toLowerCase();
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown voice provider "${name}". Available: ${Object.keys(PROVIDERS).join(", ")}.`);
  return provider;
}
