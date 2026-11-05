"""Policy/value network for Pax Renaissance.

The observation goes through an MLP torso -> h. Each legal option is encoded from its structured
features plus two learned card embeddings -> e. The option logit is MLP([h, e, h*e]); the value
head predicts the final result for the deciding player (tanh, +1 win / -1 loss).
"""
from __future__ import annotations

import numpy as np
import torch
import torch.nn as nn

CARD_SLOTS = 2  # opts[:, 0] and opts[:, 1] are card embedding indices (see src/ai/encode.js)


class PaxNet(nn.Module):
    def __init__(self, obs_size: int, opt_size: int, num_cards: int, hidden: int = 512,
                 opt_hidden: int = 256, card_dim: int = 32):
        super().__init__()
        self.config = dict(obs_size=obs_size, opt_size=opt_size, num_cards=num_cards, hidden=hidden,
                           opt_hidden=opt_hidden, card_dim=card_dim)
        self.card_emb = nn.Embedding(num_cards, card_dim, padding_idx=0)
        self.torso = nn.Sequential(nn.Linear(obs_size, hidden), nn.ReLU(), nn.Linear(hidden, hidden), nn.ReLU())
        self.opt_enc = nn.Sequential(nn.Linear(opt_size - CARD_SLOTS + CARD_SLOTS * card_dim, opt_hidden), nn.ReLU(),
                                     nn.Linear(opt_hidden, hidden), nn.ReLU())
        self.scorer = nn.Sequential(nn.Linear(3 * hidden, 256), nn.ReLU(), nn.Linear(256, 1))
        self.value_head = nn.Sequential(nn.Linear(hidden, 256), nn.ReLU(), nn.Linear(256, 1))

    def forward(self, obs: torch.Tensor, opts: torch.Tensor, seg: torch.Tensor):
        """obs [B, O], opts [N, F], seg [N] (decision index per option) -> logits [N], value [B]."""
        h = self.torso(obs)
        cards = opts[:, :CARD_SLOTS].long()
        e = self.opt_enc(torch.cat([opts[:, CARD_SLOTS:], self.card_emb(cards).flatten(1)], dim=1))
        hs = h[seg]
        logits = self.scorer(torch.cat([hs, e, hs * e], dim=1)).squeeze(-1)
        value = torch.tanh(self.value_head(h)).squeeze(-1)
        return logits, value


def segment_log_softmax(logits: torch.Tensor, seg: torch.Tensor, num_segments: int) -> torch.Tensor:
    """log-softmax of `logits` within each segment (the options of one decision)."""
    mx = torch.full((num_segments,), float("-inf"), dtype=logits.dtype, device=logits.device)
    mx = mx.scatter_reduce(0, seg, logits, reduce="amax", include_self=True)
    z = logits - mx[seg]
    lse = torch.zeros(num_segments, dtype=logits.dtype, device=logits.device).index_add(0, seg, z.exp()).log()
    return z - lse[seg]


def save_checkpoint(path, net: PaxNet, encoder_version: int, **extra):
    torch.save({"model": net.state_dict(), "config": net.config, "encoder_version": encoder_version, **extra}, path)


def load_checkpoint(path, encoder_version: int | None = None) -> PaxNet:
    ck = torch.load(path, map_location="cpu", weights_only=True)
    if encoder_version is not None and ck.get("encoder_version") != encoder_version:
        raise ValueError(f"{path} was trained with encoder v{ck.get('encoder_version')}, server uses v{encoder_version}")
    net = PaxNet(**ck["config"])
    net.load_state_dict(ck["model"])
    return net


class ModelPolicy:
    """Picks options with a PaxNet: arg-max (greedy) or sampled from the softmax."""

    def __init__(self, net: PaxNet, greedy: bool = True, seed: int = 0):
        self.net = net.eval()
        self.greedy = greedy
        self.gen = torch.Generator().manual_seed(seed)

    @torch.no_grad()
    def __call__(self, b) -> list[int]:
        if not len(b):
            return []
        obs, opts, seg = torch.from_numpy(b.obs), torch.from_numpy(b.opts), torch.from_numpy(b.seg)
        logits, _ = self.net(obs, opts, seg)
        logp = segment_log_softmax(logits, seg, len(b))
        out = []
        for j, (o, k) in enumerate(zip(b.offsets, b.counts)):
            lp = logp[o:o + k]
            i = int(lp.argmax()) if self.greedy else int(torch.multinomial(lp.exp(), 1, generator=self.gen))
            out.append(i)
        return out


class RandomPolicy:
    def __init__(self, seed: int = 0):
        self.rng = np.random.default_rng(seed)

    def __call__(self, b) -> list[int]:
        return [int(self.rng.integers(k)) for k in b.counts]
