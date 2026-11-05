// Batched game server for Python training / evaluation (see train/env.py).
// Runs many games at once; seats are either "ext" (decided by the Python side) or built-in
// agents (random / greedy), which the server plays itself.
//
// Protocol. Python -> server: one JSON command per line on stdin.
//   {"cmd":"init", "num_games":256, "seed":1, "opponent":null|"random"|"greedy",
//    "total_games":null|N, "labels":false}
//      opponent null = self-play (both seats ext). Otherwise ext plays seat 0 in even-numbered
//      games and seat 1 in odd ones. total_games caps how many games are started overall
//      (null = restart finished games forever).
//   {"cmd":"step", "actions":[i0, i1, ...]}  option index for each pending decision, in order
//   {"cmd":"close"}
// Server -> Python: after init and after every step, one frame on stdout:
//   uint32le H, H bytes of JSON header, uint32le B, B bytes of body
//   header: {pending:[{g, game_id, player, k, kind}], finished:[{g, game_id, seed, ext_seats,
//            winners, reason, decisions}], obs_size, opt_size, num_cards, encoder_version, done}
//   body:   float32le obs[len(pending) * obs_size], then opts[sum(k) * opt_size]
// `g` is the slot (0..num_games-1); `game_id` increases for every game started.
import { createInterface } from 'node:readline';
import { Game } from '../src/engine/game.js';
import { makeAgent } from '../src/ai/agents.js';
import { encodeObservation, encodeOption, OBS_SIZE, OPT_SIZE, NUM_CARD_EMBEDDINGS, ENCODER_VERSION, promptKind } from '../src/ai/encode.js';

const MAX_DECISIONS = 5000;
let cfg = null, slots = [], nextGameId = 0, started = 0, finished = [];

function startGame(g) {
  if (cfg.total_games != null && started >= cfg.total_games) { slots[g] = null; return; }
  const id = nextGameId++; started++;
  const seed = (cfg.seed + id) >>> 0;
  const ext = cfg.opponent ? [id % 2 === 0, id % 2 === 1] : [true, true];
  const game = new Game({ seed, players: [{ name: 'P0', bot: true }, { name: 'P1', bot: true }] }, { keepHistory: false });
  const bots = ext.map((e, p) => (e ? null : makeAgent(cfg.opponent, seed * 31 + p)));
  slots[g] = { id, seed, ext, game, bots, decisions: 0 };
}

// Advance slot g until an ext decision is pending; restart finished games.
function settle(g) {
  for (;;) {
    const sl = slots[g]; if (!sl) return;
    const { game } = sl;
    if (!game.request || sl.decisions >= MAX_DECISIONS) {
      const s = game.state;
      finished.push({ g, game_id: sl.id, seed: sl.seed, ext_seats: sl.ext.flatMap((e, p) => (e ? [p] : [])),
        winners: s.gameOver ? s.winner.players : [], reason: s.gameOver ? s.winner.reason : 'unfinished', decisions: sl.decisions });
      startGame(g); continue;
    }
    const r = game.request;
    if (sl.ext[r.player]) return;
    game.choose(sl.bots[r.player].choose(game.view, r, r.player, game)); sl.decisions++;
  }
}

function emit() {
  const pending = [];
  for (let g = 0; g < slots.length; g++) if (slots[g]) pending.push(g);
  const K = pending.map(g => slots[g].game.request.options.length);
  const totalK = K.reduce((a, b) => a + b, 0);
  const body = new Float32Array(pending.length * OBS_SIZE + totalK * OPT_SIZE);
  let off = pending.length * OBS_SIZE;
  const meta = pending.map((g, j) => {
    const sl = slots[g]; const r = sl.game.request; const s = sl.game.view;
    body.set(encodeObservation(s, r.player, r), j * OBS_SIZE);
    for (const o of r.options) { body.set(encodeOption(s, r, o, r.player), off); off += OPT_SIZE; }
    const m = { g, game_id: sl.id, player: r.player, k: r.options.length, kind: promptKind(r.prompt) };
    if (cfg.labels) { m.prompt = r.prompt; m.options = r.options.map(o => o.id); }
    return m;
  });
  const header = Buffer.from(JSON.stringify({ pending: meta, finished, obs_size: OBS_SIZE, opt_size: OPT_SIZE,
    num_cards: NUM_CARD_EMBEDDINGS, encoder_version: ENCODER_VERSION, done: pending.length === 0 }));
  finished = [];
  const b = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const h4 = Buffer.alloc(4); h4.writeUInt32LE(header.length);
  const b4 = Buffer.alloc(4); b4.writeUInt32LE(b.length);
  process.stdout.write(Buffer.concat([h4, header, b4, b]));
}

function fail(msg) { process.stderr.write('envserver: ' + msg + '\n'); process.exit(1); }

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let c; try { c = JSON.parse(line); } catch { fail('bad JSON: ' + line.slice(0, 200)); }
  if (c.cmd === 'init') {
    cfg = { num_games: 64, seed: 1, opponent: null, total_games: null, labels: false, ...c };
    slots = []; finished = []; nextGameId = 0; started = 0;
    for (let g = 0; g < cfg.num_games; g++) startGame(g);
    for (let g = 0; g < cfg.num_games; g++) settle(g);
    emit();
  } else if (c.cmd === 'step') {
    if (!cfg) fail('step before init');
    const pending = []; for (let g = 0; g < slots.length; g++) if (slots[g]) pending.push(g);
    if (!Array.isArray(c.actions) || c.actions.length !== pending.length) fail(`expected ${pending.length} actions, got ${c.actions?.length}`);
    pending.forEach((g, j) => {
      const sl = slots[g]; const r = sl.game.request; const a = c.actions[j];
      if (!Number.isInteger(a) || a < 0 || a >= r.options.length) fail(`bad action ${a} for slot ${g} (k=${r.options.length})`);
      sl.game.choose(r.options[a].id); sl.decisions++;
      settle(g);
    });
    emit();
  } else if (c.cmd === 'close') { rl.close(); process.exit(0); }
  else fail('unknown cmd ' + c.cmd);
});
