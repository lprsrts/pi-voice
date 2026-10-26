import { dominantFrequency } from "./protocol.ts";

// The voice bar's motion language. The bar is one Gaussian beam: a fixed
// envelope with a carrier inside it. Every property of the beam means one thing:
//
//   colour     who owns the moment (you, the voice, Pi, nobody)
//   amplitude  energy: how loud, how busy
//   density    carrier cycles: pitch for audio, steady for Pi's work
//   drift      the carrier's phase velocity, in bar widths per second, so it
//              reads the same at any density. Rightward means coming to you (the
//              voice, Pi's progress), leftward means going from you (your speech
//              being taken in); a sway is presence without flow, frozen is blocked.
//
// What the bar shows follows from facts (barState), each state is one row of
// STATES, events add impulses (EVENTS), and TRANSITIONS sets how long each change
// takes. BarMotion turns all of it into dots; index.ts and the marketing renderer
// draw them. Nothing here touches the terminal, so it is all testable.

export type BarState = "off" | "paused" | "connecting" | "listening" | "hearing" | "speaking" | "working" | "error";
export const BAR_STATES: readonly BarState[] = ["off", "paused", "connecting", "listening", "hearing", "speaking", "working", "error"];
export type BarEvent = "handoff" | "tool" | "settled" | "interrupt" | "error";
export type ColorToken = "dim" | "accent" | "success" | "warning" | "error";

/** What is true right now; barState decides what the bar shows from it. */
export type BarFacts = {
  connection: "closed" | "connecting" | "open";
  /** Voice is on but its connection is closed until it comes back (auto-pause). */
  paused: boolean;
  /** Pi is working on a task. */
  busy: boolean;
  /** The voice's audio is playing. */
  speaking: boolean;
  /** The user's voice is coming in (recent mic level). */
  hearing: boolean;
};

/**
 * The state the facts call for. Whoever is talking owns the bar, and the user
 * wins over the voice (it yields when talked over); then Pi's work; then quiet.
 */
export function barState(facts: BarFacts): BarState {
  if (facts.connection === "connecting") return "connecting";
  if (facts.connection === "closed") return facts.paused ? "paused" : "off";
  if (facts.hearing) return "hearing";
  if (facts.speaking) return "speaking";
  if (facts.busy) return "working";
  return "listening";
}

// ---------- Drift profiles: velocity (bar widths per second) over time ----------

/** Velocity at `t` seconds into a state; `level` is the live signal (0-1) where a state follows one. */
export type Drift = (t: number, level: number) => number;
const TAU = Math.PI * 2;
const smooth = (u: number) => u * u * (3 - 2 * u);

export const DRIFT = {
  /** Steady flow. */
  constant: (v: number): Drift => () => v,
  /** Sway: the phase swings back and forth, no net flow. */
  sine: (amplitude: number, hz: number): Drift => t => amplitude * Math.sin(TAU * hz * t),
  /** A flinch that settles. */
  damped: (amplitude: number, hz: number, tau: number): Drift => t => amplitude * Math.exp(-t / tau) * Math.sin(TAU * hz * t),
  /** Spinning up (or down) to `to` over `ms`. */
  ramp: (to: number, ms: number): Drift => t => to * smooth(Math.min(1, (t * 1000) / ms)),
  /** Blocked: nothing flows. */
  frozen: (): Drift => () => 0,
  /** Flow that follows the signal: `base + gain × level`. */
  follow: (base: number, gain: number): Drift => (_t, level) => base + gain * level,
  /** Two profiles added. */
  sum: (a: Drift, b: Drift): Drift => (t, level) => a(t, level) + b(t, level),
  /** A profile that fades out after `ms` (the listening breath settles). */
  fade: (drift: Drift, ms: number): Drift => (t, level) => drift(t, level) * (1 - smooth(Math.min(1, (t * 1000) / ms))),
};

// ---------- States ----------

export type StateSpec = {
  color: ColorToken;
  /** Envelope height at `t` seconds in, from the live signal (0-1). */
  level: (t: number, signal: number) => number;
  /** Carrier cycles across the bar; `signal` is the live pitch in cycles, when there is one. */
  cycles: (signal: number) => number;
  drift: Drift;
  /** Which live signal the state follows. */
  source?: "input" | "output";
};

