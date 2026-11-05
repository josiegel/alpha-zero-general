// Human-readable explanations of card features for the hover preview.
import { EMPIRE_NAMES, CITY } from '../data/map.js';
import { EMPIRE_SQUARES } from '../data/cards.js';
import { REL_NAME, REL_PRESTIGE } from '../engine/util.js';
import { prestigeCount } from '../engine/state.js';
import { kingCount, republicCount, lawCount, globConcessions, religionCounts, victoryMet } from '../engine/rules.js';

const locName = (loc) => (loc === '@husband' ? "her husband's Empire" : loc ? EMPIRE_NAMES[loc] || loc : 'no Location');
const side = (m) => (m === 'W' ? 'West' : 'East');
const PRESTIGE = { catholic: 'Catholic', islamic: 'Muslim', reformist: 'Reformist', law: 'Law', discovery: 'Discovery', patron: 'Patron' };
const where = (loc) => (loc === 'East' || loc === 'West' ? `any ${side(loc[0])}ern Empire (you choose one)` : locName(loc));

export function opText(o, loc) {
  const L = where(loc);
  switch (o.type) {
    case 'behead': return ['Behead', `Discard one card in any Tableau whose Location matches ${L} (not this card). If you behead an Empire Square, it returns to its Throne and this card is killed too.`];
    case 'tax': return ['Tax', `Target a Concession bordering ${L}. Its owner either pays 1 florin to China or represses it, then must place a Levy in an empty City there. The Empire must have an empty City.`];
    case 'repress': {
      const ruling = o.targets.filter(t => t !== 'pawn').map(t => t[0].toUpperCase() + t.slice(1));
      const parts = [];
      if (o.targets.includes('pawn')) parts.push(`one pawn in a Concession bordering ${L}`);
      if (ruling.length) parts.push(`one ${ruling.join(' or ')} of any religion from a City in ${L}`);
      return [`Repress (${o.targets.join('/')})`, `Remove ${parts.join(', or ')}${parts.length > 1 ? ',' : ''} and put it on that Empire Square as a Repressed Token${o.targets.includes('pawn') ? ' (a pawn becomes a Serf)' : ''}. You gain 1 florin.`];
    }
    case 'vote': return [`Vote (${side(o.market)})`, `Regime change in an Empire Square sitting in any ${side(o.market)} Tableau (not a Vassal or Throne). You need more Concessions on its Borders than any other player, and you pay 1 florin per Repressed Token. You gain it as a King, or flip it if it is already yours (King ↔ Republic). A Theocracy may become Medieval (Golden Liberty).`];
    case 'commerce': return [`Commerce (${side(o.market)})`, `Take 1 florin lying on any card in the ${side(o.market)} market row.`];
    case 'siege': return ['Siege', `Kill one Knight or Rook at ${L} or a bordering Pirate. Any religion; there is no battle and no cost.`];
    case 'corsair': return [`Corsair (${REL_NAME[o.religion]})`, `Move a ${REL_NAME[o.religion]} Pirate from a Sea Border of ${L} to another Sea Border of ${L}, or of an Empire adjacent across a Sea Border. It kills any Concession or Pirate already there. It cannot end on a Pirate of the same religion.`];
    case 'inquisitor': return [`Inquisitor (${REL_NAME[o.religion]})`, `Move a ${REL_NAME[o.religion]} Bishop anywhere in play to an adjacent card in the same Tableau, or to any card or Throne sharing its card's Location. If it lands on another Bishop, both die (Diet of Worms). Otherwise it may kill one Repressed Token there (pacification). This Op works even when the card is silenced.`];
    case 'campaign': return ['Campaign', `Attack an Empire adjacent to ${L} (diagonals count) that is in a Throne or an opponent's Tableau. All Knights in ${L} attack, paying 1 florin each. If any survive the battle, the defeated Empire becomes your Vassal (regime change).`];
  }
  return [o.type, ''];
}

