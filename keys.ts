import { execFile } from "node:child_process";
import { promisify } from "node:util";

const securityAsync = promisify(execFile);

// Keys live in the macOS login keychain as generic passwords with service
// "<provider>-api-key" under the current user's account; an environment
// variable overrides the keychain (CI, non-macOS).
export type KeySpec = {
  service: string;   // keychain service name
  env: string;       // override for CI/non-macOS
  label: string;     // human name, also the keychain label
  /** Keys longer than the 128-character limit of security's interactive -w prompt. */
  long?: boolean;
};

export const OPENAI_KEY: KeySpec = { service: "openai-api-key", env: "OPENAI_API_KEY", label: "OpenAI API key", long: true };

/** The interactive prompt truncates at 128 characters, so long keys go through the clipboard. */
export function provisionCommand(spec: KeySpec): string {
  const base = `security add-generic-password -U -s "${spec.service}" -a "$USER" -l "${spec.label}" -w`;
  return spec.long ? `${base} "$(pbpaste)" && pbcopy </dev/null   # copy the key first` : base;
}

type SecurityCall = (args: string[], options: { timeout: number; signal: AbortSignal; maxBuffer: number }) => Promise<{ stdout: string; stderr: string }>;

const defaultCall: SecurityCall = (args, options) =>
  securityAsync("/usr/bin/security", args, options) as Promise<{ stdout: string; stderr: string }>;

function failDetail(error: unknown): { code?: number; stderr: string } {
  const detail = error as { code?: number; stderr?: string; message?: string } | null;
  return { code: detail?.code, stderr: String(detail?.stderr ?? detail?.message ?? "") };
}

/**
 * Resolves a provider API key for a voice session: env override first
 * (CI/non-macOS), then the login keychain item. The value is never logged or persisted; callers must not
 * embed it in messages or stored state.
 */
export async function resolveApiKey(
  spec: KeySpec,
  signal: AbortSignal,
  options: { platform?: NodeJS.Platform; call?: SecurityCall } = {},
): Promise<string> {
  const override = process.env[spec.env]?.trim();
  if (override) return override;
  const provision = provisionCommand(spec);
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new Error(`No ${spec.label}: no keychain on this platform. Set ${spec.env}.`);
  }
  const call = options.call ?? defaultCall;
  let stdout: string;
  try {
    const result = await call(["find-generic-password", "-s", spec.service, "-w"], { timeout: 60000, signal, maxBuffer: 4096 });
    stdout = String(result.stdout);
  } catch (error) {
    const { code, stderr } = failDetail(error);
    if (code === 44 || /could not be found/i.test(stderr)) {
      throw new Error(`No ${spec.label}: add Keychain item "${spec.service}" by running this in your terminal (the key never enters shell history):\n${provision}`);
    }
    if (/refused access|interaction is not allowed/i.test(stderr)) {
      throw new Error("Keychain read was denied or unavailable (headless or SSH session?). Retry from a GUI terminal and allow access.");
    }
    throw new Error(`Keychain read failed: ${stderr.split("\n")[0].trim() || "unknown error"}`);
  }
  const key = stdout.replace(/\s+$/, "");
  if (!key || /\s/.test(key)) {
    throw new Error(`Keychain item "${spec.service}" is empty or malformed. Re-provision it:\n${provision}`);
  }
  if (spec.long && key.length === 128) {
    throw new Error(`Keychain item "${spec.service}" is exactly 128 characters: the security prompt truncated it. Re-provision it from the clipboard:\n${provision}`);
  }
  return key;
}

/** Reports the API-key source for /talk check without reading the secret. */
export async function apiKeyStatus(spec: KeySpec, options: { platform?: NodeJS.Platform; call?: SecurityCall } = {}): Promise<string> {
  const override = process.env[spec.env]?.trim();
  if (override) return `env override ${spec.env}`;
  if ((options.platform ?? process.platform) !== "darwin") return `missing (no keychain on this platform; set ${spec.env})`;
  const call = options.call ?? defaultCall;
  try {
    await call(["find-generic-password", "-s", spec.service], { timeout: 10000, signal: AbortSignal.timeout(10000), maxBuffer: 4096 });
    return `keychain "${spec.service}" present`;
  } catch (error) {
    const { code, stderr } = failDetail(error);
    if (code === 44 || /could not be found/i.test(stderr)) return `missing — run in a terminal: ${provisionCommand(spec)}`;
    return "unknown (keychain query failed; /talk start will surface the reason)";
  }
}
