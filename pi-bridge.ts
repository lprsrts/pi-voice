// The voice and the Pi session are one agent: the voice is its mouth and ears,
// the Pi session its hands and reasoning. The bridge hands requests to the Pi
// session (ask_pi), reports what it is doing (pi_status), and stops it
// (cancel_pi). Tools, permission prompts, and the transcript stay as in the TUI.
// Everything the voice is told about the work is in the first person, since
// the work is its own.

// Added to Pi's system prompt while a voice session runs: the voice is Pi's own
// voice, so its answers are heard rather than read.
export const VOICE_PROMPT = [
  "You are speaking with the user right now: a live voice (GPT-Live) is your own voice and ears in this session. It hears the user, passes their requests to you, and speaks your final answer aloud in your name, possibly paraphrased. You and the voice are one agent, not two.",
  "Messages that start with \"Voice request\" are speech transcripts: they can contain recognition errors, missing punctuation, or half-finished phrases. The first line is the request; it can be followed by what was said since the previous request (the user's earlier turns and what you said by voice), which is what the request refers to: read it before acting. Interpret sensibly; ask only if you truly cannot act.",
  "Do the work exactly as you would for typed requests, with your usual tools and care. When the user is thinking aloud, describing a plan, or asking a question about a change (\"would this work?\", \"do we need anything else?\"), look and answer the question; do not change files until they ask you to make the change.",
  "End with a short answer meant to be spoken: the outcome first, one to three sentences, no code, paths, tables, or long lists unless asked. Details stay in the terminal.",
].join("\n");

/** The parts of Pi's ExtensionAPI and ExtensionContext the bridge needs (keeps it testable). */
export type PiHost = {
  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): unknown;
};
export type PiControl = {
  isIdle(): boolean;
  abort(): void;
  hasPendingMessages(): boolean;
};

/** An update the voice model should tell the user about at the next quiet moment. */
export type Notice = (text: string) => void;
/** Silent background context (only providers with such a channel, e.g. GPT-Live thinking). */
export type Progress = (text: string) => void;

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** How a voice request is introduced to Pi (the system prompt section explains it). */
export const VOICE_REQUEST = "Voice request (speech transcript; may contain recognition errors): ";
/** Introduces the spoken conversation a voice request refers to. */
export const CONVERSATION_MARK = "\n\nWhat we said since my last request, oldest first:\n";
/** The user's words of a request, without the voice framing, for status and notices. */
const spokenPart = (request: string) => request.startsWith(VOICE_REQUEST) ? request.slice(VOICE_REQUEST.length).split(CONVERSATION_MARK)[0] : request;

/** One-line, bounded description of a tool call for pi_status. */
export function describeTool(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const detail = typeof a.command === "string" ? a.command
    : typeof a.path === "string" ? a.path
    : typeof a.file_path === "string" ? a.file_path
    : typeof a.query === "string" ? a.query
    : typeof a.pattern === "string" ? a.pattern
    : "";
  return clip(detail ? `${name}: ${detail.replace(/\s+/g, " ")}` : name, 160);
}

export function assistantText(message: unknown): string {
  const m = message as { role?: string; content?: unknown };
  if (m?.role !== "assistant" || !Array.isArray(m.content)) return "";
  return m.content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("\n").trim();
}

/** Text of a user message (string or content parts). */
function userText(message: any): string {
  if (message?.role !== "user") return "";
  if (typeof message.content === "string") return message.content.trim();
  return Array.isArray(message.content) ? message.content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("\n").trim() : "";
}

const BRIEFING_CHARS = 4000;

/**
 * What a new voice session should know, in the first person: the voice starts
 * blank each time, but the Pi session holds the conversation and the work.
 * Built from the session branch (latest compaction summary, then recent user
 * requests and answers) plus the work running right now.
 */
