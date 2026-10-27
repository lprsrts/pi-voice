#!/usr/bin/env node
// Runs live voice scenarios against real GPT-Live and a real Pi session.
//
//   node scripts/live/run.mjs [scenario ...|all] [--audio inject|acoustic|silent]
//                             [--runs N] [--model provider/id] [--cwd DIR] [--record DIR] [--quiet]
//
// By default Pi works in a disposable copy of this repository, so it can edit
// files freely; --cwd points it at another project (which it may change).
// Costs real money: GPT-Live voice time ($0.05/min), text-to-speech for the
// scripted lines (cached after the first run), and your Pi model's tokens.
import { REPO, runScenario, scratchCopy } from "./harness.mjs";
import { SCENARIOS, answerLatency, commonChecks } from "./scenarios.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i === -1 ? fallback : args.splice(i, 2)[1]; };
const flag = name => { const i = args.indexOf(`--${name}`); if (i === -1) return false; args.splice(i, 1); return true; };
const audio = option("audio", "inject");
const runs = Number(option("runs", "1"));
const model = option("model", undefined);
const cwdOption = option("cwd", undefined);
const recordDir = option("record", undefined);
const quiet = flag("quiet");
if (flag("help") || flag("h")) {
  console.log(`Scenarios:\n${Object.entries(SCENARIOS).map(([name, s]) => `  ${name.padEnd(22)}${s.description}`).join("\n")}\n\nOptions: --audio inject|acoustic|silent  --runs N  --model provider/id  --cwd DIR  --record DIR  --quiet`);
  process.exit(0);
}
if (!["inject", "acoustic", "silent"].includes(audio)) throw new Error(`Unknown --audio ${audio}.`);
const names = !args.length || args.includes("all") ? Object.keys(SCENARIOS) : args;
for (const name of names) if (!SCENARIOS[name]) throw new Error(`Unknown scenario "${name}". Run with --help for the list.`);
if (audio === "acoustic") console.log("Acoustic mode: lines are played through the speakers and voice processing is off (it would cancel them). Use speakers, not headphones.");

const summary = [];
let voiceSeconds = 0;
for (const name of names) {
  for (let run = 1; run <= runs; run++) {
    const cwd = cwdOption ?? scratchCopy(REPO);
    console.log(`\n=== ${name}${runs > 1 ? ` (run ${run}/${runs})` : ""} — ${SCENARIOS[name].description}`);
    console.log(`    audio: ${audio}, working directory: ${cwd}`);
    const print = (t, kind, data) => {
      if (quiet && !/^(user\.says|voice\.says|pi\.(prompt|steer|followUp|tool|abort)|result|delegation|bridge\.(pi_status|cancel_pi)|error|gpt-live\.error)/.test(kind)) return;
      console.log(`${t.toFixed(2).padStart(7)}s  ${kind.padEnd(14)} ${String(data).replace(/\s+/g, " ").slice(0, 150)}`);
    };
    let r;
    try {
      r = await runScenario(SCENARIOS[name], { audio, cwd, model, log: print, record: recordDir && `${recordDir}/${name}-${run}.jsonl` });
    } catch (error) {
      console.log(`    FAILED TO RUN: ${error instanceof Error ? error.message : error}`);
      summary.push({ name, run, model: model ?? "default", passed: 0, total: 1, latency: undefined });
      continue;
    }
    voiceSeconds += r.voiceSeconds;
    const checks = [...SCENARIOS[name].checks(r), ...commonChecks(r)];
    console.log(`    Pi model: ${r.model}`);
    for (const c of checks) console.log(`    ${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.detail && !c.pass ? `\n          ${String(c.detail).replace(/\s+/g, " ").slice(0, 300)}` : ""}`);
    const turns = r.turns.map(t => `"${t.say.slice(0, 32)}…" reply heard ${t.replyHeard?.toFixed(2) ?? "–"} s, result heard ${t.resultHeard?.toFixed(2) ?? "–"} s after it`);
    if (turns.length) console.log(`    timing:\n      ${turns.join("\n      ")}`);
    if (r.frameGaps?.length) {
      const gaps = r.frameGaps.map(g => g.ms).sort((a, b) => a - b);
      const top = r.frameGaps.toSorted((a, b) => b.ms - a.ms).slice(0, 3).map(g => `${g.ms} ms before ${g.after}`).join(", ");
      console.log(`    server frame gaps: n ${gaps.length}, p50 ${gaps[gaps.length >> 1]} ms, p99 ${gaps[Math.floor(gaps.length * 0.99)]} ms, max ${gaps.at(-1)} ms (${top})`);
    }
    console.log(`    voice connected (billed): ${r.voiceSeconds.toFixed(1)} s of ${r.wallSeconds.toFixed(1)} s`);
    summary.push({ name, run, model: r.model, passed: checks.filter(c => c.pass).length, total: checks.length, latency: answerLatency(r) });
  }
}

console.log("\n=== Summary");
for (const s of summary) {
  console.log(`  ${s.passed === s.total ? "PASS" : "FAIL"}  ${`${s.name}${runs > 1 ? ` #${s.run}` : ""}`.padEnd(26)} ${`${s.passed}/${s.total} checks`.padEnd(12)} ${s.latency !== undefined ? `end of speech → answer heard ${s.latency.toFixed(2)} s` : ""}  [${s.model}]`);
}
console.log(`  GPT-Live voice time: ${(voiceSeconds / 60).toFixed(1)} min (≈ $${(voiceSeconds / 60 * 0.05).toFixed(2)})`);
process.exit(summary.every(s => s.passed === s.total) ? 0 : 1);