// How long the listening breath lasts before the bar settles still.
export const BREATH_MS = 6000;
// Paused: one slow pulse every this long, so a paused bar still says it is there.
export const PAUSE_PULSE_MS = 5000, PAUSE_PULSE_WIDTH_MS = 900;

const pulse = (t: number) => {
  const phase = (t * 1000) % PAUSE_PULSE_MS;
  return phase < PAUSE_PULSE_WIDTH_MS ? Math.sin(Math.PI * phase / PAUSE_PULSE_WIDTH_MS) ** 2 : 0;
};

export const STATES: Record<BarState, StateSpec> = {
  // Not connected: a flat, dim line.
  off: { color: "dim", level: () => 0, cycles: () => 5, drift: DRIFT.frozen() },
  // Paused until a result (or /talk start) brings it back: flat, with a slow pulse.
  paused: { color: "dim", level: t => 0.14 * pulse(t), cycles: () => 4, drift: DRIFT.frozen() },
  // Opening a connection: the beam grows from flat and starts to move.
  connecting: { color: "accent", level: t => 0.55 * smooth(Math.min(1, t / 0.6)), cycles: () => 6, drift: DRIFT.ramp(0.08, 600) },
  // Open and quiet: a faint breath that settles.
  listening: { color: "accent", level: () => 0.12, cycles: () => 5, drift: DRIFT.fade(DRIFT.sine(0.05, 0.2), BREATH_MS) },
  // You are talking: your voice drives it, flowing leftward (into the voice) while you speak.
  hearing: { color: "accent", level: (_t, s) => 0.12 + 0.88 * s, cycles: s => s, drift: DRIFT.follow(-0.02, -0.2), source: "input" },
  // The voice is talking: its audio drives it, flowing rightward (to you).
  speaking: { color: "success", level: (_t, s) => 0.1 + 0.9 * s, cycles: s => s, drift: DRIFT.follow(0.05, 0.15), source: "output" },
  // Pi is working: steady rightward progress.
  working: { color: "warning", level: () => 0.85, cycles: () => 8, drift: DRIFT.constant(0.07) },
  // Something failed: a red flinch that settles (the bar then shows the state the facts call for).
  error: { color: "error", level: t => 0.7 * Math.exp(-t / 0.5), cycles: () => 12, drift: DRIFT.damped(0.6, 3, 0.25) },
};

/** How long an error flinch shows before the bar returns to its state. */
export const ERROR_MS = 900;

// ---------- Events: impulses on top of the state ----------

export type EventSpec = {
  /** Phase displacement (bar widths) delivered over `ms` as a smooth sweep. */
  sweep?: { distance: number; ms: number };
  /** A velocity kick (bar widths per second) that decays with `tau` seconds. */
  kick?: { velocity: number; tau: number };
  /** An amplitude swell that decays with `tau`; `width` narrows it to the centre (a ripple). */
  swell?: { gain: number; tau: number; width?: number };
};

export const EVENTS: Record<BarEvent, EventSpec> = {
  // A request went to Pi: one sweep toward the work.
  handoff: { sweep: { distance: 0.35, ms: 500 } },
  // Pi started a tool: a beat of progress.
  tool: { kick: { velocity: 0.45, tau: 0.3 }, swell: { gain: 0.25, tau: 0.25 } },
  // A spoken turn settled into the chat: a ripple at the centre.
  settled: { swell: { gain: 1.2, tau: 0.3, width: 0.06 } },
  // The user talked over the voice: no impulse; the transition is the reaction.
  interrupt: {},
  error: {},
};

// ---------- Transitions: how long each change takes ----------

export type TransitionRule = { from?: BarState; to?: BarState; after?: BarEvent; ms: number };

