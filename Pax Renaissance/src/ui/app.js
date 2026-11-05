import { Game } from '../engine/game.js';
import { RandomAgent, makeAgent } from '../ai/agents.js';
import { loadNet } from '../ai/nn.js';
import { ASSETS } from '../data/assets.js';
import { BOARD, EMPIRES, CITIES, CITY, BORDERS, BANKS, EMPIRE_NAMES, EAST_EMPIRES, WEST_EMPIRES, ROUTES, EMPORIA, borderBetween } from '../data/map.js';
import { CARD, tableauUnits, vassalsOf, prestigeCount, concessionsOf, emporiumBusted, isEmp, empOf, cardName, ownerOfUnit } from '../engine/state.js';
import { kingCount, republicCount, victoryMet, tradeFairPreview, religionCounts, oneShotForecast, opForecast } from '../engine/rules.js';
import { cardInfo, empireInfo, victoryInfo, locInfo } from './explain.js';

const $ = (sel) => document.querySelector(sel);
const h = (tag, cls, attrs = {}) => { const e = document.createElement(tag); if (cls) e.className = cls; Object.assign(e, attrs); return e; };
const SAVE_KEY = 'paxren-save-v1';
const GLYPH = { K: '♞', R: '♜', B: '♝' };

let game = null, seats = [], bots = [], filterRef = null, filterOpts = null, botTimer = null;

// ---------------------------------------------------------------- bots
const NET_BASE = 'models/pax-net';
const BOT_KEY = 'paxren-bot-type';
const BOT_LABEL = { search: 'neural network + search', neural: 'neural network', greedy: 'greedy', random: 'random' };
const SEARCH_SIMS = 100;
const needsNet = (t) => t === 'neural' || t === 'search';
let netPromise = null;
const getNet = () => (netPromise ||= loadNet(NET_BASE).catch((e) => { netPromise = null; throw e; }));

// Is the trained network present? Updates the setup screen's bot list.
async function checkNet() {
  const opts = [...$('#botType').querySelectorAll('option')].filter((o) => needsNet(o.value));
  try {
    const res = await fetch(NET_BASE + '.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('missing');
    const m = await res.json();
    const g = m.evals && m.evals.eval_greedy;
    $('#botNote').textContent = g != null ? `Trained network from iteration ${m.iteration + 1}: wins ${Math.round(g * 100)}% against the greedy bot on its own.` : 'Trained network loaded.';
    opts.forEach((o) => { o.disabled = false; });
  } catch {
    opts.forEach((o) => { o.disabled = true; o.textContent += ' (no model found)'; });
    if (needsNet($('#botType').value)) $('#botType').value = 'greedy';
    $('#botNote').textContent = 'No trained network in models/. Export one with: python train/export_web.py runs/ppo2/best.pt';
  }
}

// One agent per seat, in seating order (the engine reseats players so the Fugger bank goes first).
async function makeBots(g) {
  const seated = g.state.players;
  const types = seated.map((p) => (p.bot ? p.botType || 'random' : null));
  let net = null;
  if (types.some(needsNet)) {
    try { net = await getNet(); } catch (e) {
      console.error(e);
      alert(`The neural-network bot couldn't load (${e.message}). Using the greedy bot instead.`);
      types.forEach((t, i) => { if (needsNet(t)) { types[i] = 'greedy'; seated[i].botType = 'greedy'; } });
    }
  }
  return types.map((t, i) => (t ? makeAgent(t === 'search' ? 'search' + SEARCH_SIMS : t, (g.config.seed ^ (i * 2654435761)) >>> 0, { net }) : null));
}
const botLabel = (p) => BOT_LABEL[game.state.players[p]?.botType || 'random'];

// ---------------------------------------------------------------- setup
function initSetup() {
  const upd = () => {
    const bot = document.querySelector('input[name=mode]:checked').value === 'bot';
    $('#name2').value = bot ? 'Bot' : ($('#name2').value === 'Bot' ? 'Player 2' : $('#name2').value);
    $('#botrow').hidden = !bot;
  };
  document.querySelectorAll('input[name=mode]').forEach(r => r.addEventListener('change', upd));
  try { const t = localStorage.getItem(BOT_KEY); if (t) $('#botType').value = t; } catch { /* ignore */ }
  $('#botType').onchange = () => { try { localStorage.setItem(BOT_KEY, $('#botType').value); } catch { /* ignore */ } };
  checkNet();
  $('#start').onclick = () => {
    const bot = document.querySelector('input[name=mode]:checked').value === 'bot';
    const b1 = $('#bank1').value, b2 = $('#bank2').value;
    const pool = ['Fugger', 'Medici', 'Coeur', 'Marchionni'].filter(x => x !== b1 && x !== b2);
    pool.sort(() => Math.random() - 0.5);
    let banks = null;
    if (b1 || b2) { if (b1 && b1 === b2) return alert('Choose two different banks.'); banks = [b1 || pool.pop(), b2 || pool.pop()]; }
    const seed = $('#seed').value ? (parseInt($('#seed').value, 10) >>> 0) : (Math.random() * 2 ** 32) >>> 0;
    const p2 = { name: $('#name2').value || (bot ? 'Bot' : 'Player 2'), bot };
    if (bot) p2.botType = $('#botType').value;
    const players = [{ name: $('#name1').value || 'Player 1' }, p2];
    startGame(new Game({ seed, players, banks }));
  };
  const saved = localStorage.getItem(SAVE_KEY);
  if (saved) { $('#resume').hidden = false; $('#resume').onclick = () => loadRecord(JSON.parse(saved)); }
  $('#loadfile').onchange = async (ev) => { const f = ev.target.files[0]; if (f) loadRecord(JSON.parse(await f.text())); };
}
function loadRecord(rec) {
  try { startGame(Game.fromRecord(rec)); } catch (e) { console.error(e); alert('Could not load game: ' + e.message); }
}
async function startGame(g) {
  const startBtn = $('#start'); startBtn.disabled = true;
  const label = startBtn.textContent;
  if (g.state.players.some((p) => p.bot && needsNet(p.botType))) startBtn.textContent = 'Loading the neural network…';
  try { bots = await makeBots(g); } finally { startBtn.disabled = false; startBtn.textContent = label; }
  game = g;
  seats = game.state.players.map(p => (p.bot ? 'bot' : 'human'));
  $('#setup').hidden = true; $('#app').hidden = false;
  render();
}
function save() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(game.record())); } catch { /* ignore */ } }

