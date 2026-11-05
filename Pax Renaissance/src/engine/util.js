// Small deterministic helpers shared by the engine.

// Mulberry32 PRNG; state is a uint32 stored in game state so games are reproducible.
export function rngNext(s) {
  let t = (s.rng = (s.rng + 0x6D2B79F5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
export function shuffle(s, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rngNext(s) * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
export const clone = (x) => (typeof structuredClone === 'function' ? structuredClone(x) : JSON.parse(JSON.stringify(x)));

export const REL_NAME = { C: 'Catholic', I: 'Muslim', R: 'Reformist' };
// Pieces are always referred to by religion (gold = Catholic, green = Muslim, red = Reformist).
export const REL_COLOR = { C: 'Catholic', I: 'Muslim', R: 'Reformist' };
export const PRESTIGE_REL = { catholic: 'C', islamic: 'I', reformist: 'R' };
export const REL_PRESTIGE = { C: 'catholic', I: 'islamic', R: 'reformist' };
export const TOKEN_NAME = { K: 'Knight', R: 'Rook', P: 'Pawn' };

export function tokenLabel(tok) {
  if (!tok) return '';
  if (tok.t === 'P') return `Pawn(P${tok.c + 1})`;
  return `${REL_COLOR[tok.c]} ${TOKEN_NAME[tok.t]}`;
}

// Thrown when the engine needs a decision that has not been supplied yet.
export class NeedChoice {
  constructor(req) { this.req = req; }
}
