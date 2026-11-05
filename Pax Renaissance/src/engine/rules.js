// Pax Renaissance 2E rules. All procedures are written as straight-line code that asks for
// decisions via ctx.choose(); see game.js for how decisions are replayed.
import { CARD, isEmp, empOf, empKey, empSide, locSet, intersects, freshTurn, cardLoc, coupleOf, vassalsOf, topSuzerain,
  empireTableauSide, tableauUnits, ownerOfUnit, holderOf, getBishop, setBishop, isSilenced, abilityCount, abilityAny,
  handLimit, prestigeCount, unitOps, adjacent, adjacentEmpires, emporiumBusted, cityCapacity, empireCities, levyIcon,
  levyCities, saturated, rulingClass, seaBordersOf, concessionsOf, cardName, empName, hasAbilityCard,
  CITY, BORDER, BORDERS, EMPIRES, EAST_EMPIRES, WEST_EMPIRES, bordersOf, borderBetween, EMPORIA } from './state.js';
import { ROUTES } from '../data/map.js';
import { EMPIRE_SQUARES } from '../data/cards.js';
import { REL_NAME, REL_COLOR, REL_PRESTIGE, PRESTIGE_REL, tokenLabel } from './util.js';

const log = (s, msg) => s.log.push(msg);
const pn = (s, p) => s.players[p].name;
const opt = (id, label, ref) => (ref ? { id, label, ref } : { id, label });

// ======================================================================
//  Tokens
// ======================================================================
function takeToken(s, t, c) {
  if (s.pool[t][c] > 0) { s.pool[t][c]--; return true; }
  for (const e of EMPIRES) {
    const r = s.empires[e].repressed; const i = r.findIndex(x => x.t === t && x.c === c);
    if (i >= 0) { r.splice(i, 1); return true; }
  }
  for (const id in s.cities) {
    const i = s.cities[id].findIndex(x => x.t === t && x.c === c);
    if (i >= 0) { s.cities[id].splice(i, 1); return true; }
  }
  return false;
}
function takePirate(s, c) {
  if (s.pool.pirate[c] > 0) { s.pool.pirate[c]--; return true; }
  const b = BORDERS.find(b => s.borders[b.id].pirate === c);
  if (b) { s.borders[b.id].pirate = null; return true; }
  return false;
}
function takePawn(s, p) {
  const P = s.players[p];
  if (P.pawns > 0) { P.pawns--; return true; }
  for (const e of EMPIRES) {
    const r = s.empires[e].repressed; const i = r.findIndex(x => x.t === 'P' && x.c === p);
    if (i >= 0) { r.splice(i, 1); return true; }
  }
  const b = BORDERS.find(b => s.borders[b.id].pawn === p);
  if (b) { s.borders[b.id].pawn = null; return true; }
  return false;
}
function killTok(s, tok) {
  if (tok.t === 'P') s.players[tok.c].pawns++;
  else if (tok.t === 'pirate') s.pool.pirate[tok.c]++;
  else s.pool[tok.t][tok.c]++;
}
function killBishop(s, c) { s.pool.bishop[c]++; }
function pay(s, p, n) { s.players[p].florins -= n; }
function gain(s, p, n) { s.players[p].florins += n; }

// ======================================================================
//  Card movement
// ======================================================================
function removeFromRow(s, key) {
  for (const P of s.players) {
    for (const row of [P.west, P.east, P.hand, P.oldMaids]) {
      const i = row.indexOf(key); if (i >= 0) { row.splice(i, 1); return true; }
    }
  }
  return false;
}
// discard a non-empire card out of the game (with its bishop)
function discardCard(s, key, why = 'discarded') {
  const e = coupleOf(s, key);
  if (e) s.empires[e].queen = null;
  else removeFromRow(s, key);
  const b = s.bishops[key]; if (b) { killBishop(s, b); delete s.bishops[key]; }
  log(s, `${CARD[key].name} ${why}.`);
}
// return an empire square (and its vassals) to the Throne
function returnToThrone(s, e, { killQueen = false, keepBishop = true } = {}) {
  const E = s.empires[e];
  for (const v of vassalsOf(s, e)) returnToThrone(s, v, {});
  removeFromRow(s, empKey(e));
  E.owner = null; E.suzerain = null; E.face = 'king';
  if (killQueen && E.queen) { log(s, `${CARD[E.queen].name} is killed.`); E.queen = null; }
  if (!keepBishop && E.bishop) { killBishop(s, E.bishop); E.bishop = null; }
}
function addEmpireToTableau(s, p, e) {
  const side = empSide(e);
  (side === 'W' ? s.players[p].west : s.players[p].east).push(empKey(e));
}

// ======================================================================
//  Location / targeting helpers
// ======================================================================
function chooseEmpire(s, p, ctx, empires, prompt) {
  if (empires.length === 1) return empires[0];
  return ctx.choose(p, prompt, empires.map(e => opt(e, empName(e), { type: 'empire', id: e }))).id;
}
// all bishop holders: tableau cards/empires of all players + thrones
function allHolders(s) {
  const out = [];
  for (let p = 0; p < s.numPlayers; p++) for (const u of tableauUnits(s, p)) if (u.kind !== 'queen') out.push(u.key);
  for (const e of EMPIRES) if (s.empires[e].owner === null) out.push(empKey(e));
  return out;
}
function rowOfHolder(s, h) {
  for (let p = 0; p < s.numPlayers; p++) {
    const P = s.players[p];
    const row = P.west.slice().reverse().concat(['BOARD'], P.east);
    if (row.includes(h)) return { p, row };
  }
  return null;
}
function tableauNeighbors(s, h) {
  const out = new Set();
  if (isEmp(h)) {
    const e = empOf(h); const E = s.empires[e];
    if (E.owner === null) return [];
    if (E.suzerain) {
      const sz = E.suzerain; out.add(empKey(sz));
      vassalsOf(s, sz).forEach(v => v !== e && out.add(empKey(v)));
      const top = topSuzerain(s, e); const r = rowOfHolder(s, empKey(top));
      if (r) { const i = r.row.indexOf(empKey(top)); [r.row[i - 1], r.row[i + 1]].forEach(x => x && x !== 'BOARD' && out.add(x)); }
      return [...out];
    }
    vassalsOf(s, e).forEach(v => out.add(empKey(v)));
  }
  const r = rowOfHolder(s, h);
  if (r) {
    const i = r.row.indexOf(h);
    for (const j of [i - 1, i + 1]) {
      const x = r.row[j]; if (!x || x === 'BOARD') continue;
      out.add(x);
      if (isEmp(x)) vassalsOf(s, empOf(x)).forEach(v => out.add(empKey(v)));
    }
  }
  return [...out];
}
function holderLabel(s, h) {
  const own = isEmp(h) ? s.empires[empOf(h)].owner : ownerOfUnit(s, h);
  return `${cardName(s, h)}${own === null ? ' [Throne]' : ` [${s.players[own].name}]`}`;
}

// place a bishop on holder h, applying Diet of Worms / pacification
function landBishop(s, p, h, color, ctx) {
  const cur = getBishop(s, h);
  if (cur) {
    killBishop(s, cur); killBishop(s, color); setBishop(s, h, null);
    log(s, `Diet of Worms: both Bishops on ${cardName(s, h)} are killed.`);
    return;
  }
  setBishop(s, h, color);
  log(s, `${REL_COLOR[color]} Bishop placed on ${cardName(s, h)}.`);
  if (isEmp(h)) {
    const E = s.empires[empOf(h)];
    if (E.repressed.length) {
      const opts = [opt('none', 'Do not pacify')].concat(E.repressed.map((t, i) => opt('k' + i, `Pacify (kill) repressed ${tokenLabel(t)}`)));
      const c = ctx.choose(p, `Pacification on ${empName(empOf(h))}?`, opts);
      if (c.id !== 'none') { const t = E.repressed.splice(+c.id.slice(1), 1)[0]; killTok(s, t); log(s, `Pacified a repressed ${tokenLabel(t)}.`); }
    }
  }
  enforceAll(s, ctx);
}

