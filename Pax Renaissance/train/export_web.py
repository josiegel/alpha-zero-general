"""Export a trained checkpoint for the web app's neural-network bot.

    python train/export_web.py runs/ppo2/best.pt            # -> models/pax-net.json + models/pax-net.bin

Writes the weights as little-endian float32 (models/pax-net.bin) and a manifest (models/pax-net.json)
with the network shape, encoder version, where each tensor sits in the .bin, and a few test
decisions with PyTorch's outputs, so src/ai/nn.js can be checked against PyTorch
(node tools/nn_check.mjs).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from env import PaxEnv  # noqa: E402
from model import PaxNet  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("checkpoint")
    ap.add_argument("--out", default=str(ROOT / "models" / "pax-net"))
    ap.add_argument("--tests", type=int, default=6, help="test decisions to include")
    a = ap.parse_args()

    ck = torch.load(a.checkpoint, map_location="cpu", weights_only=True)
    net = PaxNet(**ck["config"]).eval()
    net.load_state_dict(ck["model"])

    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    tensors, chunks, off = {}, [], 0
    for name, t in net.state_dict().items():
        arr = t.detach().cpu().numpy().astype("<f4")
        tensors[name] = {"shape": list(arr.shape), "offset": off, "length": int(arr.size)}
        chunks.append(arr.tobytes())
        off += arr.size
    out.with_suffix(".bin").write_bytes(b"".join(chunks))

    # test decisions: real positions from the game server, with PyTorch's logits and value
    tests = []
    with PaxEnv(num_games=4, seed=4242, total_games=4) as env:
        b = env.batch
        rng = np.random.default_rng(0)
        while len(tests) < a.tests and not b.done:
            for j in range(len(b)):
                if len(tests) >= a.tests or b.counts[j] < 3 or rng.random() > 0.3:
                    continue
                o, k = b.offsets[j], b.counts[j]
                obs = torch.from_numpy(b.obs[j:j + 1].copy())
                opts = torch.from_numpy(b.opts[o:o + k].copy())
                with torch.no_grad():
                    logits, value = net(obs, opts, torch.zeros(k, dtype=torch.int64))
                nz = np.nonzero(b.obs[j])[0]
                tests.append({"obs_index": nz.tolist(), "obs_value": b.obs[j][nz].tolist(),
                              "opts": b.opts[o:o + k].tolist(), "logits": logits.tolist(), "value": float(value[0])})
            b = env.step([int(rng.integers(k)) for k in b.counts])

    manifest = {
        "format": 1, "dtype": "float32", "config": ck["config"], "encoder_version": ck["encoder_version"],
        "source": str(Path(a.checkpoint).as_posix()), "iteration": ck.get("iteration"), "evals": ck.get("evals"),
        "exported": time.strftime("%Y-%m-%d %H:%M"), "tensors": tensors, "tests": tests,
    }
    out.with_suffix(".json").write_text(json.dumps(manifest))
    print(f"wrote {out.with_suffix('.bin')} ({off * 4 / 1e6:.1f} MB) and {out.with_suffix('.json')} "
          f"with {len(tests)} test decisions; encoder v{ck['encoder_version']}")


if __name__ == "__main__":
    main()
