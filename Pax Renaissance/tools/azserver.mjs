// Game-tree server for alpha-zero-general (see paxrenaissance/PaxBridge.py at the repo root).
//
// Unlike envserver.mjs (which steps many live games forward), this server keeps a store of
// immutable game-tree nodes so MCTS can branch from any position: stepping a node creates a new
// child node and leaves the parent untouched. A node is (unit-start checkpoint, answers within
// the unit), exactly what the Game controller replays, so nodes share checkpoint objects.
//
// Protocol. Python -> server: one JSON command per line on stdin.
//   {"cmd":"new", "seed":S, "max_decisions":3000}     new game              -> node frame
//   {"cmd":"step", "id":N, "a":i}                     apply option i of N   -> node frame
//   {"cmd":"determinize", "id":N, "seed":R, "tries":8}
//        copy of N with everything the player to move cannot know re-dealt (deck order,
//        never-seen face-down cards, RNG). The copy is checked to look identical to the mover
//        (same observation and option list); if no try passes, N itself is returned.
//                                                     -> node frame
//   {"cmd":"encode", "id":N}                          -> node frame with body
//   {"cmd":"labels", "id":N}                          -> JSON frame {prompt, options:[label]}
//   {"cmd":"free", "ids":[...]}                       drop nodes (no reply)
//   {"cmd":"close"}
// "new", "step" and "determinize" take an optional "encode":true to include the body; without it
// the node frame has an empty body (MCTS only needs encodings at the leaves it expands).
// Server -> Python: one frame per command (except free):
//   uint32le H, H bytes of JSON header, uint32le B, B bytes of body
//   node header: {id, player, k, ended, winners, reason, decisions, key, obs_size, opt_size,
//                 num_cards, encoder_version}
//     player: seat (0/1) to move; for an ended game, the seat that made the last decision.
//     key:    hash of the position (checkpoint + answers), for MCTS transposition tables.
//   node body: float32le obs[obs_size], then opts[k * opt_size] (obs all zero when ended)
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { Game } from '../src/engine/game.js';
import { determinize, makeRng } from '../src/ai/determinize.js';
import { encodeObservation, encodeOption, OBS_SIZE, OPT_SIZE, NUM_CARD_EMBEDDINGS, ENCODER_VERSION } from '../src/ai/encode.js';

const nodes = new Map();   // id -> node
const children = new Map(); // `${id}:${a}` -> child id (so re-stepping an edge reuses the node)
let nextId = 1;

// Build a controller positioned at (checkpoint, answers) without re-running setup.
function controller(state, answers) {
  const g = Object.create(Game.prototype);
  Object.assign(g, { config: null, keepHistory: false, state, answers, units: [], history: [], view: null, request: null });
  g.advance();
  return g;
}

function makeNode(state, answers, { decisions, maxDecisions, lastMover }) {
  const g = controller(state, answers);
  const n = { state: g.state, answers: g.answers, request: g.request, view: g.view, decisions, maxDecisions, lastMover };
  n.ended = !n.request || decisions >= maxDecisions;
  n.player = n.request && !n.ended ? n.request.player : lastMover;
  n.obs = n.ended ? new Float32Array(OBS_SIZE) : encodeObservation(n.view, n.player, n.request);
  return n;
}

function keyOf(n) {
  const h = createHash('sha1');
  h.update(JSON.stringify(n.state, (k, v) => (k === 'log' ? undefined : v)));
  h.update('|' + n.answers.join('\u0001'));
  if (n.ended) h.update('|end');
  return h.digest('base64');
}

function store(n) { const id = nextId++; nodes.set(id, n); return id; }

function get(id) {
  const n = nodes.get(id);
  if (!n) fail(`unknown node ${id} (freed?)`);
  return n;
}

function frame(header, body) {
  const hb = Buffer.from(JSON.stringify(header));
  const bb = body ? Buffer.from(body.buffer, body.byteOffset, body.byteLength) : Buffer.alloc(0);
  const h4 = Buffer.alloc(4); h4.writeUInt32LE(hb.length);
  const b4 = Buffer.alloc(4); b4.writeUInt32LE(bb.length);
  process.stdout.write(Buffer.concat([h4, hb, b4, bb]));
}

