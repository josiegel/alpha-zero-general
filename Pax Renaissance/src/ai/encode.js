// Observation / option encodings for learned agents (neural networks).
//
//   encodeObservation(state, viewer, request?) -> Float32Array(OBS_SIZE)
//     Board from `viewer`'s perspective (0 = me, 1 = opponent) plus, when `request` is given,
//     the decision context: what kind of prompt this is and which action / Op it belongs to.
//   encodeOption(state, request, option, viewer?) -> Float32Array(OPT_SIZE)
//     Structured features of one legal option. Elements OPT_CARD_SLOT and OPT_CARD2_SLOT hold
//     card embedding indices (0 = no card, 1 + index into CARDS otherwise) and are meant for an
//     embedding lookup, not as numeric features.
//
// Information a player with perfect memory could know is encoded: all hands (cards only enter a
// hand by purchase from the face-up market) and face-down trade-fair cards that were face up
// earlier (state.seen). Never encoded: deck order, face-down cards never seen face up (e.g. those
// dealt at setup; flag only), and the engine's RNG state.
// OBS_LAYOUT gives [offset, length] of each observation section; `cards` is a CARDS.length x
// CARD_FEATS table so a model can treat each card as a token.
import { CARDS, EMPIRE_SQUARES } from '../data/cards.js';
import { EMPIRES, CITIES, BORDERS, EMPORIA, EMPIRE_NAMES } from '../data/map.js';
import { CARD, tableauUnits, prestigeCount, concessionsOf, handLimit, emporiumBusted, levyIcon, isEmp, empOf, ownerOfUnit, unitOps, isSilenced } from '../engine/state.js';
import { kingCount, republicCount } from '../engine/rules.js';
import { isKnownMarketCard } from './determinize.js';

export const ENCODER_VERSION = 3;
export const MAX_PLAYERS = 2;

// ---------------- vocabularies ----------------
const REL = ['C', 'I', 'R'];
const REL_WORDS = [/Catholic/, /Muslim|Islamic/, /Reformist/];
const PRESTIGE = ['catholic', 'islamic', 'reformist', 'law', 'discovery', 'patron'];
const BANK_LIST = ['Fugger', 'Medici', 'Coeur', 'Marchionni'];
const VICTORIES = ['holy', 'imperial', 'globalization', 'renaissance'];
const MAP_STATES = ['M', 'C', 'I', 'R'];
const OP_TYPES = [...new Set([
  ...CARDS.flatMap(c => c.ops.map(o => o.type)),
  ...Object.values(EMPIRE_SQUARES).flatMap(e => [...e.king.ops, ...e.republic.ops].map(o => o.type)),
])].sort();
const ONESHOTS = [...new Set(CARDS.filter(c => c.oneShot).map(c => c.oneShot.type))].sort();
const AGENT_TYPES = ['bishop', 'pirate', 'knight', 'rook', 'pawn'];
const LOCS = [...EMPIRES, 'East', 'West'];
const TOKEN_WORDS = [/Knight/, /Rook/, /Pawn|Concession/, /Pirate/, /Bishop/];
const BATTLES = [/Conspiracy/, /Peasant revolt/, /Jihad/, /Crusade/, /Reformation/, /Campaign/];