/** First match wins. `after` matches an event in the last half second. */
export const TRANSITIONS: TransitionRule[] = [
  { after: "interrupt", to: "hearing", ms: 80 },   // the voice yields at once
  { to: "error", ms: 80 },
  { from: "error", ms: 400 },
  { to: "hearing", ms: 120 },                      // a reaction to your voice
  { from: "hearing", ms: 300 },                    // "I heard you"
  { after: "handoff", to: "working", ms: 500 },    // with the sweep
  { from: "working", to: "speaking", ms: 400 },    // the result resolves into the read-out
  { from: "connecting", ms: 500 },
  { to: "connecting", ms: 300 },
  { to: "paused", ms: 600 },                       // winding down
  { to: "off", ms: 600 },
  { ms: 250 },
];

export function transitionMs(from: BarState, to: BarState, recent: BarEvent[]): number {
  for (const rule of TRANSITIONS) {
    if (rule.from && rule.from !== from) continue;
    if (rule.to && rule.to !== to) continue;
    if (rule.after && !recent.includes(rule.after)) continue;
    return rule.ms;
  }
  return 250;
}

// ---------- Live signals ----------

const RATE = 24000, LOW_HZ = 80, HIGH_HZ = 4000;
// 16 cycles span log(HIGH_HZ / LOW_HZ); 9 per second is ~1.2 cycles in a 33 ms frame.
const MAX_LOG_HZ_PER_S = 9;

/**
 * Loudness and pitch of one audio stream, eased for drawing: fast attack, slower
 * release, a ~90 ms pitch glide. Adaptive gain normalises by the recent peak, so
 * quiet microphones still deflect; a floor keeps silence from amplifying noise.
 */
export class Meter {
  level = 0;
  private target = 0;
  private logHz = Math.log(200);
  private targetLogHz = Math.log(200);
  private peak = 0;
  private frame?: number[];
  private releaseUntil = 0;

  /** Feeds the newest frame (`fresh` false once it is stale) and eases toward it. */
  update(samples: number[], fresh: boolean, dt: number, now = 0) {
    this.peak *= Math.pow(0.985, dt * 30);
    if (!fresh || !samples.length) this.target = 0;
    else if (samples !== this.frame) {
      this.frame = samples;
      let peak = 0;
      for (const value of samples) peak = Math.max(peak, Math.abs(value));
      this.peak = Math.max(this.peak, peak);
      this.target = Math.min(1, peak / Math.max(this.peak, 0.06));
      const hz = this.target > 0.15 ? dominantFrequency(samples, RATE, LOW_HZ, HIGH_HZ) : undefined;
      if (hz) this.targetLogHz = Math.log(hz);
    }
    this.ease(dt, now);
  }

  /** Sets the targets directly (a synthetic voice, for previews and renders). */
  set(level: number, hz: number, dt: number, now = 0) {
    this.target = level;
    this.targetLogHz = Math.log(hz);
    this.ease(dt, now);
  }

  /** Drops to silence fast (the user talked over the voice). */
  cut(now: number, ms = 80) { this.releaseUntil = now + ms; this.target = 0; }

  private ease(dt: number, now: number) {
    const release = now < this.releaseUntil ? 0.03 : 0.18;
    this.level += (this.target - this.level) * (1 - Math.exp(-dt / (this.target > this.level ? 0.04 : release)));
    // A ~90 ms glide, at most about 1.2 cycles of density a frame: a tracker jumping
    // between harmonics would otherwise shake the beam's sides.
    const glide = (this.targetLogHz - this.logHz) * (1 - Math.exp(-dt / 0.09));
    const most = MAX_LOG_HZ_PER_S * dt;
    this.logHz += Math.max(-most, Math.min(most, glide));
  }

  /** Pitch as carrier cycles: 80 Hz-4 kHz on a log scale onto 4-20 cycles. */
  get cycles() { return 4 + 16 * Math.max(0, Math.min(1, Math.log(Math.exp(this.logHz) / LOW_HZ) / Math.log(HIGH_HZ / LOW_HZ))); }
}

// ---------- Live facts ----------

// Your voice counts as coming in above this meter level, and for this long after.
export const HEARD_LEVEL = 0.25, HEARD_HOLD_MS = 350;