// ---------------------------------------------------------------- elements
function cardEl(id, opts = {}) {
  const c = CARD[id];
  const [sheet, idx] = c.img; const S = ASSETS.sheets[sheet];
  const x = idx % S.cols, y = Math.floor(idx / S.cols);
  const e = h('div', 'card');
  e.style.backgroundImage = `url("${S.url}")`;
  e.style.backgroundSize = `${S.cols * 100}% ${S.rows * 100}%`;
  e.style.backgroundPosition = `${S.cols > 1 ? (x * 100) / (S.cols - 1) : 0}% ${S.rows > 1 ? (y * 100) / (S.rows - 1) : 0}%`;
  e.dataset.preview = 'card:' + id;
  if (opts.bishop) e.append(h('span', 'bishop ' + opts.bishop, { textContent: GLYPH.B }));
  return e;
}
function backEl(side) { const e = h('div', 'back'); e.style.backgroundImage = `url("${ASSETS.cardBack[side]}")`; return e; }
function empEl(s, e) {
  const E = s.empires[e];
  const el = h('div', 'empsq');
  el.style.backgroundImage = `url("${ASSETS.empires[e][E.face]}")`;
  el.dataset.preview = 'emp:' + e;
  if (E.bishop) el.append(h('span', 'bishop ' + E.bishop, { textContent: GLYPH.B }));
  const b = h('div', 'badges');
  if (E.repressed.length) b.append(miniTokens(s, E.repressed));
  el.append(b);
  return el;
}
function miniTokens(s, toks) {
  const m = h('span', 'mini');
  for (const t of toks) {
    if (t.t === 'P') { const p = h('span', 'pw'); p.style.background = BANKS[s.players[t.c].bank].css; m.append(p); }
    else m.append(h('span', 'tk ' + t.c, { textContent: GLYPH[t.t] }));
  }
  return m;
}

// registry of clickable targets for the current decision
let targets = new Map();
function reg(key, el) { if (!targets.has(key)) targets.set(key, []); targets.get(key).push(el); }
const refKey = (r) => {
  if (!r) return null;
  switch (r.type) {
    case 'market': return `market:${r.row}:${r.i}`;
    case 'holder': return isEmp(r.id) ? 'empire:' + empOf(r.id) : 'card:' + r.id;
    default: return `${r.type}:${r.id}`;
  }
};

// ---------------------------------------------------------------- render
function render() {
  if (!game) return;
  targets = new Map();
  const s = game.view;
  renderBoard(s);
  renderTableaux(s);
  renderPlayers(s);
  renderLog(s);
  renderDecision(s);
  applyTargets();
  if (previewKey && !$('#preview').hidden) buildPreview(previewKey);
  $('#status').textContent = s.gameOver ? `Game over — ${s.winner.players.map(i => s.players[i].name).join(' & ')} win (${s.winner.reason})` : `Round ${s.turnNo} · ${s.players[s.current].name} to play`;
  scheduleBot();
}

