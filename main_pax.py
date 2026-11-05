"""AlphaZero self-play training for Pax Renaissance (see paxrenaissance/README.md).

    python main_pax.py                       # train from scratch
    python main_pax.py --init "Pax Renaissance/runs/ppo2/best.pt"   # start from the PPO network
"""
import argparse
import logging

import coloredlogs

from Coach import Coach
from paxrenaissance.PaxGame import PaxGame
from paxrenaissance.pytorch.NNet import NNetWrapper as nn
from utils import dotdict

log = logging.getLogger(__name__)
coloredlogs.install(level='INFO')

args = dotdict({
    'numIters': 1000,
    'numEps': 50,               # self-play games per iteration (a game is ~70-120 decisions)
    'tempThreshold': 30,        # decisions played with temperature 1 before switching to arg-max
    'updateThreshold': 0.55,
    'maxlenOfQueue': 50000,     # each example holds the encoded position and options (~25 KB)
    'numMCTSSims': 50,
    # Games to pit the new net against the previous one. Pax is high-variance: at 20 games the
    # 95% margin on the win rate is about ±0.22, so the 0.55 threshold would accept or reject a
    # net mostly by luck. At 100 it is about ±0.10. Costs roughly 12 s per game at 50 sims.
    'arenaCompare': 100,
    'cpuct': 1.5,
    'checkpoint': './temp/pax/',
    'load_model': False,
    'load_folder_file': ('./temp/pax/', 'best.pth.tar'),
    'numItersForTrainExamplesHistory': 5,
})


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--init', help='PPO checkpoint (Pax Renaissance/train/ppo.py) to start from')
    p.add_argument('--load', action='store_true', help='resume from args.load_folder_file')
    p.add_argument('--no-determinize', action='store_true', help='let search see hidden cards (faster, but it cheats)')
    p.add_argument('--sims', type=int)
    p.add_argument('--eps', type=int)
    p.add_argument('--arena', type=int, help='games per new-vs-previous comparison (default 100)')
    a = p.parse_args()
    if a.arena:
        args.arenaCompare = a.arena
    if a.sims:
        args.numMCTSSims = a.sims
    if a.eps:
        args.numEps = a.eps
    args.load_model = a.load

    g = PaxGame(determinize=not a.no_determinize)
    nnet = nn(g)
    if a.init:
        log.info('Initialising from PPO checkpoint %s', a.init)
        nnet.load_ppo(a.init)
    if args.load_model:
        nnet.load_checkpoint(*args.load_folder_file)

    c = Coach(g, nnet, args)
    if args.load_model:
        c.loadTrainExamples()
    log.info('Starting the learning process 🎉')
    c.learn()


if __name__ == '__main__':
    main()
