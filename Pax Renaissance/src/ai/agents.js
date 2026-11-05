// Bot agents. Every agent implements:
//   choose(view, request, playerIndex, game) -> optionId   (may return a Promise)
// `view` is the full engine state (agents should only use public info + their own hand; see
// encode.js for the observation used by learned agents), `request` is {prompt, options[], main,
// trail}. `game` (optional) is the Game, for agents that simulate ahead from its checkpoint.
import { encodeObservation, encodeOption } from './encode.js';
import { rolloutUnit, ReplayMismatch } from '../engine/game.js';
import { determinize, makeRng } from './determinize.js';
import { evaluate } from './heuristic.js';
import { SearchAgent } from './search.js';

export class RandomAgent {
  constructor(seed = Date.now()) { this.s = seed >>> 0; }
  rand() { // xorshift
    let x = this.s || 1; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.s = x >>> 0; return this.s / 4294967296;
  }
  choose(view, req) {
    let opts = req.options;
    // Slight bias so random games end: avoid ending the turn early when other actions exist.
    if (req.main && opts.length > 1) opts = opts.filter(o => o.id !== 'end' || this.rand() < 0.15);
    return opts[Math.floor(this.rand() * opts.length)].id;
  }
}

// One-ply greedy baseline. For each legal option it finishes the current action `rollouts` times
// (remaining sub-decisions random, hidden cards re-dealt so it cannot peek at draws) and scores
// the result with the heuristic in heuristic.js. Needs the `game` argument; without it, it falls
// back to random play.
export class GreedyAgent {
  constructor(seed = 1, { rollouts = 2 } = {}) { this.rnd = makeRng(seed); this.rollouts = rollouts; this.fallback = new RandomAgent(seed); }
  choose(view, req, me, game) {
    if (!game || req.options.length === 1) return this.fallback.choose(view, req);
    const pick = (_p, _prompt, options) => options[Math.floor(this.rnd() * options.length)];
    let best = null, bestScore = -Infinity;
    for (const o of req.options) {
      const answers = game.answers.concat([o.id]);
      let total = 0, n = 0;
      for (let r = 0; r < this.rollouts; r++) {
        let s;
        try { s = rolloutUnit(determinize(game.state, me, this.rnd), answers, pick); }
        catch (e) {
          if (!(e instanceof ReplayMismatch)) throw e;
          s = rolloutUnit(game.state, answers, pick); // re-deal changed an earlier reveal in this action
        }
        total += evaluate(s, me); n++;
        if (s.gameOver) break; // terminal: deterministic enough
      }
      const score = total / n + this.rnd() * 1e-3; // random tie-break
      if (score > bestScore) { bestScore = score; best = o.id; }
    }
    return best;
  }
}

// Neural-network agent: scores every legal option with a policy network given the observation
// vector, then picks the arg-max (or samples). Plug in any model exposing
// `score(obsVec, optionVecs) -> number[]` (e.g. an ONNX / TF.js model).
// Synchronous when model.score is (e.g. src/ai/nn.js), otherwise returns a Promise.
export class PolicyAgent {
  constructor(model, { greedy = true, seed = 1 } = {}) { this.model = model; this.greedy = greedy; this.rnd = makeRng(seed); }
  choose(view, req, player) {
    if (req.options.length === 1) return req.options[0].id;
    const obs = encodeObservation(view, player, req);
    const optVecs = req.options.map(o => encodeOption(view, req, o, player));
    const scores = this.model.score(obs, optVecs);
    return typeof scores?.then === 'function' ? scores.then(s => this.pick(req, s)) : this.pick(req, scores);
  }
  pick(req, scores) {
    if (this.greedy) return req.options[scores.indexOf(Math.max(...scores))].id;
    const mx = Math.max(...scores);
    const ex = scores.map(x => Math.exp(x - mx)); const z = ex.reduce((a, b) => a + b, 0);
    let r = this.rnd() * z;
    for (let i = 0; i < ex.length; i++) { r -= ex[i]; if (r <= 0) return req.options[i].id; }
    return req.options[req.options.length - 1].id;
  }
}

// name: random | greedy | greedyN | neural | search | searchN
//   (neural and search need opts.net, a network from src/ai/nn.js; searchN = N simulations per move)
export function makeAgent(name, seed, opts = {}) {
  if (name === 'random') return new RandomAgent(seed);
  if (name === 'greedy') return new GreedyAgent(seed);
  if (name === 'neural' || name.startsWith('search')) {
    if (!opts.net) throw new Error(`The ${name} bot needs a loaded network`);
    if (name === 'neural') return new PolicyAgent(opts.net, { greedy: true, seed });
    const n = name.match(/^search(\d+)?$/);
    if (n) return new SearchAgent(opts.net, { sims: n[1] ? +n[1] : 100, seed });
  }
  const m = name.match(/^greedy(\d+)$/); if (m) return new GreedyAgent(seed, { rollouts: +m[1] });
  throw new Error('Unknown agent ' + name);
}