/** The facts of a live session (index.ts gathers the inputs each tick). */
export function liveFacts(s: {
  connected: boolean; ready: boolean; talking: boolean; idle: boolean;
  voiceState: string; lastHeardAt: number; now: number; muted: boolean;
}): BarFacts & { muted: boolean } {
  return {
    connection: s.connected ? (s.ready ? "open" : "connecting") : "closed",
    paused: s.talking && !s.connected,
    busy: !s.idle,
    speaking: s.voiceState === "speaking",
    // Your voice, not the voice's own echo: while it plays, only an interruption (which stops it) counts.
    hearing: s.voiceState !== "speaking" && s.now - s.lastHeardAt < HEARD_HOLD_MS,
    // Muting is about the open connection; a closed one shows paused or off, not dashes.
    muted: s.muted && s.connected,
  };
}

// ---------- The beam ----------

export type BarFrame = {
  /** Three rows of braille masks (U+2800 + mask), one per terminal column. */
  rows: number[][];
  /** Colour as a weighted mix of tokens (weights sum to 1); `muted` asks for it dimmed. */
  tint: [ColorToken, number][];
  /** 0-1: how muted (dashed and dimmed) the bar is. */
  muted: number;
  /** The state the facts call for (for labels and tests). */
  state: BarState;
};

const BEAM_WAIST = 0.16;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
type Impulse = { event: BarEvent; at: number };
const IMPULSE_MS = 3000; // an impulse is spent by then (its displacement then stays put)
// A carrier never moves more than this much of a cycle in one frame: past half a
// cycle the eye cannot tell which way it went (fast sweeps on dense carriers, a
// late frame after rest). The bar-width positions are kept exact.
const MAX_STEP = 0.4;

/** How far an event has displaced the carriers (bar widths) `since` seconds after it. */
function displacement(spec: EventSpec, since: number): number {
  let d = 0;
  if (spec.sweep) d += spec.sweep.distance * smooth(clamp01((since * 1000) / spec.sweep.ms));
  if (spec.kick) d += spec.kick.velocity * spec.kick.tau * (1 - Math.exp(-since / spec.kick.tau));
  return d;
}

/**
 * Draws the beam over time. Each state keeps its own carrier phase, in cycles,
 * advanced by `cycles × drift` (drift in bar widths per second), so the wave
 * flows at the drift's speed whatever its density, and a density change zooms
 * about the bar's centre instead of somewhere off the bar. Each state also keeps
 * its own clock, so a state fading out goes on as it was (an error flinch keeps
 * decaying, connecting holds its plateau). Weights move from where they are to the
 * new state over the transition's duration, so changing state never jumps.
 */
export class BarMotion {
  private state: BarState = "off";
  private from: Record<BarState, number> = blank();
  private weights: Record<BarState, number> = { ...blank(), off: 1 };
  private transitionStart = 0;
  private transitionMs = 0;
  private enteredAt: Record<BarState, number> = blank();
  private phases: Record<BarState, number> = blank();     // cycles, wrapped to [0, 1)
  private positions: Record<BarState, number> = blank();  // bar widths travelled (for tests and labels)
  private impulses: Impulse[] = [];
  private spent = 0;         // displacement of impulses that are over
  private shared = 0;        // total event displacement, bar widths
  private errorUntil = -Infinity;
  private errorAgain = false;
  private mutedFrom = 0;
  private mutedTo = 0;
  private mutedAt = 0;
  private last?: number;
  private reduced: () => boolean;

  constructor(options: { reducedMotion?: () => boolean } = {}) { this.reduced = options.reducedMotion ?? (() => false); }

  /** Back to off, as if new (a fresh mount). */
  reset() {
    Object.assign(this, { state: "off", from: blank(), weights: { ...blank(), off: 1 }, transitionStart: 0, transitionMs: 0, enteredAt: blank(),
      phases: blank(), positions: blank(), impulses: [], spent: 0, shared: 0, errorUntil: -Infinity, errorAgain: false, mutedFrom: 0, mutedTo: 0, mutedAt: 0, last: undefined });
  }

  /** An event at `now` (ms): impulses, and for errors a flinch (again, if one is showing). */
  event(event: BarEvent, now: number) {
    if (!this.reduced()) this.impulses.push({ event, at: now }); // reduced motion: no impulses, only the error flinch's state
    if (event === "error") { this.errorUntil = now + ERROR_MS; this.errorAgain = true; }
  }

