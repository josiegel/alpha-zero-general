"""Python client for tools/envserver.mjs: many Pax Renaissance games stepped in one batch.

    with PaxEnv(num_games=64, opponent="greedy", total_games=200) as env:
        b = env.batch
        while not b.done:
            b = env.step(policy(b))     # one option index per pending decision

Each Batch holds the pending decisions of every game waiting on the Python side:
    obs      float32 [B, obs_size]       observation per decision
    opts     float32 [N, opt_size]       options of all decisions, concatenated
    seg      int64   [N]                 decision index (0..B-1) of each option row
    counts   int64   [B]                 number of options per decision
    pending  list of dict                {g, game_id, player, k, kind[, prompt, options]}
    finished list of dict                games that ended since the previous batch
"""
from __future__ import annotations

import json
import struct
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "tools" / "envserver.mjs"


@dataclass
class Batch:
    pending: list
    finished: list
    obs: np.ndarray
    opts: np.ndarray
    counts: np.ndarray
    seg: np.ndarray
    offsets: np.ndarray  # start row in `opts` of each decision
    done: bool
    obs_size: int
    opt_size: int
    num_cards: int
    encoder_version: int

    def __len__(self) -> int:
        return len(self.pending)


class PaxEnv:
    def __init__(self, num_games: int = 64, seed: int = 1, opponent: str | None = None,
                 total_games: int | None = None, labels: bool = False, node: str = "node"):
        self.proc = subprocess.Popen([node, str(SERVER)], cwd=str(ROOT), stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, bufsize=0)
        self.batch = self._send({"cmd": "init", "num_games": num_games, "seed": seed, "opponent": opponent,
                                 "total_games": total_games, "labels": labels})

    def step(self, actions) -> Batch:
        self.step_async(actions)
        return self.step_wait()

    # Split form of step(), so several servers can compute in parallel:
    #   for e in envs: e.step_async(acts[e]);  then  for e in envs: e.step_wait()
    def step_async(self, actions):
        actions = [int(a) for a in actions]
        if len(actions) != len(self.batch):
            raise ValueError(f"expected {len(self.batch)} actions, got {len(actions)}")
        self.proc.stdin.write((json.dumps({"cmd": "step", "actions": actions}) + "\n").encode())
        self.proc.stdin.flush()

    def step_wait(self) -> Batch:
        self.batch = self._read()
        return self.batch

    def close(self):
        if self.proc.poll() is None:
            try:
                self.proc.stdin.write(b'{"cmd":"close"}\n')
                self.proc.stdin.flush()
                self.proc.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                self.proc.kill()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    # ---- protocol ----
    def _send(self, cmd: dict) -> Batch:
        self.proc.stdin.write((json.dumps(cmd) + "\n").encode())
        self.proc.stdin.flush()
        return self._read()

    def _readn(self, n: int) -> bytearray:
        buf = bytearray()
        while len(buf) < n:
            chunk = self.proc.stdout.read(n - len(buf))
            if not chunk:
                raise RuntimeError(f"envserver exited (code {self.proc.poll()}); see its stderr above")
            buf += chunk
        return buf  # writable, so numpy/torch views of it are too

    def _read(self) -> Batch:
        (hlen,) = struct.unpack("<I", self._readn(4))
        h = json.loads(self._readn(hlen))
        (blen,) = struct.unpack("<I", self._readn(4))
        body = np.frombuffer(self._readn(blen), dtype="<f4")
        B, O, F = len(h["pending"]), h["obs_size"], h["opt_size"]
        counts = np.array([p["k"] for p in h["pending"]], dtype=np.int64)
        obs = body[: B * O].reshape(B, O)
        opts = body[B * O:].reshape(-1, F)
        offsets = np.concatenate([[0], np.cumsum(counts)[:-1]]).astype(np.int64) if B else np.zeros(0, np.int64)
        return Batch(pending=h["pending"], finished=h["finished"], obs=obs, opts=opts, counts=counts,
                     seg=np.repeat(np.arange(B, dtype=np.int64), counts), offsets=offsets, done=h["done"],
                     obs_size=O, opt_size=F, num_cards=h["num_cards"], encoder_version=h["encoder_version"])
