import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "./config.ts";

// The /talk command surface: parsing, argument completion, help, and the
// keyboard shortcuts read from Pi's keybindings.json. index.ts runs the commands.

export const PREVIEW_STATES = ["story", "cycle", "connecting", "listening", "hearing", "working", "speaking", "muted", "error", "paused", "off"] as const;
export type PreviewState = (typeof PREVIEW_STATES)[number];

type Spec = { name: string; usage: string; description: string; values?: readonly string[] };

export const TALK_COMMANDS: readonly Spec[] = [
  { name: "start", usage: "start", description: "Start voice, or resume it after a pause" },
  { name: "stop", usage: "stop", description: "End the voice connection; a running Pi task keeps going" },
  { name: "mute", usage: "mute [on|off]", description: "Stop or resume the microphone (no argument toggles)", values: ["on", "off"] },
  { name: "unmute", usage: "unmute", description: "Resume the microphone" },
  { name: "check", usage: "check", description: "Setup status, settings, and shortcuts; no network or microphone" },
  { name: "devices", usage: "devices", description: "The macOS input and output in use" },
  { name: "tone", usage: "tone [20-20000]", description: "Play a test tone (440 Hz by default)", values: ["220", "440", "1000"] },
  { name: "mic-test", usage: "mic-test [1-10]", description: "Record a few seconds, report the level, play it back", values: ["3", "5", "10"] },
  { name: "preview", usage: "preview [story|cycle|state|off]", description: "Preview the voice bar: the story of every state, a cycle, or one state", values: PREVIEW_STATES },
  { name: "help", usage: "help", description: "List the /talk commands and shortcuts" },
];

export type TalkCommand =
  | { name: "toggle" | "start" | "stop" | "unmute" | "check" | "devices" | "help" }
  | { name: "mute"; value?: boolean }
  | { name: "tone"; hz: number }
  | { name: "mic-test"; seconds: number }
  | { name: "preview"; state: PreviewState }
  | { name: "error"; message: string };

const usage = (spec: Spec) => `Use /talk ${spec.usage}`;

/** Levenshtein distance, for "did you mean" on a mistyped subcommand. */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/** Parses the text after /talk. An empty argument toggles voice. */
export function parseTalk(args: string): TalkCommand {
  const [verb = "", ...rest] = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!verb) return { name: "toggle" };
  const spec = TALK_COMMANDS.find(command => command.name === verb);
  if (!spec) {
    const near = TALK_COMMANDS.map(command => ({ command, d: distance(verb, command.name) })).sort((a, b) => a.d - b.d)[0];
    const hint = near && near.d <= 2 ? `Did you mean /talk ${near.command.name}?` : "See /talk help.";
    return { name: "error", message: `Unknown command "/talk ${verb}". ${hint}` };
  }
  if (rest.length > 1 || (rest.length && !spec.values)) return { name: "error", message: usage(spec) };
  const [arg] = rest;
  switch (spec.name) {
    case "mute":
      if (arg !== undefined && arg !== "on" && arg !== "off") return { name: "error", message: usage(spec) };
      return { name: spec.name, value: arg === undefined ? undefined : arg === "on" };
    case "tone": {
      const hz = arg === undefined ? 440 : Number(arg);
      return Number.isInteger(hz) && hz >= 20 && hz <= 20000 ? { name: "tone", hz } : { name: "error", message: usage(spec) };
    }
    case "mic-test": {
      const seconds = arg === undefined ? 3 : Number(arg);
      return Number.isInteger(seconds) && seconds >= 1 && seconds <= 10 ? { name: "mic-test", seconds } : { name: "error", message: usage(spec) };
    }
    case "preview":
      return (PREVIEW_STATES as readonly string[]).includes(arg ?? "story") ? { name: "preview", state: (arg ?? "story") as PreviewState } : { name: "error", message: usage(spec) };
    default:
      return { name: spec.name } as TalkCommand;
  }
}

export type Completion = { value: string; label: string; description?: string };

/** Completions for the text after "/talk ": subcommands, then their values. */
export function talkCompletions(prefix: string): Completion[] | null {
  const text = prefix.replace(/^\s+/, "").toLowerCase();
  const space = text.indexOf(" ");
  const items = space < 0
    ? TALK_COMMANDS.filter(command => command.name.startsWith(text)).map(command => ({
      value: command.values ? `${command.name} ` : command.name,
      label: command.name,
      description: command.description,
    }))
    : (TALK_COMMANDS.find(command => command.name === text.slice(0, space))?.values ?? [])
      .filter(value => value.startsWith(text.slice(space + 1).trim()))
      .map(value => ({ value: `${text.slice(0, space)} ${value}`, label: value }));
  return items.length ? items : null;
}

// ---------- Keyboard shortcuts ----------

export type ShortcutAction = "toggle" | "mute";
export const SHORTCUT_IDS: Record<ShortcutAction, string> = { toggle: "pi-voice.toggle", mute: "pi-voice.mute" };
export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string[]> = { toggle: ["alt+v"], mute: ["alt+m"] };
const SHORTCUT_LABELS: Record<ShortcutAction, string> = { toggle: "start or stop voice", mute: "mute or unmute the microphone" };

/**
 * Keys for each action from Pi's keybindings.json (parsed), where pi-voice's
 * actions sit next to Pi's own: "pi-voice.toggle": "alt+v" or a list; [] disables.
 * A missing or invalid entry keeps the default.
 */
export function resolveShortcuts(config: unknown): Record<ShortcutAction, string[]> {
  const block = config && typeof config === "object" ? config as Record<string, unknown> : {};
  const keys = (value: unknown) => typeof value === "string" ? [value] : Array.isArray(value) && value.every(key => typeof key === "string") ? value as string[] : undefined;
  const result = {} as Record<ShortcutAction, string[]>;
  for (const action of Object.keys(SHORTCUT_IDS) as ShortcutAction[]) {
    result[action] = (keys(block[SHORTCUT_IDS[action]]) ?? DEFAULT_SHORTCUTS[action]).map(key => key.trim().toLowerCase()).filter(Boolean);
  }
  return result;
}

/** Pi's keybindings.json in its agent directory, read once at load (/reload rereads it). */
export function keybindingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentDir(env), "keybindings.json");
}

export function loadShortcuts(path = keybindingsPath()): Record<ShortcutAction, string[]> {
  try { return resolveShortcuts(existsSync(path) ? JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) : undefined); }
  catch { return resolveShortcuts(undefined); }
}

export function shortcutLines(shortcuts: Record<ShortcutAction, string[]>): string[] {
  return (Object.keys(SHORTCUT_IDS) as ShortcutAction[]).map(action =>
    `  ${shortcuts[action].join(", ") || "none"}: ${SHORTCUT_LABELS[action]} (${SHORTCUT_IDS[action]})`);
}

export function talkHelp(shortcuts: Record<ShortcutAction, string[]>): string {
  const width = Math.max(...TALK_COMMANDS.map(command => command.usage.length));
  return [
    "/talk: start voice, or stop it if it is running",
    ...TALK_COMMANDS.map(command => `/talk ${command.usage.padEnd(width)}  ${command.description}`),
    `shortcuts (set in ${keybindingsPath()}, then /reload):`,
    ...shortcutLines(shortcuts),
  ].join("\n");
}
