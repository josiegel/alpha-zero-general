// Head-to-head matches between built-in agents, alternating seats.
// Usage: node tools/arena.mjs <agentA> <agentB> [games=100] [seed=1]
//   agents: random | greedy | greedyN (N rollouts per option) | neural (models/pax-net, or set PAX_NET)
import { readFileSync } from 'node:fs';
import { Game } from '../src/engine/game.js';
import { makeAgent } from '../src/ai/agents.js';
import { netFromBuffers } from '../src/ai/nn.js';

let net = null;
function loadNetFile() {
  const base = process.env.PAX_NET || 'models/pax-net';
  const bin = readFileSync(base + '.bin');
  return netFromBuffers(JSON.parse(readFileSync(base + '.json', 'utf8')), bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
}

const [nameA = 'greedy', nameB = 'random', nStr = '100', seedStr = '1'] = process.argv.slice(2);
const N = +nStr, seed0 = +seedStr;
const needsNet = (n) => n === 'neural' || n.startsWith('search');
if (needsNet(nameA) || needsNet(nameB)) net = loadNetFile();
const res = { A: 0, B: 0, draw: 0, unfinished: 0 }; const reasons = {}; let decisions = 0;
const seatWins = [0, 0];
const t0 = Date.now();
for (let g = 0; g < N; g++) {
  const seed = seed0 + g;
  const aSeat = g % 2; // A plays seat 0 in even games
  const game = new Game({ seed, players: [{ name: 'P0', bot: true }, { name: 'P1', bot: true }] }, { keepHistory: false });
  const bots = [];
  bots[aSeat] = makeAgent(nameA, seed * 7 + 1, { net });
  bots[1 - aSeat] = makeAgent(nameB, seed * 13 + 5, { net });
  let n = 0;
  while (game.request && n < 5000) {
    const r = game.request;
    game.choose(bots[r.player].choose(game.view, r, r.player, game)); n++;
  }
  decisions += n;
  const s = game.state;
  if (!s.gameOver) { res.unfinished++; continue; }
  const w = s.winner.players;
  reasons[s.winner.reason] = (reasons[s.winner.reason] || 0) + 1;
  if (w.length !== 1) res.draw++;
  else { (w[0] === aSeat ? res.A++ : res.B++); seatWins[w[0]]++; }
}
const played = N - res.unfinished;
const score = (res.A + 0.5 * res.draw) / played;
const se = Math.sqrt(score * (1 - score) / played);
console.log(`${nameA} vs ${nameB}: ${res.A}-${res.B} (${res.draw} draws, ${res.unfinished} unfinished) over ${N} games`);
console.log(`${nameA} score ${(100 * score).toFixed(1)}% ± ${(196 * se).toFixed(1)} (95%)  | seat-0 wins ${seatWins[0]}, seat-1 wins ${seatWins[1]}`);
console.log('end reasons', JSON.stringify(reasons));
console.log(`${(decisions / N).toFixed(0)} decisions/game, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