// Decision kinds, matched against the prompt text (first match wins; order matters).
const PROMPT_KINDS = [
  ['main', /choose an action/],
  ['oneshot', /: One-shot\?$/],
  ['victory_square', /activate a Victory Square/],
  ['ops_pick', /^Ops: choose a card and Op/],
  ['fair_levy', /^Trade fair Levy/],
  ['tax_levy', /^Tax Levy/],
  ['survivor_pawn', /^Place surviving Pawn/],
  ['survivor_pirate', /^Place surviving .*Pirate/],
  ['survivor_token', /^Place surviving/],
  ['pawn_place', /^Place Pawn agent/],
  ['bishop_place', /Bishop agent$/],
  ['pirate_place', /Pirate agent$/],
  ['token_place', /^Place .* agent/],
  ['bishop_take', /Bishops left: take one/],
  ['op_target', /— choose target$/],
  ['coronation', /: coronation\?$/],
  ['location', /choose the Location/],
  ['oneshot_target', /target Empire for the/],
  ['regime_concession', /^Regime change: place a Concession/],
  ['battle_defender', /choose a defender to kill/],
  ['battle_attacker', /choose one of your attackers to lose/],
  ['emancipation', /^Emancipation in/],
  ['taxed', /You are taxed at/],
  ['pacify', /^Pacification on/],
  ['hand_discard', /Hand limit exceeded/],
  ['apostasy', /^Apostasy between/],
  ['crypto', /Medici Ciphers Broken/],
  ['golden_liberty', /^Golden Liberty/],
  ['rhodes', /^Knights of Rhodes/],
  ['other', /(?:)/],
];
export function promptKind(prompt) { return PROMPT_KINDS.find(([, re]) => re.test(prompt))[0]; }

// Option verbs, derived from the option id.
const VERBS = ['buy', 'play', 'sell_h', 'sell_m', 'sell_t', 'ops', 'fair', 'win', 'reprisal', 'counterref', 'end',
  'skip', 'none', 'done', 'yes', 'no', 'pay', 'repress', 'maid', 'marry', 'holder', 'from', 'city', 'border',
  'discard', 'attacker', 'empire', 'pacify', 'op', 'crypto_op', 'behead', 'move', 'tax', 'take_florin',
  'victory', 'relpair', 'card', 'other'];
const MAIN_VERBS = ['buy', 'play', 'sell', 'ops', 'fair', 'win', 'reprisal', 'counterref'];
const REF_TYPES = ['card', 'empire', 'city', 'border', 'market', 'holder', 'victory'];

const CARD_IX = Object.fromEntries(CARDS.map((c, i) => [c.id, i]));
const EMP_IX = Object.fromEntries(EMPIRES.map((e, i) => [e, i]));
const CITY_IX = Object.fromEntries(CITIES.map((c, i) => [c.id, i]));
const BORDER_IX = Object.fromEntries(BORDERS.map((b, i) => [b.id, i]));

// Display names -> ids, longest first so "Constantinople" etc. match cleanly.
const EMPIRE_NAME_RES = EMPIRES.map(e => [EMP_IX[e], new RegExp(`\\b${EMPIRE_NAMES[e]}\\b`)]);
const CITY_NAME_RES = CITIES.map(c => [CITY_IX[c.id], c.name || c.id]);
const BORDER_NAME_RES = BORDERS.map(b => [BORDER_IX[b.id], b.id]);

// ---------------- observation layout ----------------
const G_SIZE = 2 + VICTORIES.length + 2 + 1 + 3 + 5 + 3 + 3;
const P_SIZE = 1 + 6 + 10 + PRESTIGE.length + BANK_LIST.length + 1;
const E_SIZE = 3 + 1 + EMPIRES.length + 1 + 4 + 3 + 3 + 2 + 3;
const C_SIZE = 6 + 6 + 1;
const B_SIZE = MAX_PLAYERS + 3 + 1;
const M_SIZE = 4;
// per-card channels
const CF = { myHand: 0, myTab: 1, oppTab: 2, queen: 3, market: 4, mktSlot: 5, mktFlorins: 6, myMaid: 7, oppMaid: 8,
  bishop: 9 /* +3 */, silenced: 12, ctxMain: 13, ctxOp: 14, oppHand: 15, mktFaceDown: 16 };
export const CARD_FEATS = 17;
const X_SIZE = PROMPT_KINDS.length + MAIN_VERBS.length + OP_TYPES.length + EMPIRES.length /* op empire */
  + EMPIRES.length /* empires named in prompt */ + 2 /* East/West named */ + 3 /* religion named */
  + TOKEN_WORDS.length + BATTLES.length + 4;

