// Checks src/ai/nn.js against PyTorch, using the test decisions train/export_web.py stores in the
// manifest, then times a forward pass.  Usage: node tools/nn_check.mjs [models/pax-net]
import { readFileSync } from 'node:fs';
import { netFromBuffers } from '../src/ai/nn.js';
import { OBS_SIZE } from '../src/ai/encode.js';

const base = process.argv[2] || 'models/pax-net';
const manifest = JSON.parse(readFileSync(base + '.json', 'utf8'));
const bin = readFileSync(base + '.bin');
const net = netFromBuffers(manifest, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));

let worst = 0, argmaxOk = 0;
for (const t of manifest.tests) {
  const obs = new Float32Array(OBS_SIZE);
  t.obs_index.forEach((ix, i) => { obs[ix] = t.obs_value[i]; });
  const opts = t.opts.map((o) => Float32Array.from(o));
  const got = net.score(obs, opts);
  got.forEach((g, i) => { worst = Math.max(worst, Math.abs(g - t.logits[i])); });
  worst = Math.max(worst, Math.abs(net.value(obs) - t.value));
  const am = (a) => a.indexOf(Math.max(...a));
  if (am(got) === am(t.logits)) argmaxOk++;
}
console.log(`${manifest.tests.length} test decisions: max |JS - PyTorch| = ${worst.toExponential(2)}, same top choice in ${argmaxOk}/${manifest.tests.length}`);

const t = manifest.tests[0];
const obs = new Float32Array(OBS_SIZE); t.obs_index.forEach((ix, i) => { obs[ix] = t.obs_value[i]; });
const opts = t.opts.map((o) => Float32Array.from(o));
const t0 = performance.now(); for (let i = 0; i < 20; i++) net.score(obs, opts);
console.log(`forward pass with ${opts.length} options: ${((performance.now() - t0) / 20).toFixed(1)} ms`);
process.exitCode = worst < 1e-3 && argmaxOk === manifest.tests.length ? 0 : 1;
