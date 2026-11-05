// Headless self-play: runs random-vs-random games to fuzz the rules engine and (later) to
// generate training data.  Usage: node tools/selfplay.mjs [games=20] [seed=1]
import { Game } from '../src/engine/game.js';
import { RandomAgent } from '../src/ai/agents.js';
import { encodeObservation, OBS_SIZE } from '../src/ai/encode.js';

const N = +(process.argv[2] || 20); const seed0 = +(process.argv[3] || 1);
const stats = { done: 0, reasons: {}, decisions: 0, errors: 0 };
const t0 = Date.now();
for (let g = 0; g < N; g++) {
  const seed = seed0 + g;
  const game = new Game({ seed, players: [{ name: 'A', bot: true }, { name: 'B', bot: true }] });
  const bots = [new RandomAgent(seed * 7 + 1), new RandomAgent(seed * 13 + 5)];
  let n = 0;
  try {
    while (game.request && n < 20000) {
      const r = game.request;
      if (n % 50 === 0) { const o = encodeObservation(game.view, r.player); if (o.length !== OBS_SIZE || o.some(Number.isNaN)) throw new Error('bad obs'); }
      game.choose(bots[r.player].choose(game.view, r, r.player)); n++;
    }
    const s = game.state;
    stats.decisions += n;
    const reason = s.gameOver ? s.winner.reason : 'unfinished';
    stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
    if (s.gameOver) stats.done++;
    checkInvariants(s);
  } catch (e) {
    stats.errors++;
    console.log(`Game seed ${seed} error after ${n} decisions:`, e.stack.split('\n').slice(0, 6).join('\n'));
    console.log('Last log:', game.view?.log.slice(-8).join(' | '));
    if (game.request) console.log('Pending:', game.request.prompt);
  }
}
console.log(JSON.stringify(stats), `${((Date.now() - t0) / 1000).toFixed(1)}s`);

function checkInvariants(s) {
  // token conservation
  const cnt = { K: { C: 0, I: 0, R: 0 }, R: { C: 0, I: 0, R: 0 } };
  for (const id in s.cities) for (const t of s.cities[id]) cnt[t.t][t.c]++;
  for (const e in s.empires) for (const t of s.empires[e].repressed) if (t.t !== 'P') cnt[t.t][t.c]++;
  const tot = { C: 10, I: 7, R: 7 };
  for (const t of ['K', 'R']) for (const c of ['C', 'I', 'R']) if (cnt[t][c] + s.pool[t][c] !== tot[c]) throw new Error(`token count ${t}${c}: ${cnt[t][c]}+${s.pool[t][c]}`);
  s.players.forEach((P, p) => {
    let n = P.pawns;
    for (const b in s.borders) if (s.borders[b].pawn === p) n++;
    for (const e in s.empires) for (const t of s.empires[e].repressed) if (t.t === 'P' && t.c === p) n++;
    if (n !== 10) throw new Error(`pawn count p${p}=${n}`);
    if (P.florins < 0) throw new Error('negative florins');
  });
  let b = { C: 0, I: 0, R: 0 };
  for (const k in s.bishops) b[s.bishops[k]]++;
  for (const e in s.empires) if (s.empires[e].bishop) b[s.empires[e].bishop]++;
  for (const c of ['C', 'I', 'R']) if (b[c] + s.pool.bishop[c] !== 5) throw new Error('bishop count ' + c);
}