function renderBoard(s) {
  const board = $('#board');
  const avail = Math.min(window.innerHeight - 60, window.innerWidth - 380);
  const S = Math.max(560, Math.floor(avail)); const k = S / BOARD.size;
  board.style.width = board.style.height = S + 'px'; $('#tableaux').style.width = S + 'px';
  board.style.backgroundImage = `url("${ASSETS.board}")`;
  board.innerHTML = ''; const keepRoute = routeShown; routeShown = null;
  const place = (el, x, y, w, hgt) => { el.classList.add('abs'); Object.assign(el.style, { left: x * k + 'px', top: y * k + 'px', width: w * k + 'px', height: hgt * k + 'px' }); board.append(el); return el; };
  const tokSize = Math.max(16, 26 * S / 1000);

  for (const e of EMPIRES) {
    const sl = BOARD.slot(e);
    const img = h('img', 'mapcard', { src: ASSETS.maps[e][s.mapState[e]], alt: '' });
    place(img, sl.x, sl.y, sl.w, sl.h);
    const hit = place(h('div', 'slot-hit'), sl.x, sl.y, sl.w, sl.h); reg('empire:' + e, hit); hit.dataset.preview = 'loc:' + e;
  }
  // busted emporia
  for (const c of CITIES) if (c.emporium && emporiumBusted(s, c.id)) {
    const [x, y] = BOARD.cityPos(c.id);
    const d = h('div', 'busted ' + c.emporium); d.style.left = x * k + 'px'; d.style.top = y * k + 'px';
    d.style.width = d.style.height = tokSize * 1.6 + 'px'; board.append(d);
  }
  // city tokens + hit areas
  for (const c of CITIES) {
    const [x, y] = BOARD.cityPos(c.id);
    s.cities[c.id].forEach((t, i) => {
      const el = h('div', `tok ${t.c}`, { textContent: GLYPH[t.t] });
      el.style.left = (x * k + i * tokSize * 0.6) + 'px'; el.style.top = (y * k - i * tokSize * 0.3) + 'px';
      el.style.fontSize = tokSize * 0.85 + 'px'; el.style.width = el.style.height = tokSize + 'px';
      board.append(el);
    });
    const hit = h('div', 'hit'); hit.style.left = x * k + 'px'; hit.style.top = y * k + 'px'; hit.dataset.preview = 'loc:' + c.empire;
    hit.style.width = hit.style.height = tokSize * 1.6 + 'px';
    board.append(hit); reg('city:' + c.id, hit);
  }
  // borders
  for (const b of BORDERS) {
    const [x, y] = BOARD.borderPos(b.id); const B = s.borders[b.id];
    if (B.pawn !== null) {
      const el = h('div', 'tok pawn'); el.style.left = x * k + 'px'; el.style.top = y * k + 'px';
      el.style.background = BANKS[s.players[B.pawn].bank].css; el.style.width = el.style.height = tokSize * 0.75 + 'px';
      if (B.pirate) el.style.left = (x * k - tokSize * 0.45) + 'px';
      board.append(el);
    }
    if (B.pirate) {
      const el = h('div', 'tok pirate ' + B.pirate, { textContent: '⛵' }); el.style.left = (x * k + (B.pawn !== null ? tokSize * 0.45 : 0)) + 'px'; el.style.top = y * k + 'px';
      el.style.fontSize = tokSize * 0.8 + 'px'; board.append(el);
    }
    const hit = h('div', 'hit border'); hit.style.left = x * k + 'px'; hit.style.top = y * k + 'px';
    hit.style.width = hit.style.height = tokSize * 1.8 + 'px';
    board.append(hit); reg('border:' + b.id, hit);
  }
  // thrones
  for (const e of EMPIRES) {
    const t = BOARD.throne(e); const E = s.empires[e];
    const el = empEl(s, e); if (E.owner !== null) { el.classList.add('owned'); el.innerHTML = ''; }
    if (E.owner === null && E.queen) { const q = cardEl(E.queen); q.style.cssText += 'position:absolute;right:-8%;top:8%;width:38%;height:58%;'; el.append(q); }
    place(el, t.x, t.y, t.w, t.h);
    if (E.owner === null) reg('empire:' + e, el);
  }
  // victory squares
  for (const v of ['renaissance', 'globalization', 'imperial', 'holy']) {
    const [x, y] = BOARD.victory[v];
    const el = h('div', 'empsq'); el.style.backgroundImage = `url("${ASSETS.victory[v][s.victory[v] ? 'active' : 'inactive']}")`;
    el.dataset.preview = `vic:${v}:${s.victory[v] ? 'active' : 'inactive'}`;
    place(el, x, y, BOARD.victory.w, BOARD.victory.h); reg('victory:' + v, el);
  }
  // market
  for (const row of ['W', 'E']) {
    s.market[row].forEach((sl, i) => {
      const r = BOARD.market(row, i);
      let el;
      if (!sl.card) el = h('div', 'slot-hit');
      else if (sl.faceDown) { el = backEl(CARD[sl.card].side); el.classList.add('card'); el.style.cursor = 'default'; }
      else el = cardEl(sl.card);
      if (sl.florins) el.append(h('span', 'florins', { textContent: sl.florins }));
      if (i === 0) el.dataset.route = row;
      place(el, r.x, r.y, r.w, r.h); reg(`market:${row}:${i}`, el);
      if (sl.card && !sl.faceDown) reg('card:' + sl.card, el);
    });
    const d = BOARD.deck(row); const el = backEl(row); el.classList.add('card'); el.style.cursor = 'default';
    el.append(h('span', 'deckcount', { textContent: s.decks[row].length })); el.dataset.route = row;
    place(el, d.x, d.y, d.w, d.h);
  }
  if (keepRoute) showRoute(keepRoute);
  if (locShown) showLoc(locShown);
}

function visibleHand(p) {
  if (seats[p] === 'bot') return false;
  if (seats.every(x => x === 'human')) { const r = game.request; return r ? r.player === p : game.view.current === p; }
  return true;
}

function renderTableaux(s) {
  const wrap = $('#tableaux'); wrap.innerHTML = '';
  s.players.forEach((P, p) => {
    const box = h('div', 'tab');
    const hd = h('h4'); hd.style.color = BANKS[P.bank].css;
    hd.append(document.createTextNode(`${P.name} — ${P.bank}`));
    hd.append(h('span', 'tflorins', { textContent: `${P.florins} ƒ` }));
    hd.append(h('span', 'sub', { textContent: `West tableau ← player board → East tableau` }));
    box.append(hd);
    const row = h('div', 'tabrow');
    row.append(h('span', 'sidelabel', { textContent: 'WEST' }));
    const used = s.current === p ? s.turn.used : [];
    const unitEl = (key) => {
      if (isEmp(key)) {
        const e = empOf(key); const st = h('div', 'stack');
        const cp = h('div', 'couple'); const ee = empEl(s, e); if (used.includes(key)) ee.append(h('div', 'used'));
        cp.append(ee); reg('empire:' + e, ee);
        const q = s.empires[e].queen; if (q) { const qe = cardEl(q); if (used.includes(q)) qe.append(h('div', 'used')); cp.append(qe); reg('card:' + q, qe); }
        st.append(cp);
        const vs = vassalsOf(s, e);
        if (vs.length) { const vw = h('div', 'vassals'); for (const v of vs) vw.append(unitEl('EMP:' + v)); st.append(vw); }
        return st;
      }
      const ce = cardEl(key, { bishop: s.bishops[key] }); if (used.includes(key)) ce.append(h('div', 'used')); reg('card:' + key, ce); return ce;
    };
    for (const key of P.west.slice().reverse()) row.append(unitEl(key));
    const pl = h('div', 'placard'); pl.style.backgroundImage = `url("${ASSETS.placards[P.bank]}")`; pl.dataset.preview = 'placard:' + P.bank;
    row.append(pl);
    for (const key of P.east) row.append(unitEl(key));
    row.append(h('span', 'sidelabel', { textContent: 'EAST' }));
    box.append(row);
    const hand = h('div', 'hand');
    hand.append(h('span', 'label', { textContent: 'Hand' }));
    if (visibleHand(p)) P.hand.forEach(k => { const c = cardEl(k); reg('card:' + k, c); hand.append(c); });
    else P.hand.forEach(k => hand.append(backEl(CARD[k].side)));
    if (!P.hand.length) hand.append(h('span', 'sub', { textContent: '(empty)' }));
    if (P.oldMaids.length) {
      hand.append(h('span', 'sep')); hand.append(h('span', 'label', { textContent: 'Old Maids' }));
      const m = h('div', 'maids'); P.oldMaids.forEach(k => { const c = cardEl(k); reg('card:' + k, c); m.append(c); }); hand.append(m);
    }
    box.append(hand);
    wrap.append(box);
  });
}