// ---- agent placement ----
function bishopTargets(s, playedKey, empires) {
  return allHolders(s).filter(h => h === playedKey || intersects(cardLoc(s, h), empires));
}
function placeBishopAgent(s, p, color, playedKey, empires, ctx, mandatory) {
  if (s.pool.bishop[color] <= 0 && !allHolders(s).some(h => getBishop(s, h) === color)) return;
  const ts = bishopTargets(s, playedKey, empires);
  const opts = ts.map(h => opt('h:' + h, `${REL_COLOR[color]} Bishop → ${holderLabel(s, h)}`, { type: 'holder', id: h }));
  if (!mandatory) opts.push(opt('skip', 'Do not place this Bishop'));
  if (!opts.length) return;
  const c = ctx.choose(p, `Place ${REL_COLOR[color]} Bishop agent`, opts);
  if (c.id === 'skip') return;
  if (s.pool.bishop[color] <= 0) {
    const from = allHolders(s).filter(h => getBishop(s, h) === color);
    const f = from.length === 1 ? from[0] : ctx.choose(p, `No ${REL_COLOR[color]} Bishops left: take one from`, from.map(h => opt('f:' + h, holderLabel(s, h), { type: 'holder', id: h }))).id.slice(2);
    setBishop(s, f, null); s.pool.bishop[color]++;
  }
  s.pool.bishop[color]--;
  landBishop(s, p, c.id.slice(2), color, ctx);
}
// options to place a ruling-class token (agent) into a city of the given empires
function cityHasRoom(s, id, tok) {
  const toks = s.cities[id]; if (toks.length >= cityCapacity(s, id)) return false;
  if (id === 'Venice' && toks.length === 1) return tok.c === 'C' && toks[0].c === 'C';
  return true;
}
function cityAgentOptions(s, p, empires, payForRepress = true, tok = { c: 'C' }) {
  const out = [];
  for (const e of empires) for (const id of empireCities(e)) {
    const cap = cityCapacity(s, id); if (!cap) continue;
    const toks = s.cities[id];
    if (cityHasRoom(s, id, tok)) out.push(opt('c:' + id + ':-', `${CITY[id].name || id} (empty)`, { type: 'city', id }));
    else if (!payForRepress || s.players[p].florins >= 1)
      toks.forEach((t, i) => out.push(opt(`c:${id}:${i}`, `${CITY[id].name || id}: repress ${tokenLabel(t)}${payForRepress ? ' (1 florin)' : ''}`, { type: 'city', id })));
  }
  return out;
}
function placeCityAgent(s, p, tok, empires, ctx, mandatory) {
  const opts = cityAgentOptions(s, p, empires, true, tok);
  if (!mandatory) opts.push(opt('skip', `Do not place this ${tokenLabel(tok)}`));
  if (!opts.length) return null;
  const c = ctx.choose(p, `Place ${tokenLabel(tok)} agent`, opts);
  if (c.id === 'skip') return null;
  const [, id, ix] = c.id.split(':');
  if (ix !== '-') {
    const old = s.cities[id].splice(+ix, 1)[0];
    s.empires[CITY[id].empire].repressed.push(old); pay(s, p, 1);
    log(s, `${tokenLabel(old)} in ${CITY[id].name || id} repressed (1 florin).`);
  }
  if (!takeToken(s, tok.t, tok.c)) { log(s, `No ${tokenLabel(tok)} available.`); return null; }
  s.cities[id].push({ t: tok.t, c: tok.c });
  log(s, `${tokenLabel(tok)} placed in ${CITY[id].name || id}.`);
  return id;
}
function pirateKills(s, b) {
  const B = s.borders[b];
  if (B.pirate) { killTok(s, { t: 'pirate', c: B.pirate }); log(s, `Pirate at ${b} killed.`); B.pirate = null; }
  if (B.pawn !== null && !abilityCount(s, B.pawn, 'pirate_immune')) {
    killTok(s, { t: 'P', c: B.pawn }); log(s, `Concession of ${pn(s, B.pawn)} at ${b} killed.`); B.pawn = null;
  }
}
function placePirateAgent(s, p, color, empires, ctx, mandatory) {
  const bs = [...new Set(empires.flatMap(seaBordersOf))];
  const opts = bs.map(b => opt('b:' + b, `${REL_COLOR[color]} Pirate → ${b}${describeBorder(s, b)}`, { type: 'border', id: b }));
  if (!mandatory) opts.push(opt('skip', 'Do not place this Pirate'));
  if (!opts.length) return;
  const c = ctx.choose(p, `Place ${REL_COLOR[color]} Pirate agent`, opts);
  if (c.id === 'skip') return;
  if (!takePirate(s, color)) return;
  const b = c.id.slice(2);
  pirateKills(s, b);
  s.borders[b].pirate = color;
  log(s, `${REL_COLOR[color]} Pirate placed at ${b}.`);
}
function describeBorder(s, b) {
  const B = s.borders[b]; const parts = [];
  if (B.pawn !== null) parts.push(`${s.players[B.pawn].bank} concession`);
  if (B.pirate) parts.push(`${REL_COLOR[B.pirate]} pirate`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}
// pawn placement options in borders of the given empires (no pirate); repress costs 1
function pawnOptions(s, p, empires, cost = 1) {
  const out = [];
  for (const e of empires) for (const b of bordersOf(e)) {
    const B = s.borders[b.id]; if (B.pirate) continue;
    if (B.pawn === null) out.push(opt(`b:${b.id}:${e}`, `Concession → ${b.id}`, { type: 'border', id: b.id }));
    else if (s.players[p].florins >= cost) out.push(opt(`b:${b.id}:${e}`, `Concession → ${b.id}: repress ${s.players[B.pawn].bank} pawn into ${empName(e)} (${cost} florin)`, { type: 'border', id: b.id }));
  }
  // dedupe identical empty-border options
  const seen = new Set(); return out.filter(o => { const k = o.label; if (seen.has(k)) return false; seen.add(k); return true; });
}
function placePawnAgent(s, p, empires, ctx, mandatory, prompt = 'Place Pawn agent (Concession)') {
  const opts = pawnOptions(s, p, empires);
  if (!mandatory) opts.push(opt('skip', 'Do not place this Pawn'));
  if (!opts.length) return;
  const c = ctx.choose(p, prompt, opts);
  if (c.id === 'skip') return;
  const [, b, e] = c.id.split(':');
  const B = s.borders[b];
  if (B.pawn !== null) {
    s.empires[e].repressed.push({ t: 'P', c: B.pawn }); pay(s, p, 1);
    log(s, `${s.players[B.pawn].bank} Concession at ${b} repressed into ${empName(e)}.`); B.pawn = null;
  }
  if (!takePawn(s, p)) return;
  B.pawn = p; log(s, `${pn(s, p)} places a Concession at ${b}.`);
}
function placeAgents(s, p, card, playedKey, empires, ctx, mandatory, { skipBishops = false, onlyBishops = false } = {}) {
  for (const a of card.agents) {
    if (a.type === 'bishop') { if (!skipBishops) placeBishopAgent(s, p, a.color, playedKey, empires, ctx, mandatory); continue; }
    if (onlyBishops) continue;
    if (a.type === 'knight' || a.type === 'rook') placeCityAgent(s, p, { t: a.type === 'knight' ? 'K' : 'R', c: a.color }, empires, ctx, mandatory);
    else if (a.type === 'pirate') placePirateAgent(s, p, a.color, empires, ctx, mandatory);
    else if (a.type === 'pawn') placePawnAgent(s, p, empires, ctx, mandatory);
  }
}

// ======================================================================
//  Consistency checks run after every step
// ======================================================================
export function enforceAll(s, ctx) {
  // Venice condottieri
  const V = s.cities.Venice;
  if (V.length > 1 && (cityCapacity(s, 'Venice') < 2 || V.some(t => t.c !== 'C'))) {
    const i = V.findIndex(t => t.c !== 'C'); const t = V.splice(i >= 0 ? i : 1, 1)[0]; killTok(s, t);
    log(s, `Venice discards down to one token (${tokenLabel(t)} killed).`);
  }
  // hand limits
  for (let p = 0; p < s.numPlayers; p++) {
    const P = s.players[p];
    while (P.hand.length > handLimit(s, p)) {
      const c = ctx.choose(p, `Hand limit exceeded: discard a card`, P.hand.map(k => opt('d:' + k, `Discard ${CARD[k].name}`, { type: 'card', id: k })));
      const k = c.id.slice(2); P.hand.splice(P.hand.indexOf(k), 1); log(s, `${pn(s, p)} discards ${CARD[k].name} (hand limit).`);
    }
  }
}

// ======================================================================
//  Battles
// ======================================================================
// attackers/defenders: [{label, kill(), survive?()}]
function battle(s, p, attackers, defenders, ctx, title) {
  const A = attackers.length, D = defenders.length; const n = Math.min(A, D);
  log(s, `${title}: ${A} attacker(s) vs ${D} defender(s).`);
  let atts = attackers.slice(), defs = defenders.slice();
  for (let i = 0; i < n; i++) {
    if (defs.length > 1 && !allSame(defs)) {
      const c = ctx.choose(p, `${title}: choose a defender to kill (${n - i} exchange(s) left)`, uniq(defs).map(d => opt('d:' + defs.indexOf(d), d.label, d.ref)));
      const d = defs.splice(+c.id.slice(2), 1)[0]; d.kill();
    } else defs.shift().kill();
    if (atts.length > 1 && !allSame(atts)) {
      const c = ctx.choose(p, `${title}: choose one of your attackers to lose`, uniq(atts).map(a => opt('a:' + atts.indexOf(a), a.label, a.ref)));
      const a = atts.splice(+c.id.slice(2), 1)[0]; a.kill();
    } else atts.shift().kill();
  }
  const won = atts.length > 0;
  log(s, won ? `${title}: Victorious with ${atts.length} survivor(s).` : `${title}: the attack fails.`);
  return { won, survivors: atts };
}
const allSame = (arr) => arr.every(x => x.label === arr[0].label);
function uniq(arr) { const seen = new Set(); return arr.filter(x => { if (seen.has(x.label)) return false; seen.add(x.label); return true; }); }

function cityDefenders(s, e, filter = () => true) {
  return rulingClass(s, e).filter(r => filter(r.tok)).map(r => ({
    label: `${tokenLabel(r.tok)} in ${CITY[r.city].name || r.city}`, ref: { type: 'city', id: r.city }, tok: r.tok,
    kill() { const arr = s.cities[r.city]; const i = arr.indexOf(r.tok); if (i >= 0) arr.splice(i, 1); killTok(s, r.tok); },
  }));
}
function borderPirates(s, e, filter = () => true) {
  return bordersOf(e).filter(b => s.borders[b.id].pirate && filter(s.borders[b.id].pirate)).map(b => {
    const c = s.borders[b.id].pirate;
    return { label: `${REL_COLOR[c]} Pirate at ${b.id}`, ref: { type: 'border', id: b.id }, tok: { t: 'pirate', c },
      kill() { if (s.borders[b.id].pirate === c) { s.borders[b.id].pirate = null; killTok(s, { t: 'pirate', c }); } } };
  });
}
function agentAttackers(s, card) {
  return card.agents.filter(a => a.type !== 'bishop').map(a => {
    const tok = a.type === 'pawn' ? { t: 'P' } : a.type === 'pirate' ? { t: 'pirate', c: a.color } : { t: a.type === 'knight' ? 'K' : 'R', c: a.color };
    const nm = a.type === 'pawn' ? 'Pawn' : `${REL_COLOR[a.color]} ${a.type[0].toUpperCase() + a.type.slice(1)}`;
    return { label: `Agent ${nm}`, agent: true, tok, kill() {} };
  });
}
function repressedAttackers(s, e, types) {
  const E = s.empires[e];
  return E.repressed.filter(t => types.includes(t.t)).map(t => ({
    label: `Repressed ${tokenLabel(t)}`, repressed: true, tok: t,
    kill() { const i = E.repressed.indexOf(t); if (i >= 0) E.repressed.splice(i, 1); killTok(s, t); },
  }));
}
// place surviving agents / repressed attackers into the conquered empire
function placeSurvivors(s, p, e, survivors, ctx) {
  for (const sv of survivors) {
    if (!sv.agent && !sv.repressed) continue;
    const E = s.empires[e];
    if (sv.repressed) { const i = E.repressed.indexOf(sv.tok); if (i >= 0) E.repressed.splice(i, 1); }
    const tok = sv.tok;
    if (tok.t === 'K' || tok.t === 'R') {
      if (sv.agent && !takeToken(s, tok.t, tok.c)) continue;
      const free = empireCities(e).filter(id => cityHasRoom(s, id, tok));
      if (!free.length) { E.repressed.push({ t: tok.t, c: tok.c }); log(s, `Survivor ${tokenLabel(tok)} repressed (no room).`); continue; }
      const c = free.length === 1 ? free[0] : ctx.choose(p, `Place surviving ${tokenLabel(tok)} in a city of ${empName(e)}`, free.map(id => opt(id, CITY[id].name || id, { type: 'city', id }))).id;
      s.cities[c].push({ t: tok.t, c: tok.c }); log(s, `Survivor ${tokenLabel(tok)} placed in ${CITY[c].name || c}.`);
    } else if (tok.t === 'pirate') {
      if (!takePirate(s, tok.c)) continue;
      const free = seaBordersOf(e).filter(b => !s.borders[b].pirate && s.borders[b].pawn === null);
      if (!free.length) { killTok(s, tok); continue; }
      const b = free.length === 1 ? free[0] : ctx.choose(p, `Place surviving ${REL_COLOR[tok.c]} Pirate`, free.map(b => opt(b, b, { type: 'border', id: b }))).id;
      s.borders[b].pirate = tok.c; log(s, `Survivor Pirate placed at ${b}.`);
    } else if (tok.t === 'P') {
      const owner = sv.agent ? p : tok.c;
      if (sv.agent && !takePawn(s, p)) continue;
      const free = bordersOf(e).filter(b => !s.borders[b.id].pirate && s.borders[b.id].pawn === null).map(b => b.id);
      if (!free.length) { E.repressed.push({ t: 'P', c: owner }); log(s, `Surviving Pawn repressed (no room).`); continue; }
      const b = free.length === 1 ? free[0] : ctx.choose(p, `Place surviving Pawn (${s.players[owner].bank}) as a Concession`, free.map(b => opt(b, b, { type: 'border', id: b }))).id;
      s.borders[b].pawn = owner; log(s, `Surviving Pawn becomes a ${s.players[owner].bank} Concession at ${b}.`);
    }
  }
}

// ======================================================================
//  Regime change
// ======================================================================
// mode: 'war' | 'vote' | 'campaign' | 'coronation'
function regimeChange(s, p, e, ctx, { mode, suzerain = null, queen = null } = {}) {
  const E = s.empires[e];
  const prev = E.owner;
  log(s, `REGIME CHANGE in ${empName(e)} by ${pn(s, p)}.`);
  if (mode === 'coronation') {
    if (prev === null) { E.owner = p; E.face = 'king'; addEmpireToTableau(s, p, e); }
    else if (prev !== p) { // Henry VIII
      detachFrom(s, e, prev); for (const v of vassalsOf(s, e)) returnToThrone(s, v);
      if (E.bishop) { killBishop(s, E.bishop); E.bishop = null; }
      E.owner = p; E.face = 'king'; addEmpireToTableau(s, p, e);
    }
    if (E.queen) { log(s, `${CARD[E.queen].name} is killed.`); E.queen = null; }
    E.queen = queen;
  } else if (prev === p && mode !== 'campaign') {
    // strawman: flip
    if (E.queen) { log(s, `${CARD[E.queen].name} is killed.`); E.queen = null; }
    if (E.bishop) { killBishop(s, E.bishop); E.bishop = null; }
    for (const v of vassalsOf(s, e)) returnToThrone(s, v);
    removeFromRow(s, empKey(e)); E.suzerain = null;
    E.face = E.face === 'king' ? 'republic' : 'king';
    addEmpireToTableau(s, p, e);
    log(s, `${empName(e)} flips to its ${E.face === 'king' ? 'King' : 'Republic'} side.`);
  } else {
    if (prev !== null) {
      detachFrom(s, e, prev);
      if (E.queen) { log(s, `${CARD[E.queen].name} is killed.`); E.queen = null; }
      if (E.bishop) { killBishop(s, E.bishop); E.bishop = null; }
    }
    for (const v of vassalsOf(s, e)) returnToThrone(s, v);
    E.owner = p; E.face = 'king';
    if (mode === 'campaign') { E.suzerain = suzerain; log(s, `${empName(e)} becomes a Vassal of ${empName(suzerain)}.`); }
    else addEmpireToTableau(s, p, e);
  }
  // Concession
  const copts = pawnOptions(s, p, [e]).filter(o => o.id.endsWith(':' + e));
  if (copts.length) {
    copts.push(opt('skip', 'No Concession'));
    const c = ctx.choose(p, `Regime change: place a Concession in ${empName(e)}?`, copts);
    if (c.id !== 'skip') {
      const [, b] = c.id.split(':'); const B = s.borders[b];
      if (B.pawn !== null) { E.repressed.push({ t: 'P', c: B.pawn }); pay(s, p, 1); log(s, `${s.players[B.pawn].bank} Concession at ${b} repressed.`); B.pawn = null; }
      if (takePawn(s, p)) { B.pawn = p; log(s, `${pn(s, p)} gains a Concession at ${b}.`); }
    }
  }
  emancipate(s, p, e, ctx);
  enforceAll(s, ctx);
}
function detachFrom(s, e, owner) {
  const E = s.empires[e];
  if (E.suzerain) E.suzerain = null; else removeFromRow(s, empKey(e));
}
function emancipate(s, p, e, ctx) {
  const E = s.empires[e];
  for (;;) {
    const opts = [];
    E.repressed.forEach((t, i) => {
      if (t.t === 'P') {
        for (const b of bordersOf(e)) if (!s.borders[b.id].pirate && s.borders[b.id].pawn === null)
          opts.push(opt(`e:${i}:b:${b.id}`, `Emancipate ${tokenLabel(t)} → ${b.id}`, { type: 'border', id: b.id }));
      } else {
        for (const id of empireCities(e)) if (cityHasRoom(s, id, t))
          opts.push(opt(`e:${i}:c:${id}`, `Emancipate ${tokenLabel(t)} → ${CITY[id].name || id}`, { type: 'city', id }));
      }
    });
    if (!opts.length) return;
    const u = uniq(opts); u.push(opt('done', 'Done emancipating'));
    const c = ctx.choose(p, `Emancipation in ${empName(e)}`, u);
    if (c.id === 'done') return;
    const [, i, kind, where] = c.id.split(':');
    const t = E.repressed.splice(+i, 1)[0];
    if (kind === 'b') s.borders[where].pawn = t.c; else s.cities[where].push(t);
    log(s, `Emancipated ${tokenLabel(t)}.`);
  }
}

// ======================================================================
//  One-shots
// ======================================================================
function oneShotFeasible(s, p, card, key) {
  const os = card.oneShot; if (!os) return false;
  switch (os.type) {
    case 'trade_shift': {
      const col = EMPORIA.black.includes(os.emporium) ? 'black' : 'white';
      if (s.activeEmporium[col] === os.emporium) return false;
      if (os.requires && tableauPrestige(s, p, os.requires) - card.prestige.filter(x => x === os.requires).length <= 0) return false;
      return true;
    }
    case 'crusade': case 'jihad': case 'reformation': {
      const r = warReligion(os.type);
      return locSet(card.loc).some(e => warDefenders(s, e, r).length > 0);
    }
    case 'coronation': return false;
    default: return true;
  }
}
function tableauPrestige(s, p, kind) {
  let n = 0;
  for (const u of tableauUnits(s, p)) n += (u.kind === 'empire' ? empirePrestige(s, u.empire) : CARD[u.key].prestige).filter(x => x === kind).length;
  return n;
}
const warReligion = (t) => ({ crusade: 'C', jihad: 'I', reformation: 'R' }[t]);
function warDefenders(s, e, r) {
  return cityDefenders(s, e, t => t.c !== r).concat(borderPirates(s, e, c => c !== r));
}

function doTradeShift(s, p, emp) {
  const col = EMPORIA.black.includes(emp) ? 'black' : 'white';
  const old = s.activeEmporium[col];
  s.activeEmporium[col] = emp;
  const toks = s.cities[old].splice(0);
  toks.forEach(t => s.empires[CITY[old].empire].repressed.push(t));
  log(s, `Trade shift: ${CITY[emp].name || emp} opens; ${CITY[old].name || old} is busted${toks.length ? ` (${toks.length} token(s) repressed)` : ''}.`);
}

function doCivilWar(s, p, card, cardKey, e, type, ctx) {
  const attackers = (card ? agentAttackers(s, card) : []).concat(borderPirates(s, e));
  if (type === 'conspiracy') attackers.push(...repressedAttackers(s, e, ['K', 'R']));
  else {
    for (const b of bordersOf(e)) if (s.borders[b.id].pawn === p) {
      const bid = b.id;
      attackers.push({ label: `Your Concession at ${bid}`, ref: { type: 'border', id: bid }, tok: { t: 'P', c: p },
        kill() { if (s.borders[bid].pawn === p) { s.borders[bid].pawn = null; killTok(s, { t: 'P', c: p }); } } });
    }
    attackers.push(...repressedAttackers(s, e, ['P']));
  }
  const res = battle(s, p, attackers, cityDefenders(s, e), ctx, `${type === 'conspiracy' ? 'Conspiracy' : 'Peasant revolt'} in ${empName(e)}`);
  if (res.won) { placeSurvivors(s, p, e, res.survivors, ctx); regimeChange(s, p, e, ctx, { mode: 'war' }); }
  return res.won;
}
function doReligiousWar(s, p, card, e, r, ctx) {
  const atts = card.agents.filter(a => a.type !== 'bishop' && a.type !== 'pawn').map(a => ({
    label: `Agent ${REL_COLOR[a.color]} ${a.type}`, agent: true,
    tok: a.type === 'pirate' ? { t: 'pirate', c: a.color } : { t: a.type === 'knight' ? 'K' : 'R', c: a.color }, kill() {} }));
  atts.push(...borderPirates(s, e, c => c === r));
  atts.push(...cityDefenders(s, e, t => t.c === r));
  let rhodes = r === 'C' && abilityCount(s, p, 'knights_rhodes') > 0;
  if (rhodes && adjacentEmpires(s, e).some(x => cityDefenders(s, x, t => t.c === 'C' && t.t === 'R').length))
    rhodes = ctx.choose(p, 'Knights of Rhodes: count adjacent Catholic Rooks as Knights in this crusade?', [opt('yes', 'Yes'), opt('no', 'No')]).id === 'yes';
  for (const x of adjacentEmpires(s, e)) atts.push(...cityDefenders(s, x, t => t.c === r && (t.t === 'K' || (rhodes && t.t === 'R'))));
  const name = { C: 'Crusade', I: 'Jihad', R: 'Reformation' }[r];
  const res = battle(s, p, atts, warDefenders(s, e, r), ctx, `${name} in ${empName(e)}`);
  if (res.won) {
    placeSurvivors(s, p, e, res.survivors, ctx);
    s.mapState[e] = r; log(s, `${empName(e)} becomes a ${REL_NAME[r]} Theocracy.`);
    regimeChange(s, p, e, ctx, { mode: 'war' });
  }
  return res.won;
}
function doApostasy(s, p, [r1, r2]) {
  log(s, `APOSTASY between ${REL_NAME[r1]} and ${REL_NAME[r2]}!`);
  const k1 = REL_PRESTIGE[r1], k2 = REL_PRESTIGE[r2];
  for (let q = 0; q < s.numPlayers; q++) {
    if (abilityCount(s, q, 'apostasy_immune')) { log(s, `${pn(s, q)} is immune to apostasy.`); continue; }
    const units = tableauUnits(s, q);
    const pres = (u) => (u.kind === 'empire' ? empirePrestige(s, u.empire) : CARD[u.key].prestige);
    const has = (k) => units.some(u => pres(u).includes(k));
    if (!(has(k1) && has(k2))) continue;
    const victims = units.filter(u => pres(u).includes(k1) || pres(u).includes(k2));
    for (const u of victims) {
      if (u.kind === 'empire') { if (s.empires[u.empire].owner === q) { log(s, `${empName(u.empire)} returns to its Throne (apostasy).`); returnToThrone(s, u.empire, {}); } }
      else if (u.kind === 'queen') { const e = coupleOf(s, u.key); if (e && s.empires[e].owner === q) { log(s, `${empName(e)} and ${CARD[u.key].name} return to the Throne (apostasy).`); returnToThrone(s, e, {}); } }
      else if (s.players[q].west.includes(u.key) || s.players[q].east.includes(u.key)) discardCard(s, u.key, 'discarded by apostasy');
    }
  }
}
function empirePrestige(s, e) { return EMPIRE_SQUARES[e][s.empires[e].face].prestige; }

// ======================================================================
//  Main actions
// ======================================================================
function freeOpsAvailable(s, p, side) { return tableauUnits(s, p).some(u => u.kind === 'card' && CARD[u.key].freeOpsSide === side && !isSilenced(s, u.key)); }

export function mainActionOptions(s, p) {
  const T = s.turn; const P = s.players[p]; const out = [];
  const canSpend = T.actions < 2;
  // purchase
  if (canSpend && T.counts.purchase < 2) {
    for (const row of ['W', 'E']) for (let i = 1; i < 6; i++) {
      const sl = s.market[row][i]; if (!sl.card || sl.faceDown) continue;
      if (T.usury.includes(sl.card)) continue;
      if (P.florins < i) continue;
      if (!CARD[sl.card].comet && P.hand.length >= handLimit(s, p)) continue;
      out.push(opt(`buy:${row}:${i}`, `Purchase ${CARD[sl.card].name} (${i} florin${i > 1 ? 's' : ''})${sl.florins ? ` +${sl.florins} on card` : ''}`, { type: 'market', row, i }));
    }
  }
  if (canSpend && T.counts.play < 2) for (const k of P.hand) out.push(opt('play:' + k, `Play ${CARD[k].name}`, { type: 'card', id: k }));
  if (canSpend && T.counts.sell < 2) for (const o of sellOptions(s, p)) out.push(o);
  for (const side of ['W', 'E']) {
    if (T.did['ops' + side]) continue;
    const free = freeOpsAvailable(s, p, side);
    if (!canSpend && !free) continue;
    if (opsOptions(s, p, [side]).length) out.push(opt('ops:' + side, `Activate ${side === 'W' ? 'Western' : 'Eastern'} Ops${free ? ' (free)' : ''}`));
  }
  if (canSpend && !T.did.opsW && !T.did.opsE && abilityCount(s, p, 'dual_ops') && opsOptions(s, p, ['W', 'E']).length)
    out.push(opt('ops:WE', 'Activate Eastern & Western Ops in one action'));
  for (const side of ['W', 'E']) {
    if (T.did['fair' + side]) continue;
    const free = abilityCount(s, p, 'free_fair') && !T.did.freeFair;
    if (!canSpend && !free) continue;
    const sl = s.market[side][0];
    if (sl.card && sl.faceDown) out.push(opt('fair:' + side, `Convene ${side === 'W' ? 'Western' : 'Eastern'} trade fair${free ? ' (free)' : ''}`, { type: 'market', row: side, i: 0 }));
  }
  if (!T.did.victory) for (const v of ['holy', 'imperial', 'globalization', 'renaissance']) {
    if (!s.victory[v]) continue;
    const two = abilityAny(s, 'vic2_' + v);
    if (two ? T.actions > 0 : !canSpend) continue;
    if (victoryMet(s, p, v)) out.push(opt('win:' + v, `Declare ${v} victory${two ? ' (costs 2 actions)' : ''}`));
  }
  if (canSpend) {
    for (const u of tableauUnits(s, p)) {
      if (u.kind !== 'queen' && u.kind !== 'card') continue;
      const c = CARD[u.key]; if (isSilenced(s, u.key)) continue;
      if (c.abilityKeys.includes('popular_reprisals') && u.kind === 'queen') out.push(opt('reprisal:' + u.key, `${c.name}: discard to launch a peasant revolt in ${empName(coupleOf(s, u.key))}`));
      if (c.abilityKeys.includes('counter_reformation')) out.push(opt('counterref:' + u.key, `${c.name}: perform an apostasy between any 2 religions`));
    }
  }
  if (T.actions >= 1) out.push(opt('end', 'End turn'));
  return out;
}

export function playUnit(s, ctx) {
  if (s.gameOver) return;
  const p = s.current;
  const opts = mainActionOptions(s, p);
  if (opts.length === 0 || (opts.length === 1 && opts[0].id === 'end')) { endTurn(s); return; }
  const c = ctx.choose(p, `${pn(s, p)}: choose an action (${s.turn.actions}/2 used)`, opts, { main: true });
  if (c.id === 'end') { endTurn(s); return; }
  const [kind, a, b] = c.id.split(':');
  const T = s.turn;
  const spend = () => { T.actions++; };
  switch (kind) {
    case 'buy': spend(); T.counts.purchase++; doPurchase(s, p, a, +b, ctx); break;
    case 'play': spend(); T.counts.play++; doPlay(s, p, a, ctx); break;
    case 'sell': spend(); T.counts.sell++; doSell(s, p, c.id.slice(5), ctx); break;
    case 'ops': {
      const sides = a.split('');
      if (sides.length === 2 || !freeOpsAvailable(s, p, a)) spend();
      sides.forEach(x => { T.did['ops' + x] = true; });
      log(s, `${pn(s, p)} activates ${sides.map(x => (x === 'W' ? 'Western' : 'Eastern')).join(' & ')} Ops.`);
      doOps(s, p, sides, ctx); break;
    }
    case 'fair': {
      const free = abilityCount(s, p, 'free_fair') && !T.did.freeFair;
      if (free) T.did.freeFair = true; else spend();
      T.did['fair' + a] = true; doTradeFair(s, p, a, ctx); break;
    }
    case 'win': {
      if (abilityAny(s, 'vic2_' + a)) T.actions += 2; else spend();
      T.did.victory = true;
      s.gameOver = true; s.winner = { players: [p], reason: `${a} victory` };
      log(s, `*** ${pn(s, p)} declares ${a.toUpperCase()} VICTORY and wins! ***`); break;
    }
    case 'reprisal': {
      spend(); const e = coupleOf(s, a); discardCard(s, a, 'discarded (Popular Reprisals)');
      doCivilWar(s, p, null, null, e, 'peasant_revolt', ctx); break;
    }
    case 'counterref': {
      spend();
      const pairs = [['C', 'I'], ['C', 'R'], ['I', 'R']];
      const ch = ctx.choose(p, 'Apostasy between which religions?', pairs.map(x => opt(x.join(''), `${REL_NAME[x[0]]} & ${REL_NAME[x[1]]}`)));
      doApostasy(s, p, ch.id.split('')); break;
    }
  }
  enforceAll(s, ctx);
  if (!s.gameOver && T.actions >= 2 && mainActionOptions(s, p).every(o => o.id === 'end')) endTurn(s);
}

// ---------------- E1 purchase ----------------
function doPurchase(s, p, row, i, ctx) {
  const P = s.players[p]; const sl = s.market[row][i]; const key = sl.card; const other = row === 'W' ? 'E' : 'W';
  for (let j = 0; j < i; j++) {
    let tgt = s.market[row][j];
    if (!tgt.card) tgt = s.market[other][j].card ? s.market[other][j] : null;
    pay(s, p, 1);
    if (tgt) { tgt.florins++; s.turn.usury.push(tgt.card); }
  }
  const spec = sl.florins; gain(s, p, spec);
  sl.card = null; sl.florins = 0;
  log(s, `${pn(s, p)} purchases ${CARD[key].name} for ${i}${spec ? ` (and takes ${spec} florin${spec > 1 ? 's' : ''})` : ''}.`);
  if (CARD[key].comet) {
    const inact = ['holy', 'imperial', 'globalization', 'renaissance'].filter(v => !s.victory[v]);
    log(s, `A Comet! It is discarded.`);
    if (inact.length) {
      const c = ctx.choose(p, 'Comet: activate a Victory Square', inact.map(v => opt(v, `Activate ${v} victory`, { type: 'victory', id: v })));
      s.victory[c.id] = true; log(s, `${c.id[0].toUpperCase() + c.id.slice(1)} victory is now active.`);
    }
    return;
  }
  P.hand.push(key);
}

// ---------------- E2 play ----------------
function doPlay(s, p, key, ctx) {
  const P = s.players[p]; const card = CARD[key];
  P.hand.splice(P.hand.indexOf(key), 1);
  if (card.suitors) return playQueen(s, p, key, ctx);
  (card.side === 'W' ? P.west : P.east).push(key);
  log(s, `${pn(s, p)} plays ${card.name}.`);
  playEffects(s, p, card, key, ctx, { fromSale: false });
}
// handles the one-shot / agent decision for a card; also used by Pragmatic Treachery
function playEffects(s, p, card, key, ctx, { fromSale }) {
  const os = card.oneShot;
  let trigger = false;
  if (os && oneShotFeasible(s, p, card, key) && (!fromSale || ['conspiracy', 'peasant_revolt', 'crusade', 'apostasy'].includes(os.type))) {
    const label = os.type === 'trade_shift' ? `Trigger trade shift (${CITY[os.emporium].name || os.emporium})` : `Trigger ${os.type.replace('_', ' ')}${os.religions ? ` (${os.religions.map(r => REL_NAME[r]).join(' vs ')})` : ''}`;
    const opts = [opt('yes', label), opt('no', fromSale ? 'Do not perform the One-shot' : 'No One-shot (optionally place Agents)')];
    trigger = ctx.choose(p, `${card.name}: One-shot?`, opts).id === 'yes';
  }
  if (fromSale && !trigger) return;
  const needsEmpire = trigger ? !['apostasy'].includes(os.type) || card.agents.length : card.agents.length > 0;
  let empires = locSet(card.loc);
  if (!needsEmpire) { /* nothing */ }
  else if (trigger && ['crusade', 'jihad', 'reformation'].includes(os.type)) {
    const r = warReligion(os.type);
    const ok = empires.filter(e => warDefenders(s, e, r).length);
    empires = [chooseEmpire(s, p, ctx, ok, `${card.name}: target Empire for the ${os.type}`)];
  } else if (empires.length > 1) {
    empires = [chooseEmpire(s, p, ctx, empires, `${card.name}: choose the Location ("${card.loc === 'East' ? 'The East' : 'The West'}")`)];
  }
  if (!trigger) { placeAgents(s, p, card, key, empires, ctx, false); return; }
  log(s, `${pn(s, p)} triggers the ${os.type.replace('_', ' ')} One-shot of ${card.name}.`);
  const e = empires[0];
  switch (os.type) {
    case 'trade_shift': doTradeShift(s, p, os.emporium); placeAgents(s, p, card, key, empires, ctx, true); break;
    case 'apostasy': placeAgents(s, p, card, key, empires, ctx, true); doApostasy(s, p, os.religions); break;
    case 'conspiracy': case 'peasant_revolt':
      doCivilWar(s, p, card, key, e, os.type, ctx); placeAgents(s, p, card, key, locSet(card.loc), ctx, true, { onlyBishops: true }); break;
    case 'crusade': case 'jihad': case 'reformation':
      doReligiousWar(s, p, card, e, warReligion(os.type), ctx);
      for (const a of card.agents) if (a.type === 'pawn') placePawnAgent(s, p, [e], ctx, true);
      placeAgents(s, p, card, key, locSet(card.loc), ctx, true, { onlyBishops: true }); break;
  }
}
function queenSuitorOptions(s, p, key) {
  const henry = abilityCount(s, p, 'henry8') > 0;
  return CARD[key].suitors.filter(e => {
    const E = s.empires[e]; if (E.face !== 'king') return false;
    if (E.owner === null || E.owner === p) return henry || !E.queen;
    return henry;
  });
}
function playQueen(s, p, key, ctx) {
  const card = CARD[key];
  const suit = queenSuitorOptions(s, p, key);
  const opts = suit.map(e => opt('m:' + e, `Coronation: marry the King of ${empName(e)}${s.empires[e].queen ? ' (already married!)' : ''}`, { type: 'empire', id: e }));
  opts.push(opt('maid', 'Play as an Old Maid (under your Player Board)'));
  const c = ctx.choose(p, `${card.name}: coronation?`, opts);
  if (c.id === 'maid') { s.players[p].oldMaids.push(key); log(s, `${pn(s, p)} plays ${card.name} as an Old Maid.`); return; }
  const e = c.id.slice(2);
  log(s, `${pn(s, p)} plays ${card.name}: coronation with the King of ${empName(e)}.`);
  regimeChange(s, p, e, ctx, { mode: 'coronation', queen: key });
}

// ---------------- E3 sell ----------------
function sellOptions(s, p) {
  const P = s.players[p]; const out = [];
  for (const k of P.hand) out.push(opt('sell:h:' + k, `Sell ${CARD[k].name} from hand (2)`, { type: 'card', id: k }));
  for (const k of P.oldMaids) out.push(opt('sell:m:' + k, `Sell Old Maid ${CARD[k].name} (2)`, { type: 'card', id: k }));
  for (const u of tableauUnits(s, p)) {
    if (u.kind === 'queen') continue;
    out.push(opt('sell:t:' + u.key, `Sell ${cardName(s, u.key)} from tableau (${salePrice(s, p, u.key)})`, { type: 'card', id: u.key }));
  }
  return out;
}
function salePrice(s, p, key) {
  const one = (k) => (!isEmp(k) && CARD[k].abilityKeys.includes('ransom') && !isSilenced(s, k) ? 4 : 2);
  if (isEmp(key)) { const q = s.empires[empOf(key)].queen; return 2 + (q ? one(q) : 0); }
  return one(key);
}
function doSell(s, p, spec, ctx) {
  const [where, key] = [spec.slice(0, 1), spec.slice(2)];
  if (where === 'h') { s.players[p].hand.splice(s.players[p].hand.indexOf(key), 1); gain(s, p, 2); log(s, `${pn(s, p)} sells ${CARD[key].name} from hand for 2.`); afterSale(s, p, key, false, ctx); return; }
  if (where === 'm') { s.players[p].oldMaids.splice(s.players[p].oldMaids.indexOf(key), 1); gain(s, p, 2); log(s, `${pn(s, p)} sells Old Maid ${CARD[key].name} for 2.`); return; }
  const price = salePrice(s, p, key);
  // abilities of the sold card (only from tableau) evaluated before removal
  const card = isEmp(key) ? null : CARD[key];
  const silenced = isSilenced(s, key);
  gain(s, p, price);
  if (isEmp(key)) {
    const e = empOf(key); log(s, `${pn(s, p)} sells ${empName(e)} for ${price}; it returns to its Throne.`);
    returnToThrone(s, e, {});
  } else {
    log(s, `${pn(s, p)} sells ${card.name} for ${price}.`);
    discardCard(s, key, 'sold');
    if (!silenced && card.abilityKeys.includes('enclosure')) enclosure(s, p, ctx);
    if (!silenced && card.abilityKeys.includes('cryptography')) cryptography(s, p, ctx);
  }
  if (card) afterSale(s, p, key, true, ctx);
}
function afterSale(s, p, key, fromTableau, ctx) {
  if (abilityCount(s, p, 'pragmatic_treachery') && CARD[key].oneShot) {
    playEffects(s, p, CARD[key], key, ctx, { fromSale: true });
  }
}
function enclosure(s, p, ctx) {
  for (const e of WEST_EMPIRES) if (s.empires[e].repressed.length) emancipate(s, p, e, ctx);
}
function cryptography(s, p, ctx) {
  const opts = [];
  for (let q = 0; q < s.numPlayers; q++) {
    if (q === p) continue;
    for (const u of tableauUnits(s, q)) {
      if (u.side !== 'W' || isSilenced(s, u.key)) continue;
      unitOps(s, u).forEach((o, i) => {
        if (!['behead', 'tax', 'repress', 'vote'].includes(o.type)) return;
        if (opTargets(s, p, u, o).length) opts.push(opt(`x:${u.key}:${i}`, `Use ${cardName(s, u.key)}'s ${o.type} Op`, { type: 'card', id: u.key }));
      });
    }
  }
  if (!opts.length) return;
  opts.push(opt('skip', 'Do not use Cryptography'));
  const c = ctx.choose(p, 'Medici Ciphers Broken: perform an opponent\'s political Op?', opts);
  if (c.id === 'skip') return;
  const j = c.id.lastIndexOf(':'); const k = c.id.slice(2, j), i = c.id.slice(j + 1);
  const q = ownerOfUnit(s, k);
  const u = tableauUnits(s, q).find(x => x.key === k);
  performOp(s, p, u, unitOps(s, u)[+i], ctx);
}

// ======================================================================
//  E4 Ops
// ======================================================================
function opsOptions(s, p, sides) {
  const out = [];
  for (const u of tableauUnits(s, p)) {
    if (!sides.includes(u.side) || s.turn.used.includes(u.key)) continue;
    const sil = isSilenced(s, u.key);
    unitOps(s, u).forEach((o, i) => {
      if (sil && o.type !== 'inquisitor') return;
      if (opTargets(s, p, u, o).length) out.push(opt(`op:${u.key}:${i}`, `${cardName(s, u.key)}: ${opLabel(o)}`, { type: 'card', id: u.key }));
    });
  }
  return out;
}
function opLabel(o) {
  let x = o.type[0].toUpperCase() + o.type.slice(1);
  if (o.religion) x += ` (${REL_COLOR[o.religion]})`;
  if (o.market) x += ` (${o.market === 'W' ? 'West' : 'East'})`;
  if (o.targets) x += ` (${o.targets.join('/')})`;
  return x;
}
function doOps(s, p, sides, ctx) {
  let n = 0;
  for (;;) {
    const opts = opsOptions(s, p, sides);
    if (n > 0) opts.push(opt('done', 'Finish Ops'));
    if (!opts.length || (opts.length === 1 && opts[0].id === 'done')) return;
    const c = ctx.choose(p, `Ops: choose a card and Op (${n} done)`, opts);
    if (c.id === 'done') return;
    const j = c.id.lastIndexOf(':'); const key = c.id.slice(3, j), i = c.id.slice(j + 1);
    const u = tableauUnits(s, p).find(x => x.key === key);
    s.turn.used.push(key); n++;
    performOp(s, p, u, unitOps(s, u)[+i], ctx);
    enforceAll(s, ctx);
    if (s.gameOver) return;
  }
}
function unitLoc(s, u) { return u.kind === 'empire' ? [u.empire] : cardLoc(s, u.key); }

// Returns a list of target options for an op (empty = invalid).
function opTargets(s, p, u, o) {
  const loc = unitLoc(s, u);
  switch (o.type) {
    case 'inquisitor': {
      const out = [];
      for (const h of allHolders(s)) {
        if (getBishop(s, h) !== o.religion) continue;
        const isThrone = isEmp(h) && s.empires[empOf(h)].owner === null;
        const dests = new Set(tableauNeighbors(s, h));
        for (const d of allHolders(s)) if (d !== h && intersects(cardLoc(s, d), cardLoc(s, h))) {
          if (isThrone && isEmp(d) && s.empires[empOf(d)].owner === null) continue;
          dests.add(d);
        }
        for (const d of dests) out.push(opt(`${h}>${d}`, `Move ${REL_COLOR[o.religion]} Bishop: ${holderLabel(s, h)} → ${holderLabel(s, d)}${getBishop(s, d) ? ' (Diet of Worms!)' : ''}`, { type: 'holder', id: d }));
      }
      return out;
    }
    case 'commerce': {
      const out = [];
      s.market[o.market].forEach((sl, i) => { if (sl.card && sl.florins > 0) out.push(opt('m' + i, `Take 1 florin from ${o.market} market slot ${i}`, { type: 'market', row: o.market, i })); });
      return out;
    }
    case 'behead': {
      const out = [];
      const restricted = !isEmp(u.key) && CARD[u.key].abilityKeys.includes('behead_restrict');
      for (let q = 0; q < s.numPlayers; q++) for (const t of tableauUnits(s, q)) {
        if (t.key === u.key) continue;
        if (restricted) {
          const c = CARD[u.key]; const okCols = c.side === 'E' ? ['I', 'R'] : ['R', 'C'];
          const b = getBishop(s, holderOf(s, t.key));
          if (t.side !== c.side || !okCols.includes(b)) continue;
        } else if (!intersects(unitLoc(s, t), loc)) continue;
        out.push(opt('t:' + t.key, `Behead ${cardName(s, t.key)} [${s.players[q].name}]`, { type: 'card', id: t.key }));
      }
      return out;
    }
    case 'tax': {
      const out = [];
      for (const e of loc) {
        if (saturated(s, e)) continue;
        for (const b of bordersOf(e)) if (s.borders[b.id].pawn !== null) out.push(opt(`${e}|${b.id}`, `Tax ${s.players[s.borders[b.id].pawn].bank} Concession at ${b.id} (Levy in ${empName(e)})`, { type: 'border', id: b.id }));
      }
      return out;
    }
    case 'repress': {
      const out = [];
      for (const e of loc) {
        for (const r of rulingClass(s, e)) {
          if ((r.tok.t === 'K' && o.targets.includes('knight')) || (r.tok.t === 'R' && o.targets.includes('rook')))
            out.push(opt(`c|${r.city}|${r.i}|${e}`, `Repress ${tokenLabel(r.tok)} in ${CITY[r.city].name || r.city}`, { type: 'city', id: r.city }));
        }
        if (o.targets.includes('pawn')) for (const b of bordersOf(e)) if (s.borders[b.id].pawn !== null)
          out.push(opt(`b|${b.id}|${e}`, `Repress ${s.players[s.borders[b.id].pawn].bank} Concession at ${b.id} into ${empName(e)}`, { type: 'border', id: b.id }));
      }
      return out;
    }
    case 'vote': {
      const out = [];
      for (const e of EMPIRES) {
        const E = s.empires[e]; if (E.owner === null || E.suzerain) continue;
        if (empireTableauSide(s, e) !== o.market) continue;
        if (!voteMajority(s, p, e)) continue;
        if (s.players[p].florins < voteCost(s, p, e)) continue;
        out.push(opt('e:' + e, `Vote: regime change in ${empName(e)} [${s.players[E.owner].name}] (cost ${voteCost(s, p, e)})`, { type: 'empire', id: e }));
      }
      return out;
    }
    case 'corsair': {
      const out = [];
      for (const e of loc) for (const src of seaBordersOf(e)) {
        if (s.borders[src].pirate !== o.religion) continue;
        const dests = new Set(seaBordersOf(e));
        for (const x of adjacentEmpires(s, e)) { const bb = borderBetween(e, x); if (bb && bb.sea) seaBordersOf(x).forEach(d => dests.add(d)); }
        for (const d of dests) if (d !== src && s.borders[d].pirate !== o.religion)
          out.push(opt(`${src}>${d}`, `Move ${REL_COLOR[o.religion]} Pirate ${src} → ${d}${describeBorder(s, d)}`, { type: 'border', id: d }));
      }
      return uniq(out);
    }
    case 'siege': {
      const out = [];
      for (const e of loc) {
        for (const r of rulingClass(s, e)) out.push(opt(`c|${r.city}|${r.i}`, `Kill ${tokenLabel(r.tok)} in ${CITY[r.city].name || r.city}`, { type: 'city', id: r.city }));
        for (const b of bordersOf(e)) if (s.borders[b.id].pirate) out.push(opt(`b|${b.id}`, `Kill ${REL_COLOR[s.borders[b.id].pirate]} Pirate at ${b.id}`, { type: 'border', id: b.id }));
      }
      return uniq(out);
    }
    case 'campaign': {
      if (u.kind !== 'empire' || s.empires[u.empire].face !== 'king') return [];
      return adjacentEmpires(s, u.empire).filter(y => s.empires[y].owner !== p).flatMap(y => {
        const n = campaignAttackers(s, p, u.empire, y).length;
        if (n < 1 || s.players[p].florins < n) return [];
        return [opt('e:' + y, `Campaign from ${empName(u.empire)} into ${empName(y)} (${n} Knight(s), cost ${n}; ${rulingClass(s, y).length} defender(s))`, { type: 'empire', id: y })];
      });
    }
  }
  return [];
}
function voteMajority(s, p, e) {
  const cnt = (q) => bordersOf(e).filter(b => s.borders[b.id].pawn === q).length * (1 + abilityCount(s, q, 'double_concessions'));
  const mine = cnt(p);
  for (let q = 0; q < s.numPlayers; q++) if (q !== p && cnt(q) >= mine) return false;
  return mine > 0;
}
function voteCost(s, p, e) { return Math.max(0, s.empires[e].repressed.length - (abilityCount(s, p, 'patron_vote_discount') ? prestigeCount(s, p, 'patron') * abilityCount(s, p, 'patron_vote_discount') : 0)); }
// Slave Soldiers (Circassian Mamluks): each repressed Token on the Mamluk square counts as a Knight
// in your East campaigns (not when Mamluk is the defender: F9e, repressed Tokens of the defender don't fight).
function campaignAttackers(s, p, a, target = null) {
  const atts = cityDefenders(s, a, t => t.t === 'K');
  if (abilityCount(s, p, 'slave_soldiers') && empireTableauSide(s, a) === 'E' && target !== 'Mamluk')
    atts.push(...repressedAttackers(s, 'Mamluk', ['K', 'R', 'P']).map(x => ({ ...x, repressed: false, label: `Slave soldier (${x.label} in Mamluk)` })));
  return atts;
}

function performOp(s, p, u, o, ctx) {
  const targets = opTargets(s, p, u, o);
  if (!targets.length) return;
  const c = ctx.choose(p, `${cardName(s, u.key)}: ${opLabel(o)} — choose target`, targets);
  const id = c.id;
  switch (o.type) {
    case 'inquisitor': {
      const [h, d] = id.split('>');
      setBishop(s, h, null); log(s, `Inquisitor: ${REL_COLOR[o.religion]} Bishop moves from ${cardName(s, h)} to ${cardName(s, d)}.`);
      landBishop(s, p, d, o.religion, ctx); break;
    }
    case 'commerce': { const sl = s.market[o.market][+id.slice(1)]; sl.florins--; gain(s, p, 1); log(s, `${pn(s, p)} takes 1 florin from the market (commerce).`); break; }
    case 'behead': {
      const t = id.slice(2);
      if (isEmp(t)) {
        const e = empOf(t); log(s, `${pn(s, p)} beheads ${empName(e)}; it returns to its Throne.`);
        returnToThrone(s, e, { killQueen: true });
        if (u.kind === 'empire') returnToThrone(s, u.empire, {}); else discardCard(s, u.key, 'is killed (assassin)');
      } else { log(s, `${pn(s, p)} beheads ${CARD[t].name}.`); discardCard(s, t, 'beheaded'); }
      break;
    }
    case 'tax': {
      const [e, b] = id.split('|'); const q = s.borders[b].pawn;
      log(s, `${pn(s, p)} taxes the ${s.players[q].bank} Concession at ${b}.`);
      const ch = [opt('repress', `Repress your Concession into ${empName(e)}`)];
      if (s.players[q].florins >= 1) ch.unshift(opt('pay', 'Pay 1 florin to China'));
      const r = ctx.choose(q, `You are taxed at ${b}: pay or repress?`, ch);
      if (r.id === 'pay') { pay(s, q, 1); log(s, `${pn(s, q)} pays 1 florin.`); }
      else { s.borders[b].pawn = null; s.empires[e].repressed.push({ t: 'P', c: q }); log(s, `${pn(s, q)} represses the Concession.`); }
      placeLevy(s, q, e, ctx, `Tax Levy: choose a city in ${empName(e)}`);
      break;
    }
    case 'repress': {
      const parts = id.split('|');
      if (parts[0] === 'c') { const tok = s.cities[parts[1]].splice(+parts[2], 1)[0]; s.empires[parts[3]].repressed.push(tok); log(s, `${tokenLabel(tok)} in ${CITY[parts[1]].name || parts[1]} is repressed.`); }
      else { const q = s.borders[parts[1]].pawn; s.borders[parts[1]].pawn = null; s.empires[parts[2]].repressed.push({ t: 'P', c: q }); log(s, `${s.players[q].bank} Concession at ${parts[1]} is repressed into ${empName(parts[2])}.`); }
      gain(s, p, 1); break;
    }
    case 'vote': {
      const e = id.slice(2); const cost = voteCost(s, p, e); pay(s, p, cost);
      log(s, `${pn(s, p)} wins a vote in ${empName(e)} (paid ${cost}).`);
      const theo = s.mapState[e] !== 'M';
      regimeChange(s, p, e, ctx, { mode: 'vote' });
      if (theo) {
        const r = ctx.choose(p, `Golden Liberty: make ${empName(e)} Medieval?`, [opt('yes', 'Yes, make it Medieval'), opt('no', `No, keep it ${REL_NAME[s.mapState[e]]}`)]);
        if (r.id === 'yes') { s.mapState[e] = 'M'; log(s, `Golden Liberty: ${empName(e)} becomes Medieval.`); enforceAll(s, ctx); }
      }
      break;
    }
    case 'corsair': {
      const [src, d] = id.split('>');
      s.borders[src].pirate = null; pirateKills(s, d); s.borders[d].pirate = o.religion;
      log(s, `Corsair: ${REL_COLOR[o.religion]} Pirate moves ${src} → ${d}.`); break;
    }
    case 'siege': {
      const parts = id.split('|');
      if (parts[0] === 'c') { const tok = s.cities[parts[1]].splice(+parts[2], 1)[0]; killTok(s, tok); log(s, `Siege kills ${tokenLabel(tok)} in ${CITY[parts[1]].name || parts[1]}.`); }
      else { const c = s.borders[parts[1]].pirate; s.borders[parts[1]].pirate = null; killTok(s, { t: 'pirate', c }); log(s, `Siege kills the Pirate at ${parts[1]}.`); }
      break;
    }
    case 'campaign': {
      const y = id.slice(2); const atts = campaignAttackers(s, p, u.empire, y);
      pay(s, p, atts.length);
      const res = battle(s, p, atts, cityDefenders(s, y), ctx, `Campaign of ${empName(u.empire)} into ${empName(y)}`);
      if (res.won) {
        const suz = topSuzerain(s, u.empire);
        regimeChange(s, p, y, ctx, { mode: 'campaign', suzerain: suz });
      }
      break;
    }
  }
}

// ---------------- levy ----------------
function placeLevy(s, chooser, e, ctx, prompt) {
  const cs = levyCities(s, e);
  if (!cs.length) return false;
  const c = cs.length === 1 ? cs[0] : ctx.choose(chooser, prompt, cs.map(id => opt(id, `${CITY[id].name || id} (${iconLabel(levyIcon(s, id))})`, { type: 'city', id }))).id;
  const ic = levyIcon(s, c); const tok = { t: ic[0], c: ic[1] };
  if (!takeToken(s, tok.t, tok.c)) { log(s, `No ${tokenLabel(tok)} available for the Levy.`); return false; }
  s.cities[c].push(tok); log(s, `Levy: ${tokenLabel(tok)} raised in ${CITY[c].name || c}.`);
  return true;
}
const iconLabel = (ic) => tokenLabel({ t: ic[0], c: ic[1] });

// ======================================================================
//  E5 Trade fair
// ======================================================================
// Pure computation of what a trade fair convened now by player p in `row` would do.
// Used both by the engine and by the UI route highlighting.
export function tradeFairPreview(s, p, row) {
  const sl = s.market[row][0];
  const color = row === 'W' ? 'white' : 'black';
  const emp = s.activeEmporium[color];
  const route = ROUTES[emp];
  let profits = sl.florins + (s.numPlayers <= 2 ? 1 : 2);
  const res = { row, emporium: emp, route, profits, initiator: p, subsidy: 1, steps: [], levies: [], endsAt: null, leftover: 0 };
  profits--;
  if (profits > 0) {
    res.levies.push(route[0]);
    for (let i = 1; i < route.length; i++) {
      const b = borderBetween(route[i - 1], route[i]); const B = s.borders[b.id];
      if (profits === 0) { res.steps.push({ border: b.id, kind: 'unreached' }); continue; }
      let took = false;
      if (B.pawn !== null) {
        const q = B.pawn;
        const mult = 1 + abilityCount(s, q, 'double_concessions') + (emp === 'SpiceIslands' ? abilityCount(s, q, 'cape') : 0);
        const n = Math.min(mult, profits); profits -= n; took = true;
        res.steps.push({ border: b.id, kind: 'pawn', player: q, amount: n });
      } else if (B.pirate) { profits--; took = true; res.steps.push({ border: b.id, kind: 'pirate', color: B.pirate, amount: 1 }); }
      else res.steps.push({ border: b.id, kind: 'empty' });
      if (took && profits === 0) { res.endsAt = b.id; continue; }
      res.levies.push(route[i]);
    }
  } else res.steps = route.slice(1).map((e, i) => ({ border: borderBetween(route[i], e).id, kind: 'unreached' }));
  res.leftover = profits;
  res.levyRoom = Object.fromEntries(res.levies.map(e => [e, !saturated(s, e)]));
  return res;
}
function doTradeFair(s, p, row, ctx) {
  const sl = s.market[row][0];
  const pv = tradeFairPreview(s, p, row);
  log(s, `${pn(s, p)} convenes the ${row === 'W' ? 'Western' : 'Eastern'} trade fair (${pv.profits} profit${pv.profits > 1 ? 's' : ''}); ${CARD[sl.card].name} is discarded.`);
  sl.card = null; sl.florins = 0;
  gain(s, p, 1);
  if (pv.levies.length === 0) log(s, 'The voyage ends before it begins.');
  for (const st of pv.steps) {
    if (st.kind === 'pawn') { gain(s, st.player, st.amount); log(s, `${pn(s, st.player)}'s Concession at ${st.border} earns ${st.amount}.`); }
    else if (st.kind === 'pirate') log(s, `A Pirate at ${st.border} takes 1 florin (to China).`);
  }
  for (const e of pv.levies) placeLevy(s, p, e, ctx, `Trade fair Levy in ${empName(e)}: choose a city`);
  sl.florins = pv.leftover;
}

// ======================================================================
//  Victory
// ======================================================================
export function supremeReligion(s, p) { return religionCounts(s, p).supreme; }
// Bishops in play and Tokens in matching Theocracies per religion (from player p's point of view,
// including p's supremacy-affecting abilities when p is given).
export function religionCounts(s, p) {
  const bishops = { C: 0, I: 0, R: 0 }, units = { C: 0, I: 0, R: 0 };
  for (const h of allHolders(s)) { const b = getBishop(s, h); if (b) bishops[b]++; }
  for (const e of EMPIRES) {
    const r = s.mapState[e]; if (r === 'M') continue;
    for (const id of empireCities(e)) for (const t of s.cities[id]) if (t.c === r) units[r]++;
    for (const b of bordersOf(e)) {
      const pc = s.borders[b.id].pirate;
      if (pc === r) units[r]++;
      if (p !== undefined && pc === 'I' && r === 'R' && abilityCount(s, p, 'green_pirates_red')) units.R++;
    }
  }
  if (p !== undefined) {
    if (abilityCount(s, p, 'patron_green_bishops')) bishops.I += prestigeCount(s, p, 'patron');
    if (abilityCount(s, p, 'green_pirates_red')) bishops.R += BORDERS.filter(b => s.borders[b.id].pirate === 'I').length;
  }
  let supreme = null;
  for (const r of ['C', 'I', 'R']) {
    const ob = Object.keys(bishops).filter(x => x !== r).reduce((a, x) => a + bishops[x], 0);
    const ou = Object.keys(units).filter(x => x !== r).reduce((a, x) => a + units[x], 0);
    if (bishops[r] > ob && units[r] > ou) supreme = r;
  }
  return { bishops, units, supreme };
}
export function kingCount(s, p) { return EMPIRES.filter(e => s.empires[e].owner === p && s.empires[e].face === 'king').length; }
export function republicCount(s, p) {
  return EMPIRES.filter(e => s.empires[e].owner === p && s.empires[e].face === 'republic').length + abilityCount(s, p, 'counts_republic');
}
export function globConcessions(s, p) { return concessionsOf(s, p) + (abilityCount(s, p, 'patron_concessions') ? prestigeCount(s, p, 'patron') : 0); }
export function lawCount(s, p) { return prestigeCount(s, p, 'law') + (abilityCount(s, p, 'patron_law') ? prestigeCount(s, p, 'patron') : 0); }
export function victoryMet(s, p, v) {
  const opp = [...Array(s.numPlayers).keys()].filter(q => q !== p);
  switch (v) {
    case 'holy': {
      const r = supremeReligion(s, p); if (!r) return false;
      const k = REL_PRESTIGE[r]; const mine = prestigeCount(s, p, k);
      return mine > 0 && opp.every(q => mine > prestigeCount(s, q, k));
    }
    case 'imperial': { const m = kingCount(s, p); const d = s.numPlayers === 2 ? 3 : 2; return opp.every(q => m >= kingCount(s, q) + d); }
    case 'globalization': {
      const c = globConcessions(s, p), d = prestigeCount(s, p, 'discovery');
      return opp.every(q => c >= globConcessions(s, q) + 2 && d > prestigeCount(s, q, 'discovery'));
    }
    case 'renaissance': {
      const r = republicCount(s, p), l = lawCount(s, p);
      return opp.every(q => r > republicCount(s, q) && l >= lawCount(s, q) + 2);
    }
  }
  return false;
}

// ======================================================================
//  D2 Refresh & turn end
// ======================================================================
function endTurn(s) {
  refreshMarket(s);
  if (s.gameOver) return;
  s.current = (s.current + 1) % s.numPlayers;
  if (s.current === 0) s.turnNo++;
  s.turn = freshTurn();
  log(s, `--- ${pn(s, s.current)}'s turn ---`);
}
function refreshMarket(s) {
  for (const row of ['W', 'E']) {
    const M = s.market[row];
    const gap = M.filter(x => !x.card).reduce((a, x) => a + x.florins, 0);
    const cards = M.filter(x => x.card);
    while (cards.length < 6) {
      const other = row === 'W' ? 'E' : 'W';
      const deck = s.decks[row].length ? s.decks[row] : s.decks[other];
      if (!deck.length) return patronVictory(s);
      cards.push({ card: deck.pop(), florins: 0, faceDown: false });
    }
    cards[0].florins += gap;
    s.seen ||= {};
    cards.forEach((c, i) => { c.faceDown = i === 0; if (!c.faceDown) s.seen[c.card] = true; });
    s.market[row] = cards;
  }
}
function patronVictory(s) {
  s.gameOver = true;
  const sc = s.players.map((_, p) => [prestigeCount(s, p, 'patron'), s.players[p].florins]);
  const best = sc.reduce((a, x) => (x[0] > a[0] || (x[0] === a[0] && x[1] > a[1]) ? x : a));
  const w = sc.map((x, i) => (x[0] === best[0] && x[1] === best[1] ? i : -1)).filter(i => i >= 0);
  s.winner = { players: w, reason: 'patron victory (decks exhausted)' };
  log(s, `*** The draw decks are exhausted. Patron victory: ${w.map(i => pn(s, i)).join(' & ')} ***`);
}

// ======================================================================
//  One-shot forecast (read-only; used by the UI hover)
// ======================================================================
// For player p playing `key` now, per target Empire:
//   'green'  = the One-shot would cause a regime change (battle won / coronation)
//   'yellow' = it can be triggered but would not cause a regime change
//   'red'    = it cannot be triggered (e.g. bloody rule, no eligible suitor)
// Trade shifts and apostasy never cause a regime change (kind 'effect'): green = has an effect, red = none.
export function oneShotForecast(s, p, key) {
  const card = CARD[key]; const os = card.oneShot;
  if (!os) return null;
  const byEmpire = {};
  let kind = 'regime';
  const rank = { red: 0, yellow: 1, green: 2 };
  const empires = locSet(card.loc);
  switch (os.type) {
    case 'coronation': {
      const ok = queenSuitorOptions(s, p, key);
      for (const e of card.suitors) byEmpire[e] = ok.includes(e)
        ? { status: 'green', text: `marry the King of ${empName(e)} (regime change)` }
        : { status: 'red', text: `${empName(e)}: not an eligible King (married, a Republic, or in an opponent's Tableau)` };
      break;
    }
    case 'trade_shift': { // never a regime change: green = has an effect, red = can't trigger
      const ok = oneShotFeasible(s, p, card, key);
      const col = EMPORIA.black.includes(os.emporium) ? 'black' : 'white';
      const nm = CITY[os.emporium].name || os.emporium;
      const why = s.activeEmporium[col] === os.emporium ? `${nm} is already open, so nothing would change`
        : os.requires ? `requires ${os.requires[0].toUpperCase() + os.requires.slice(1)} Prestige already in your Tableau (not counting this card)`
          : 'cannot be triggered now';
      for (const e of empires) byEmpire[e] = ok ? { status: 'green', text: `${nm} opens; ${CITY[s.activeEmporium[col]].name || s.activeEmporium[col]} is busted` } : { status: 'red', text: why };
      kind = 'effect'; break;
    }
    case 'apostasy': { // green if at least one player would have to discard
      const [k1, k2] = os.religions.map(r => REL_PRESTIGE[r]);
      const hits = [];
      for (let q = 0; q < s.numPlayers; q++) {
        if (abilityCount(s, q, 'apostasy_immune')) continue;
        const pres = tableauUnits(s, q).map(u => (u.kind === 'empire' ? empirePrestige(s, u.empire) : CARD[u.key].prestige));
        if (q === p) pres.push(card.prestige); // the played card is in your Tableau when the apostasy resolves
        if (pres.some(x => x.includes(k1)) && pres.some(x => x.includes(k2))) hits.push(`${s.players[q].name} discards ${pres.filter(x => x.includes(k1) || x.includes(k2)).length}`);
      }
      const st = hits.length ? { status: 'green', text: hits.join(', ') } : { status: 'red', text: `nobody has both ${REL_NAME[os.religions[0]]} and ${REL_NAME[os.religions[1]]} Prestige: no effect` };
      for (const e of empires) byEmpire[e] = st;
      kind = 'effect'; break;
    }
    case 'conspiracy': case 'peasant_revolt':
      for (const e of empires) {
        let A = agentAttackers(s, card).length + borderPirates(s, e).length;
        if (os.type === 'conspiracy') A += repressedAttackers(s, e, ['K', 'R']).length;
        else A += bordersOf(e).filter(b => s.borders[b.id].pawn === p).length + repressedAttackers(s, e, ['P']).length;
        const D = cityDefenders(s, e).length;
        byEmpire[e] = { status: A > D ? 'green' : 'yellow', A, D, text: `${A} attacker(s) vs ${D} defender(s) → ${A > D ? 'regime change' : 'the revolt fails'}` };
      }
      break;
    case 'crusade': case 'jihad': case 'reformation': {
      const r = warReligion(os.type);
      for (const e of empires) {
        const D = warDefenders(s, e, r).length;
        if (!D) { byEmpire[e] = { status: 'red', text: `no heretics (non-${REL_NAME[r]} Ruling Class or Pirates) to fight (bloody rule)` }; continue; }
        let A = card.agents.filter(a => a.type !== 'bishop' && a.type !== 'pawn').length + borderPirates(s, e, c => c === r).length + cityDefenders(s, e, t => t.c === r).length;
        const rhodes = r === 'C' && abilityCount(s, p, 'knights_rhodes') > 0;
        for (const x of adjacentEmpires(s, e)) A += cityDefenders(s, x, t => t.c === r && (t.t === 'K' || (rhodes && t.t === 'R'))).length;
        byEmpire[e] = { status: A > D ? 'green' : 'yellow', A, D, text: `${A} believer(s) vs ${D} heretic(s) → ${A > D ? `regime change, becomes ${REL_NAME[r]} Theocracy` : 'the war fails'}` };
      }
      break;
    }
    default: return null;
  }
  const overall = Object.values(byEmpire).reduce((m, x) => (rank[x.status] > rank[m] ? x.status : m), 'red');
  return { overall, byEmpire, kind };
}

// Can op #i of unit `key` do anything if activated right now? (read-only; used by the UI hover)
// The op is evaluated for the unit's owner if it is in a Tableau, otherwise for `viewer`.
export function opForecast(s, viewer, key, i) {
  const owner = ownerOfUnit(s, key);
  const p = owner === null ? viewer : owner;
  let u = tableauUnits(s, p).find(x => x.key === key);
  const inTableau = !!u && owner !== null;
  if (!u) u = isEmp(key) ? { key, kind: 'empire', empire: empOf(key), side: empSide(empOf(key)) } : { key, kind: 'card', side: CARD[key].side };
  const o = unitOps(s, u)[i];
  if (!o) return null;
  if (inTableau && isSilenced(s, key) && o.type !== 'inquisitor') return { ok: false, n: 0, reason: 'silenced by a Bishop' };
  if (inTableau && p === s.current && s.turn.used.includes(key)) return { ok: false, n: 0, reason: 'already used this turn' };
  const n = opTargets(s, p, u, o).length;
  return { ok: n > 0, n, p, reason: n ? `${n} possible target${n === 1 ? '' : 's'}` : 'no valid targets right now' };
}