const sections = [['global', G_SIZE], ['players', MAX_PLAYERS * P_SIZE], ['empires', EMPIRES.length * E_SIZE],
  ['cities', CITIES.length * C_SIZE], ['borders', BORDERS.length * B_SIZE], ['market', 2 * 6 * M_SIZE],
  ['context', X_SIZE], ['cards', CARDS.length * CARD_FEATS]];
export const OBS_LAYOUT = {};
let _off = 0;
for (const [name, len] of sections) { OBS_LAYOUT[name] = [_off, len]; _off += len; }
export const OBS_SIZE = _off;
function at(k, section) { if (k !== OBS_LAYOUT[section][0]) throw new Error(`encode.js layout bug: at ${k}, expected ${section} at ${OBS_LAYOUT[section][0]}`); }

// ---------------- context helpers ----------------
// What action / Op does the pending decision belong to? Derived from the unit's decision trail.
function decisionContext(s, req) {
  const out = { mainVerb: null, mainCard: null, opCard: null, opEmpire: null, opType: null };
  const trail = (req && req.trail) || [];
  if (trail.length && /choose an action/.test(trail[0].prompt)) {
    const id = trail[0].id; const verb = id.split(':')[0];
    out.mainVerb = verb;
    const m = id.match(/^(?:play|reprisal|counterref):(.+)$/) || id.match(/^sell:[hmt]:(.+)$/);
    if (m && m[1] in CARD_IX) out.mainCard = m[1];
  }
  for (let i = trail.length - 1; i >= 0; i--) {
    const m = trail[i].id.match(/^(?:op|x):(.+):(\d+)$/);
    if (!m) continue;
    const key = m[1];
    if (isEmp(key)) out.opEmpire = empOf(key); else if (key in CARD_IX) out.opCard = key;
    const ops = isEmp(key) ? unitOps(s, { kind: 'empire', empire: empOf(key) }) : CARD[key]?.ops;
    out.opType = ops?.[+m[2]]?.type ?? null;
    break;
  }
  return out;
}

