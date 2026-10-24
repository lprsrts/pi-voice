import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { currentSettings } from "./settings.ts";

// All audio goes through native/VoiceIO.swift, compiled with swiftc into the
// user cache, keyed by source hash. No binary is committed to the repo.

const source = fileURLToPath(new URL("./native/VoiceIO.swift", import.meta.url));

/** Echo cancellation: PI_VOICE_AEC, else "pi-voice".echoCancellation in Pi's settings, else on. */
export function aecEnabled(): boolean {
  return currentSettings().values.echoCancellation;
}

export function helperPath(cacheRoot = process.env.XDG_CACHE_HOME || join(homedir(), ".cache")): string {
  const hash = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 12);
  return join(cacheRoot, "pi-voice", `voice-io-${hash}`);
}

export function helperBuilt(): boolean {
  return existsSync(helperPath());
}

/** Compiles the helper on first use (~40s); later calls return the cached binary. */
export async function ensureHelper(signal?: AbortSignal): Promise<string> {
  const target = helperPath();
  if (existsSync(target)) return target;
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });
  const partial = `${target}.${process.pid}.tmp`;
  try {
    await new Promise<void>((resolve, reject) => {
      execFile("swiftc", ["-O", "-swift-version", "5", "-o", partial, source], { signal, timeout: 300000 }, (error, _stdout, stderr) => {
        if (error) reject(new Error(`Building the native audio helper failed: ${(stderr || error.message).trim().split("\n").slice(-3).join(" | ")}. Install Xcode Command Line Tools (xcode-select --install).`));
        else resolve();
      });
    });
    await rename(partial, target);
    // Older builds (previous source versions) are dead weight once this one exists.
    for (const name of await readdir(dir)) {
      if (/^voice-(io|aec)-[0-9a-f]{12}$/.test(name) && name !== basename(target)) await rm(join(dir, name), { force: true });
    }
  } finally {
    await rm(partial, { force: true });
  }
  return target;
}
