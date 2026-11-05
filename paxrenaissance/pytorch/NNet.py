"""alpha-zero-general NeuralNet wrapper around PaxNet (`Pax Renaissance/train/model.py`).

PaxNet scores a variable number of options per decision from their feature rows, so the policy
for a board with k options is a softmax over k logits, padded with zeros to game.getActionSize().
Training uses the MCTS visit distribution over the first k actions as the target.

The same architecture is used by the PPO trainer in `Pax Renaissance/train`, so a PPO checkpoint
(e.g. `Pax Renaissance/runs/ppo2/best.pt`) is a good starting point: see `load_ppo`.
"""
from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

import numpy as np
import torch
from tqdm import tqdm

sys.path.append(str(Path(__file__).resolve().parents[2]))
from NeuralNet import NeuralNet  # noqa: E402
from utils import AverageMeter, dotdict  # noqa: E402

_MODEL_PY = Path(__file__).resolve().parents[2] / "Pax Renaissance" / "train" / "model.py"
_spec = importlib.util.spec_from_file_location("pax_train_model", _MODEL_PY)
paxmodel = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(paxmodel)
PaxNet, segment_log_softmax = paxmodel.PaxNet, paxmodel.segment_log_softmax

ENCODER_VERSION = 3  # must match ENCODER_VERSION in Pax Renaissance/src/ai/encode.js

args = dotdict({
    'lr': 1e-4,
    'epochs': 4,
    'batch_size': 256,
    'hidden': 512,
    'cuda': torch.cuda.is_available(),
    'max_grad': 1.0,
})


def _batch(boards, max_actions, device):
    obs = torch.from_numpy(np.stack([b.obs for b in boards])).to(device)
    ks = [min(b.k, max_actions) for b in boards]
    opts = torch.from_numpy(np.concatenate([b.opts[:k] for b, k in zip(boards, ks)])).to(device)
    seg = torch.repeat_interleave(torch.arange(len(boards)), torch.tensor(ks)).to(device)
    return obs, opts, seg, ks


class NNetWrapper(NeuralNet):
    def __init__(self, game):
        self.game = game
        self.max_actions = game.getActionSize()
        self.device = torch.device("cuda" if args.cuda else "cpu")
        self._build(dict(obs_size=game.obs_size, opt_size=game.opt_size, num_cards=game.num_cards, hidden=args.hidden))

    def _build(self, config):
        self.nnet = PaxNet(**config).to(self.device)
        self.optimizer = torch.optim.Adam(self.nnet.parameters(), lr=args.lr)

    def train(self, examples):
        """examples: list of (board, pi, v)."""
        examples = [e for e in examples if e[0].k > 0]
        for epoch in range(args.epochs):
            print('EPOCH ::: ' + str(epoch + 1))
            self.nnet.train()
            pi_losses, v_losses = AverageMeter(), AverageMeter()
            order = np.random.permutation(len(examples))
            nb = max(1, len(examples) // args.batch_size)
            for i in tqdm(range(nb), desc='Training Net'):
                batch = [examples[j] for j in order[i * args.batch_size:(i + 1) * args.batch_size]]
                boards, pis, vs = zip(*batch)
                obs, opts, seg, ks = _batch(boards, self.max_actions, self.device)
                target_pi = torch.from_numpy(np.concatenate([np.asarray(p, dtype=np.float32)[:k] for p, k in zip(pis, ks)])).to(self.device)
                target_v = torch.tensor(vs, dtype=torch.float32, device=self.device)

                logits, v = self.nnet(obs, opts, seg)
                logp = segment_log_softmax(logits, seg, len(boards))
                l_pi = -torch.zeros(len(boards), device=self.device).index_add(0, seg, target_pi * logp).mean()
                l_v = ((target_v - v) ** 2).mean()
                loss = l_pi + l_v

                self.optimizer.zero_grad()
                loss.backward()
                torch.nn.utils.clip_grad_norm_(self.nnet.parameters(), args.max_grad)
                self.optimizer.step()
                pi_losses.update(l_pi.item(), len(boards))
                v_losses.update(l_v.item(), len(boards))
            print(f'Loss_pi={pi_losses}  Loss_v={v_losses}')

    @torch.no_grad()
    def predict(self, board):
        pi = np.zeros(self.max_actions, dtype=np.float32)
        if board.k == 0:
            return pi, 0.0
        self.nnet.eval()
        obs, opts, seg, ks = _batch([board], self.max_actions, self.device)
        logits, v = self.nnet(obs, opts, seg)
        pi[:ks[0]] = torch.softmax(logits, 0).cpu().numpy()
        return pi, float(v[0])

    def save_checkpoint(self, folder='checkpoint', filename='checkpoint.pth.tar'):
        os.makedirs(folder, exist_ok=True)
        torch.save({'state_dict': self.nnet.state_dict(), 'config': self.nnet.config,
                    'encoder_version': ENCODER_VERSION}, os.path.join(folder, filename))

    def load_checkpoint(self, folder='checkpoint', filename='checkpoint.pth.tar'):
        path = os.path.join(folder, filename)
        if not os.path.exists(path):
            raise FileNotFoundError(f"No model in path {path}")
        ck = torch.load(path, map_location=self.device, weights_only=True)
        self._check_version(ck, path)
        if ck['config'] != self.nnet.config:
            self._build(ck['config'])
        self.nnet.load_state_dict(ck['state_dict'])

    def load_ppo(self, path):
        """Start from a checkpoint written by `Pax Renaissance/train/ppo.py` (same architecture)."""
        ck = torch.load(path, map_location=self.device, weights_only=True)
        self._check_version(ck, path)
        if ck['config'] != self.nnet.config:
            self._build(ck['config'])
        self.nnet.load_state_dict(ck['model'])

    @staticmethod
    def _check_version(ck, path):
        if ck.get('encoder_version') != ENCODER_VERSION:
            raise ValueError(f"{path} was trained with encoder v{ck.get('encoder_version')}, expected v{ENCODER_VERSION}")