// ---------------- observation ----------------
export function encodeObservation(s, me, req = null) {
  const v = new Float32Array(OBS_SIZE);
  const n = s.numPlayers;
  const rel = (p) => Math.min((p - me + n) % n, MAX_PLAYERS - 1); // 0 = me, 1 = opponent
  let k = 0;

  // global
  const T = s.turn;
  v[k++] = T.actions / 2; v[k++] = s.current === me ? 1 : 0;
  for (const x of VICTORIES) v[k++] = s.victory[x] ? 1 : 0;
  v[k++] = s.decks.E.length / 80; v[k++] = s.decks.W.length / 80;
  v[k++] = s.turnNo / 40;
  v[k++] = T.counts.purchase / 2; v[k++] = T.counts.play / 2; v[k++] = T.counts.sell / 2;
  for (const d of ['opsW', 'opsE', 'fairW', 'fairE', 'victory']) v[k++] = T.did[d] ? 1 : 0;
  v[k + EMPORIA.black.indexOf(s.activeEmporium.black)] = 1; k += 3;
  v[k + EMPORIA.white.indexOf(s.activeEmporium.white)] = 1; k += 3;
  at(k, 'players');

  // players (me first)
  for (let r = 0; r < MAX_PLAYERS; r++) {
    if (r >= n) { k += P_SIZE; continue; }
    const p = (me + r) % n; const P = s.players[p];
    v[k++] = P.florins / 10;
    for (let t = 1; t <= 6; t++) v[k++] = P.florins >= t ? 1 : 0;
    v[k++] = P.hand.length / 4;
    v[k++] = handLimit(s, p) === Infinity ? 1 : 0;
    v[k++] = concessionsOf(s, p) / 6;
    v[k++] = P.pawns / 10;
    v[k++] = kingCount(s, p) / 4;
    v[k++] = republicCount(s, p) / 4;
    const units = tableauUnits(s, p);
    v[k++] = units.filter(u => u.side === 'W').length / 8;
    v[k++] = units.filter(u => u.side === 'E').length / 8;
    v[k++] = P.oldMaids.length / 3;
    v[k++] = s.current === p ? 1 : 0;
    for (const x of PRESTIGE) v[k++] = prestigeCount(s, p, x) / 6;
    v[k + BANK_LIST.indexOf(P.bank)] = 1; k += BANK_LIST.length;
    v[k++] = p / Math.max(1, n - 1); // seat
  }
  at(k, 'empires');

  // empires
  for (const e of EMPIRES) {
    const E = s.empires[e];
    v[k + (E.owner === null ? 0 : 1 + rel(E.owner))] = 1; k += 3;
    v[k++] = E.face === 'republic' ? 1 : 0;
    if (E.suzerain) v[k + EMP_IX[E.suzerain]] = 1; k += EMPIRES.length;
    v[k++] = E.queen ? 1 : 0;
    v[k + MAP_STATES.indexOf(s.mapState[e])] = 1; k += 4;
    for (const t of E.repressed) {
      if (t.t === 'K') v[k + REL.indexOf(t.c)] += 1 / 3;
      else if (t.t === 'R') v[k + 3 + REL.indexOf(t.c)] += 1 / 3;
      else if (t.t === 'P') v[k + 6 + rel(t.c)] += 1 / 3;
    }
    k += 8;
    if (E.bishop) v[k + REL.indexOf(E.bishop)] = 1; k += 3;
  }
  at(k, 'cities');

  // cities
  for (const c of CITIES) {
    for (const t of s.cities[c.id]) v[k + (t.t === 'K' ? 0 : 3) + REL.indexOf(t.c)] += 1;
    const icon = levyIcon(s, c.id); // e.g. 'KC'
    if (icon) v[k + 6 + (icon[0] === 'K' ? 0 : 3) + REL.indexOf(icon[1])] = 1;
    v[k + 12] = emporiumBusted(s, c.id) ? 1 : 0;
    k += C_SIZE;
  }

  // borders
  for (const b of BORDERS) {
    const B = s.borders[b.id];
    if (B.pawn !== null) v[k + rel(B.pawn)] = 1;
    if (B.pirate) v[k + MAX_PLAYERS + REL.indexOf(B.pirate)] = 1;
    v[k + MAX_PLAYERS + 3] = b.sea ? 1 : 0;
    k += B_SIZE;
  }

  // market slots
  for (const row of ['W', 'E']) for (let i = 0; i < 6; i++) {
    const sl = s.market[row][i];
    v[k++] = sl && sl.card ? 1 : 0; v[k++] = sl && sl.faceDown ? 1 : 0; v[k++] = (sl ? sl.florins : 0) / 3;
    v[k++] = sl && sl.faceDown && isKnownMarketCard(s, sl) ? 1 : 0;
  }
  at(k, 'context');

  // decision context
  const [xo] = OBS_LAYOUT.context;
  const ctx = decisionContext(s, req);
  if (req) {
    let j = xo;
    v[j + PROMPT_KINDS.findIndex(([, re]) => re.test(req.prompt))] = 1; j += PROMPT_KINDS.length;
    if (ctx.mainVerb && MAIN_VERBS.includes(ctx.mainVerb)) v[j + MAIN_VERBS.indexOf(ctx.mainVerb)] = 1; j += MAIN_VERBS.length;
    if (ctx.opType) v[j + OP_TYPES.indexOf(ctx.opType)] = 1; j += OP_TYPES.length;
    if (ctx.opEmpire) v[j + EMP_IX[ctx.opEmpire]] = 1; j += EMPIRES.length;
    for (const [ix, re] of EMPIRE_NAME_RES) if (re.test(req.prompt)) v[j + ix] = 1; j += EMPIRES.length;
    v[j++] = /The East/.test(req.prompt) ? 1 : 0; v[j++] = /The West/.test(req.prompt) ? 1 : 0;
    REL_WORDS.forEach((re, i) => { if (re.test(req.prompt)) v[j + i] = 1; }); j += 3;
    TOKEN_WORDS.forEach((re, i) => { if (re.test(req.prompt)) v[j + i] = 1; }); j += TOKEN_WORDS.length;
    BATTLES.forEach((re, i) => { if (re.test(req.prompt)) v[j + i] = 1; }); j += BATTLES.length;
    v[j++] = req.player === s.current ? 1 : 0;
    v[j++] = req.main ? 1 : 0;
    v[j++] = Math.min((req.trail || []).length, 20) / 10;
    v[j++] = Math.min(req.options.length, 40) / 20;
    at(j, 'cards');
  }

  // card table
  const [co] = OBS_LAYOUT.cards;
  const put = (id, ch, val = 1) => { if (id in CARD_IX) v[co + CARD_IX[id] * CARD_FEATS + ch] = val; };
  for (let p = 0; p < n; p++) s.players[p].hand.forEach(id => put(id, p === me ? CF.myHand : CF.oppHand));
  for (let p = 0; p < n; p++) {
    for (const u of tableauUnits(s, p)) {
      if (u.kind === 'empire') continue;
      put(u.key, p === me ? CF.myTab : CF.oppTab);
      if (u.kind === 'queen') put(u.key, CF.queen);
    }
    s.players[p].oldMaids.forEach(id => put(id, p === me ? CF.myMaid : CF.oppMaid));
  }
  for (const row of ['W', 'E']) s.market[row].forEach((sl, i) => {
    if (!isKnownMarketCard(s, sl)) return; // never-seen face-down card stays hidden
    put(sl.card, CF.market); put(sl.card, CF.mktSlot, i / 5); put(sl.card, CF.mktFlorins, sl.florins / 3);
    if (sl.faceDown) put(sl.card, CF.mktFaceDown);
  });
  for (const id in s.bishops) {
    put(id, CF.bishop + REL.indexOf(s.bishops[id]));
    if (isSilenced(s, id)) put(id, CF.silenced);
  }
  if (ctx.mainCard) put(ctx.mainCard, CF.ctxMain);
  if (ctx.opCard) put(ctx.opCard, CF.ctxOp);
  return v;
}