function renderPlayers(s) {
  const w = $('#players'); w.innerHTML = '';
  s.players.forEach((P, p) => {
    const d = h('div', 'pl' + (s.current === p ? ' active' : '')); d.style.borderLeftColor = BANKS[P.bank].css;
    d.append(h('span', 'nm', { textContent: `${P.name}${seats[p] === 'bot' ? ' 🤖' : ''}`, title: seats[p] === 'bot' ? `Bot: ${botLabel(p)}` : '' }));
    d.append(h('span', '', { textContent: `${P.florins} ƒ` }));
    const PN = { catholic: 'Catholic', islamic: 'Muslim', reformist: 'Reformist', law: 'Law', discovery: 'Discovery', patron: 'Patron' };
    const pr = Object.keys(PN).map(x => `${PN[x]} ${prestigeCount(s, p, x)}`).join(' · ');
    d.append(h('span', 'stats', { textContent: `${P.bank} · hand ${P.hand.length} · concessions ${concessionsOf(s, p)} · pawns left ${P.pawns} · kings ${kingCount(s, p)} · republics ${republicCount(s, p)}` }));
    d.append(h('span', 'stats', { textContent: `Prestige: ${pr}` }));
    const met = ['holy', 'imperial', 'globalization', 'renaissance'].filter(v => victoryMet(s, p, v));
    if (met.length) d.append(h('span', 'stats', { textContent: `Meets: ${met.join(', ')}${met.some(v => s.victory[v]) ? '' : ' (not active)'}` }));
    w.append(d);
  });
}

let lastLogLen = 0;
function renderLog(s) {
  const w = $('#log'); w.innerHTML = '';
  for (const l of s.log.slice(-250)) {
    const cls = l.startsWith('---') ? 'turn' : (l.startsWith('***') || l.includes('REGIME CHANGE') || l.includes('APOSTASY') ? 'big' : '');
    w.append(h('div', cls, { textContent: l }));
  }
  if (s.log.length !== lastLogLen) { w.scrollTop = w.scrollHeight; lastLogLen = s.log.length; }
}

function renderDecision(s) {
  const w = $('#decision'); w.innerHTML = '';
  const r = game.request;
  if (!r) {
    w.append(h('h3', '', { textContent: 'Game over' }));
    if (s.winner) w.append(h('div', '', { textContent: `${s.winner.players.map(i => s.players[i].name).join(' & ')} win by ${s.winner.reason}.` }));
    const b = h('button', 'primary', { textContent: 'New game' }); b.onclick = newGame; w.append(b);
    return;
  }
  w.append(h('h3', '', { textContent: r.prompt }));
  w.append(h('div', 'who', { textContent: `Decision for ${s.players[r.player].name}${seats[r.player] === 'bot' ? ` (${botLabel(r.player)} bot)` : ''}` }));
  if (seats[r.player] === 'bot') { w.append(h('div', 'thinking', { textContent: 'Bot is thinking…' })); return; }
  let opts = r.options;
  if (filterRef) {
    opts = filterOpts ? opts.filter(o => filterOpts.includes(o.id)) : opts.filter(o => refKey(o.ref) === filterRef);
    if (!opts.length) { filterRef = null; opts = r.options; }
    else { const c = h('button', '', { textContent: '← show all options' }); c.onclick = () => { filterRef = null; filterOpts = null; render(); }; w.append(c); }
  }
  const box = h('div', 'opts');
  for (const o of opts) {
    const b = h('button', '', { textContent: o.label }); b.onclick = () => pick(o.id);
    b.onmouseenter = () => hover(o, true); b.onmouseleave = () => hover(o, false);
    if (/^fair:[WE]$/.test(o.id)) b.dataset.route = o.id.slice(5);
    box.append(b);
  }
  w.append(box);
}
function hover(o, on) { const k = refKey(o.ref); if (!k) return; for (const el of targets.get(k) || []) el.style.outlineColor = on ? '#fff' : ''; }

function applyTargets() {
  const r = game.request; if (!r || seats[r.player] === 'bot') return;
  const byKey = new Map();
  const add = (k, o) => { if (!byKey.has(k)) byKey.set(k, []); if (!byKey.get(k).includes(o)) byKey.get(k).push(o); };
  for (const o of r.options) { const k = refKey(o.ref); if (k) add(k, o); }
  if (r.main) {
    // clicking one of your tableau cards offers that side's Ops as well as selling it
    for (const u of tableauUnits(game.view, r.player)) {
      const k = u.kind === 'empire' ? 'empire:' + u.empire : 'card:' + u.key;
      for (const o of r.options) if (o.id === 'ops:' + u.side || o.id === 'ops:WE') add(k, o);
    }
  }
  for (const [k, os] of byKey) for (const el of targets.get(k) || []) {
    el.classList.add('target');
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const risky = r.main && os.some(o => o.id.startsWith('sell:'));
      if (os.length === 1 && !risky) pick(os[0].id); else { filterRef = k; filterOpts = os.map(o => o.id); render(); }
    });
  }
}

