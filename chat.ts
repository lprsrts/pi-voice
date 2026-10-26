import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, MouseRegion, visibleWidth } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { SPOKEN_MESSAGE, SPOKEN_READOUT, SPOKEN_TURN, spokenContent, type SpokenReadout, type SpokenSaid, type SpokenTurn } from "./pi-bridge.ts";
import { FlapBoard, wrapWords, type FlapTile } from "./protocol.ts";

// What was said aloud, inside Pi's chat, drawn like Pi's own messages: the
// user's words on the typed-message band, the voice's as assistant text. When
// someone starts speaking, a placeholder entry is saved and its component plays
// the words in as they are said, flipping like a split-flap board. When the turn
// is over it settles into what is kept, and that text joins Pi's conversation as
// a hidden custom message; a resumed session redraws each placeholder from it.
//
// Pi's answer to a voice request is read out, and the read-out stands in for it:
// Pi's text is hidden, and an answer placeholder plays the read-out in its place
// (saved for the chat only; Pi has its answer). Above the read-out, where Pi's
// text was, Pi's written answer sits collapsed like a thinking block: a click (or
// Ctrl+O) expands it. Until the read-out starts, or if it never does, the
// placeholder shows Pi's text instead.

type Role = "user" | "voice";
type Answer = { text: string; spoken: boolean; at: number };
// A connected voice starts a read-out within a second or two; past this, Pi's text shows meanwhile.
const READOUT_WAIT_MS = 8000;
type Turn = {
  id: string; role: Role; text: string; final?: string; interrupted?: boolean; board: FlapBoard;
  answer?: Answer;
  before?: string; // an answer's read-out so far, when it goes on after a pause
  open?: boolean;   // the written answer above a read-out, expanded by a click
};

export type ChatHost = {
  /** Saves the placeholder entry; Pi draws it at once through `component`. */
  append(turn: SpokenTurn): void;
  /** Adds the kept turn to Pi's conversation (hidden; the placeholder shows it). */
  send(message: { customType: string; content: string; display: false; details: SpokenSaid }): void;
  /** Saves a read-out of Pi's answer, for the chat only. */
  save(readout: SpokenReadout): void;
  /** Whether a voice connection is open to read a result out now. */
  speaking(): boolean;
  /** Reduced motion: words appear without flipping in. */
  still?(): boolean;
};

/** A short id for an answer's text block (the same text always gives the same id). */
export function answerHash(text: string): string {
  return createHash("sha1").update(text.trim()).digest("hex").slice(0, 16);
}

/** The text blocks of a finished assistant answer (it called no tools), or nothing. */
export function answerBlocks(message: unknown): string[] | undefined {
  const m = message as { role?: string; stopReason?: string; content?: unknown };
  if (m?.role !== "assistant" || m.stopReason !== "stop" || !Array.isArray(m.content)) return undefined;
  if (m.content.some((part: any) => part?.type === "toolCall")) return undefined;
  const blocks = m.content.filter((part: any) => part?.type === "text" && part.text.trim()).map((part: any) => part.text.trim() as string);
  return blocks.length ? blocks : undefined;
}

/**
 * Whether an answer can be read out in its place: short, and nothing that only
 * works on screen (code blocks, lists, tables, headings). Longer or structured
 * answers stay as Pi's text.
 */
export function speakable(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 600) return false;
  return !/```|^\s{0,3}([-*+]|\d+[.)])\s|^\s*\|.*\||^#{1,6}\s/m.test(t);
}

/** Pi's answer as plain text: inline emphasis and code marks dropped. */
const plain = (text: string) => text.replace(/\*\*|__|`/g, "").replace(/\s*\n\s*/g, " ").trim();

/**
 * Spoken text laid out like Pi's own messages: the user's on the typed-message
 * band (a blank band row above and below), the voice's as assistant text.
 * `paint` styles a [from, to) slice of the text.
 */
export function spokenLines(text: string, user: boolean, width: number, theme: Theme,
  paint: (from: number, to: number) => string = (from, to) => theme.fg(user ? "userMessageText" : "text", text.slice(from, to))): string[] {
  const rows = wrapWords(text, Math.max(4, width - 2)).map(([from, to]) => ` ${paint(from, to)}`);
  if (!user) return rows;
  const band = (row: string) => theme.bg("userMessageBg", row + " ".repeat(Math.max(0, width - visibleWidth(row))));
  return [band(""), ...rows.map(band), band("")];
}