export function oneShotText(card) {
  const os = card.oneShot; if (!os) return null;
  const L = where(card.loc);
  const agents = 'the card\'s Agents (except Bishops)';
  switch (os.type) {
    case 'conspiracy': return ['Conspiracy (civil war)', `Battle in ${L}. Attackers: ${agents}, every bordering Pirate and that Empire's repressed Knights and Rooks. Defenders: all Ruling Class in its Cities. If any attacker survives, you get a regime change: the Empire Square comes to you as a King (or flips if it is yours), and you place a Concession and may emancipate repressed tokens.`];
    case 'peasant_revolt': return ['Peasant revolt (civil war)', `Battle in ${L}. Attackers: ${agents}, your bordering Concessions, every bordering Pirate and the Serfs (repressed Pawns) on that Empire. Defenders: all Ruling Class. If any attacker survives, you get a regime change.`];
    case 'crusade': case 'jihad': case 'reformation': {
      const r = { crusade: 'C', jihad: 'I', reformation: 'R' }[os.type];
      return [`${os.type[0].toUpperCase() + os.type.slice(1)} (religious war)`, `Battle in ${L}. Attackers are ${REL_NAME[r]} believers: the card's Knights, Rooks and Pirates, ${REL_NAME[r]} Ruling Class there, bordering ${REL_NAME[r]} Pirates and ${REL_NAME[r]} Knights in adjacent Empires. Defenders are all heretic Ruling Class and Pirates there, and there must be at least one. If you win, it becomes a ${REL_NAME[r]} Theocracy and you get a regime change.`];
    }
    case 'apostasy': return [`Apostasy (${os.religions.map(r => REL_NAME[r]).join(' vs ')})`, `Every player whose Tableau has Prestige of both ${REL_NAME[os.religions[0]]} and ${REL_NAME[os.religions[1]]} discards all cards with either Prestige. Empires and royal couples return to their Thrones. Old Maids are ignored. Agents are placed first.`];
    case 'trade_shift': return [`Trade shift: ${CITY[os.emporium]?.name || os.emporium}`, `Moves the busted disk: ${CITY[os.emporium]?.name || os.emporium} opens and becomes the start of the trade route, while the currently open Emporium of that colour is busted (tokens there are repressed). Agents must be placed.${os.requires ? ` Requires ${PRESTIGE[os.requires]} Prestige already in your Tableau.` : ''}`];
    case 'coronation': return ['Coronation', `Marry one of her suitors (${card.suitors.map(locName).join(', ')}): an unmarried King in his Throne or in your Tableau. This is a regime change: the royal couple joins your Tableau and you may place a Concession. Otherwise she can be played as an Old Maid under your player board, where her Prestige still counts.`];
  }
  return [os.type, ''];
}

function agentText(a) {
  const nm = { bishop: 'Bishop', knight: 'Knight', rook: 'Rook', pawn: 'Pawn (your Concession)', pirate: 'Pirate' }[a.type];
  return a.color ? `${REL_NAME[a.color]} ${nm}` : nm;
}