// ---------------- options ----------------
// Static per-card features (same for every encoding call).
const STATIC_CARD_SIZE = 2 + 1 + PRESTIGE.length + OP_TYPES.length + ONESHOTS.length + AGENT_TYPES.length + 1 + 1 + LOCS.length + 1;
const STATIC_CARD = CARDS.map(c => {
  const f = new Float32Array(STATIC_CARD_SIZE); let j = 0;
  f[j + (c.side === 'W' ? 0 : 1)] = 1; j += 2;
  f[j++] = c.comet ? 1 : 0;
  for (const x of PRESTIGE) f[j++] = c.prestige.filter(y => y === x).length / 2;
  for (const x of OP_TYPES) f[j++] = c.ops.filter(o => o.type === x).length / 2;
  if (c.oneShot) f[j + ONESHOTS.indexOf(c.oneShot.type)] = 1; j += ONESHOTS.length;
  for (const x of AGENT_TYPES) f[j++] = c.agents.filter(a => a.type === x).length / 2;
  f[j++] = c.suitors ? 1 : 0;
  f[j++] = c.abilities.length / 2;
  const li = c.loc ? LOCS.indexOf(c.loc) : -1;
  if (li >= 0) f[j + li] = 1; j += LOCS.length;
  f[j++] = c.loc ? 0 : 1;
  return f;
});