export class SpokenChat {
  private turns = new Map<string, Turn>();
  private open: Partial<Record<Role, Turn>> = {};
  private hiddenBlocks = new Set<string>();
  private seq = 0;
  private host: ChatHost;
  private now: () => number;

  constructor(host: ChatHost, now: () => number = Date.now) { this.host = host; this.now = now; }

  /** The session's saved turns and answers (every branch), so their placeholders redraw on resume. */
  load(entries: readonly unknown[]) {
    const blocks = new Map<string, string>(), readouts = new Map<string, SpokenReadout>();
    for (const entry of entries as any[]) {
      if (entry?.type === "message") for (const block of answerBlocks(entry.message) ?? []) blocks.set(answerHash(block), block);
      if (entry?.type === "custom" && entry.customType === SPOKEN_READOUT && entry.data?.id) readouts.set(entry.data.id, entry.data);
    }
    for (const entry of entries as any[]) {
      const said = entry?.type === "custom_message" && entry.customType === SPOKEN_MESSAGE ? entry.details as SpokenSaid : undefined;
      if (said?.id && typeof said.text === "string" && !this.turns.has(said.id)) {
        this.turns.set(said.id, { id: said.id, role: said.role, text: said.text, final: said.text, interrupted: said.interrupted, board: new FlapBoard() });
      }
      const turn = entry?.type === "custom" && entry.customType === SPOKEN_TURN ? entry.data as SpokenTurn : undefined;
      if (turn?.id && Array.isArray(turn.answer) && !this.turns.has(turn.id)) {
        for (const hash of turn.answer) this.hiddenBlocks.add(hash);
        const readout = readouts.get(turn.id);
        const text = turn.answer.map(hash => blocks.get(hash)).filter(Boolean).join("\n\n");
        this.turns.set(turn.id, { id: turn.id, role: "voice", text: "", final: readout?.text, interrupted: readout?.interrupted, board: new FlapBoard(), answer: { text, spoken: false, at: 0 } });
      }
    }
  }

  /** Whether the chat is moving: words playing in, or an answer waiting to show Pi's text if no read-out comes. */
  animating(now = this.now()): boolean {
    if (this.open.user || this.open.voice) return true;
    for (const turn of this.turns.values()) {
      const a = turn.answer;
      if (a?.spoken && !(turn.final ?? turn.text) && now - a.at < READOUT_WAIT_MS + 200) return true;
    }
    return false;
  }

  /** Whether Pi's answer text (one Markdown block) is hidden because its read-out stands in for it. */
  hidden(markdown: string): boolean { return this.hiddenBlocks.size > 0 && this.hiddenBlocks.has(answerHash(markdown)); }

  /** Hides an answer's text blocks as Pi finishes it (before Pi draws it). */
  hide(blocks: string[]) { for (const block of blocks) this.hiddenBlocks.add(answerHash(block)); }

  /**
   * The placeholder for a hidden answer, where its read-out plays in; `spoken`
   * false when no read-out will come (it shows Pi's text). Returns its id.
   */
  answer(blocks: string[], spoken = true): string {
    const id = this.newId();
    this.turns.set(id, { id, role: "voice", text: "", board: new FlapBoard(), answer: { text: blocks.join("\n\n"), spoken, at: this.now() } });
    this.host.append({ id, role: "voice", answer: blocks.map(answerHash) });
    return id;
  }

  /** Someone is speaking: their turn plays in the chat, starting a new one if needed; `answer` routes a read-out to its placeholder. */
  live(role: Role, text: string, answer?: string) {
    if (!text) return;
    const turn = answer ? this.turns.get(answer) : undefined;
    if (turn?.answer) {
      if (turn.final !== undefined) { turn.before = turn.final; turn.final = undefined; } // it goes on after a pause
      turn.text = turn.before ? `${turn.before} ${text}` : text;
      this.open[role] = turn;
      return;
    }
    (this.open[role] ?? this.begin(role)).text = text;
  }