  /** Whether the bar changes over the next frames (else it need not be redrawn). */
  moving(now: number, facts: BarFacts & { muted?: boolean }): boolean {
    const state = this.target(facts, now);
    if (state !== this.state || this.errorAgain || now - this.transitionStart < this.transitionMs) return true;
    if ((facts.muted ? 1 : 0) !== this.mutedTo || Math.abs(this.mutedTo - this.mutedValue(now)) > 0.001) return true;
    if (this.reduced()) return false;
    if (this.impulses.some(i => now - i.at < IMPULSE_MS)) return true;
    const t = Math.max(0, now - this.enteredAt[state]);
    switch (state) {
      case "off": return false;
      case "paused": return (t % PAUSE_PULSE_MS) < PAUSE_PULSE_WIDTH_MS + 100;
      case "listening": return t < BREATH_MS + 300;
      default: return true;
    }
  }

  /** The frame at `now` (ms) for `columns` terminal columns, given the facts and live signals. */
  frame(now: number, columns: number, facts: BarFacts & { muted?: boolean }, input: Meter, output: Meter): BarFrame {
    const reduced = this.reduced();
    const target = this.target(facts, now);
    if (target !== this.state || (target === "error" && this.errorAgain)) this.enter(target, now);
    this.errorAgain = false;
    const muted = facts.muted ? 1 : 0;
    if (muted !== this.mutedTo) { this.mutedFrom = this.mutedValue(now); this.mutedTo = muted; this.mutedAt = now; }
    const dt = this.last === undefined ? 0 : Math.min(0.25, Math.max(0, now - this.last) / 1000);
    // Events run on a clock that never goes back (if the wall clock does, the carriers do not rewind).
    const clock = Math.max(now, this.last ?? now);
    this.last = clock;

    // Weights: from where they were to the new state, eased over the transition.
    const u = this.transitionMs ? clamp01((now - this.transitionStart) / this.transitionMs) : 1;
    const e = reduced ? (u >= 1 ? 1 : u) : smooth(u);
    for (const s of BAR_STATES) this.weights[s] = this.from[s] + ((s === this.state ? 1 : 0) - this.from[s]) * e;

    // Every state on its own clock, with its signal's level and density.
    const signal = (spec: StateSpec) => spec.source === "input" ? input : spec.source === "output" ? output : undefined;
    const live = BAR_STATES.filter(s => this.weights[s] > 0.001).map(s => {
      const spec = STATES[s], sig = signal(spec), t = Math.max(0, now - this.enteredAt[s]) / 1000;
      if (reduced) { const still = REDUCED[s]; return { s, t, level: this.weights[s] * still.level, cycles: still.cycles, drift: 0 }; }
      return { s, t, level: this.weights[s] * spec.level(t, sig?.level ?? 0), cycles: spec.cycles(sig?.cycles ?? 6), drift: spec.drift(t, sig?.level ?? 0) };
    });

    // Events: their exact displacement so far (however late the frame), and swells.
    const ripples: [number, number][] = [];
    let swell = 0;
    if (!reduced) {
      for (const impulse of this.impulses) {
        const spec = EVENTS[impulse.event], since = Math.max(0, clock - impulse.at) / 1000;
        if (since * 1000 >= IMPULSE_MS) { this.spent += displacement(spec, since); continue; } // it stays where it got to
        if (spec.swell) {
          const g = spec.swell.gain * Math.exp(-since / spec.swell.tau);
          if (spec.swell.width) ripples.push([g, spec.swell.width]); else swell += g;
        }
      }
      this.impulses = this.impulses.filter(i => clock - i.at < IMPULSE_MS);
    } else {
      // Reduced motion: events stop where they are (no jump back), and no new ones move the bar.
      for (const i of this.impulses) this.spent += displacement(EVENTS[i.event], Math.max(0, clock - i.at) / 1000);
      this.impulses = [];
    }
    const shared = this.spent + this.impulses.reduce((d, i) => d + displacement(EVENTS[i.event], Math.max(0, clock - i.at) / 1000), 0);
    const moved = shared - this.shared;
    this.shared = shared;
    for (const { s, cycles, drift } of live) {
      const travel = drift * dt * (facts.muted && s === "listening" ? 0 : 1) + moved;
      this.positions[s] += travel;
      const step = Math.max(-MAX_STEP, Math.min(MAX_STEP, cycles * travel));
      this.phases[s] = (((this.phases[s] + step) % 1) + 1) % 1;
    }

    // The trace: three braille rows (12 dots) high, joined vertically.
    const rows = Array.from({ length: 3 }, () => new Array<number>(columns).fill(0));
    const leftBits = [1, 2, 4, 64], rightBits = [8, 16, 32, 128];
    const mutedNow = this.mutedValue(now);
    let previous: number | undefined;
    for (let sample = 0; sample < columns * 2; sample++) {
      const c = sample / Math.max(1, columns * 2 - 1) - 0.5;
      let lift = 1 + swell;
      for (const [g, width] of ripples) lift += g * Math.exp(-0.5 * (c / width) ** 2);
      const gaussian = Math.exp(-0.5 * (c / BEAM_WAIST) ** 2) * lift;
      let sum = 0;
      for (const { s, level, cycles } of live) sum += level * Math.cos(TAU * (cycles * c - this.phases[s]));
      const y = Math.round(5.5 - Math.max(-1, Math.min(1, 0.85 * gaussian * sum)) * 5.4);
      // Muted: the trace breaks into dashes.
      const gap = mutedNow > 0.5 && Math.floor(sample / 6) % 2 === 1;
      const from = previous ?? y;
      if (!gap) for (let p = Math.min(from, y); p <= Math.max(from, y); p++) {
        const row = Math.max(0, Math.min(11, p));
        rows[Math.floor(row / 4)][Math.floor(sample / 2)] |= (sample % 2 ? rightBits : leftBits)[row % 4];
      }
      previous = y;
    }
    const tint = BAR_STATES.filter(s => this.weights[s] > 0.001).map(s => [STATES[s].color, this.weights[s]] as [ColorToken, number]);
    return { rows, tint, muted: mutedNow, state: this.state };
  }