function pick(id) {
  filterRef = null; filterOpts = null; clearRoute();
  try { game.choose(id); } catch (e) { console.error(e); alert('Error: ' + e.message); }
  save(); render();
}
function scheduleBot() {
  clearTimeout(botTimer);
  const r = game.request; if (!r || seats[r.player] !== 'bot') return;
  botTimer = setTimeout(async () => {
    const g = game;
    const id = await bots[r.player].choose(g.view, r, r.player, g);
    if (g !== game || g.request !== r) return; // the game changed meanwhile (undo, new game)
    pick(id);
  }, r.main ? 700 : 350);
}

// ---------------------------------------------------------------- preview / modal
function infoBox(rows) {
  const box = h('div', 'info');
  for (const row of rows) {
    const [kind, a, b] = row;
    if (kind === 'table') {
      const tb = h('table', 'itable'); const thr = h('tr'); a.forEach(x => thr.append(h('th', '', { textContent: x }))); tb.append(thr);
      b.forEach((r, i) => { const tr = h('tr', i === row[3] ? 'hi' : ''); r.forEach(x => tr.append(h('td', '', { textContent: x }))); tb.append(tr); });
      box.append(tb); continue;
    }
    if (kind === 'head') box.append(h('div', 'ihead', { textContent: a }));
    else if (kind === 'sub') box.append(h('div', 'isub', { textContent: a }));
    else if (kind === 'p') box.append(h('div', 'ip', { textContent: a }));
    else if (kind === 'list') { box.append(h('div', 'ltitle', { textContent: a })); for (const [t, open] of b) box.append(h('div', 'litem' + (open ? ' open' : ''), { textContent: t })); }
    else if (kind === 'section') { const d = h('div', 'isec ' + a); d.append(h('span', 'sname', { textContent: b })); d.append(h('span', 'shint', { textContent: row[3] })); box.append(d); }
    else { const d = h('div', 'irow ' + kind); d.append(h('b', '', { textContent: a })); d.append(h('span', '', { textContent: b })); box.append(d); }
  }
  return box;
}
// the player from whose point of view hover forecasts are computed
function viewer() {
  const r = game.request;
  if (r && seats[r.player] === 'human') return r.player;
  const h0 = seats.indexOf('human'); return seats.every(x => x === 'human') ? game.view.current : (h0 >= 0 ? h0 : game.view.current);
}
// wrap the words Catholic / Muslim / Reformist in spans coloured gold / green / red
function colorizeReligions(root) {
  const cls = { Catholic: 'rel-C', Muslim: 'rel-I', Reformist: 'rel-R' };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const nodes = [];
  while (walker.nextNode()) if (/Catholic|Muslim|Reformist/.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const frag = document.createDocumentFragment();
    for (const part of n.nodeValue.split(/(Catholic|Muslim|Reformist)/)) {
      if (cls[part]) frag.append(h('span', cls[part], { textContent: part })); else if (part) frag.append(document.createTextNode(part));
    }
    n.replaceWith(frag);
  }
}
// colour each Op row green/red by whether it could do something if activated right now
function markOps(rows, key) {
  let i = 0;
  for (const r of rows) {
    if (r[0] !== 'op') continue;
    const f = opForecast(game.view, viewer(), key, i++);
    if (!f) continue;
    r[0] = 'op ' + (f.ok ? 'opok' : 'opno');
    r[1] = `${r[1]} — ${f.ok ? '✓' : '✕'} ${f.reason}`;
  }
}
const cardInPlay = (s, id) => ownerOfUnit(s, id) !== null || s.players.some(P => P.oldMaids.includes(id));
let previewKey = null;
document.addEventListener('mouseover', (ev) => {
  if (!game) return;
  const rt = ev.target.closest('[data-route]');
  const pc = ev.target.closest('[data-preview^="card:"]');
  const pcId = pc && pc.dataset.preview.slice(5);
  const os = pc && !cardInPlay(game.view, pcId) && CARD[pcId].oneShot;
  if (rt) showRoute(rt.dataset.route);
  else if (os && os.type === 'trade_shift') showRoute((EMPORIA.black.includes(os.emporium) ? 'E' : 'W') + '>' + os.emporium);
  else clearRoute();
  const t = ev.target.closest('[data-preview]'); const pv = $('#preview');
  if (!t) { pv.hidden = true; previewKey = null; clearLoc(); return; }
  if (previewKey === t.dataset.preview && !pv.hidden) return;
  buildPreview(t.dataset.preview);
  positionPreview(ev);
});
function buildPreview(key) {
  const pv = $('#preview');
  previewKey = key;
  const [kind, a] = key.split(':');
  pv.innerHTML = '';
  const s = game.view;
  clearLoc();
  if (kind === 'card') {
    const rows = cardInfo(CARD[a], EMPIRES.find(e => s.empires[e].queen === a) || null);
    const os = CARD[a].oneShot;
    for (const row of ['W', 'E']) for (const sl of s.market[row]) {
      if (sl.card === a && !sl.faceDown && sl.florins) rows[1] = ['sub', `${rows[1][1]} · ${sl.florins} florin${sl.florins === 1 ? '' : 's'} on this card`];
    }
    const inPlay = cardInPlay(s, a);
    if (os && os.type === 'trade_shift' && !inPlay) {
      if (routeSummary) rows.push(['route', 'Trade shift preview (map)', routeSummary.join(String.fromCharCode(10))]);
      else rows.push(['p', `${CITY[os.emporium].name || os.emporium} is already the open Emporium, so this trade shift would change nothing.`]);
    }
    // once a card is in play (Tableau, royal couple or Old Maid) its One-shot and Agents are spent
    if (inPlay) for (const r of rows) {
      if (r[0] === 'section' && r[1] === 'os') { r[1] = 'os spent'; r[3] = 'already played — no longer applies'; }
      else if (r[0] === 'os' || r[0] === 'agents') r[0] += ' spent';
    }
    const fc = inPlay ? null : oneShotForecast(s, viewer(), a);
    if (fc) {
      const i = rows.findIndex(r => r[0] === 'os'); const lines = Object.entries(fc.byEmpire).map(([e, x]) => `${x.status === 'green' ? '●' : x.status === 'yellow' ? '◐' : '✕'} ${EMPIRE_NAMES[e]}: ${x.text}`);
      const label = fc.kind === 'effect'
        ? { green: 'If played now: has an effect', red: 'If played now: no effect / cannot trigger' }[fc.overall]
        : { green: 'If played now: causes a regime change', yellow: 'If played now: happens, but no regime change', red: 'If played now: cannot be triggered' }[fc.overall];
      if (i >= 0) { rows[i] = ['os ' + fc.overall, rows[i][1], rows[i][2]]; rows.splice(i + 1, 0, ['fc ' + fc.overall, `${label} (for ${s.players[viewer()].name})`, lines.join('\n')]); }
    }
    markOps(rows, a);
    pv.append(cardEl(a)); pv.append(infoBox(rows)); showLoc(cardRegion(s, a, fc));
  }
  else if (kind === 'emp') { showLoc({ empires: [a], cities: [] }); const e = h('div', 'empsq'); e.style.backgroundImage = `url("${ASSETS.empires[a][s.empires[a].face]}")`; pv.append(e); const er = empireInfo(s, a); markOps(er, 'EMP:' + a); pv.append(infoBox(er)); }
  else if (kind === 'vic') {
    const e = h('div', 'empsq'); e.style.backgroundImage = `url("${ASSETS.victory[a][s.victory[a] ? 'active' : 'inactive']}")`; pv.append(e);
    const box = infoBox(victoryInfo(s, a)); if (a === 'holy') colorizeReligions(box); pv.append(box);
  }
  else if (kind === 'loc') { showLoc({ empires: [a], cities: [], pieces: true }); markAffecting(s, a); const box = infoBox(locInfo(s, a)); box.classList.add('small'); colorizeReligions(box); pv.append(box); }
  else if (kind === 'placard') { const e = h('div', 'placard'); e.style.backgroundImage = `url("${ASSETS.placards[a]}")`; pv.append(e); }
  pv.hidden = false;
}
document.addEventListener('mousemove', (ev) => { if (!$('#preview').hidden) positionPreview(ev); });
function positionPreview(ev) {
  const pv = $('#preview'); const r = pv.getBoundingClientRect(); const pad = 18;
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + r.width > window.innerWidth - 4) x = ev.clientX - pad - r.width;
  if (x < 4) x = 4;
  if (y + r.height > window.innerHeight - 4) y = window.innerHeight - 4 - r.height;
  if (y < 4) y = 4;
  pv.style.left = x + 'px'; pv.style.top = y + 'px';
}