  /** The turn is over: it settles into `text` ("" hides it) and, if anything is kept, joins Pi's conversation (or, for a read-out, the chat). */
  settle(role: Role, text: string, interrupted: boolean, answer?: string) {
    const read = answer ? this.turns.get(answer) : undefined;
    if (read?.answer) {
      if (this.open[role] === read) this.open[role] = undefined;
      const final = [read.before, text].filter(Boolean).join(" ");
      if (!final) return;
      read.final = read.text = final;
      read.interrupted = interrupted;
      this.host.save(interrupted ? { id: read.id, text: final, interrupted } : { id: read.id, text: final });
      return;
    }
    const turn = this.open[role] ?? (text ? this.begin(role, text) : undefined);
    this.open[role] = undefined;
    if (!turn) return;
    turn.final = text;
    turn.interrupted = interrupted;
    if (!text) return;
    turn.text = text;
    this.host.send({
      customType: SPOKEN_MESSAGE,
      content: spokenContent(role, text, interrupted),
      display: false,
      details: interrupted ? { id: turn.id, role, text, interrupted } : { id: turn.id, role, text },
    });
  }

  private newId() { return `${this.now().toString(36)}-${(this.seq++).toString(36)}`; }

  private begin(role: Role, final?: string): Turn {
    const id = this.newId();
    const turn: Turn = { id, role, text: final ?? "", final, board: new FlapBoard() };
    this.turns.set(id, turn); // before the entry: Pi draws it as it is appended
    this.open[role] = turn;
    this.host.append({ id, role });
    return turn;
  }

  /**
   * The chat component for a placeholder entry, or nothing (a dropped turn, or
   * one this session never saved). An answer's placeholder is Pi's written answer
   * (collapsed once a read-out exists; a click or `expanded`, Ctrl+O, opens it)
   * above the read-out.
   */
  component(id: string | undefined, theme: Theme, expanded = false) {
    const turn = id ? this.turns.get(id) : undefined;
    if (!turn || (!turn.answer && turn.final === "")) return undefined;
    if (!turn.answer) return { invalidate() {}, render: (width: number) => this.lines(turn, width, theme) };
    const answer = turn.answer;
    const written = { invalidate() {}, render: (width: number) => this.writtenLines(turn, answer, width, theme, expanded) };
    const box = new Container();
    box.addChild(new MouseRegion(written, event => {
      if (event.type !== "click" || event.button !== "left" || !(turn.final ?? turn.text)) return undefined;
      turn.open = !turn.open;
      return { handled: true };
    }));
    box.addChild({ invalidate() {}, render: (width: number) => (turn.final ?? turn.text) ? ["", ...this.lines(turn, width, theme)] : [] });
    return box;
  }

  /** Pi's written answer: in full until a read-out exists (unless the voice is about to say it), then a label to click open. */
  private writtenLines(turn: Turn, answer: Answer, width: number, theme: Theme, expanded: boolean): string[] {
    const full = () => spokenLines(plain(answer.text), false, width, theme);
    if (turn.final ?? turn.text) return expanded || turn.open ? full() : [` ${theme.italic(theme.fg("thinkingText", "Written answer"))}`];
    const coming = answer.spoken && this.host.speaking() && this.now() - answer.at < READOUT_WAIT_MS;
    return coming ? [] : full();
  }

  private lines(turn: Turn, width: number, theme: Theme): string[] {
    const text = turn.final ?? turn.text;
    if (!text) return []; // dropped after it started: only Pi's spacer stays
    const user = turn.role === "user";
    // Each character as shown (flipping glyphs while live) and its state.
    const shown = [...text], state: FlapTile["state"][] = shown.map(() => "still");
    if (turn.final === undefined && !this.host.still?.()) {
      let i = 0;
      for (const tile of turn.board.tiles(text, this.now())) for (const char of tile.text) { shown[i] = char; state[i++] = tile.state; }
    }
    const fg = user
      ? { flip: "dim", glow: "accent", still: "userMessageText" } as const
      : { flip: "dim", glow: "success", still: "text" } as const;
    const paint = (from: number, to: number) => {
      let out = "";
      for (let i = from; i < to; i++) out += theme.fg(fg[state[i]], shown[i]);
      return out;
    };
    return spokenLines(text, user, width, theme, paint);
  }
}