export function sessionBriefing(entries: readonly any[], options: { cwd?: string; status?: any } = {}): string {
  let summary = "";
  const turns: string[] = [];
  for (const entry of entries) {
    if (entry?.type === "compaction" && typeof entry.summary === "string") { summary = entry.summary; turns.length = 0; continue; }
    if (entry?.type !== "message") continue;
    const user = userText(entry.message);
    if (user) {
      const spoken = user.startsWith(VOICE_REQUEST);
      turns.push(`- The user (${spoken ? "spoken" : "typed"}): ${clip(spokenPart(user).replace(/\s+/g, " "), 300)}`);
      continue;
    }
    const answer = assistantText(entry.message);
    if (answer) turns.push(`- Me: ${clip(answer.replace(/\s+/g, " "), 400)}`);
  }
  const lines = ["What I know about this session (my own memory; the work below is mine):"];
  if (options.cwd) lines.push(`Working directory: ${options.cwd}`);
  let budget = BRIEFING_CHARS - (summary ? Math.min(summary.length, 1200) : 0);
  const recent: string[] = [];
  for (let i = turns.length - 1; i >= 0 && budget - turns[i].length > 0; i--) { recent.unshift(turns[i]); budget -= turns[i].length; }
  if (summary) lines.push(`Earlier in this session (summary): ${clip(summary.replace(/\s+/g, " "), 1200)}`);
  lines.push(recent.length ? `Recent conversation, oldest first:\n${recent.join("\n")}` : "Nothing has been said in this session yet.");
  const status = options.status;
  if (status && status.state !== "idle") {
    const waiting = status.state === "waiting_for_approval" ? ` I'm waiting for the user to answer a prompt in the terminal${status.approval ? `: ${status.approval}` : ""}.` : "";
    lines.push(`Right now I'm still working on "${status.task ?? "a task"}"${status.last_tool ? `; last step: ${status.last_tool}` : ""}.${waiting} Its result will arrive as an update.`);
  } else lines.push("Right now nothing is running.");
  return lines.join("\n");
}

export class PiBridge {
  private host: PiHost;
  private control: PiControl;
  private notice: Notice;
  private now: () => number;
  private task?: string;          // first voice request of the current run
  private startedAt = 0;
  private voiceInRun = false;     // announce the outcome only for runs voice asked for
  private cancelledByVoice = false; // the voice model already confirmed the cancellation
  private lastTool?: string;
  private lastText = "";
  private queued: string[] = [];
  private approval?: string;
  private active = true;
  private progress?: Progress;
  private lastProgressAt = -Infinity;

  constructor(host: PiHost, control: PiControl, notice: Notice, now = () => Date.now(), progress?: Progress) {
    this.host = host;
    this.control = control;
    this.notice = notice;
    this.now = now;
    this.progress = progress;
  }

  /** Dispatches a bridge call by name; results are JSON-serializable and returned immediately. */
  call(name: string, args: Record<string, unknown>): object {
    if (name === "ask_pi") return this.ask(String(args.request ?? ""), args.when === "now" ? "now" : "after");
    if (name === "pi_status") return this.status();
    if (name === "cancel_pi") return this.cancel();
    return { error: `Unknown tool ${name}.` };
  }

  ask(request: string, when: "now" | "after"): object {
    request = request.trim();
    if (!request) return { error: "Empty request; ask the user what Pi should do." };
    request = clip(request, 4000);
    if (this.control.isIdle()) {
      this.task = spokenPart(request);
      this.startedAt = this.now();
      this.lastTool = undefined;
      this.lastText = "";
      this.voiceInRun = true;
      this.host.sendUserMessage(request);
      return { status: "started", note: "Started on it. Do not state any result until the update with the result arrives." };
    }
    this.voiceInRun = true;
    if (when === "now") {
      this.host.sendUserMessage(request, { deliverAs: "steer" });
      return { status: "steered", note: "Added to the running task." };
    }
    this.queued.push(request);
    this.host.sendUserMessage(request, { deliverAs: "followUp" });
    return { status: "queued", position: this.queued.length, note: "Queued after the current task." };
  }