export const OPT_CARD_SLOT = 0;   // main card of the option (target)
export const OPT_CARD2_SLOT = 1;  // second card named in the option id (e.g. source of a Bishop move)
export const NUM_CARD_EMBEDDINGS = CARDS.length + 1;
const O = {};
{
  let j = 2;
  const add = (name, len) => { O[name] = j; j += len; };
  add('verb', VERBS.length); add('ref', REF_TYPES.length + 1);
  add('tEmp', EMPIRES.length); add('tCity', CITIES.length); add('tBorder', BORDERS.length);
  add('mEmp', EMPIRES.length); add('mCity', CITIES.length); add('mBorder', BORDERS.length);
  add('row', 2); add('slot', 6); add('slotFlorins', 1); add('price', 1);
  add('rel', 3); add('token', TOKEN_WORDS.length); add('victory', VICTORIES.length); add('opType', OP_TYPES.length);
  add('cardOwner', 3); add('cardWhere', 4); add('num', 1); add('flags', 7);
  add('card', STATIC_CARD_SIZE);
  O.size = j;
}
export const OPT_SIZE = O.size;

export function optionVerb(id) {
  const head = id.split(/[:|]/)[0];
  if (id.includes('>')) return 'move';
  if (/^sell:[hmt]:/.test(id)) return 'sell_' + id[5];
  const direct = { buy: 'buy', play: 'play', ops: 'ops', fair: 'fair', win: 'win', reprisal: 'reprisal', counterref: 'counterref',
    end: 'end', skip: 'skip', none: 'none', done: 'done', yes: 'yes', no: 'no', pay: 'pay', repress: 'repress', maid: 'maid',
    m: 'marry', h: 'holder', f: 'from', c: 'city', b: 'border', d: 'discard', a: 'attacker', e: 'empire', op: 'op', x: 'crypto_op', t: 'behead' };
  if (head in direct) return direct[head];
  if (/^k\d+$/.test(id)) return 'pacify';
  if (/^m\d+$/.test(id)) return 'take_florin';
  if (head in EMP_IX && id.includes('|')) return 'tax';
  if (VICTORIES.includes(id)) return 'victory';
  if (/^[CIR]{2}$/.test(id)) return 'relpair';
  if (id in CARD_IX) return 'card';
  if (id in EMP_IX) return 'empire';
  if (id in CITY_IX) return 'city';
  if (id in BORDER_IX) return 'border';
  return 'other';
}

