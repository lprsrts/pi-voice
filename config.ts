import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Provider config: the defaults in providers/<name>/ ship with the package; a
// user directory overrides them per file. session.json is merged key by key
// over the default (so `{"voice": "..."}` alone is enough); Markdown files
// replace the default wholesale.

/** Pi's agent directory: PI_CODING_AGENT_DIR or ~/.pi/agent. */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

/** PI_VOICE_CONFIG_DIR, else pi-voice/ in Pi's agent directory. */
export function userConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PI_VOICE_CONFIG_DIR?.trim()) return env.PI_VOICE_CONFIG_DIR.trim();
  return join(agentDir(env), "pi-voice");
}

export type ProviderFiles = {
  session<T>(): T;
  text(name: string): string;
};

export function providerFiles(provider: string, options: { defaults?: string; user?: string } = {}): ProviderFiles {
  const defaults = options.defaults ?? fileURLToPath(new URL(`./providers/${provider}/`, import.meta.url));
  const user = options.user ?? join(userConfigDir(), provider);
  const own = (name: string) => { const path = join(user, name); return existsSync(path) ? path : undefined; };
  return {
    session<T>() {
      const base = JSON.parse(readFileSync(join(defaults, "session.json"), "utf8"));
      const path = own("session.json");
      return (path ? { ...base, ...JSON.parse(readFileSync(path, "utf8")) } : base) as T;
    },
    text(name) {
      return readFileSync(own(name) ?? join(defaults, name), "utf8").trim();
    },
  };
}