// married = Empire a Queen is married to (null if unmarried); her Ops act in her husband's Empire
export function cardInfo(card, married = null) {
  const L = card.suitors ? (married || '@husband') : card.loc;
  const rows = [];
  rows.push(['head', card.name]);
  if (card.comet) { rows.push(['p', 'Comet: when purchased it is discarded and you activate an inactive Victory Square of your choice.']); return rows; }
  rows.push(['sub', `${side(card.side)} card · Location: ${card.suitors ? (married ? `${locName(married)} (married Queen)` : "her husband's Empire (Queen)") : locName(card.loc)}${card.prestige.length ? ' · Prestige: ' + card.prestige.map(x => PRESTIGE[x]).join(', ') : ''}`]);
  if (card.ops.length) {
    rows.push(['section', 'ops', 'Ops', `usable once per turn each, via an "Activate ${side(card.side)}ern Ops" action`]);
    for (const o of card.ops) { const [t, d] = opText(o, L); rows.push(['op', t, d]); }
  }
  const os = oneShotText(card);
  if (os || card.agents.length) {
    rows.push(['section', 'os', 'When played', os ? 'optional One-shot, then Agents' : 'Agents only — no One-shot']);
    if (os) rows.push(['os', 'One-shot: ' + os[0], os[1]]);
    if (card.agents.length) rows.push(['agents', 'Agents: ' + card.agents.map(agentText).join(', '), os ? 'Optional if you skip the One-shot; mandatory if you trigger it.' : 'Optional: place any, all or none.']);
  }
  if (card.abilities.length) {
    rows.push(['section', 'ab', card.abilities.length > 1 ? 'Abilities' : 'Ability', 'always active while in a Tableau and not silenced']);
    for (const a of card.abilities) rows.push(['ab', a.name || 'Rule for all players', a.text + (a.all && !/all players/i.test(a.text) ? ' (applies to all players)' : '')]);
  }
  return rows;
}

export function empireInfo(s, e) {
  const E = s.empires[e]; const sq = EMPIRE_SQUARES[e][E.face];
  const rows = [['head', `${EMPIRE_NAMES[e]} — ${E.face === 'king' ? 'King' : 'Republic'}`], ['sub', sq.name]];
  rows.push(['sub', `${side(EMPIRE_SQUARES[e].side)} · ${E.owner === null ? 'in its Throne' : 'owned by ' + s.players[E.owner].name}${E.suzerain ? ` · Vassal of ${EMPIRE_NAMES[E.suzerain]}` : ''} · ${s.mapState[e] === 'M' ? 'Medieval' : REL_NAME[s.mapState[e]] + ' Theocracy'}${sq.prestige.length ? ' · Prestige: ' + sq.prestige.map(x => PRESTIGE[x]).join(', ') : ''}`]);
  if (sq.ops.length) {
    rows.push(['section', 'ops', 'Ops', `usable once per turn, via an "Activate ${side(EMPIRE_SQUARES[e].side)}ern Ops" action`]);
    for (const o of sq.ops) { const [t, d] = opText(o, e); rows.push(['op', t, d]); }
  }
  if (E.repressed.length) rows.push(['p', `Repressed tokens: ${E.repressed.length}. A vote here costs that many florins.`]);
  if (E.bishop) rows.push(['p', `${REL_NAME[E.bishop]} Bishop present: its Ops are silenced.`]);
  return rows;
}

