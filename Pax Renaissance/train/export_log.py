"""Export a training run's log.jsonl to CSVs for the training dashboard.

    python train/export_log.py runs/ppo1

Writes <run>/dashboard/iterations.csv (one row per iteration) and evals.csv (one row per
evaluation). If a run was resumed, a repeated iteration keeps its latest entry.
"""
from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

ITER_COLS = ["iter", "decisions", "games", "game_len", "league_score", "pg", "vf", "ent", "kl", "clipfrac",
             "secs"]
EVAL_COLS = ["iter", "random", "random_lo", "random_hi", "greedy", "greedy_lo", "greedy_hi"]


def main():
    run = Path(sys.argv[1] if len(sys.argv) > 1 else "runs/ppo1")
    rows = {}
    for line in (run / "log.jsonl").read_text().splitlines():
        if line.strip():
            r = json.loads(line)
            rows[r["iter"]] = r
    out = run / "dashboard"
    out.mkdir(exist_ok=True)
    with open(out / "iterations.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(ITER_COLS)
        for it in sorted(rows):
            r = rows[it]
            ls = r.get("league_score")
            w.writerow([it + 1, r["decisions"], r["games"], round(r["game_len"], 1),
                        "" if ls is None else round(ls, 3), round(r["pg"], 4), round(r["vf"], 4),
                        round(r["ent"], 3), round(r["kl"], 5), round(r["clipfrac"], 3),
                        round(r["t_collect"] + r["t_update"], 1)])
    n_eval = 0
    with open(out / "evals.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(EVAL_COLS)
        for it in sorted(rows):
            r = rows[it]
            if "eval_random" not in r and "eval_greedy" not in r:
                continue
            row = [it + 1]
            for opp in ("random", "greedy"):
                s, ci = r.get(f"eval_{opp}"), r.get(f"eval_{opp}_ci")
                row += ["", "", ""] if s is None else [s, ci[0], ci[1]]
            w.writerow(row)
            n_eval += 1
    print(f"wrote {len(rows)} iterations and {n_eval} evaluations to {out}")


if __name__ == "__main__":
    main()
