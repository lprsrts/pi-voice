// pi-voice settings: a "pi-voice" object in Pi's settings.json (global, or the
// project's .pi/settings.json, which Pi merges over it), each overridable by an
// environment variable, else the default.
//
//   "pi-voice": { "autoPause": 15, "idlePause": 60, "echoCancellation": true, "reducedMotion": false }

export type VoiceSettings = {
  /** Seconds of silence while Pi works before the voice connection pauses (0 = never). */
  autoPause: number;
  /** Seconds of silence while nothing runs before it pauses (0 = never). */
  idlePause: number;
  /** Apple voice processing (echo cancellation); off only with headphones. */
  echoCancellation: boolean;
  /** Still shapes and colours instead of motion: no drift, no impulses, no flipping text. */
  reducedMotion: boolean;
};

export const DEFAULT_SETTINGS: VoiceSettings = { autoPause: 15, idlePause: 60, echoCancellation: true, reducedMotion: false };

export const SETTINGS_KEY = "pi-voice";

const ENV: Record<keyof VoiceSettings, string> = {
  autoPause: "PI_VOICE_AUTOPAUSE",
  idlePause: "PI_VOICE_IDLE_PAUSE",
  echoCancellation: "PI_VOICE_AEC",
  reducedMotion: "PI_VOICE_REDUCED_MOTION",
};

export type Source = "env" | "settings" | "default";

const seconds = (value: unknown) => {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number >= 0 ? number : undefined;
};
const flag = (value: unknown) => {
  if (typeof value === "boolean") return value;
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ["1", "true", "on", "yes"].includes(text) ? true : ["0", "false", "off", "no"].includes(text) ? false : undefined;
};

/**
 * The effective settings and where each value came from. `settings` is Pi's
 * merged settings (pi.getSettings()); invalid values fall through to the next
 * source and are reported in `invalid`.
 */
export function resolveSettings(settings: unknown, env: NodeJS.ProcessEnv = process.env): { values: VoiceSettings; sources: Record<keyof VoiceSettings, Source>; invalid: string[] } {
  const own = (settings as Record<string, unknown> | undefined)?.[SETTINGS_KEY];
  const block = own && typeof own === "object" ? own as Record<string, unknown> : {};
  const values = { ...DEFAULT_SETTINGS };
  const sources = {} as Record<keyof VoiceSettings, Source>;
  const invalid: string[] = [];
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof VoiceSettings)[]) {
    const parse = typeof DEFAULT_SETTINGS[key] === "number" ? seconds : flag;
    const fromEnv = env[ENV[key]]?.trim() ? parse(env[ENV[key]]) : undefined;
    const fromSettings = key in block ? parse(block[key]) : undefined;
    if (env[ENV[key]]?.trim() && fromEnv === undefined) invalid.push(`${ENV[key]}=${env[ENV[key]]}`);
    if (key in block && fromSettings === undefined) invalid.push(`"${SETTINGS_KEY}".${key}: ${JSON.stringify(block[key])}`);
    const value = fromEnv ?? fromSettings;
    (values as Record<string, unknown>)[key] = value ?? DEFAULT_SETTINGS[key];
    sources[key] = fromEnv !== undefined ? "env" : fromSettings !== undefined ? "settings" : "default";
  }
  return { values, sources, invalid };
}

let read: () => unknown = () => undefined;

/** Where Pi's merged settings come from (index.ts passes pi.getSettings). */
export function useSettings(reader: () => unknown) { read = reader; }

/** The effective settings now: env, then Pi's settings, then defaults. */
export function currentSettings(env: NodeJS.ProcessEnv = process.env) {
  let settings: unknown;
  try { settings = read(); } catch { settings = undefined; }
  return resolveSettings(settings, env);
}

/** Env variable name for a setting (for /talk check and docs). */
export const envName = (key: keyof VoiceSettings) => ENV[key];
