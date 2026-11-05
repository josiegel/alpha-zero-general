// Hand-written position evaluation for baseline bots: score(me) - score(best opponent).
// Rewards progress toward the four declarable victories and the patron (decks-exhausted) victory.
import { prestigeCount, tableauUnits } from '../engine/state.js';
import { kingCount, republicCount, globConcessions, lawCount, victoryMet } from '../engine/rules.js';

const WIN = 1000;
const VICS = ['holy', 'imperial', 'globalization', 'renaissance'];

function playerScore(s, p) {
  const P = s.players[p];
  let x = 0;
  x += 3 * prestigeCount(s, p, 'patron') + 0.5 * Math.min(P.florins, 12);
  x += 2.5 * kingCount(s, p) + 3 * republicCount(s, p);
  x += 1.5 * globConcessions(s, p) + 1.5 * prestigeCount(s, p, 'discovery') + 1.5 * lawCount(s, p);
  for (const r of ['catholic', 'islamic', 'reformist']) x += 0.75 * prestigeCount(s, p, r);
  x += 0.75 * tableauUnits(s, p).length + 0.5 * P.hand.length;
  // a victory this player could declare: worth a lot (only if the opponent does not win first)
  for (const v of VICS) if (s.victory[v] && victoryMet(s, p, v)) x += 25;
  return x;
}

export function evaluate(s, me) {
  if (s.gameOver) {
    const w = s.winner.players;
    if (w.includes(me)) return w.length === 1 ? WIN : 0;
    return -WIN;
  }
  let best = -Infinity;
  for (let q = 0; q < s.numPlayers; q++) if (q !== me) best = Math.max(best, playerScore(s, q));
  return playerScore(s, me) - best;
}
