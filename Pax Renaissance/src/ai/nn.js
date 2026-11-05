// The trained policy/value network (train/model.py, PaxNet) in plain JavaScript, for the web app's
// neural-network bot. Weights come from train/export_web.py: models/pax-net.json (shapes,
// encoder version, test cases) + models/pax-net.bin (float32).
//
//   const net = await loadNet('models/pax-net');          // browser (fetch)
//   const net = netFromBuffers(manifest, arrayBuffer);     // anywhere
//   net.score(obsVec, optionVecs) -> logits[]             // what PolicyAgent expects
//   net.value(obsVec) -> predicted result for the deciding player (-1..1)
import { ENCODER_VERSION } from './encode.js';

const CARD_SLOTS = 2; // option vectors start with two card-embedding indices (see encode.js)

export async function loadNet(base) {
  const [mres, bres] = await Promise.all([fetch(base + '.json'), fetch(base + '.bin')]);
  if (!mres.ok || !bres.ok) throw new Error(`Couldn't load ${base}.json/.bin (HTTP ${mres.status}/${bres.status})`);
  return netFromBuffers(await mres.json(), await bres.arrayBuffer());
}

export function netFromBuffers(manifest, buffer) {
  if (manifest.encoder_version !== ENCODER_VERSION) {
    throw new Error(`Model was trained for encoder v${manifest.encoder_version}, this app uses v${ENCODER_VERSION}. Re-export a matching checkpoint.`);
  }
  const all = new Float32Array(buffer);
  const t = (name) => {
    const d = manifest.tensors[name]; if (!d) throw new Error('Missing tensor ' + name);
    return { shape: d.shape, data: all.subarray(d.offset, d.offset + d.length) };
  };
  return new PaxNet(manifest, t);
}

// Dense layer y = W x + b with W stored transposed ([in][out]) so sparse inputs are cheap.
class Linear {
  constructor(w, b) {
    const [out, inp] = w.shape;
    this.in = inp; this.out = out; this.b = b.data;
    this.wt = new Float32Array(inp * out);
    for (let o = 0; o < out; o++) for (let i = 0; i < inp; i++) this.wt[i * out + o] = w.data[o * inp + i];
  }
  forward(x, relu) {
    const y = new Float64Array(this.out); y.set(this.b);
    const { wt, out } = this;
    for (let i = 0; i < this.in; i++) {
      const xi = x[i]; if (xi === 0) continue;
      const row = i * out;
      for (let o = 0; o < out; o++) y[o] += xi * wt[row + o];
    }
    const r = new Float32Array(out);
    for (let o = 0; o < out; o++) r[o] = relu && y[o] < 0 ? 0 : y[o];
    return r;
  }
}

class PaxNet {
  constructor(manifest, t) {
    this.manifest = manifest;
    this.config = manifest.config;
    const L = (p) => new Linear(t(p + '.weight'), t(p + '.bias'));
    this.torso = [L('torso.0'), L('torso.2')];
    this.optEnc = [L('opt_enc.0'), L('opt_enc.2')];
    this.scorer = [L('scorer.0'), L('scorer.2')];
    this.valueHead = [L('value_head.0'), L('value_head.2')];
    const emb = t('card_emb.weight');
    this.emb = emb.data; this.cardDim = emb.shape[1]; this.numCards = emb.shape[0];
  }
  hidden(obs) { return this.torso[1].forward(this.torso[0].forward(obs, true), true); }
  encodeOption(opt) {
    const F = this.config.opt_size, D = this.cardDim;
    const x = new Float32Array(F - CARD_SLOTS + CARD_SLOTS * D);
    x.set(opt.subarray(CARD_SLOTS, F), 0);
    for (let s = 0; s < CARD_SLOTS; s++) {
      const c = Math.round(opt[s]);
      if (c > 0 && c < this.numCards) x.set(this.emb.subarray(c * D, (c + 1) * D), F - CARD_SLOTS + s * D);
    }
    return this.optEnc[1].forward(this.optEnc[0].forward(x, true), true);
  }
  score(obs, optVecs) {
    const h = this.hidden(obs), H = h.length;
    return optVecs.map((o) => {
      const e = this.encodeOption(o instanceof Float32Array ? o : Float32Array.from(o));
      const x = new Float32Array(3 * H);
      x.set(h, 0); x.set(e, H);
      for (let i = 0; i < H; i++) x[2 * H + i] = h[i] * e[i];
      return this.scorer[1].forward(this.scorer[0].forward(x, true), false)[0];
    });
  }
  value(obs) { return Math.tanh(this.valueHead[1].forward(this.valueHead[0].forward(this.hidden(obs), true), false)[0]); }
}