  /** Where each carrier is and how much each state shows (for tests). */
  snapshot() { return { state: this.state, weights: { ...this.weights }, positions: { ...this.positions }, phases: { ...this.phases }, shared: this.shared }; }

  /** The state for these facts, an error flinch first. */
  private target(facts: BarFacts, now: number): BarState {
    return now < this.errorUntil ? "error" : barState(facts);
  }

  private enter(state: BarState, now: number) {
    const recent = this.impulses.filter(i => now - i.at < 500).map(i => i.event);
    const ms = this.reduced() ? 150 : transitionMs(this.state, state, recent);
    this.from = { ...this.weights };
    this.transitionStart = now;
    this.transitionMs = ms;
    // A state comes in from rest; one coming back keeps its carrier where it was.
    if (this.weights[state] < 0.01) { this.phases[state] = 0; this.positions[state] = 0; }
    this.state = state;
    this.enteredAt[state] = now;
  }

  private mutedValue(now: number) {
    const u = clamp01((now - this.mutedAt) / 250);
    return this.mutedFrom + (this.mutedTo - this.mutedFrom) * smooth(u);
  }
}

/** Reduced motion: each state as a still shape (fixed height and density, no signal, no drift). */
const REDUCED: Record<BarState, { level: number; cycles: number }> = {
  off: { level: 0, cycles: 5 }, paused: { level: 0, cycles: 4 }, connecting: { level: 0.4, cycles: 6 },
  listening: { level: 0.12, cycles: 5 }, hearing: { level: 0.5, cycles: 6 }, speaking: { level: 0.5, cycles: 9 },
  working: { level: 0.6, cycles: 8 }, error: { level: 0.5, cycles: 12 },
};

function blank(): Record<BarState, number> {
  return { off: 0, paused: 0, connecting: 0, listening: 0, hearing: 0, speaking: 0, working: 0, error: 0 };
}

// ---------- The story: every state and event in order, for previews and renders ----------

