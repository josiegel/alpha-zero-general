"""PPO self-play training for Pax Renaissance.

    python train/ppo.py --run runs/ppo1                      # train (Ctrl+C to stop; resumable)
    python train/ppo.py --run runs/ppo1 --resume             # continue from runs/ppo1/latest.pt
    python train/ppo.py --run runs/smoke --iters 2 --steps 2048 --eval-every 1 --eval-games 20   # smoke test

How it works
- One envserver runs --num-games games in self-play. Each new game is either pure self-play (both
  seats are the learner and both generate training data) or, with probability --league-prob, a
  league game: one seat is a frozen past checkpoint (sampled from the run's snapshots) and only the
  learner's seat is trained on.
- Each player's decisions in a game form one trajectory. The reward is +1 win / -1 loss / 0 draw
  at the end. Advantages use GAE over that trajectory (gamma = 1 by default).
- A game still in progress when an iteration's batch is full carries over to the next iteration.
  Its stored log-probs keep the PPO ratio correct for the policy that actually chose the moves.
- Every --eval-every iterations the greedy (arg-max) policy plays --eval-games against random and
  greedy on fixed evaluation seeds. Results go to <run>/log.jsonl and the console.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from env import PaxEnv  # noqa: E402
from eval import END_TYPES, end_type, evaluate  # noqa: E402
from model import ModelPolicy, PaxNet, load_checkpoint, save_checkpoint, segment_log_softmax  # noqa: E402

TRAIN_SEED_BASE = 10_000_000  # evaluation uses 1,000,000+; keep them apart


# ---------------------------------------------------------------- batching helpers
def gather_rows(offsets: np.ndarray, counts: np.ndarray) -> np.ndarray:
    """Concatenated option-row indices for decisions with these (offset, count)."""
    total = int(counts.sum())
    if total == 0:
        return np.zeros(0, np.int64)
    starts = np.repeat(offsets - np.concatenate([[0], np.cumsum(counts)[:-1]]), counts)
    return starts + np.arange(total)


def forward_subset(net, b, idx: np.ndarray):
    """Run `net` on the decisions `idx` of env batch `b`. Returns (logp rows, value, local offsets)."""
    counts = b.counts[idx]
    rows = gather_rows(b.offsets[idx], counts)
    seg = np.repeat(np.arange(len(idx)), counts)
    obs = torch.from_numpy(b.obs[idx])
    opts = torch.from_numpy(b.opts[rows])
    seg_t = torch.from_numpy(seg)
    logits, value = net(obs, opts, seg_t)
    logp = segment_log_softmax(logits, seg_t, len(idx))
    local_off = np.concatenate([[0], np.cumsum(counts)[:-1]]).astype(np.int64)
    return logp, value, local_off, counts, rows


def sample_actions(logp: torch.Tensor, offsets, counts, gen: torch.Generator):
    acts, lps = [], []
    for o, k in zip(offsets, counts):
        lp = logp[o:o + k]
        a = int(torch.multinomial(lp.exp(), 1, generator=gen)) if k > 1 else 0
        acts.append(a)
        lps.append(float(lp[a]))
    return acts, lps


# ---------------------------------------------------------------- trajectories
class Trajectory:
    __slots__ = ("obs", "opts", "act", "logp", "value")

    def __init__(self):
        self.obs, self.opts, self.act, self.logp, self.value = [], [], [], [], []


def finish_trajectory(t: Trajectory, reward: float, gamma: float, lam: float):
    v = np.array(t.value, dtype=np.float32)
    n = len(v)
    adv = np.zeros(n, np.float32)
    last = 0.0
    for i in reversed(range(n)):
        next_v = v[i + 1] if i + 1 < n else 0.0
        r = reward if i == n - 1 else 0.0
        delta = r + gamma * next_v - v[i]
        last = delta + gamma * lam * last
        adv[i] = last
    ret = adv + v
    return adv, ret


# ---------------------------------------------------------------- league
class League:
    """Frozen past checkpoints used as opponents."""

    def __init__(self, run: Path, max_size: int, encoder_version: int):
        self.dir = run / "snapshots"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.max_size = max_size
        self.encoder_version = encoder_version
        self.cache: dict[str, PaxNet] = {}

    def paths(self):
        # the most recent snapshots plus the last few best-so-far checkpoints
        return sorted(self.dir.glob("snap_*.pt"))[-self.max_size:] + sorted(self.dir.glob("best_*.pt"))[-5:]

    def add_best(self, src: Path, it: int):
        (self.dir / f"best_{it:05d}.pt").write_bytes(src.read_bytes())

    def add(self, net: PaxNet, it: int):
        save_checkpoint(self.dir / f"snap_{it:05d}.pt", net, self.encoder_version, iteration=it)

    def sample(self) -> str | None:
        ps = self.paths()
        return str(random.choice(ps)) if ps else None

    def get(self, path: str) -> PaxNet:
        if path not in self.cache:
            if len(self.cache) >= self.max_size:
                self.cache.pop(next(iter(self.cache)))
            self.cache[path] = load_checkpoint(path, self.encoder_version).eval()
        return self.cache[path]


# ---------------------------------------------------------------- main loop
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", default="runs/ppo1", help="run directory (checkpoints, log)")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--iters", type=int, default=1000)
    ap.add_argument("--num-games", type=int, default=128)
    ap.add_argument("--steps", type=int, default=8192, help="learner decisions per iteration")
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--minibatch", type=int, default=1024)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--clip", type=float, default=0.2)
    ap.add_argument("--vf-coef", type=float, default=0.5)
    ap.add_argument("--ent-coef", type=float, default=0.01)
    ap.add_argument("--gamma", type=float, default=1.0)
    ap.add_argument("--lam", type=float, default=0.95)
    ap.add_argument("--max-grad", type=float, default=0.5)
    ap.add_argument("--init", default=None, help="start from this checkpoint's weights (fresh optimizer); "
                    "iteration numbering continues from it")
    ap.add_argument("--greedy-games", type=int, default=0,
                    help="extra parallel games against the greedy bot (0 = none); the learner plays one seat")
    ap.add_argument("--rollback-after", type=int, default=2,
                    help="reload best.pt after this many evaluations in a row whose 95%% range is entirely below "
                         "the best score (0 = never)")
    ap.add_argument("--league-prob", type=float, default=0.2)
    ap.add_argument("--league-size", type=int, default=10)
    ap.add_argument("--snapshot-every", type=int, default=10)
    ap.add_argument("--eval-every", type=int, default=10)
    ap.add_argument("--eval-games", type=int, default=100)
    ap.add_argument("--eval-opponents", nargs="+", default=["random", "greedy"])
    ap.add_argument("--hidden", type=int, default=512)
    ap.add_argument("--threads", type=int, default=3)
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()

    torch.set_num_threads(a.threads)
    torch.manual_seed(a.seed)
    random.seed(a.seed)
    np.random.seed(a.seed)
    run = Path(a.run)
    run.mkdir(parents=True, exist_ok=True)
    gen = torch.Generator().manual_seed(a.seed)

    # env 0: self-play (with league games); env 1 (optional): the learner against the greedy bot
    envs = [PaxEnv(num_games=a.num_games, seed=TRAIN_SEED_BASE + a.seed * 1_000_000)]
    if a.greedy_games:
        envs.append(PaxEnv(num_games=a.greedy_games, seed=TRAIN_SEED_BASE + a.seed * 1_000_000 + 500_000,
                           opponent="greedy"))
    bs = [e.batch for e in envs]
    ver = bs[0].encoder_version
    b = bs[0]

    start_it = 0
    best = {"iter": None, "score": -1.0, "bad_streak": 0, "rollbacks": 0}
    if (run / "best.json").exists():
        best = json.loads((run / "best.json").read_text())
    if a.resume and (run / "latest.pt").exists():
        ck = torch.load(run / "latest.pt", map_location="cpu", weights_only=True)
        net = PaxNet(**ck["config"])
        net.load_state_dict(ck["model"])
        opt = torch.optim.Adam(net.parameters(), lr=a.lr)
        opt.load_state_dict(ck["optim"])
        start_it = ck["iteration"] + 1
        if ck.get("encoder_version") != ver:
            sys.exit(f"checkpoint encoder v{ck.get('encoder_version')} != server v{ver}")
        print(f"resumed from iteration {ck['iteration']}")
    elif a.init:
        ck = torch.load(a.init, map_location="cpu", weights_only=True)
        if ck.get("encoder_version") != ver:
            sys.exit(f"{a.init}: encoder v{ck.get('encoder_version')} != server v{ver}")
        net = PaxNet(**ck["config"])
        net.load_state_dict(ck["model"])
        opt = torch.optim.Adam(net.parameters(), lr=a.lr)
        start_it = ck.get("iteration", -1) + 1
        g = (ck.get("evals") or {}).get("eval_greedy")
        if g is not None and best["iter"] is None:  # the starting point is the best so far
            best.update(iter=start_it, score=g)
            save_checkpoint(run / "best.pt", net, ver, iteration=start_it - 1, evals=ck.get("evals"))
        print(f"initialised from {a.init} (iteration {start_it}, greedy score {g})")
    else:
        net = PaxNet(b.obs_size, b.opt_size, b.num_cards, hidden=a.hidden)
        opt = torch.optim.Adam(net.parameters(), lr=a.lr)
    (run / "args.json").write_text(json.dumps(vars(a), indent=1))
    dash_src = Path(__file__).resolve().parent / "dashboard.html"
    if dash_src.exists() and not (run / "dashboard.html").exists():
        (run / "dashboard.html").write_bytes(dash_src.read_bytes())  # live view of log.jsonl
    league = League(run, a.league_size, ver)
    if not league.paths():
        league.add(net, start_it)  # so league games are possible from the start
    if (run / "best.pt").exists() and best["iter"] is not None and not list(league.dir.glob("best_*.pt")):
        league.add_best(run / "best.pt", best["iter"])
    (run / "best.json").write_text(json.dumps(best))

    game_opp: dict[int, tuple[int, str] | None] = {}  # self-play game_id -> (frozen seat, ckpt) or None
    trajs: dict[tuple[int, int, int], Trajectory] = defaultdict(Trajectory)  # (env, game_id, player)
    log_f = open(run / "log.jsonl", "a")
    txt_f = open(run / "train.log", "a", encoding="utf-8")

    def say(msg: str):
        print(msg, flush=True)
        txt_f.write(time.strftime("%Y-%m-%d %H:%M:%S  ") + msg + "\n")
        txt_f.flush()

    say(f"start: iterations {start_it}..{a.iters - 1}, args {json.dumps(vars(a))}")

    try:
        for it in range(start_it, a.iters):
            t0 = time.time()
            net.eval()
            buf = dict(obs=[], opts=[], act=[], logp=[], adv=[], ret=[])
            n_buf = 0
            stats = defaultdict(float)
            ends = dict.fromkeys(END_TYPES, 0)  # how this iteration's finished training games ended
            # ------------------------------------------------ collect
            while n_buf < a.steps:
                for k, bk in enumerate(bs):
                    for f in bk.finished:
                        gid = f["game_id"]
                        mode = game_opp.pop(gid, None) if k == 0 else None
                        w = f["winners"]
                        if k == 0:
                            stats["games"] += 1
                            stats["game_len"] += f["decisions"]
                            ends[end_type(f["reason"])] += 1
                        for p in (0, 1):
                            t = trajs.pop((k, gid, p), None)
                            if t is None:
                                continue
                            reward = 0.0 if len(w) != 1 else (1.0 if w[0] == p else -1.0)
                            if k == 1:
                                stats["greedy_games"] += 1
                                stats["greedy_score"] += (reward + 1) / 2
                            elif mode is not None:
                                stats["league_games"] += 1
                                stats["league_score"] += (reward + 1) / 2
                            adv, ret = finish_trajectory(t, reward, a.gamma, a.lam)
                            buf["obs"] += t.obs
                            buf["opts"] += t.opts
                            buf["act"] += t.act
                            buf["logp"] += t.logp
                            buf["adv"].append(adv)
                            buf["ret"].append(ret)
                            n_buf += len(t.act)
                            stats["dec_greedy" if k == 1 else "dec_self"] += len(t.act)
                if n_buf >= a.steps:
                    break
                for k, bk in enumerate(bs):
                    # who decides each pending decision? (None = the learner)
                    groups: dict[str | None, list[int]] = defaultdict(list)
                    for j, p in enumerate(bk.pending):
                        who = None
                        if k == 0:
                            gid = p["game_id"]
                            if gid not in game_opp:
                                ck = league.sample() if random.random() < a.league_prob else None
                                game_opp[gid] = (random.randint(0, 1), ck) if ck else None
                            mode = game_opp[gid]
                            who = mode[1] if mode and mode[0] == p["player"] else None
                        groups[who].append(j)
                    actions = [0] * len(bk)
                    with torch.no_grad():
                        for who, idx in groups.items():
                            idx = np.array(idx, dtype=np.int64)
                            model = net if who is None else league.get(who)
                            logp, value, off, counts, rows = forward_subset(model, bk, idx)
                            acts, lps = sample_actions(logp, off, counts, gen)
                            for jj, j in enumerate(idx):
                                actions[j] = acts[jj]
                                if who is None:
                                    p = bk.pending[j]
                                    t = trajs[(k, p["game_id"], p["player"])]
                                    t.obs.append(bk.obs[j].astype(np.float16))
                                    o = bk.offsets[j]
                                    t.opts.append(bk.opts[o:o + bk.counts[j]].astype(np.float16))
                                    t.act.append(acts[jj])
                                    t.logp.append(lps[jj])
                                    t.value.append(float(value[jj]))
                    envs[k].step_async(actions)
                bs = [e.step_wait() for e in envs]  # the servers compute in parallel
            t_collect = time.time() - t0

            # ------------------------------------------------ update
            net.train()
            D = len(buf["act"])
            obs_all = torch.from_numpy(np.stack(buf["obs"]).astype(np.float32))
            counts_all = np.array([len(o) for o in buf["opts"]], dtype=np.int64)
            off_all = np.concatenate([[0], np.cumsum(counts_all)[:-1]]).astype(np.int64)
            opts_all = torch.from_numpy(np.concatenate(buf["opts"]).astype(np.float32))
            act_all = torch.tensor(buf["act"], dtype=torch.int64)
            logp_old = torch.tensor(buf["logp"], dtype=torch.float32)
            adv_all = torch.from_numpy(np.concatenate(buf["adv"]))
            ret_all = torch.from_numpy(np.concatenate(buf["ret"]))
            adv_all = (adv_all - adv_all.mean()) / (adv_all.std() + 1e-8)
            upd = defaultdict(float)
            n_mb = 0
            for _ in range(a.epochs):
                perm = np.random.permutation(D)
                for s in range(0, D, a.minibatch):
                    idx = perm[s:s + a.minibatch]
                    counts = counts_all[idx]
                    rows = torch.from_numpy(gather_rows(off_all[idx], counts))
                    seg = torch.from_numpy(np.repeat(np.arange(len(idx)), counts))
                    loc = torch.from_numpy(np.concatenate([[0], np.cumsum(counts)[:-1]]).astype(np.int64))
                    idx_t = torch.from_numpy(idx)
                    logits, value = net(obs_all[idx_t], opts_all[rows], seg)
                    logp = segment_log_softmax(logits, seg, len(idx))
                    lp_a = logp[loc + act_all[idx_t]]
                    ratio = (lp_a - logp_old[idx_t]).exp()
                    adv = adv_all[idx_t]
                    pg = -torch.min(ratio * adv, ratio.clamp(1 - a.clip, 1 + a.clip) * adv).mean()
                    vf = ((value - ret_all[idx_t]) ** 2).mean()
                    ent_rows = -(logp.exp() * logp)
                    ent = torch.zeros(len(idx)).index_add(0, seg, ent_rows).mean()
                    loss = pg + a.vf_coef * vf - a.ent_coef * ent
                    opt.zero_grad()
                    loss.backward()
                    torch.nn.utils.clip_grad_norm_(net.parameters(), a.max_grad)
                    opt.step()
                    with torch.no_grad():
                        upd["pg"] += float(pg)
                        upd["vf"] += float(vf)
                        upd["ent"] += float(ent)
                        upd["kl"] += float((logp_old[idx_t] - lp_a).mean())
                        upd["clipfrac"] += float(((ratio - 1).abs() > a.clip).float().mean())
                    n_mb += 1
            t_update = time.time() - t0 - t_collect

            # ------------------------------------------------ bookkeeping
            rec = dict(iter=it, time=round(time.time(), 1), decisions=D, games=int(stats["games"]),
                       game_len=stats["game_len"] / max(stats["games"], 1),
                       league_score=(stats["league_score"] / stats["league_games"]) if stats["league_games"] else None,
                       greedy_train_score=(stats["greedy_score"] / stats["greedy_games"]) if stats["greedy_games"] else None,
                       greedy_share=stats["dec_greedy"] / max(1, stats["dec_greedy"] + stats["dec_self"]),
                       ends=ends,
                       **{k: v / n_mb for k, v in upd.items()},
                       t_collect=round(t_collect, 1), t_update=round(t_update, 1))
            ckpt = dict(model=net.state_dict(), config=net.config, encoder_version=ver, optim=opt.state_dict(), iteration=it)
            torch.save(ckpt, run / "latest.pt.tmp")
            (run / "latest.pt.tmp").replace(run / "latest.pt")  # atomic: a kill mid-save can't corrupt it
            if (it + 1) % a.snapshot_every == 0:
                league.add(net, it + 1)
            if a.eval_every and (it + 1) % a.eval_every == 0:
                pol = ModelPolicy(net, greedy=True)
                for opp_name in a.eval_opponents:
                    r = evaluate(pol, opp_name, games=a.eval_games, num_games=min(64, a.eval_games), verbose=False)
                    rec[f"eval_{opp_name}"] = round(r["score"], 3)
                    rec[f"eval_{opp_name}_ci"] = [round(x, 3) for x in r["ci95"]]
                    rec[f"eval_{opp_name}_ends"] = r["ends"]  # {win|loss|draw: {end type: games}}
                ck_path = run / f"ckpt_{it + 1:05d}.pt"
                save_checkpoint(ck_path, net, ver, iteration=it, evals={k: v for k, v in rec.items() if k.startswith("eval_")})
                # best-so-far tracking and rollback, judged on the score against greedy
                g, g_hi = rec.get("eval_greedy"), (rec.get("eval_greedy_ci") or [None, None])[1]
                if g is not None:
                    if g > best["score"]:
                        best.update(iter=it + 1, score=g, bad_streak=0)
                        (run / "best.pt").write_bytes(ck_path.read_bytes())
                        league.add_best(ck_path, it + 1)
                        rec["new_best"] = True
                        say(f"new best: {g:.0%} against greedy at iteration {it + 1}")
                    elif g_hi < best["score"]:
                        best["bad_streak"] += 1
                    else:
                        best["bad_streak"] = 0
                    if a.rollback_after and best["bad_streak"] >= a.rollback_after and (run / "best.pt").exists():
                        ckb = torch.load(run / "best.pt", map_location="cpu", weights_only=True)
                        net.load_state_dict(ckb["model"])
                        opt = torch.optim.Adam(net.parameters(), lr=a.lr)
                        best["bad_streak"] = 0
                        best["rollbacks"] += 1
                        rec["rollback_to"] = best["iter"]
                        torch.save(dict(model=net.state_dict(), config=net.config, encoder_version=ver,
                                        optim=opt.state_dict(), iteration=it), run / "latest.pt.tmp")
                        (run / "latest.pt.tmp").replace(run / "latest.pt")
                        say(f"rollback: {a.rollback_after} evaluations clearly below the best "
                            f"({best['score']:.0%}); reloaded best.pt from iteration {best['iter']}")
                    (run / "best.json").write_text(json.dumps(best))
                rec["best_iter"], rec["best_score"] = best["iter"], best["score"] if best["iter"] else None
            log_f.write(json.dumps(rec) + "\n")
            log_f.flush()
            ls = f"{rec['league_score']:.2f}" if rec["league_score"] is not None else "-"
            if rec["greedy_train_score"] is not None:
                ls += f"  vs-greedy {rec['greedy_train_score']:.2f} ({rec['greedy_share']:.0%} of data)"
            ev = "  ".join(f"{k[5:]}={v:.0%}" for k, v in rec.items()
                           if k.startswith("eval_") and isinstance(v, float))
            ev += "  ends " + " ".join(f"{t[:3]}{n}" for t, n in ends.items() if n)
            say(f"it {it:4d}  dec {D:5d}  games {rec['games']:4d}  len {rec['game_len']:5.1f}  "
                f"pg {rec['pg']:+.3f}  vf {rec['vf']:.3f}  ent {rec['ent']:.2f}  kl {rec['kl']:+.4f}  "
                f"clip {rec['clipfrac']:.2f}  vs-league {ls}  [{t_collect:.0f}s+{t_update:.0f}s]  {ev}")
    except KeyboardInterrupt:
        say("interrupted; latest.pt holds the last completed iteration")
    finally:
        for e in envs:
            e.close()
        log_f.close()
        txt_f.close()


if __name__ == "__main__":
    main()