function emitNode(id, withBody) {
  const n = get(id);
  const k = n.ended ? 0 : n.request.options.length;
  let body = null;
  if (withBody) {
    body = new Float32Array(OBS_SIZE + k * OPT_SIZE);
    body.set(n.obs, 0);
    for (let i = 0; i < k; i++) body.set(encodeOption(n.view, n.request, n.request.options[i], n.player), OBS_SIZE + i * OPT_SIZE);
  }
  if (n.key === undefined) n.key = keyOf(n);
  const s = n.state;
  frame({ id, player: n.player, k, ended: n.ended, winners: s.gameOver ? s.winner.players : [],
    reason: s.gameOver ? s.winner.reason : (n.ended ? 'unfinished' : null), decisions: n.decisions, key: n.key,
    obs_size: OBS_SIZE, opt_size: OPT_SIZE, num_cards: NUM_CARD_EMBEDDINGS, encoder_version: ENCODER_VERSION }, body);
}

function sameToMover(a, b) {
  if (a.ended !== b.ended || a.player !== b.player) return false;
  if (a.ended) return true;
  const oa = a.request.options, ob = b.request.options;
  if (oa.length !== ob.length || oa.some((o, i) => o.id !== ob[i].id)) return false;
  for (let i = 0; i < a.obs.length; i++) if (a.obs[i] !== b.obs[i]) return false;
  return true;
}

function fail(msg) { process.stderr.write('azserver: ' + msg + '\n'); process.exit(1); }

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let c; try { c = JSON.parse(line); } catch { fail('bad JSON: ' + line.slice(0, 200)); }
  switch (c.cmd) {
    case 'new': {
      const seed = (c.seed ?? (Date.now() >>> 0)) >>> 0;
      const g = new Game({ seed, players: [{ name: 'P0', bot: true }, { name: 'P1', bot: true }] }, { keepHistory: false });
      const n = makeNode(g.state, g.answers, { decisions: 0, maxDecisions: c.max_decisions ?? 3000, lastMover: 0 });
      emitNode(store(n), !!c.encode);
      break;
    }
    case 'step': {
      const p = get(c.id);
      if (p.ended) fail(`step on ended node ${c.id}`);
      const opts = p.request.options;
      if (!Number.isInteger(c.a) || c.a < 0 || c.a >= opts.length) fail(`bad action ${c.a} for node ${c.id} (k=${opts.length})`);
      const ck = `${c.id}:${c.a}`;
      let id = children.get(ck);
      if (id === undefined || !nodes.has(id)) {
        id = store(makeNode(p.state, p.answers.concat([opts[c.a].id]),
          { decisions: p.decisions + 1, maxDecisions: p.maxDecisions, lastMover: p.player }));
        children.set(ck, id);
      }
      emitNode(id, !!c.encode);
      break;
    }
    case 'determinize': {
      const p = get(c.id);
      let out = c.id;
      if (!p.ended) {
        const rnd = makeRng(c.seed ?? 1);
        for (let t = 0; t < (c.tries ?? 8); t++) {
          let n;
          try { n = makeNode(determinize(p.state, p.player, rnd), p.answers, p); }
          catch { continue; } // an earlier answer in this unit is illegal in the re-dealt world
          if (sameToMover(p, n)) { out = store(n); break; }
        }
      }
      emitNode(out, !!c.encode);
      break;
    }
    case 'encode': emitNode(c.id, true); break;
    case 'labels': {
      const n = get(c.id);
      frame(n.ended ? { prompt: null, options: [], log: n.state.log.slice(-5) }
        : { prompt: n.request.prompt, options: n.request.options.map(o => o.label ?? o.id), log: n.view.log.slice(-5) }, null);
      break;
    }
    case 'free': {
      for (const id of c.ids || []) nodes.delete(id);
      if (children.size > 4 * nodes.size + 100000) for (const [k, v] of children) if (!nodes.has(v)) children.delete(k);
      break;
    }
    case 'close': rl.close(); process.exit(0); break;
    default: fail('unknown cmd ' + c.cmd);
  }
});