  status(): object {
    if (this.control.isIdle()) {
      return { state: "idle", last_result: this.lastText ? clip(this.lastText, 600) : undefined };
    }
    return {
      state: this.approval ? "waiting_for_approval" : "working",
      task: this.task ?? "a task started from the terminal",
      elapsed_s: this.startedAt ? Math.round((this.now() - this.startedAt) / 1000) : undefined,
      last_tool: this.lastTool,
      latest_text: this.lastText ? clip(this.lastText, 400) : undefined,
      queued: this.queued.length ? this.queued.map(q => clip(spokenPart(q), 120)) : undefined,
      approval: this.approval,
    };
  }

  cancel(): object {
    if (this.control.isIdle()) return { status: "idle", note: "Nothing was running." };
    this.cancelledByVoice = true;
    this.control.abort();
    return { status: "cancelled", still_queued: this.control.hasPendingMessages() };
  }

  /**
   * A voice session started while the Pi session is already working (e.g. the
   * user restarted voice mid-task): treat the run as voice-requested, so its
   * result is still announced, and remember the last answer for status.
   */
  adopt(task: string | undefined, lastAnswer: string | undefined) {
    if (lastAnswer) this.lastText = lastAnswer;
    if (this.control.isIdle()) return;
    this.voiceInRun = true;
    if (task) this.task = spokenPart(task);
  }

  // ---------- Pi events (wired by index.ts) ----------

  agentStart() {
    this.startedAt ||= this.now();
    this.lastTool = undefined; // a new run must not report the previous run's output
    this.lastText = "";
  }

  /** Progress is pulled through pi_status; providers with a silent channel also get it pushed, at most every 3 s. */
  toolStart(name: string, args: unknown) {
    this.lastTool = describeTool(name, args);
    if (!this.progress || !this.voiceInRun || !this.active || this.now() - this.lastProgressAt < 3000) return;
    this.lastProgressAt = this.now();
    this.progress(`Progress on my task "${clip(this.task ?? "the current task", 120)}": I just ran ${this.lastTool}.`);
  }

  messageEnd(message: unknown) {
    const text = assistantText(message);
    if (text) this.lastText = text;
    // A queued follow-up starts as its user message lands.
    const m = message as { role?: string; content?: unknown };
    if (m?.role === "user" && this.queued.length) {
      const content = typeof m.content === "string" ? m.content : assistantText({ role: "assistant", content: m.content });
      const index = this.queued.findIndex(q => content.includes(q.slice(0, 200)));
      if (index !== -1) this.task = spokenPart(this.queued.splice(index, 1)[0]);
    }
  }

  promptStart(title?: string) {
    this.approval = title ? clip(title, 160) : "a confirmation";
    if (this.voiceInRun && this.active) this.notice(`I'm blocked until the user answers a prompt in the terminal: ${this.approval}`);
  }

  promptEnd() {
    this.approval = undefined;
  }

  /** The run fully settled (no retries or queued continuations left). */
  settled(aborted: boolean) {
    const announce = this.voiceInRun && this.active && !(aborted && this.cancelledByVoice);
    this.cancelledByVoice = false;
    const task = this.task;
    this.voiceInRun = false;
    this.approval = undefined;
    this.task = undefined;
    this.startedAt = 0;
    this.queued = [];
    if (!announce) return;
    const subject = task ? `the task "${clip(task.replace(/[.!?\s]+$/, ""), 300)}"` : "its task";
    const result = this.lastText ? clip(this.lastText, 1500) : "(no text answer)";
    this.notice(aborted
      ? `I stopped ${subject} before finishing. My last output: ${result}`
      : `I finished ${subject}. My answer: ${result}`);
  }

  /** The voice session ended: stop emitting notices (Pi keeps running). */
  detach() {
    this.active = false;
  }
}
