// The voice model is Pi's mouth and ears; Pi's own agent does the work. These
// three tools hand requests to Pi, report what it is doing, and stop it. Pi's
// tools, permission prompts, and session transcript stay exactly as in the TUI.

/** Function tools sent to the Realtime session (OpenAI function-tool shape). */
export const PI_TOOLS = [
  {
    type: "function",
    name: "ask_pi",
    description: "Hand a request to Pi, the coding agent running in the user's terminal, which has the real access: files, shell, git, Basic Memory, the web. Returns immediately; Pi works in the background and an automatic update from Pi arrives with the result.",
    parameters: {
      type: "object",
      properties: {
        request: { type: "string", description: "The request in the user's own words, plus any context from this conversation Pi needs." },
        when: { type: "string", enum: ["now", "after"], description: "Only matters while Pi is busy. now: add to or correct the running task. after: queue as the next task. Default after." },
      },
      required: ["request"],
    },
  },
  {
    type: "function",
    name: "pi_status",
    description: "What Pi is doing right now: current request, last tool it ran, elapsed time, queued requests, whether it waits for approval in the terminal.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "cancel_pi",
    description: "Stop Pi's running task. Use when the user says stop, cancel, or never mind about Pi's work.",
    parameters: { type: "object", properties: {}, required: [] },
  },
] as const;

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

  /** Dispatches a Realtime function call; results are JSON-serializable and returned immediately. */
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
      this.task = request;
      this.startedAt = this.now();
      this.lastTool = undefined;
      this.lastText = "";
      this.voiceInRun = true;
      this.host.sendUserMessage(request);
      return { status: "started", note: "Pi is working on it. Do not state any result until Pi's automatic update arrives." };
    }
    this.voiceInRun = true;
    if (when === "now") {
      this.host.sendUserMessage(request, { deliverAs: "steer" });
      return { status: "steered", note: "Added to Pi's running task." };
    }
    this.queued.push(request);
    this.host.sendUserMessage(request, { deliverAs: "followUp" });
    return { status: "queued", position: this.queued.length, note: "Pi will start it after the current task." };
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
      queued: this.queued.length ? this.queued.map(q => clip(q, 120)) : undefined,
      approval: this.approval,
    };
  }

  cancel(): object {
    if (this.control.isIdle()) return { status: "idle", note: "Pi was not working on anything." };
    this.cancelledByVoice = true;
    this.control.abort();
    return { status: "cancelled", still_queued: this.control.hasPendingMessages() };
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
    this.progress(`Pi is working on "${clip(this.task ?? "the current task", 120)}"; it just ran ${this.lastTool}.`);
  }

  messageEnd(message: unknown) {
    const text = assistantText(message);
    if (text) this.lastText = text;
    // A queued follow-up starts as its user message lands.
    const m = message as { role?: string; content?: unknown };
    if (m?.role === "user" && this.queued.length) {
      const content = typeof m.content === "string" ? m.content : assistantText({ role: "assistant", content: m.content });
      const index = this.queued.findIndex(q => content.includes(q.slice(0, 200)));
      if (index !== -1) this.task = this.queued.splice(index, 1)[0];
    }
  }

  promptStart(title?: string) {
    this.approval = title ? clip(title, 160) : "a confirmation";
    if (this.voiceInRun && this.active) this.notice(`Pi is waiting for the user to answer a prompt in the terminal: ${this.approval}`);
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
      ? `Pi stopped ${subject} before finishing. Pi's last output: ${result}`
      : `Pi finished ${subject}. Pi's answer: ${result}`);
  }

  /** The voice session ended: stop emitting notices (Pi keeps running). */
  detach() {
    this.active = false;
  }
}
