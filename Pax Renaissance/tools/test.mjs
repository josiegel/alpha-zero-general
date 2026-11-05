// Scenario tests built from rulebook examples.  Usage: node tools/test.mjs
import { newGame, CARD } from '../src/engine/state.js';
import { playUnit } from '../src/engine/rules.js';
import { NeedChoice } from '../src/engine/util.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') { if (cond) pass++; else { fail++; console.log('FAIL:', name, extra); } }

// run one unit; `script` is a list of predicates/substrings selecting options in order
function run(s, script) {
  let i = 0; const seen = [];
  const ctx = {
    choose(p, prompt, options) {
      seen.push(prompt);
      if (options.length === 1 && i >= script.length) return options[0];
      const want = script[i++];
      if (want === undefined) throw new NeedChoice({ prompt, options });
      const o = options.find(x => (typeof want === 'function' ? want(x) : x.id === want || x.label.includes(want)));
      if (!o) throw new Error(`No option matching ${want} for "${prompt}": ${options.map(x => x.id).join(', ')}`);
      return o;
    },
  };
  try { playUnit(s, ctx); return { done: true, seen }; } catch (e) { if (e instanceof NeedChoice) return { done: false, req: e.req, seen }; throw e; }
}
function base() {
  const s = newGame({ seed: 42, players: [{ name: 'A' }, { name: 'B' }], banks: ['Fugger', 'Coeur'] });
  s.log = []; return s;
}

// --- Trade fair example (G4/G5): Tana route, concession Byz-Hun (A), Ott-Mam (B, start) ---
{
  const s = base();
  s.borders['Hungary-Byzantium'].pawn = 0; s.players[0].pawns--;
  s.market.E[0].florins = 1; // 1 + 1 (2-player) = 2 profits
  const f0 = s.players[0].florins, f1 = s.players[1].florins;
  const r = run(s, ['fair:E', 'Caffa']);
  check('fair: initiator +1 and Byz-Hun concession +1', s.players[0].florins === f0 + 2, s.players[0].florins);
  check('fair: Ott-Mam concession gets nothing', s.players[1].florins === f1);
  check('fair: only Byzantium levy', s.log.filter(l => l.startsWith('Levy')).length === 1, s.log.join('\n'));
  check('fair: card discarded, 0 left', s.market.E[0].card === null && s.market.E[0].florins === 0);
}
// --- 3 profits: voyage reaches Ott-Mam; levies in Byz, Hun (if room), Ott ---
{
  const s = base();
  s.borders['Hungary-Byzantium'].pawn = 0; s.players[0].pawns--;
  s.market.E[0].florins = 2;
  const f1 = s.players[1].florins;
  run(s, ['fair:E', () => true, () => true, () => true, () => true]);
  check('fair3: purple concession paid', s.players[1].florins === f1 + 1);
  const lv = s.log.filter(l => l.startsWith('Levy'));
  check('fair3: levies in up to 3 empires', lv.length === 3, lv.join(' | '));
}
// --- Purchase cost & usury (E1) ---
{
  const s = base();
  s.market.W[3].florins = 2;
  const f = s.players[0].florins; // 3
  const id = s.market.W[3].card;
  run(s, ['buy:W:3']);
  check('buy: paid 3, took 2', s.players[0].florins === f - 3 + 2, s.players[0].florins);
  check('buy: card in hand', s.players[0].hand.includes(id));
  check('buy: florins placed on slots 0-2', [0, 1, 2].every(i => s.market.W[i].florins >= 1));
  // usury: second action must not offer buying slots 1 or 2 in W
  const r = run(s, []);
  const ids = r.req.options.map(o => o.id);
  check('usury: cannot buy W1/W2 this turn', !ids.includes('buy:W:1') && !ids.includes('buy:W:2'), ids.join(','));
}
// --- Vote requires majority; cost = repressed (F6) ---
{
  const s = base();
  // give B the France empire; A has 2 French concessions, B has 0 French concessions
  s.empires.France.owner = 1; s.players[1].west.push('EMP:France'); s.empires.France.face = 'king';
  s.empires.France.repressed.push({ t: 'R', c: 'C' });
  s.borders['England-France'].pawn = 0; s.players[0].pawns--;
  // find a West card with a W vote op and put it in A's tableau
  const voter = Object.values(CARD).find(c => c.side === 'W' && c.ops.some(o => o.type === 'vote' && o.market === 'W'));
  s.players[0].west.push(voter.id);
  const f = s.players[0].florins;
  const r = run(s, ['ops:W', (o) => o.id.startsWith('op:' + voter.id), 'e:France', 'skip', 'done']);
  check('vote: France moved to A', s.empires.France.owner === 0 && s.players[0].west.includes('EMP:France'), JSON.stringify(s.empires.France));
  check('vote: paid 1', s.players[0].florins === f - 1, s.players[0].florins);
}
// --- Campaign: all knights pay; no defenders => vassal (F9) ---
{
  const s = base();
  s.empires.HRE.owner = 0; s.players[0].west.push('EMP:HRE');
  s.cities.Nurnberg.push({ t: 'K', c: 'R' }); s.pool.K.R--;
  s.cities.Vienna = [{ t: 'K', c: 'C' }]; s.pool.R.C++; s.pool.K.C--;
  s.cities.Paris = []; s.pool.K.C++;
  s.players[0].florins = 5;
  run(s, ['ops:W', 'op:EMP:HRE:0', 'e:France', 'skip', 'done']);
  check('campaign: paid 2 for 2 knights', s.players[0].florins === 3, s.players[0].florins);
  check('campaign: France vassal of HRE', s.empires.France.suzerain === 'HRE' && s.empires.France.owner === 0);
}
// --- Bloody rule: no crusade without heretics (K1c) ---
{
  const s = base();
  const crus = Object.values(CARD).find(c => c.oneShot?.type === 'crusade' && c.loc === 'England');
  if (crus) {
    s.players[0].hand.push(crus.id);
    s.cities.London = [{ t: 'R', c: 'C' }];
    const r = run(s, ['play:' + crus.id]);
    const ids = r.req ? r.req.options.map(o => o.id) : [];
    check('bloody rule: no crusade option in all-catholic England', !ids.includes('yes'), r.req?.prompt);
  }
}
// --- Hand limit (E1a) ---
{
  const s = base();
  s.players[0].hand = [s.decks.W.pop(), s.decks.W.pop()];
  const r = run(s, []);
  check('hand limit: no purchase with 2 cards', !r.req.options.some(o => o.id.startsWith('buy:') && !CARD[s.market[o.id[4]][+o.id[6]].card].comet));
}
// --- Repress op gains 1 (F5b) ---
{
  const s = base();
  const rep = Object.values(CARD).find(c => c.side === 'E' && c.loc === 'Ottoman' && c.ops.some(o => o.type === 'repress' && o.targets.includes('rook')));
  s.players[0].east.push(rep.id);
  const f = s.players[0].florins;
  run(s, ['ops:E', (o) => o.id.startsWith('op:' + rep.id), (o) => o.id.startsWith('c|Constantinople1'), 'done']);
  check('repress: +1 florin', s.players[0].florins === f + 1);
  check('repress: token on Ottoman square', s.empires.Ottoman.repressed.length === 1);
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
