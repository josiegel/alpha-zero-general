"""Smoke test without PyTorch: Arena games of MCTS (uniform prior, random value) vs random.

    python -m paxrenaissance.test_pax [games] [sims]
"""
import sys
import time

import numpy as np

from Arena import Arena
from Coach import Coach
from MCTS import MCTS
from utils import dotdict
from paxrenaissance.PaxGame import PaxGame
from paxrenaissance.PaxPlayers import RandomPlayer


class UniformNet:
    def __init__(self, game):
        self.n = game.getActionSize()

    def predict(self, board):
        pi = np.zeros(self.n, dtype=np.float32)
        pi[:min(board.k, self.n)] = 1
        return pi / max(pi.sum(), 1), float(np.random.uniform(-0.1, 0.1))


def main():
    games = int(sys.argv[1]) if len(sys.argv) > 1 else 2
    sims = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    g = PaxGame(seed=1)
    args = dotdict({'numMCTSSims': sims, 'cpuct': 1.0, 'tempThreshold': 10})

    # one self-play episode through Coach (checks value bookkeeping and pickling of boards)
    t = time.time()
    coach = Coach.__new__(Coach)
    coach.game, coach.args = g, args
    coach.mcts = MCTS(g, UniformNet(g), args)
    ex = coach.executeEpisode()
    import pickle
    ex2 = pickle.loads(pickle.dumps(ex[:50]))
    assert ex2[0][0].obs.shape == (g.obs_size,) and ex2[0][0].opts.shape[1] == g.opt_size
    vals = {round(e[2], 4) for e in ex}
    print(f"self-play episode: {len(ex)} examples, values {vals}, {time.time() - t:.1f}s, "
          f"{g.bridge.calls} server calls, truncated decisions {g.truncated}")

    rp = RandomPlayer(g).play
    mcts = MCTS(g, UniformNet(g), args)
    arena = Arena(lambda b: int(np.argmax(mcts.getActionProb(b, temp=0))), rp, g)
    t = time.time()
    print("mcts vs random (won, lost, drawn):", arena.playGames(games), f"{time.time() - t:.1f}s")


if __name__ == '__main__':
    main()
