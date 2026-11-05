"""Evaluate a policy against a built-in opponent (random / greedy) with alternating seats.

    python train/eval.py --policy random --opponent greedy --games 200
    python train/eval.py --policy untrained --opponent random
    python train/eval.py --policy checkpoints/ppo_0100.pt --opponent greedy --sample

Score = (wins + draws/2) / games, with a 95% Wilson interval. Evaluation seeds start at 1,000,000
by default so they don't overlap the seeds used for training.
"""
from __future__ import annotations

import argparse
import math
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from env import PaxEnv  # noqa: E402
from model import ModelPolicy, PaxNet, RandomPolicy, load_checkpoint  # noqa: E402


def wilson(score: float, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return 0.0, 1.0
    d = 1 + z * z / n
    c = (score + z * z / (2 * n)) / d
    m = z * math.sqrt(score * (1 - score) / n + z * z / (4 * n * n)) / d
    return max(0.0, c - m), min(1.0, c + m)


END_TYPES = ("holy", "imperial", "globalization", "renaissance", "patron", "unfinished")


def end_type(reason: str) -> str:
    """'holy victory' -> 'holy', 'patron victory (decks exhausted)' -> 'patron', 'unfinished'."""
    head = reason.split()[0]
    return head if head in END_TYPES else "unfinished"


def evaluate(policy, opponent: str, games: int = 200, num_games: int = 64, seed: int = 1_000_000,
             verbose: bool = True) -> dict:
    t0 = time.time()
    wins = losses = draws = unfinished = decisions = 0
    seat_wins = Counter()
    reasons = Counter()
    ends = {"win": Counter(), "loss": Counter(), "draw": Counter()}  # end type of each result
    with PaxEnv(num_games=min(num_games, games), seed=seed, opponent=opponent, total_games=games) as env:
        b = env.batch
        while True:
            for f in b.finished:
                (me,) = f["ext_seats"]
                reasons[f["reason"]] += 1
                w = f["winners"]
                et = end_type(f["reason"])
                if f["reason"] == "unfinished":
                    unfinished += 1
                elif len(w) != 1:
                    draws += 1
                    ends["draw"][et] += 1
                elif w[0] == me:
                    wins += 1
                    seat_wins[me] += 1
                    ends["win"][et] += 1
                else:
                    losses += 1
                    ends["loss"][et] += 1
            if b.done:
                break
            decisions += len(b)
            b = env.step(policy(b))
    n = wins + losses + draws
    score = (wins + 0.5 * draws) / n if n else 0.0
    lo, hi = wilson(score, n)
    res = dict(opponent=opponent, games=n, wins=wins, losses=losses, draws=draws, unfinished=unfinished,
               score=score, ci95=(lo, hi), seat_wins=dict(seat_wins), reasons=dict(reasons),
               ends={k: dict(v) for k, v in ends.items()}, seconds=time.time() - t0, decisions=decisions)
    if verbose:
        print(f"vs {opponent}: {wins}-{losses}-{draws} (W-L-D, {unfinished} unfinished) "
              f"score {100 * score:.1f}% [95% CI {100 * lo:.1f}-{100 * hi:.1f}]  "
              f"wins as seat 0/1: {seat_wins[0]}/{seat_wins[1]}")
        for k in ("win", "loss", "draw"):
            if ends[k]:
                print(f"  {k}s by:", ", ".join(f"{t} {ends[k][t]}" for t in END_TYPES if ends[k][t]))
        print(f"  {res['seconds']:.1f}s, {decisions} policy decisions ({decisions / max(res['seconds'], 1e-9):.0f}/s)")
    return res


def make_policy(spec: str, sample: bool, seed: int):
    if spec == "random":
        return RandomPolicy(seed)
    if spec == "untrained":
        with PaxEnv(num_games=1, total_games=1) as env:  # just to read the encoding sizes
            b = env.batch
        import torch
        torch.manual_seed(seed)
        return ModelPolicy(PaxNet(b.obs_size, b.opt_size, b.num_cards), greedy=not sample, seed=seed)
    with PaxEnv(num_games=1, total_games=1) as env:
        ver = env.batch.encoder_version
    return ModelPolicy(load_checkpoint(spec, encoder_version=ver), greedy=not sample, seed=seed)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--policy", default="random", help="random | untrained | path to a .pt checkpoint")
    ap.add_argument("--opponent", default="random", nargs="+", help="random and/or greedy")
    ap.add_argument("--games", type=int, default=200)
    ap.add_argument("--num-games", type=int, default=64, help="games run in parallel")
    ap.add_argument("--seed", type=int, default=1_000_000)
    ap.add_argument("--sample", action="store_true", help="sample from the policy instead of arg-max")
    a = ap.parse_args()
    policy = make_policy(a.policy, a.sample, a.seed)
    for opp in a.opponent:
        evaluate(policy, opp, games=a.games, num_games=a.num_games, seed=a.seed)


if __name__ == "__main__":
    main()