// Tracking popup for a victory square: rows = ['head'|'sub'|'p', text] or ['table', header[], rows[][], highlightIndex]
export function victoryInfo(s, v) {
  const names = s.players.map(P => P.name);
  const status = s.victory[v] ? 'ACTIVE' : 'inactive (activated by buying a Comet)';
  const met = s.players.map((_, p) => (victoryMet(s, p, v) ? 'yes' : '–'));
  const two = s.numPlayers === 2;
  const head = { renaissance: 'Renaissance Victory', globalization: 'Globalization Victory', imperial: 'Imperial Victory', holy: 'Holy Victory' }[v];
  const rows = [['head', head], ['sub', status]];
  const perPlayer = (cols) => s.players.map((P, p) => [P.name, ...cols.map(f => f(p)), met[p]]);
  const best = (vals) => { const m = Math.max(...vals); return vals.filter(x => x === m).length === 1 ? vals.indexOf(m) : -1; };
  if (v === 'renaissance') {
    rows.push(['p', 'Need more Republics than each opponent AND at least 2 more Law Prestige than each opponent.']);
    rows.push(['table', ['Player', 'Republics', 'Law', 'Meets'], perPlayer([p => republicCount(s, p), p => lawCount(s, p)]), met.indexOf('yes')]);
  } else if (v === 'globalization') {
    rows.push(['p', 'Need at least 2 more Concessions than each opponent AND more Discovery Prestige than each opponent.']);
    rows.push(['table', ['Player', 'Concessions', 'Discovery', 'Meets'], perPlayer([p => globConcessions(s, p), p => prestigeCount(s, p, 'discovery')]), met.indexOf('yes')]);
  } else if (v === 'imperial') {
    rows.push(['p', `Need at least ${two ? 3 : 2} more King-side Empire Squares (Suzerains and Vassals) than each opponent.`]);
    rows.push(['table', ['Player', 'Kings', 'Republics', 'Meets'], perPlayer([p => kingCount(s, p), p => republicCount(s, p)]), met.indexOf('yes')]);
  } else if (v === 'holy') {
    const rc = religionCounts(s);
    rows.push(['p', 'A religion is supreme with more Bishops in play than the other two combined AND more of its Tokens in its own Theocracies than the other two combined. To win, have more Prestige of the supreme religion than each opponent.']);
    const order = ['C', 'I', 'R'];
    const table = order.map(r => [REL_NAME[r], rc.bishops[r], rc.units[r], ...s.players.map((_, p) => prestigeCount(s, p, REL_PRESTIGE[r]))]);
    rows.push(['table', ['Religion', 'Bishops', 'Theocracy tokens', ...names.map(n => n + ' prestige')], table, rc.supreme ? order.indexOf(rc.supreme) : -1]);
    rows.push(['p', rc.supreme ? `${REL_NAME[rc.supreme]} is supreme.` : 'No religion is supreme.']);
    rows.push(['sub', `Meets: ${s.players.map((P, p) => `${P.name} ${met[p]}`).join(' · ')}`]);
  }
  return rows;
}

// Hover popup for an Empire's map region.
import { empireCities, cityCapacity, levyIcon, emporiumBusted, saturated, bordersOf as bordersOfE, BORDER as BORDER_ } from '../engine/state.js';
import { tokenLabel } from '../engine/util.js';
import { CARD as CARD_ } from '../engine/state.js';
const CARD_NAME = (id) => CARD_[id].name;
export function locInfo(s, e) {
  const E = s.empires[e];
  const who = (p) => (s.players[p].name === 'You' ? 'You' : s.players[p].name);
  const ctrl = E.owner === null ? 'Throne' : who(E.owner) + (E.suzerain ? ` (vassal of ${EMPIRE_NAMES[E.suzerain]})` : '');
  const rel = s.mapState[e] === 'M' ? 'Secular' : `${REL_NAME[s.mapState[e]]} theocracy`;
  const cities = empireCities(e).map(id => {
    const c = CITY[id]; const toks = s.cities[id];
    const nm = c.name || id;
    if (emporiumBusted(s, id)) return [`${nm}: busted`, true];
    if (toks.length < cityCapacity(s, id)) { const ic = levyIcon(s, id); return [`${nm}: ${toks.length ? toks.map(tokenLabel).join(', ') + ' + ' : ''}open (${tokenLabel({ t: ic[0], c: ic[1] })})`, true]; }
    return [`${nm}: ${toks.map(tokenLabel).join(', ')}`, false];
  });
  const borders = bordersOfE(e).map(b => {
    const B = s.borders[b.id]; const other = EMPIRE_NAMES[b.a === e ? b.b : b.a];
    const occ = [B.pawn !== null ? `${s.players[B.pawn].bank} pawn` : '', B.pirate ? `${REL_NAME[B.pirate]} pirate` : ''].filter(Boolean).join(' + ');
    return [`${other}${b.sea ? '' : ' (land)'}: ${occ || 'open'}`, !occ];
  });
  return [
    ['head', EMPIRE_NAMES[e]],
    ['sub', `${ctrl} · ${E.face === 'king' ? 'Kingdom' : 'Republic'} · ${rel}${E.repressed.length ? ` · ${E.repressed.length} repressed` : ''}`],
    ['list', 'Cities', cities],
    ['list', 'Borders', borders],
  ];
}