export type StoryStep = {
  label: string;
  /** What the step shows, in a sentence (previews and the motion clip say it). */
  meaning: string;
  ms: number;
  facts: BarFacts;
  muted?: boolean;
  /** A synthetic voice coming in or going out during the step. */
  voice?: "input" | "output";
  /** Events and when they fire (ms into the step). */
  events?: [BarEvent, number][];
};

const quiet: BarFacts = { connection: "open", paused: false, busy: false, speaking: false, hearing: false };
export const STORY: StoryStep[] = [
  { label: "connecting", meaning: "The beam grows from flat and starts to move.", ms: 1500, facts: { ...quiet, connection: "connecting" } },
  { label: "listening", meaning: "A faint breath, then stillness: ready, nothing flowing.", ms: 2500, facts: quiet },
  { label: "hearing you", meaning: "Your voice drives it, flowing left, into the voice.", ms: 2600, facts: { ...quiet, hearing: true }, voice: "input" },
  { label: "your turn settles", meaning: "A ripple at the centre as your words land in the chat.", ms: 1400, facts: quiet, events: [["settled", 300]] },
  { label: "handed to Pi", meaning: "A sweep toward the work; then steady amber progress, a beat per tool call.", ms: 3400, facts: { ...quiet, busy: true }, events: [["handoff", 0], ["tool", 1000], ["tool", 2200]] },
  { label: "speaking", meaning: "The result resolves into the voice: its audio drives it, flowing right, to you.", ms: 3000, facts: { ...quiet, speaking: true }, voice: "output" },
  { label: "you talk over it", meaning: "The voice yields at once, and your voice takes the bar.", ms: 1800, facts: { ...quiet, hearing: true }, voice: "input", events: [["interrupt", 0]] },
  { label: "listening", meaning: "Your turn settles; quiet again.", ms: 1200, facts: quiet, events: [["settled", 200]] },
  { label: "muted", meaning: "The trace breaks into dashes and holds still: nothing goes in.", ms: 2200, facts: quiet, muted: true },
  { label: "error", meaning: "A red flinch that settles; never a stuck red bar.", ms: 1500, facts: quiet, events: [["error", 100]] },
  { label: "paused", meaning: "Flat and dim, with a slow pulse: back with the result or /talk start.", ms: 6000, facts: { ...quiet, connection: "closed", paused: true } },
];
export const STORY_MS = STORY.reduce((total, step) => total + step.ms, 0);

/** The story at `ms` (looping): the step, how far into it, and the events between `from` and `ms`. */
export function storyAt(ms: number, from = ms): { step: StoryStep; t: number; events: BarEvent[] } {
  const loop = (x: number) => ((x % STORY_MS) + STORY_MS) % STORY_MS;
  let start = 0, step = STORY[0];
  for (const s of STORY) { if (loop(ms) < start + s.ms) { step = s; break; } start += s.ms; }
  const events: BarEvent[] = [];
  if (ms > from) {
    let at = 0;
    for (const s of STORY) {
      for (const [event, offset] of s.events ?? []) {
        // Every firing of this event in (from, ms], counting loops.
        const first = at + offset;
        for (let k = Math.ceil((from - first) / STORY_MS); first + k * STORY_MS <= ms; k++) if (first + k * STORY_MS > from) events.push(event);
      }
      at += s.ms;
    }
  }
  return { step, t: loop(ms) - start, events };
}

/** A synthetic voice: a syllable envelope and gliding pitch, for previews and renders. */
export function syntheticVoice(seconds: number, source: "input" | "output"): { level: number; hz: number } {
  const syllables = 0.12 + 0.88 * Math.pow(0.5 + 0.5 * Math.sin(seconds * 4.3 + Math.sin(seconds * 1.7)), 2);
  return source === "input"
    ? { level: 0.7 * syllables, hz: 260 * Math.pow(2, 1.2 * Math.sin(seconds * 1.3) + 0.6 * Math.sin(seconds * 3.1)) }
    : { level: syllables, hz: 180 * Math.pow(2, 1.0 * Math.sin(seconds * 0.9 + 1) + 0.8 * Math.sin(seconds * 2.3)) };
}
