// Game controller. The rules are written as straight-line procedures that call ctx.choose().
// A "unit" is one main action of the current player (including all sub-decisions, possibly by
// other players, e.g. tax responses). Within a unit, decisions are replayed from a checkpoint:
//   state_checkpoint + [answers...]  -> either the unit completes, or a NeedChoice is raised.
// Everything is plain JSON, so a full game is reproducible from (config, seed, answers).
import { newGame } from './state.js';
import { playUnit } from './rules.js';
import { NeedChoice, clone } from './util.js';

export class ReplayMismatch extends Error {}

// Play one unit from `state` (a unit-start checkpoint; it is cloned): replay `answers`, then ask
// pick(player, prompt, options, meta) -> option for every further decision. Returns the state
// after the unit. Throws ReplayMismatch if an answer is not legal in this (e.g. re-dealt) state.
export function rolloutUnit(state, answers, pick) {
  const s = clone(state); let i = 0;
  playUnit(s, {
    choose(player, prompt, options, meta = {}) {
      if (options.length === 1 && !meta.main) return options[0];
      if (i < answers.length) {
        const id = answers[i++];
        const o = options.find(x => x.id === id);
        if (!o) throw new ReplayMismatch(id);
        return o;
      }
      return pick(player, prompt, options, meta);
    },
  });
  return s;
}

export class Game {
  // opts.keepHistory = false skips the undo checkpoints (for headless self-play)
  constructor(config, { keepHistory = true } = {}) {
    this.config = config;
    this.keepHistory = keepHistory;
    this.state = newGame(config);
    this.answers = [];      // answers within the current unit
    this.units = [];        // answers of completed units (the game record)
    this.history = [];      // checkpoints [{state, unitsLen}] for undo
    this.view = null;       // state as of the latest partial replay (what the UI shows)
    this.request = null;    // pending decision {player, prompt, options, main}
    this.advance();
  }

  static fromRecord(rec) {
    const g = new Game(rec.config);
    for (const unit of rec.units) for (const a of unit) g.choose(a);
    for (const a of rec.pending || []) g.choose(a);
    return g;
  }
  record() { return { config: this.config, units: this.units, pending: this.answers.slice() }; }

  // run the current unit with the current answers
  _run() {
    const s = clone(this.state);
    const answers = this.answers;
    let i = 0;
    // trail: every decision resolved so far in this unit (including forced single options), so
    // agents can see what action/op the pending decision belongs to.
    const trail = [];
    const ctx = {
      choose(player, prompt, options, meta = {}) {
        if (!options.length) throw new Error('Engine bug: empty choice for ' + prompt);
        if (options.length === 1 && !meta.main) { trail.push({ player, prompt, id: options[0].id }); return options[0]; }
        if (i < answers.length) {
          const id = answers[i++];
          const o = options.find(x => x.id === id);
          if (!o) throw new Error(`Invalid answer "${id}" for "${prompt}"`);
          trail.push({ player, prompt, id });
          return o;
        }
        throw new NeedChoice({ player, prompt, options, main: !!meta.main, trail: trail.slice() });
      },
    };
    try {
      playUnit(s, ctx);
      return { done: true, state: s };
    } catch (e) {
      if (e instanceof NeedChoice) return { done: false, state: s, req: e.req };
      throw e;
    }
  }

  advance() {
    for (let guard = 0; guard < 10000; guard++) {
      if (this.state.gameOver) { this.request = null; this.view = this.state; return; }
      const r = this._run();
      if (r.done) {
        if (this.keepHistory) {
          this.history.push({ state: this.state, unitsLen: this.units.length });
          if (this.history.length > 400) this.history.shift();
        }
        this.units.push(this.answers);
        this.answers = [];
        this.state = r.state;
        continue;
      }
      this.request = r.req; this.view = r.state;
      return;
    }
    throw new Error('Engine made no progress');
  }

  choose(id) {
    if (!this.request) throw new Error('No pending decision');
    if (!this.request.options.some(o => o.id === id)) throw new Error('Illegal option ' + id);
    this.answers = this.answers.concat([id]);
    this.advance();
  }

  // Undo the last decision (within the current action) or the last completed action.
  undo() {
    if (this.answers.length) { this.answers = this.answers.slice(0, -1); this.advance(); return true; }
    let h = this.history.pop();
    while (h && this.units[h.unitsLen].length === 0) { this.units = this.units.slice(0, h.unitsLen); h = this.history.pop(); }
    if (!h) { this.advance(); return false; }
    this.state = h.state;
    this.answers = this.units[h.unitsLen].slice(0, -1);
    this.units = this.units.slice(0, h.unitsLen);
    this.advance();
    return true;
  }
  canUndoInAction() { return this.answers.length > 0; }
}