// ---------------------------------------------------------------- card region highlight
function cardRegion(s, id, fc = null) {
  const c = CARD[id]; let empires = [];
  if (c.suitors) { const m = EMPIRES.find(e => s.empires[e].queen === id); empires = m ? [m] : c.suitors; }
  else if (c.loc === 'East') empires = EAST_EMPIRES;
  else if (c.loc === 'West') empires = WEST_EMPIRES;
  else if (c.loc) empires = [c.loc];
  const cities = c.oneShot?.type === 'trade_shift' ? [c.oneShot.emporium] : [];
  const status = fc ? Object.fromEntries(Object.entries(fc.byEmpire).map(([e, x]) => [e, x.status])) : {};
  return { empires, cities, status };
}
let locShown = null;
function clearLoc() {
  locShown = null; const o = document.getElementById('locOverlay'); if (o) o.remove();
  document.querySelectorAll('.affects').forEach(el => el.classList.remove('affects'));
}
// cards (market, tableaux, hand) and empire squares whose Location includes Empire e
function cardAffects(s, id, e) {
  const c = CARD[id]; if (c.comet) return false;
  if (c.suitors) { const m = EMPIRES.find(x => s.empires[x].queen === id); return m ? m === e : c.suitors.includes(e); }
  return c.loc === e || (c.loc === 'East' && EAST_EMPIRES.includes(e)) || (c.loc === 'West' && WEST_EMPIRES.includes(e));
}
function markAffecting(s, e) {
  document.querySelectorAll('[data-preview^="card:"]').forEach(el => { if (!el.closest('#preview') && cardAffects(s, el.dataset.preview.slice(5), e)) el.classList.add('affects'); });
  document.querySelectorAll(`[data-preview="emp:${e}"]`).forEach(el => { if (!el.closest('#preview')) el.classList.add('affects'); });
  document.querySelectorAll('.board .empsq').forEach(el => { if (el.style.backgroundImage.includes(ASSETS.empires[e].king) || el.style.backgroundImage.includes(ASSETS.empires[e].republic)) el.classList.add('affects'); });
}
function showLoc(region) {
  const { empires, cities } = region; region.status = region.status || {};
  if (!empires.length && !cities.length) return;
  locShown = region; const old = document.getElementById('locOverlay'); if (old) old.remove();
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg'); svg.id = 'locOverlay';
  svg.setAttribute('class', 'routeOverlay'); svg.setAttribute('viewBox', `0 0 ${BOARD.size} ${BOARD.size}`);
  const el = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); svg.append(e); return e; };
  for (const e of EMPIRES) if (!empires.includes(e)) { const r = BOARD.slot(e); el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: '#000000', opacity: 0.45 }); }
  const COL = { green: '#3ee66b', yellow: '#ffd23c', red: '#ff4a3d' };
  for (const e of empires) {
    const r = BOARD.slot(e); const c = COL[(region.status || {})[e]] || '#46e0ff';
    el('rect', { x: r.x + 8, y: r.y + 8, width: r.w - 16, height: r.h - 16, rx: 26, fill: c + '22', stroke: c, 'stroke-width': 24 });
    const t = BOARD.throne(e); el('rect', { x: t.x, y: t.y, width: t.w, height: t.h, rx: 20, fill: 'none', stroke: c, 'stroke-width': 18 });
  }
  for (const c of cities) { const [x, y] = BOARD.cityPos(c); el('circle', { cx: x, cy: y, r: 120, fill: 'none', stroke: '#ffffff', 'stroke-width': 26 }); }
  if (region.pieces) { // ring every piece in the Empire's cities and on its borders
    const s = game.view;
    for (const e of empires) {
      for (const id of CITIES.filter(c => c.empire === e).map(c => c.id)) if (s.cities[id].length) { const [x, y] = BOARD.cityPos(id); el('circle', { cx: x, cy: y, r: 105, fill: '#ff9d1c33', stroke: '#ff9d1c', 'stroke-width': 20 }); }
      for (const b of BORDERS.filter(b => b.a === e || b.b === e)) { const B = s.borders[b.id]; if (B.pawn !== null || B.pirate) { const [x, y] = BOARD.borderPos(b.id); el('circle', { cx: x, cy: y, r: 105, fill: '#ff9d1c33', stroke: '#ff9d1c', 'stroke-width': 20 }); } }
    }
  }
  $('#board').append(svg);
}

