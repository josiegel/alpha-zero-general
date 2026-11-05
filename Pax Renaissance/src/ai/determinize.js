// Determinization: re-deal everything `viewer` cannot know, consistently with what they can.
// Used to test the encoder for leaks and by bots that simulate ahead (so they cannot peek at
// future draws).
// Knowable (kept): every hand (cards only enter hands by purchase from the face-up market) and
// face-down market cards that were face up earlier (state.seen).
// Hidden (re-dealt): deck order, face-down cards never seen face up (e.g. the ones dealt at
// setup), and the RNG state.
import { clone } from '../engine/util.js';

export function makeRng(seed) {
  let x = (seed >>> 0) || 1;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

export const isKnownMarketCard = (s, sl) => !!sl.card && (!sl.faceDown || !!(s.seen && s.seen[sl.card]));

export function determinize(s, viewer, rnd) {
  const t = clone(s);
  for (const side of ['E', 'W']) {
    const hidden = t.market[side].filter(sl => sl.card && !isKnownMarketCard(t, sl));
    const pool = t.decks[side].concat(hidden.map(sl => sl.card));
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    hidden.forEach(sl => { sl.card = pool.pop(); });
    t.decks[side] = pool;
  }
  t.rng = Math.floor(rnd() * 4294967296) >>> 0;
  return t;
}