export function encodeOption(s, req, o, me = req.player) {
  const v = new Float32Array(OPT_SIZE);
  const id = o.id; const ref = o.ref || null; const label = o.label || '';
  v[O.verb + VERBS.indexOf(optionVerb(id))] = 1;
  v[O.ref + (ref ? REF_TYPES.indexOf(ref.type) + 1 : 0)] = 1;

  // the card this option is about, if any (never the face-down trade-fair card)
  let card = null;
  const setEmpire = (e, base) => { if (e in EMP_IX) v[base + EMP_IX[e]] = 1; };
  if (ref) {
    if (ref.type === 'card' || ref.type === 'holder') { if (isEmp(ref.id)) setEmpire(empOf(ref.id), O.tEmp); else if (ref.id in CARD_IX) card = ref.id; }
    else if (ref.type === 'empire') setEmpire(ref.id, O.tEmp);
    else if (ref.type === 'city' && ref.id in CITY_IX) v[O.tCity + CITY_IX[ref.id]] = 1;
    else if (ref.type === 'border' && ref.id in BORDER_IX) v[O.tBorder + BORDER_IX[ref.id]] = 1;
    else if (ref.type === 'market') {
      const sl = s.market[ref.row][ref.i];
      v[O.row + (ref.row === 'W' ? 0 : 1)] = 1; v[O.slot + ref.i] = 1;
      v[O.slotFlorins] = (sl?.florins || 0) / 3;
      if (sl && isKnownMarketCard(s, sl)) card = sl.card; // e.g. a trade fair on a remembered card
    } else if (ref.type === 'victory') v[O.victory + VICTORIES.indexOf(ref.id)] = 1;
  }
  if (id.startsWith('buy:')) v[O.price] = +id.split(':')[2] / 5;
  const side = id.match(/^(?:ops|fair):([WE]+)$/);
  if (side) for (const ch of side[1]) v[O.row + (ch === 'W' ? 0 : 1)] = 1;

  // entities named in the id count as targets (e.g. the Levy empire of a Tax), those only in the label as mentions
  const opm = id.match(/^(?:op|x):(.+):(\d+)$/);
  if (opm) {
    const key = opm[1];
    const ops = isEmp(key) ? unitOps(s, { kind: 'empire', empire: empOf(key) }) : CARD[key]?.ops;
    const t = ops?.[+opm[2]]?.type; if (t) v[O.opType + OP_TYPES.indexOf(t)] = 1;
    if (isEmp(key)) setEmpire(empOf(key), O.tEmp); else if (!card && key in CARD_IX) card = key;
  }
  let card2 = null;
  for (const part of id.split(/[:|>]/)) {
    if (part in CARD_IX) { if (!card) card = part; else if (part !== card && !card2) card2 = part; }
    else if (part in EMP_IX) v[O.tEmp + EMP_IX[part]] = 1;
    else if (part in CITY_IX) v[O.tCity + CITY_IX[part]] = 1;
    else if (part in BORDER_IX) v[O.tBorder + BORDER_IX[part]] = 1;
    else if (VICTORIES.includes(part)) v[O.victory + VICTORIES.indexOf(part)] = 1;
  }
  if (/^[CIR]{2}$/.test(id)) for (const ch of id) v[O.rel + REL.indexOf(ch)] = 1;

  // entities mentioned in the label (battle targets, emancipation, etc.)
  for (const [ix, re] of EMPIRE_NAME_RES) if (re.test(label)) v[O.mEmp + ix] = 1;
  for (const [ix, name] of CITY_NAME_RES) if (label.includes(name)) v[O.mCity + ix] = 1;
  for (const [ix, name] of BORDER_NAME_RES) if (label.includes(name)) v[O.mBorder + ix] = 1;
  REL_WORDS.forEach((re, i) => { if (re.test(label)) v[O.rel + i] = 1; });
  TOKEN_WORDS.forEach((re, i) => { if (re.test(label)) v[O.token + i] = 1; });
  const num = label.match(/cost (\d+)|\((\d+) florin|\((\d+)\)/);
  if (num) v[O.num] = +(num[1] || num[2] || num[3]) / 5;
  v[O.flags] = /\bfree\b/i.test(label) ? 1 : 0;
  v[O.flags + 1] = /Diet of Worms/.test(label) ? 1 : 0;
  v[O.flags + 2] = /already married/.test(label) ? 1 : 0;
  v[O.flags + 3] = /costs 2 actions/.test(label) ? 1 : 0;
  v[O.flags + 4] = /^Repressed\b/.test(label) ? 1 : 0;
  v[O.flags + 5] = /^Agent\b/.test(label) ? 1 : 0;
  v[O.flags + 6] = card && ref && (ref.type === 'card' || ref.type === 'holder') && ref.id === card ? 1 : 0; // card is the target (vs. the source of a move)

  if (card) {
    v[OPT_CARD_SLOT] = CARD_IX[card] + 1;
    const owner = ownerOfUnit(s, card);
    const n = s.numPlayers;
    v[O.cardOwner + (owner === null ? 0 : 1 + Math.min((owner - me + n) % n, 1))] = 1;
    const P = s.players[me];
    const where = P.hand.includes(card) ? 0 : P.oldMaids.includes(card) ? 1 : owner !== null ? 2 : 3;
    v[O.cardWhere + where] = 1;
    v.set(STATIC_CARD[CARD_IX[card]], O.card);
  }
  if (card2) v[OPT_CARD2_SLOT] = CARD_IX[card2] + 1;
  return v;
}
