// Game state construction and read-only queries.
import { CARDS, EMPIRE_SQUARES } from '../data/cards.js';
import { EMPIRES, EAST_EMPIRES, WEST_EMPIRES, CITIES, CITY, BORDERS, BORDER, bordersOf, borderBetween, START_STATE, START_TOKENS, GRID, EMPORIA, EMPIRE_NAMES } from '../data/map.js';
import { shuffle, PRESTIGE_REL } from './util.js';

export const CARD = Object.fromEntries(CARDS.map(c => [c.id, c]));
export const BANK_ORDER = ['Fugger', 'Medici', 'Coeur', 'Marchionni'];

// ---- Ability catalogue (keyed by ability name on the card) ----
const ABILITY_KEYS = [
  [/SYNCRETISM|COLLEGIUM/i, 'immune_silence'],
  [/GRITTI|LEO AFRICANUS/i, 'dual_ops'],
  [/RAGUSAN|IMPERIAL ARSENAL/i, 'pirate_immune'],
  [/GENOCIDE|HOLOCAUST/i, 'behead_restrict'],
  [/MAMLUK GOLDEN AGE/i, 'patron_green_bishops'],
  [/SLAVE SOLDIERS/i, 'slave_soldiers'],
  [/JEWISH BANKERS/i, 'patron_vote_discount'],
  [/LEYMAN PATRONAGE/i, 'green_pirates_red'],
  [/RANSOM|AZTEC GOLD/i, 'ransom'],
  [/POPULAR REPRISALS/i, 'popular_reprisals'],
  [/FORTIFICATIONS/i, 'free_ops'],
  [/ASTRONOMICAL NAVIGATION|CARTOGRAPHY/i, 'patron_concessions'],
  [/SECULAR UNIVERSITY|NATURE OF THINGS/i, 'counts_republic'],
  [/CONDOTTIER/i, 'condottiere'],
  [/DOUBLE ENTRY|PRINTING PRESS|STADTWECHSEL/i, 'unlimited_hand'],
  [/BUFFER STATE/i, 'buffer_state'],
  [/RELIGION AS DELUSIONAL/i, 'apostasy_immune'],
  [/GERMAN HUMANISM|GERMAN RENAISSANCE|REPUBLICAN IDEALS/i, 'patron_law'],
  [/ENDING SUBSISTENCE/i, 'enclosure'],
  [/COMMANDER OF THE VENICE/i, 'free_fair'],
  [/COUNTER-REFORMATION/i, 'counter_reformation'],
  [/MEDICI CIPHERS/i, 'cryptography'],
  [/PATRON'S RENOWN/i, 'double_concessions'],
  [/PRAGMATIC TREACHERY/i, 'pragmatic_treachery'],
  [/HENRY VIII/i, 'henry8'],
  [/KNIGHTS OF RHODES/i, 'knights_rhodes'],
  [/CAPE OF GOOD HOPE/i, 'cape'],
];
for (const c of CARDS) {
  c.abilityKeys = [];
  for (const a of c.abilities) {
    let key = null;
    if (/costs 2 actions/i.test(a.text)) {
      const m = a.text.match(/declaring (\w+) victory/i);
      key = 'vic2_' + m[1].toLowerCase();
    } else {
      for (const [re, k] of ABILITY_KEYS) if (re.test(a.name)) { key = k; break; }
    }
    a.key = key;
    if (key) c.abilityKeys.push(key);
    else console.warn('Unmapped ability', c.id, a.name);
  }
  if (c.abilityKeys.includes('free_ops')) c.freeOpsSide = c.side; // Civil Engineer = East, Mining Engineer = West
}

export const isEmp = (k) => typeof k === 'string' && k.startsWith('EMP:');
export const empOf = (k) => k.slice(4);
export const empKey = (e) => 'EMP:' + e;
export const empSide = (e) => EMPIRE_SQUARES[e].side;

export function locSet(loc) {
  if (!loc) return [];
  if (loc === 'East') return EAST_EMPIRES;
  if (loc === 'West') return WEST_EMPIRES;
  return [loc];
}
export const intersects = (a, b) => a.some(x => b.includes(x));

// ---------------- setup ----------------
export function newGame({ seed = Date.now() >>> 0, players = [{ name: 'Player 1' }, { name: 'Player 2' }], banks = null } = {}) {
  const s = { seed, rng: seed >>> 0, log: [], gameOver: false, winner: null, turnNo: 1 };
  const n = players.length;
  let bankList = banks ? banks.slice() : shuffle(s, BANK_ORDER.slice()).slice(0, n);
  s.numPlayers = n;
  s.players = players.map((pl, i) => ({
    name: pl.name || `Player ${i + 1}`, bot: !!pl.bot, botType: pl.bot ? pl.botType || 'random' : null, bank: bankList[i], florins: 0,
    hand: [], west: [], east: [], oldMaids: [], pawns: 10,
  }));
  // seating: random; Fugger always first
  let order = shuffle(s, s.players.map((_, i) => i));
  const f = order.findIndex(i => s.players[i].bank === 'Fugger');
  if (f > 0) order = order.slice(f).concat(order.slice(0, f));
  s.players = order.map(i => s.players[i]);
  s.players.forEach((p, i) => { p.florins = 3 + i; });
  s.current = 0;

  s.mapState = { ...START_STATE };
  s.activeEmporium = { black: 'Tana', white: 'Trebizond' };
  s.cities = Object.fromEntries(CITIES.map(c => [c.id, []]));
  s.borders = Object.fromEntries(BORDERS.map(b => [b.id, { pawn: null, pirate: null }]));
  s.pool = { bishop: { C: 5, I: 5, R: 5 }, K: { C: 10, I: 7, R: 7 }, R: { C: 10, I: 7, R: 7 }, pirate: { C: 6, I: 4, R: 3 } };
  for (const [city, t, c] of START_TOKENS) { s.cities[city].push({ t, c }); s.pool[t][c]--; }
  s.players.forEach((p, i) => {
    const b = BORDERS.find(b => b.start === p.bank);
    s.borders[b.id].pawn = i; p.pawns--;
  });
  s.empires = Object.fromEntries(EMPIRES.map(e => [e, { owner: null, face: 'king', suzerain: null, queen: null, repressed: [], bishop: null }]));
  s.bishops = {}; // cardId -> color (bishops on tableau cards)
  s.victory = { holy: false, imperial: false, globalization: false, renaissance: false };

  // decks
  s.decks = {};
  s.market = {};
  for (const side of ['E', 'W']) {
    const pool = shuffle(s, CARDS.filter(c => c.side === side && !c.comet).map(c => c.id));
    const comets = CARDS.filter(c => c.side === side && c.comet).map(c => c.id);
    const bottom = shuffle(s, pool.splice(0, 12).concat(comets));
    const top = pool.splice(0, 4 * n);
    s.decks[side] = bottom.concat(top); // end of array = top of deck
    s.market[side] = [];
    for (let i = 0; i < 6; i++) s.market[side].push({ card: s.decks[side].pop(), florins: 0, faceDown: i === 0 });
  }
  // cards that have ever been face up in the market (so every player could know them)
  s.seen = {};
  for (const side of ['E', 'W']) for (const sl of s.market[side]) if (!sl.faceDown) s.seen[sl.card] = true;
  s.turn = freshTurn();
  s.log.push(`Game start. Turn order: ${s.players.map(p => `${p.name} (${p.bank})`).join(', ')}.`);
  return s;
}

export function freshTurn() {
  return { actions: 0, counts: { purchase: 0, play: 0, sell: 0 }, did: {}, usury: [], used: [] };
}

// ---------------- queries ----------------
export function cardLoc(s, key) {
  // effective Location (array of empires) of a tableau unit or bishop holder
  if (isEmp(key)) return [empOf(key)];
  const c = CARD[key];
  if (c.suitors) { const e = coupleOf(s, key); return e ? [e] : []; }
  return locSet(c.loc);
}
export function coupleOf(s, queenId) {
  for (const e of EMPIRES) if (s.empires[e].queen === queenId) return e;
  return null;
}
export function vassalsOf(s, e) { return EMPIRES.filter(v => s.empires[v].suzerain === e); }
export function topSuzerain(s, e) { let x = e; while (s.empires[x].suzerain) x = s.empires[x].suzerain; return x; }

// side of the tableau an owned empire sits in (vassals sit with their suzerain)
export function empireTableauSide(s, e) {
  const p = s.empires[e].owner; if (p === null) return null;
  const top = topSuzerain(s, e);
  const k = empKey(top);
  if (s.players[p].west.includes(k)) return 'W';
  if (s.players[p].east.includes(k)) return 'E';
  return empSide(top);
}

// All units in a player's tableau: {key, kind:'card'|'empire'|'queen', side}
export function tableauUnits(s, p) {
  const P = s.players[p]; const out = [];
  for (const side of ['W', 'E']) {
    const row = side === 'W' ? P.west : P.east;
    for (const k of row) {
      if (isEmp(k)) {
        const stack = [empOf(k)];
        while (stack.length) {
          const e = stack.shift();
          out.push({ key: empKey(e), kind: 'empire', side, empire: e });
          if (s.empires[e].queen) out.push({ key: s.empires[e].queen, kind: 'queen', side, empire: e });
          stack.push(...vassalsOf(s, e));
        }
      } else out.push({ key: k, kind: 'card', side });
    }
  }
  return out;
}

export function ownerOfUnit(s, key) {
  if (isEmp(key)) return s.empires[empOf(key)].owner;
  for (let i = 0; i < s.numPlayers; i++) {
    const P = s.players[i];
    if (P.west.includes(key) || P.east.includes(key)) return i;
  }
  const e = coupleOf(s, key); if (e) return s.empires[e].owner;
  return null;
}

// bishop holder for a unit (queens in a royal couple share the king's square)
export function holderOf(s, key) {
  if (!isEmp(key) && CARD[key].suitors) { const e = coupleOf(s, key); return e ? empKey(e) : key; }
  return key;
}
export function getBishop(s, h) { return isEmp(h) ? s.empires[empOf(h)].bishop : (s.bishops[h] || null); }
export function setBishop(s, h, c) { if (isEmp(h)) s.empires[empOf(h)].bishop = c; else if (c) s.bishops[h] = c; else delete s.bishops[h]; }

export function hasAbilityCard(s, p, key) {
  return tableauUnits(s, p).some(u => u.kind !== 'empire' && CARD[u.key].abilityKeys.includes(key));
}
export function immune(s, p) { return p !== null && hasAbilityCard(s, p, 'immune_silence'); }
export function isSilenced(s, key) {
  const h = holderOf(s, key);
  if (!getBishop(s, h)) return false;
  const p = ownerOfUnit(s, key);
  if (!isEmp(key) && CARD[key].abilityKeys.includes('immune_silence')) return false;
  return !immune(s, p);
}
// count of active (unsilenced) instances of an ability in p's tableau
export function abilityCount(s, p, key) {
  let n = 0;
  for (const u of tableauUnits(s, p)) {
    if (u.kind === 'empire') continue;
    const c = CARD[u.key];
    if (c.abilityKeys.includes(key) && !isSilenced(s, u.key)) n += c.abilityKeys.filter(k => k === key).length;
  }
  return n;
}
export function abilityAny(s, key) { // red-text "all players" abilities
  for (let p = 0; p < s.numPlayers; p++) if (abilityCount(s, p, key)) return true;
  return false;
}

export function handLimit(s, p) { return abilityCount(s, p, 'unlimited_hand') ? Infinity : 2; }

export function unitPrestige(s, u) {
  if (u.kind === 'empire') return EMPIRE_SQUARES[u.empire][s.empires[u.empire].face].prestige;
  return CARD[u.key].prestige;
}
export function prestigeCount(s, p, kind) {
  let n = 0;
  for (const u of tableauUnits(s, p)) n += unitPrestige(s, u).filter(x => x === kind).length;
  for (const q of s.players[p].oldMaids) n += CARD[q].prestige.filter(x => x === kind).length;
  return n;
}
export function unitOps(s, u) {
  if (u.kind === 'empire') return EMPIRE_SQUARES[u.empire][s.empires[u.empire].face].ops;
  return CARD[u.key].ops;
}

// adjacency of empires (shared border or diagonal)
export function adjacent(s, a, b) {
  if (a === b) return false;
  const [ca, ra] = GRID[a], [cb, rb] = GRID[b];
  if (Math.abs(ca - cb) > 1 || Math.abs(ra - rb) > 1) return false;
  if (ca !== cb && ra !== rb) { // diagonal
    if (abilityAny(s, 'buffer_state') && ((a === 'Portugal' && b === 'France') || (a === 'France' && b === 'Portugal'))) return false;
  }
  return true;
}
export function adjacentEmpires(s, e) { return EMPIRES.filter(x => adjacent(s, e, x)); }

// ---------------- map queries ----------------
export function emporiumBusted(s, cityId) {
  const c = CITY[cityId];
  if (!c.emporium) return false;
  return s.activeEmporium[c.emporium] !== cityId;
}
export function venicePairAllowed(s) {
  return abilityAny(s, 'condottiere') && (s.mapState.Papal === 'M' || s.mapState.Papal === 'C');
}
export function cityCapacity(s, cityId) {
  if (emporiumBusted(s, cityId)) return 0;
  if (cityId === 'Venice' && venicePairAllowed(s)) return 2;
  return 1;
}
export function empireCities(e) { return CITIES.filter(c => c.empire === e).map(c => c.id); }
export function levyIcon(s, cityId) { return CITY[cityId].icons[s.mapState[CITY[cityId].empire]]; }
// cities where a Levy may be placed (unoccupied space matching icon)
export function levyCities(s, e) {
  return empireCities(e).filter(id => {
    const cap = cityCapacity(s, id); const toks = s.cities[id];
    if (toks.length >= cap) return false;
    if (id === 'Venice' && toks.length === 1 && !(toks[0].c === 'C')) return false;
    return true;
  });
}
export function saturated(s, e) { return levyCities(s, e).length === 0; }
export function rulingClass(s, e) {
  const out = [];
  for (const id of empireCities(e)) s.cities[id].forEach((tok, i) => out.push({ city: id, i, tok }));
  return out;
}
export function seaBordersOf(e) { return bordersOf(e).filter(b => b.sea).map(b => b.id); }
export function concessionsOf(s, p) { return BORDERS.filter(b => s.borders[b.id].pawn === p).length; }

export function playerLabel(s, p) { return s.players[p].name; }
export function empName(e) { return EMPIRE_NAMES[e] || e; }
export function cardName(s, key) {
  if (isEmp(key)) { const e = empOf(key); return `${empName(e)} (${s.empires[e].face === 'king' ? 'King' : 'Republic'})`; }
  return CARD[key].name;
}
export { CITY, BORDER, BORDERS, EMPIRES, EAST_EMPIRES, WEST_EMPIRES, bordersOf, borderBetween, EMPORIA, PRESTIGE_REL };
