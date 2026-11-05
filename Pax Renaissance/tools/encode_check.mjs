// Checks the NN encoder (src/ai/encode.js) over random self-play games:
//  - fixed sizes, finite values, no prompt kind / option verb falling into 'other'
//  - hidden information does not leak: re-dealing the deck order and never-seen face-down
//    trade-fair cards must leave the viewer's observation and option encodings unchanged
//  - reports how often two legal options of one decision get identical encodings
// Usage: node tools/encode_check.mjs [games=200] [seed=1]
import { Game } from '../src/engine/game.js';
import { RandomAgent } from '../src/ai/agents.js';
import { encodeObservation, encodeOption, OBS_SIZE, OPT_SIZE, OBS_LAYOUT, promptKind, optionVerb } from '../src/ai/encode.js';
import { determinize as perturbHidden, makeRng } from '../src/ai/determinize.js';

const N = +(process.argv[2] || 200); const seed0 = +(process.argv[3] || 1);
let decisions = 0, leaks = 0, collisions = 0, collisionDecisions = 0, failures = 0;
const otherPrompts = new Set(), otherVerbs = new Set(), collisionExamples = new Map();
let encTime = 0;

const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const t0 = Date.now();
for (let g = 0; g < N; g++) {
  const seed = seed0 + g;
  const game = new Game({ seed, players: [{ name: 'A', bot: true }, { name: 'B', bot: true }] });
  const bots = [new RandomAgent(seed * 7 + 1), new RandomAgent(seed * 13 + 5)];
  const rnd = makeRng(seed * 2654435761);
  try {
    while (game.request) {
      const r = game.request; const s = game.view; const me = r.player;
      const te = performance.now();
      const obs = encodeObservation(s, me, r);
      const opts = r.options.map(o => encodeOption(s, r, o, me));
      encTime += performance.now() - te;
      if (obs.length !== OBS_SIZE || !obs.every(Number.isFinite)) throw new Error('bad obs');
      if (opts.some(o => o.length !== OPT_SIZE || !o.every(Number.isFinite))) throw new Error('bad option vector');
      if (promptKind(r.prompt) === 'other') otherPrompts.add(r.prompt);
      r.options.forEach(o => { if (optionVerb(o.id) === 'other') otherVerbs.add(o.id); });

      // duplicate encodings among this decision's options
      const keys = opts.map(o => Array.from(o).join(','));
      const dup = keys.length - new Set(keys).size;
      if (dup) {
        collisions += dup; collisionDecisions++;
        const kind = promptKind(r.prompt);
        if (!collisionExamples.has(kind)) {
          const seen = new Map(); const ex = [];
          keys.forEach((k, i) => { if (seen.has(k)) ex.push(`${r.options[seen.get(k)].id} == ${r.options[i].id}`); else seen.set(k, i); });
          collisionExamples.set(kind, `${r.prompt}: ${ex.slice(0, 3).join('; ')}`);
        }
      }

      // leak test (every 5th decision)
      if (decisions % 5 === 0) {
        const t = perturbHidden(s, me, rnd);
        const obs2 = encodeObservation(t, me, r);
        const opts2 = r.options.map(o => encodeOption(t, r, o, me));
        if (!eq(obs, obs2) || opts.some((o, i) => !eq(o, opts2[i]))) {
          leaks++;
          if (leaks <= 3) {
            const diff = []; obs.forEach((a, i) => { if (a !== obs2[i]) diff.push(i); });
            const sec = Object.entries(OBS_LAYOUT).find(([, [o, l]]) => diff[0] >= o && diff[0] < o + l);
            console.log(`LEAK seed ${seed} "${r.prompt}": obs diffs at ${diff.slice(0, 5)} (${sec ? sec[0] : 'options'})`);
          }
        }
      }
      decisions++;
      game.choose(bots[me].choose(s, r, me));
    }
  } catch (e) {
    failures++;
    console.log(`seed ${seed}:`, e.stack.split('\n').slice(0, 4).join('\n'));
  }
}
console.log(`OBS_SIZE=${OBS_SIZE} OPT_SIZE=${OPT_SIZE}`);
console.log('layout', JSON.stringify(OBS_LAYOUT));
console.log(`${N} games, ${decisions} decisions, ${((Date.now() - t0) / 1000).toFixed(1)}s, encoding ${(encTime / decisions).toFixed(3)} ms/decision`);
console.log(`failures=${failures} leaks=${leaks} unclassified prompts=${otherPrompts.size} unclassified option ids=${otherVerbs.size}`);
if (otherPrompts.size) console.log('  prompts:', [...otherPrompts].slice(0, 10));
if (otherVerbs.size) console.log('  option ids:', [...otherVerbs].slice(0, 10));
console.log(`decisions with identical option encodings: ${collisionDecisions} (${(100 * collisionDecisions / decisions).toFixed(2)}%), ${collisions} duplicate options`);
for (const [k, ex] of collisionExamples) console.log(`  [${k}] ${ex}`);
process.exitCode = failures || leaks || otherPrompts.size || otherVerbs.size ? 1 : 0;
