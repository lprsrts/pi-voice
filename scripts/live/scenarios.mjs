// Real-life voice scenarios for the live harness. Each has one or more voice
// sessions of scripted turns (seconds after that voice session starts) and
// checks over what happened: what Pi received and did, what the voice said,
// and how fast. Every scenario also gets the common checks at the bottom.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const said = r => r.voiceLines.join(" ");
const check = (name, pass, detail = "") => ({ name, pass: !!pass, detail });
const CONFUSED = /not (entirely )?sure (what|which)|could you clarify|what do you mean|which .{0,40} (are you )?referring|can you (be more specific|clarify)/i;

export const SCENARIOS = {
  "quick-answer": {
    description: "A one-step question about the project, answered by running a command.",
    // Long enough for acoustic timing (speech through the air is slower to hand off); the latency check is separate.
    sessions: [{ seconds: 30, turns: [{ at: 1.5, say: "How many TypeScript files are in this repository? Just the number." }] }],
    checks: r => [
      check("Pi received the question", r.piRequests.some(q => /typescript/i.test(q))),
      check("Pi ran a tool to answer it", r.piTools.length > 0, r.piTools[0]),
      check("the voice spoke the result", r.results.length > 0 && /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|(thir|four|fif|six|seven|eigh|nine)teen|(twen|thir|for|fif)ty)\b/i.test(said(r)), said(r)),
      check("answer heard within 6 s of the end of speech", r.turns[0]?.resultHeard !== undefined && answerLatency(r) < 6, `${answerLatency(r)?.toFixed(2)} s`),
    ],
  },

  "status-and-stop": {
    description: "A long task, a status question while it runs, then stopping it.",
    sessions: [{ seconds: 34, turns: [
      { at: 1.5, say: "Run sleep 20 in the shell, then tell me it finished." },
      { at: 11, say: "What are you working on right now?" },
      { at: 19, say: "Stop that." },
    ] }],
    checks: r => [
      check("Pi started the long task", r.piTools.some(t => /sleep/.test(t)), r.piTools.find(t => /sleep/.test(t))),
      check("the status question did not reach Pi as a request", !r.piRequests.some(q => /working on right now/i.test(q))),
      check("the voice answered the status question", r.voiceLines.some(l => /sleep|wait|run|command|shell/i.test(l)), said(r)),
      check("\"stop\" aborted the task", r.aborted && r.bridgeCalls.includes("cancel_pi")),
    ],
  },

  "no-handoff-chitchat": {
    description: "Thinking aloud and small talk that ask for nothing: none of it may reach Pi as a request.",
    sessions: [{ seconds: 30, turns: [
      { at: 1.5, say: "Okay. Hmm, give me a second, I'm just thinking." },
      { at: 9, say: "I had way too much coffee this morning." },
      { at: 17, say: "Right, that makes sense. Thanks." },
    ] }],
    checks: r => [
      check("nothing was handed to Pi", r.piRequests.length === 0, r.piRequests.map(q => q.slice(0, 120)).join(" | ")),
      check("Pi ran no tools", r.piTools.length === 0, r.piTools.join(" | ")),
      check("the voice replied", r.voiceLines.length > 0, said(r)),
    ],
  },

  "cancel-mid-write": {
    description: "Stopping a task that is writing a file: the writes must stop when the voice says it stopped.",
    sessions: [{ seconds: 34, turns: [
      { at: 1.5, say: "Run a shell loop that appends the numbers one to forty to count.txt, one number per second." },
      { at: 15, say: "Stop that." },
    ] }],
    checks: r => {
      const file = join(r.cwd, "count.txt");
      const lines = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").length : 0;
      const abortAt = r.events.find(e => e.kind === "pi.settled" && e.data === "aborted")?.t;
      const lastWrite = existsSync(file) ? (statSync(file).mtimeMs - r.t0) / 1000 : undefined;
      return [
        check("the loop started writing", lines > 0, `${lines} lines`),
        check("\"stop\" aborted the task", r.aborted && r.bridgeCalls.includes("cancel_pi")),
        check("no write landed more than 2 s after the abort", abortAt !== undefined && lastWrite !== undefined && lastWrite - abortAt < 2, `abort ${abortAt?.toFixed(1)} s, last write ${lastWrite?.toFixed(1)} s, ${lines} lines`),
        check("the loop did not run to the end", lines < 40, `${lines} lines`),
        // A stop GPT-Live did not hand off must not be claimed (seen acoustically: "Stopping it." while it kept writing).
        check("the voice never claimed a stop that did not happen", r.aborted || !r.voiceLines.some(l => /\bstop(ped|ping)?\b/i.test(l) && !/\b(not|haven'?t|hasn'?t|didn'?t)\b/i.test(l)), said(r)),
      ];
    },
  },

  "connection-drop": {
    description: "The connection drops while Pi works: Pi keeps going, and its result is still spoken without the user restarting voice.",
    sessions: [{ seconds: 40, turns: [
      { at: 1.5, say: "Run sleep 15 in the shell, then tell me it finished." },
      { at: 10, drop: true },
    ] }],
    checks: r => [
      check("Pi kept working after the drop", !r.aborted && r.events.some(e => e.kind === "pi.settled" && e.data === ""), r.events.filter(e => e.kind === "pi.text").map(e => e.data).join(" | ").slice(0, 160)),
      check("the result was spoken in the same talk, without a manual restart", r.voiceLines.some((l, i) => /finish|done|slept|complete/i.test(l)) && r.events.some(e => e.kind === "result.heard"), said(r)),
      check("the drop was reported to the user", r.events.some(e => e.kind.startsWith("ui.")), r.events.filter(e => e.kind.startsWith("ui.")).map(e => e.data).join(" | ")),
    ],
  },

  "silent-link-loss": {
    description: "The link goes dead with no close (Wi-Fi gone, Mac asleep) while Pi works: voice notices within seconds and comes back for the result.",
    sessions: [{ seconds: 40, turns: [
      { at: 1.5, say: "Run sleep 15 in the shell, then tell me it finished." },
      { at: 10, blackhole: true },
    ] }],
    checks: r => {
      const lostAt = r.events.find(e => e.kind === "ui.warning")?.t;
      const holeAt = r.events.find(e => e.kind === "net.blackhole")?.t;
      return [
        check("the dead link was noticed within 12 s", lostAt !== undefined && lostAt - holeAt < 12, lostAt === undefined ? "never" : `${(lostAt - holeAt).toFixed(1)} s`),
        check("Pi kept working", !r.aborted && r.events.some(e => e.kind === "pi.settled" && e.data === "")),
        check("the result was spoken without a manual restart", r.events.some(e => e.kind === "result.heard"), said(r)),
      ];
    },
  },

  "stuck-at-result": {
    description: "GPT-Live gets stuck as Pi's result is sent (seen live): voice notices, reconnects once, and still says the result.",
    sessions: [{ seconds: 45, stuckOnResult: true, turns: [{ at: 1.5, say: "How many TypeScript files are in this repository? Just the number." }] }],
    checks: r => [
      check("the stuck session was noticed", r.events.some(e => e.kind === "ui.warning" && /Reconnecting to say the result/.test(e.data)), r.events.filter(e => e.kind.startsWith("ui.")).map(e => e.data).join(" | ")),
      check("the result was said after reconnecting", r.events.some(e => e.kind === "result.heard") && r.voiceLines.some(l => /\b(\d+|(thir|four|fif|six|seven|eigh|nine)teen|twelve|eleven|ten)\b/i.test(l)), said(r)),
      check("Pi was asked once", r.piRequests.length === 1),
    ],
  },

  "muted-quiet": {
    description: "Muted for a while, then unmuted to ask something: muting must not look like a dead link.",
    sessions: [{ seconds: 30, turns: [
      { at: 1, mute: true },
      { at: 13, mute: false },
      { at: 14, say: "How many TypeScript files are in this repository? Just the number." },
    ] }],
    checks: r => [
      check("no connection loss was reported while muted", !r.events.some(e => e.kind === "ui.warning" || e.kind === "ui.error"), r.events.filter(e => e.kind.startsWith("ui.")).map(e => e.data).join(" | ")),
      check("the question after unmuting reached Pi", r.piRequests.some(q => /typescript/i.test(q))),
    ],
  },

  "chitchat-while-busy": {
    description: "Small talk and thinking aloud while Pi works: Pi does not act on it, and the result is read out plainly.",
    sessions: [{ seconds: 36, turns: [
      { at: 1.5, say: "Run sleep 10 in the shell, then list the files in the providers folder." },
      { at: 10, say: "Thanks, no rush." },
      { at: 15, say: "I'm thinking we might also move the tests to vitest someday." },
    ] }],
    checks: r => [
      // Undelegated words may reach Pi as a remark; Pi must not act on small talk.
      check("no new task and no request steered from small talk", r.events.filter(e => e.kind === "pi.prompt").length === 1 && !r.events.some(e => e.kind === "pi.steer" && /^Voice request/.test(e.data)), r.events.filter(e => /^pi\.(prompt|steer)$/.test(e.kind)).map(e => e.data.slice(0, 50)).join(" | ")),
      check("Pi did not act on the vitest musing", !r.piTools.some(t => /vitest/i.test(t)) && !r.events.some(e => e.kind === "pi.text" && /vitest/i.test(e.data)), r.events.filter(e => e.kind === "pi.text").map(e => e.data.slice(0, 80)).join(" | ")),
      check("package.json untouched", !r.piTools.some(t => /^(edit|write)\b/.test(t))),
      check("the result was read out", r.events.some(e => e.kind === "result.heard"), said(r)),
      check("no \"not done\" note about small talk", !r.voiceLines.some(l => /vitest|not done|wasn'?t done|didn'?t (do|get)/i.test(l)), said(r)),
    ],
  },

  "correction-at-finish": {
    description: "A correction said just as Pi finishes: it cannot reach the task, so the voice must say that part was not done.",
    sessions: [{ seconds: 34, turns: [
      { at: 1.5, say: "Run sleep 6 in the shell, then list the files in the providers folder." },
      { at: 14, say: "Actually, list the files in the tests folder instead." },
    ] }],
    checks: r => {
      const done = r.results.some(t => /voice\.test|tests/i.test(t));
      return [
        check("the voice did not claim work Pi did not do", done || !r.voiceLines.some(l => /tests/i.test(l) && !/not|didn|wasn|haven|yet/i.test(l)), said(r)),
        check("a missed correction was said to be not done", done || r.voiceLines.some(l => /tests/i.test(l) && /not|didn|wasn|haven|yet/i.test(l)), said(r)),
      ];
    },
  },

  "restart-memory": {
    description: "Voice is stopped mid-task and restarted: it must know what it is doing and still report the result.",
    sessions: [
      { seconds: 12, turns: [{ at: 1.5, say: "Run sleep 25 in the shell, then tell me how long it took." }] },
      // Autopause may close it while Pi works; the result reopens it and needs time to be said.
      { seconds: 40, turns: [{ at: 2, say: "What are you working on right now?" }] },
    ],
    checks: r => [
      check("the second voice session was briefed on the running task", /still working on "[^"]*sleep/i.test(r.briefings[1] ?? ""), (r.briefings[1] ?? "").split("\n").at(-1)),
      check("it answered from memory, not by asking Pi", r.piRequests.filter(q => /working on right now/i.test(q)).length === 0),
      check("it knew what it was doing", r.voiceLines.some(l => /sleep|timing|wait|25/i.test(l)), said(r)),
      check("the result was announced after the restart", r.results.some(t => /finished/i.test(t)) && r.voiceLines.some(l => /\b(25|twenty[- ]five|seconds?)\b/i.test(l))),
    ],
  },

  "multi-turn-context": {
    description: "An explanation over several turns with pauses, then a question that refers to it (reported live).",
    sessions: [{ seconds: 55, turns: [
      { at: 1.5, say: "I'm thinking about adding a debug log to live.ts, in the delegate method." },
      { at: 9, say: "It would print the delegation id whenever a request is handed off to you." },
      { at: 17, say: "Does that single line addition work in the current structure? Do we need anything else?" },
    ] }],
    checks: r => {
      const asked = r.piRequests.filter(q => /single[- ]line/i.test(q)).at(-1) ?? "";
      const answer = r.events.filter(e => e.kind === "pi.text").map(e => e.data).join(" ");
      const askedAt = r.events.find(e => e.kind.startsWith("pi.") && /single[- ]line/i.test(e.data))?.t ?? Infinity;
      const earlyEdits = r.events.filter(e => e.kind === "pi.tool" && /^(edit|write)\b/.test(e.data) && e.t < askedAt);
      return [
        check("no files were changed while the user was only explaining", earlyEdits.length === 0, earlyEdits.map(e => e.data).join(" | ")),
        check("the question reached Pi", !!asked),
        check("with the explanation it refers to (or Pi already had it)", /delegate/i.test(asked) || r.piRequests.some(q => /delegate method/i.test(q) && !/single line/i.test(q)) || r.spoken.some(line => /^user: .*delegate method/i.test(line)), asked.slice(0, 300)),
        // A missing answer is a timeout, reported by "the voice answered" below.
        check("Pi was not confused about what was meant", !CONFUSED.test(answer), answer.slice(0, 200)),
        check("a question about a change was answered, not acted on", !r.events.some(e => e.kind === "pi.tool" && /^(edit|write)\b/.test(e.data)), r.events.filter(e => e.kind === "pi.tool" && /^(edit|write)\b/.test(e.data)).map(e => e.data.slice(0, 80)).join(" | ")),
        check("the voice answered", r.results.length > 0, said(r).slice(0, 200)),
      ];
    },
  },

  "autopause": {
    description: "Silence while Pi works pauses the (billed) voice connection; Pi's result brings it back to say it.",
    pauseAfter: { busy: 8, idle: 60 },
    sessions: [{ seconds: 55, keepOpen: true, turns: [{ at: 1.5, say: "Run sleep 30 in the shell, then tell me it finished." }] }],
    checks: r => {
      const settled = r.events.find(e => e.kind === "pi.settled")?.t ?? Infinity;
      const connects = r.events.filter(e => e.kind === "voice.connect");
      const spokenAfter = r.events.filter(e => e.kind === "voice.says" && e.t > settled).map(e => e.data);
      return [
        check("voice paused while Pi worked", r.events.some(e => e.kind === "ui.info" && /paused while I work/.test(e.data))),
        check("Pi's result reopened voice", connects.some(e => e.t >= settled - 0.5), connects.map(e => e.t.toFixed(1)).join(", ")),
        check("the result was spoken after reopening", spokenAfter.length > 0, spokenAfter.join(" ")),
        check("billed voice time well under the wall time", r.voiceSeconds < r.wallSeconds - 15, `${r.voiceSeconds.toFixed(1)} s connected of ${r.wallSeconds.toFixed(1)} s`),
      ];
    },
  },

  "result-after-stop": {
    description: "Voice is stopped by the user, the task finishes meanwhile, and the next /talk start says the result unprompted.",
    sessions: [
      { seconds: 10, waitAfter: 22, turns: [{ at: 1.5, say: "Run sleep 15 in the shell, then tell me it finished." }] },
      { seconds: 15, turns: [] },
    ],
    checks: r => {
      const reopened = r.events.filter(e => e.kind === "talk.start")[1]?.t ?? Infinity;
      const settled = r.events.find(e => e.kind === "pi.settled")?.t ?? Infinity;
      const spoken = r.events.filter(e => e.kind === "voice.says" && e.t > reopened).map(e => e.data);
      return [
        check("the task finished while voice was off", settled < reopened, `settled ${settled.toFixed(1)} s, reopened ${reopened.toFixed(1)} s`),
        check("the result was handed to the new connection", r.events.some(e => e.kind === "result" && e.t > reopened)),
        check("and spoken without being asked", spoken.length > 0, spoken.join(" ")),
      ];
    },
  },

  "correction-mid-task": {
    description: "A correction while the task runs is added to it, and the answer follows the correction.",
    sessions: [{ seconds: 40, turns: [
      { at: 1.5, say: "Run sleep 10 in the shell, then list the files in the providers folder." },
      { at: 9, say: "Actually, list the files in the tests folder instead." },
    ] }],
    checks: r => [
      check("the correction went into the running task", r.events.some(e => e.kind === "pi.steer" && /tests folder/i.test(e.data)), r.events.find(e => e.kind === "pi.steer")?.data?.slice(0, 120)),
      check("the answer follows the correction", r.results.some(t => /voice\.test|tests/i.test(t)), r.results.at(-1)?.slice(0, 200)),
      // Never claim the correction was done when Pi did not do it.
      check("the voice did not claim work Pi did not do", r.results.some(t => /voice\.test|tests/i.test(t)) || !r.voiceLines.some(l => /tests folder/i.test(l) && !/not|didn|wasn/i.test(l)), said(r)),
    ],
  },
};

/** End of the speech that was answered (the last turn before the first result) to that result heard. */
export function answerLatency(r) {
  const result = r.events.find(e => e.kind === "result");
  const heard = r.events.find(e => e.kind === "result.heard");
  if (!result || !heard) return undefined;
  const end = r.turns.filter(t => t.end !== undefined && t.end < result.t).at(-1)?.end;
  return end === undefined ? undefined : heard.t - end;
}

/** Checks every scenario gets. */
export function commonChecks(r) {
  const thirdPerson = r.voiceLines.filter(l => /\bPi\s+(is|was|has|will|did|finished|stopped|found|ran|started|can|could)\b/i.test(l) || /\bthe (backend|agent)\b/i.test(l));
  return [
    check("the voice spoke in the first person (never \"Pi is…\" or \"the backend\")", thirdPerson.length === 0, thirdPerson.join(" | ")),
    check("no GPT-Live or pi-voice errors", r.errors.length === 0, r.errors.join(" | ")),
  ];
}