// ---------------------------------------------------------------- trade route highlight
let routeShown = null;
let routeSummary = null;
let routeLock = false;
function clearRoute() { if (routeLock) return; routeShown = null; routeSummary = null; const o = document.getElementById('routeOverlay'); if (o) o.remove(); }
// key = 'W' | 'E' for the current route, or 'W>SpiceIslands' to preview the route after a trade shift
function routePoints(emp) {
  const r = ROUTES[emp]; const pts = [BOARD.cityPos(emp)];
  for (let i = 1; i < r.length; i++) pts.push(BOARD.borderPos(borderBetween(r[i - 1], r[i]).id));
  const end = BOARD.slot(r[r.length - 1]); pts.push([end.x + end.w / 2, end.y + end.h / 2]);
  return pts;
}
function showRoute(key) {
  if (!game || routeShown === key) return;
  clearRoute(); routeShown = key;
  const [row, shiftTo] = key.split('>');
  const color = row === 'W' ? 'white' : 'black';
  let s = game.view; const board = $('#board');
  const oldEmp = s.activeEmporium[color];
  if (shiftTo) {
    if (oldEmp === shiftTo) { routeShown = null; return; } // already open: nothing changes
    s = { ...s, activeEmporium: { ...s.activeEmporium, [color]: shiftTo } };
  } else if (!s.market[row][0].card) return;
  const pv = tradeFairPreview(s, s.current, row);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg'); svg.id = 'routeOverlay';
  svg.setAttribute('class', 'routeOverlay'); svg.setAttribute('viewBox', `0 0 ${BOARD.size} ${BOARD.size}`);
  const el = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [a, v] of Object.entries(attrs)) e.setAttribute(a, v); if (text !== undefined) e.textContent = text; svg.append(e); return e; };
  const col = row === 'W' ? '#7fe9ff' : '#ffae42';
  // arrowhead markers (one per colour), placed at every border crossing and at the route's end
  const defs = el('defs', {});
  const marker = (id, fill, size) => {
    const m = document.createElementNS(NS, 'marker');
    for (const [a, v] of Object.entries({ id, viewBox: '0 0 10 10', refX: 6, refY: 5, markerWidth: size, markerHeight: size, markerUnits: 'userSpaceOnUse', orient: 'auto' })) m.setAttribute(a, v);
    const pth = document.createElementNS(NS, 'path'); pth.setAttribute('d', 'M0,0 L10,5 L0,10 L2.5,5 z'); pth.setAttribute('fill', fill);
    pth.setAttribute('stroke', '#000'); pth.setAttribute('stroke-width', '0.6'); m.append(pth); defs.append(m);
    return `url(#${id})`;
  };
  const arrLive = marker('arrLive', col, 190), arrDim = marker('arrDim', col + '99', 150), arrOld = marker('arrOld', '#9a9a9a', 150);
  const arrows = (m) => ({ 'marker-mid': m, 'marker-end': m });
  if (shiftTo) { // old route in grey
    const op = routePoints(oldEmp);
    el('polyline', { points: op.map(q => q.join(',')).join(' '), fill: 'none', stroke: '#000a', 'stroke-width': 56, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    el('polyline', { points: op.map(q => q.join(',')).join(' '), fill: 'none', stroke: '#9a9a9a', 'stroke-width': 30, 'stroke-dasharray': '70 40', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', ...arrows(arrOld) });
    const [ox, oy] = BOARD.cityPos(oldEmp);
    el('text', { x: ox, y: oy - 140, 'text-anchor': 'middle', class: 'rtext', fill: '#bbb' }, 'BUSTED');
  }
  // empires on the route: levy (gold), saturated (grey dashed), not reached (dimmed)
  for (const e of pv.route) {
    const r = BOARD.slot(e); const lev = pv.levies.includes(e); const room = pv.levyRoom[e];
    el('rect', { x: r.x + 10, y: r.y + 10, width: r.w - 20, height: r.h - 20, rx: 30,
      fill: lev ? (room ? '#ffd84a1f' : '#8888881f') : '#00000066', stroke: lev ? (room ? '#ffd84a' : '#aaa') : 'none',
      'stroke-width': 18, 'stroke-dasharray': lev && !room ? '40 30' : 'none' });
    if (lev) el('text', { x: r.x + r.w / 2, y: r.y + (r.y < 2000 ? 230 : r.h - 160), 'text-anchor': 'middle', class: 'rtext', fill: room ? '#ffd84a' : '#ccc' }, room ? 'LEVY' : 'FULL');
  }
  // path: emporium -> each border crossed -> end of route
  const pts = [BOARD.cityPos(pv.emporium)];
  pv.steps.forEach(st => pts.push(BOARD.borderPos(st.border)));
  const end = BOARD.slot(pv.route[pv.route.length - 1]); pts.push([end.x + end.w / 2, end.y + end.h / 2]);
  const firstUnreached = pv.steps.findIndex(st => st.kind === 'unreached');
  const lastReached = firstUnreached < 0 ? pts.length : firstUnreached + 1; // number of points on the live part
  const line = (P, attrs) => P.length > 1 && el('polyline', { points: P.map(q => q.join(',')).join(' '), fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', ...attrs });
  line(pts, { stroke: '#000a', 'stroke-width': 70 });
  line(pts.slice(0, lastReached), { stroke: col, 'stroke-width': 40, opacity: 0.95, ...arrows(arrLive) });
  if (lastReached < pts.length) line(pts.slice(lastReached - 1), { stroke: col, 'stroke-width': 24, 'stroke-dasharray': '50 50', opacity: 0.6, ...arrows(arrDim) });
  el('circle', { cx: pts[0][0], cy: pts[0][1], r: 95, fill: 'none', stroke: col, 'stroke-width': 26 });
  // who gets paid along the way
  for (const st of pv.steps) {
    const [x, y] = BOARD.borderPos(st.border);
    if (st.kind === 'pawn') {
      const c = BANKS[s.players[st.player].bank].css;
      el('circle', { cx: x, cy: y, r: 100, fill: 'none', stroke: c, 'stroke-width': 28 });
      el('text', { x, y: y - 130, 'text-anchor': 'middle', class: 'rtext', fill: c }, `+${st.amount}`);
    } else if (st.kind === 'pirate') {
      el('circle', { cx: x, cy: y, r: 100, fill: 'none', stroke: '#ff4040', 'stroke-width': 28 });
      el('text', { x, y: y - 130, 'text-anchor': 'middle', class: 'rtext', fill: '#ff6060' }, 'pirate −1');
    }
    if (st.border === pv.endsAt) el('text', { x, y: y + 210, 'text-anchor': 'middle', class: 'rtext', fill: '#fff' }, 'END');
  }
  // summary
  const pays = pv.steps.filter(st => st.kind === 'pawn').map(st => `${s.players[st.player].name} +${st.amount}`);
  const pir = pv.steps.filter(st => st.kind === 'pirate').length;
  const lines = [
    `${shiftTo ? 'After trade shift — ' : ''}${row === 'W' ? 'Western' : 'Eastern'} trade fair from ${CITY[pv.emporium].name || pv.emporium}${shiftTo ? ` (was ${CITY[oldEmp].name || oldEmp}, now grey)` : ''}: ${pv.profits} profit${pv.profits === 1 ? '' : 's'} if convened now`,
    `${s.players[s.current].name} (initiator) +1${pays.length ? ' · ' + pays.join(' · ') : ''}${pir ? ` · pirates take ${pir}` : ''}`,
    `Levies: ${pv.levies.length ? pv.levies.map(e => EMPIRE_NAMES[e] + (pv.levyRoom[e] ? '' : ' (full)')).join(', ') : 'none'}${pv.leftover ? ` · ${pv.leftover} left over` : ''}`];
  routeSummary = shiftTo ? lines : null;
  if (!shiftTo) { // trade-shift summaries go into the card popup instead, so the popup can't cover them
    const bx = 1600, by = 3330;
    el('rect', { x: bx, y: by - 60, width: 3780, height: 80 + lines.length * 110, rx: 30, fill: '#000d', stroke: col, 'stroke-width': 10 });
    lines.forEach((t, i) => el('text', { x: bx + 50, y: by + 50 + i * 110, class: 'rsum', fill: i ? '#eee' : col }, t));
  }
  board.append(svg);
}

function modal(content) {
  const m = $('#modal'); m.innerHTML = ''; const b = h('div', 'box'); b.append(content); m.append(b); m.hidden = false;
  m.onclick = () => { m.hidden = true; };
}

function newGame() { if (!game || game.state.gameOver || confirm('Abandon the current game?')) { clearTimeout(botTimer); $('#app').hidden = true; $('#setup').hidden = false; initResume(); } }
function initResume() { const saved = localStorage.getItem(SAVE_KEY); $('#resume').hidden = !saved; }

$('#btnUndo').onclick = () => {
  clearTimeout(botTimer); filterRef = null;
  let guard = 0;
  game.undo();
  while (game.request && seats[game.request.player] === 'bot' && guard++ < 500 && game.undo());
  save(); render();
};
$('#btnSave').onclick = () => {
  const blob = new Blob([JSON.stringify(game.record())], { type: 'application/json' });
  const a = h('a', '', { href: URL.createObjectURL(blob), download: `paxren-${Date.now()}.json` }); a.click();
};
$('#btnNew').onclick = newGame;
$('#btnAid').onclick = () => modal(h('img', 'aid', { src: 'assets/player-aid.png', alt: 'Player aid' }));
window.addEventListener('resize', () => game && render());
initSetup();

// ?demo=N[&seed=S][&bot=neural|greedy|random] : start a vs-bot game and fast-forward N random decisions (for testing).
const qs = new URLSearchParams(location.search);
if (qs.has('demo')) {
  const g = new Game({ seed: +(qs.get('seed') || 1), players: [{ name: 'You' }, { name: 'Bot', bot: true, botType: qs.get('bot') || 'random' }] });
  const rnd = new RandomAgent(+(qs.get('seed') || 1) + 99);
  for (let i = 0; i < +qs.get('demo') && g.request; i++) g.choose(rnd.choose(g.view, g.request));
  startGame(g);
}
// test hooks: &route=W|E simulates hovering a trade route; &hover=x,y dispatches a mouseover at that point
if (qs.has('route')) { showRoute(qs.get('route')); routeLock = true; }
if (qs.has('hover')) setTimeout(() => {
  const els = [...document.querySelectorAll(qs.get('hover'))]; const t = els[+(qs.get('n') || 0)];
  const rc = t ? t.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 }; const x = rc.left + rc.width / 2, y = rc.top + rc.height / 2;
  if (t) t.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
}, 1500);
