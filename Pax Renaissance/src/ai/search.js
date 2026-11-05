// Network-guided tree search (AlphaZero-style PUCT) for playing, with chance handled by
// re-dealing the cards nobody can know (src/ai/determinize.js) at the start of every simulation.
//
// The tree is "open loop": a node is a sequence of choices from the root, not one exact position,
// so its statistics average over the possible shuffles. Both players know the same things (hands
// and remembered cards are public; deck order is hidden from both), so one re-deal serves both
// sides of the search.
//
//   const agent = new SearchAgent(net, { sims: 100 });
//   agent.choose(view, request, player, game)   // needs the Game (checkpoint + answers so far)
//   agent.lastStats                              // root visit counts, values and timing
import { playUnit } from '../engine/rules.js';
import { NeedChoice, clone } from '../engine/util.js';
import { ReplayMismatch } from '../engine/game.js';
import { determinize, makeRng } from './determinize.js';
import { encodeObservation, encodeOption } from './encode.js';

// ---------------------------------------------------------------- engine stepping
// Run one unit from `start` (a unit-start state, cloned here) with `answers`.
// -> {done: true, state} or {done: false, view, req}
function advance(start, answers) {
  const s = clone(start); let i = 0;
  const trail = [];
  const ctx = {
    choose(player, prompt, options, meta = {}) {
      if (options.length === 1 && !meta.main) { trail.push({ player, prompt, id: options[0].id }); return options[0]; }
      if (i < answers.length) {
        const id = answers[i++];
        const o = options.find((x) => x.id === id);
        if (!o) throw new ReplayMismatch(id);
        trail.push({ player, prompt, id });
        return o;
      }
      throw new NeedChoice({ player, prompt, options, main: !!meta.main, trail: trail.slice() });
    },
  };
  try { playUnit(s, ctx); return { done: true, state: s }; }
  catch (e) { if (e instanceof NeedChoice) return { done: false, view: s, req: e.req }; throw e; }
}

// A position = the unit-start state + answers given in this unit, with its pending request,
// or a finished game.
function settle(start, answers) {
  let r = advance(start, answers);
  for (let guard = 0; r.done; guard++) {
    if (r.state.gameOver) return { terminal: true, winners: r.state.winner.players, start: r.state };
    if (guard > 50) throw new Error('search: engine made no progress');
    start = r.state; answers = [];
    r = advance(start, answers);
  }
  return { terminal: false, start, answers, view: r.view, req: r.req };
}
const step = (pos, id) => settle(pos.start, pos.answers.concat([id]));

// ---------------------------------------------------------------- search
class Node {
  constructor() { this.expanded = false; this.player = null; this.N = 0; this.edges = new Map(); }
}

export class SearchAgent {
  constructor(net, { sims = 100, cpuct = 1.5, seed = 1 } = {}) {
    this.net = net; this.sims = sims; this.cpuct = cpuct; this.rnd = makeRng(seed);
    this.lastStats = null;
  }

  // network priors (softmax of logits) and value for the deciding player
  evaluate(pos) {
    const { view, req } = pos; const p = req.player;
    const obs = encodeObservation(view, p, req);
    const logits = this.net.score(obs, req.options.map((o) => encodeOption(view, req, o, p)));
    const mx = Math.max(...logits); const ex = logits.map((x) => Math.exp(x - mx)); const z = ex.reduce((a, b) => a + b, 0);
    return { priors: ex.map((x) => x / z), value: this.net.value(obs) };
  }

  root(game, me) {
    try { return settle(determinize(game.state, me, this.rnd), game.answers); }
    catch (e) { if (e instanceof ReplayMismatch) return settle(game.state, game.answers); throw e; } // a re-deal changed a card already revealed this action
  }

  choose(view, req, me, game) {
    if (req.options.length === 1) return req.options[0].id;
    if (!game) throw new Error('SearchAgent needs the game');
    const t0 = Date.now();
    const root = new Node();
    for (let n = 0; n < this.sims; n++) this.simulate(root, this.root(game, me));
    const legal = new Set(req.options.map((o) => o.id));
    let best = null;
    for (const [id, e] of root.edges) {
      if (!legal.has(id)) continue;
      if (!best || e.N > best.e.N || (e.N === best.e.N && e.W / Math.max(1, e.N) > best.e.W / Math.max(1, best.e.N))) best = { id, e };
    }
    this.lastStats = {
      ms: Date.now() - t0, sims: this.sims,
      moves: [...root.edges].filter(([id]) => legal.has(id)).map(([id, e]) => ({ id, visits: e.N, prior: e.P, q: e.N ? e.W / e.N : null }))
        .sort((a, b) => b.visits - a.visits),
    };
    return best ? best.id : req.options[0].id;
  }

  simulate(root, pos) {
    const path = []; // [edge, player who chose it]
    let node = root, leafValue = 0, leafPlayer = 0, terminal = null;
    for (;;) {
      if (pos.terminal) { terminal = pos.winners; break; }
      if (!node.expanded) {
        const { priors, value } = this.evaluate(pos);
        node.expanded = true; node.player = pos.req.player;
        pos.req.options.forEach((o, i) => node.edges.set(o.id, { P: priors[i], N: 0, W: 0, child: null }));
        leafValue = value; leafPlayer = pos.req.player;
        break;
      }
      // options can differ between re-deals (e.g. which cards a trade fair drew)
      const opts = pos.req.options;
      for (const o of opts) if (!node.edges.has(o.id)) node.edges.set(o.id, { P: 1 / opts.length, N: 0, W: 0, child: null });
      const sq = Math.sqrt(node.N + 1);
      let best = null, bestU = -Infinity;
      for (const o of opts) {
        const e = node.edges.get(o.id);
        const q = e.N ? e.W / e.N : 0;
        const u = q + this.cpuct * e.P * sq / (1 + e.N);
        if (u > bestU) { bestU = u; best = { id: o.id, e }; }
      }
      path.push({ node, e: best.e, player: node.player });
      pos = step(pos, best.id);
      if (!best.e.child) best.e.child = new Node();
      node = best.e.child;
    }
    // back up: value from the point of view of the player who chose each edge (2-player zero-sum)
    const valueFor = (p) => {
      if (terminal) return terminal.length !== 1 ? 0 : terminal[0] === p ? 1 : -1;
      return p === leafPlayer ? leafValue : -leafValue;
    };
    for (const { node: n, e, player } of path) { e.N++; e.W += valueFor(player); n.N++; }
  }
}
