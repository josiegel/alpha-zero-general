"""Pax Renaissance (2nd edition, 2 players) for alpha-zero-general.

The rules engine is the JavaScript one in `Pax Renaissance/src/engine`, driven through a Node
process (see PaxBridge.py). How the game is mapped onto the Game interface:

* Board: a PaxBoard, a handle to a position in the Node process plus lazily fetched encodings
  (`obs` [3825] for the position, `opts` [k, 244] for the k legal options). The network scores
  options from their features, so action i means "option i of the current decision".
* Actions: getActionSize() is a fixed cap (MAX_ACTIONS); only the first k are valid. Options past
  the cap are never offered (this is rare; see `truncated`).
* Players: seat 0 is player 1, seat 1 is player -1. Pax is not strictly alternating: a player makes
  several decisions per turn, and the opponent sometimes answers mid-turn (taxes etc.). So
  getNextState returns `player` when the same seat decides again and `-player` otherwise. MCTS.py
  in this repo keeps the value's sign when the mover does not change.
* Canonical form: the encodings are already from the mover's point of view, so the canonical board
  is the same position. With `determinize=True`, getCanonicalForm of a real (non-canonical) board
  re-deals everything the mover cannot know (deck order, unseen face-down cards, RNG), so search
  cannot peek at future draws. Children of canonical boards are canonical and are not re-dealt, so
  each search runs in one consistent sampled world.
* Results: +1 / -1 for the mover of the board passed in; a game that hits `max_decisions` is a draw.
"""
from __future__ import annotations

import logging
import random
import sys
from collections import OrderedDict
from pathlib import Path

import numpy as np

sys.path.append(str(Path(__file__).resolve().parent.parent))
from Game import Game  # noqa: E402

from .PaxBridge import PaxBoard, PaxBridge  # noqa: E402

log = logging.getLogger(__name__)

MAX_ACTIONS = 64  # largest decision seen in 300 random + 20 greedy games: 28 options
DRAW = 1e-4


class PaxGame(Game):
    def __init__(self, max_actions: int = MAX_ACTIONS, max_decisions: int = 3000, determinize: bool = True,
                 seed: int | None = None, cache_size: int = 2048, node: str | None = None):
        super().__init__()
        self.max_actions = max_actions
        self.max_decisions = max_decisions
        self.determinize = determinize
        self.rng = random.Random(seed)
        self.bridge = PaxBridge(node)
        # (position key, canonical, action) -> child. Saves a server round trip when MCTS walks an
        # edge again, and keeps recently used positions alive in the server.
        self._cache: OrderedDict = OrderedDict()
        self._cache_size = cache_size
        self.truncated = 0  # decisions seen with more than max_actions options
        probe = self.bridge.new_game(0, max_decisions)
        self.obs_size, self.opt_size, self.num_cards = probe.obs_size, probe.opt_size, probe.num_cards

    # ---- Game interface ----
    def getInitBoard(self) -> PaxBoard:
        return self.bridge.new_game(self.rng.getrandbits(32), self.max_decisions)

    def getBoardSize(self):
        return (self.obs_size,)

    def getActionSize(self) -> int:
        return self.max_actions

    def getNextState(self, board: PaxBoard, player: int, action: int):
        key = (board.key, board.canonical, int(action))
        child = self._cache.get(key)
        if child is None:
            if not 0 <= action < min(board.k, self.max_actions):
                raise ValueError(f"invalid action {action} for {board}")
            child = self.bridge.step(board, action)
            self._cache[key] = child
            if len(self._cache) > self._cache_size:
                self._cache.popitem(last=False)
        else:
            self._cache.move_to_end(key)
        return child, (player if child.player == board.player else -player)

    def getValidMoves(self, board: PaxBoard, player: int) -> np.ndarray:
        v = np.zeros(self.max_actions, dtype=np.float32)
        if board.k > self.max_actions:
            self.truncated += 1
            if self.truncated == 1:
                log.warning("decision with %d options exceeds max_actions=%d; extra options are not offered",
                            board.k, self.max_actions)
        v[: min(board.k, self.max_actions)] = 1
        return v

    def getGameEnded(self, board: PaxBoard, player: int) -> float:
        # `player` is always the sign of board.player in Coach, Arena and MCTS, so the result is
        # given for the board's mover.
        if not board.ended:
            return 0
        if len(board.winners) == 1:
            return 1 if board.winners[0] == board.player else -1
        return DRAW

    def getCanonicalForm(self, board: PaxBoard, player: int) -> PaxBoard:
        if board.canonical:
            return board
        if self.determinize and not board.ended:
            return self.bridge.determinize(board, self.rng.getrandbits(32))
        return board.as_canonical()

    def getSymmetries(self, board: PaxBoard, pi):
        # No symmetries. Coach stores what this returns as a training example, so hand it a copy
        # without the server handle; otherwise every stored example keeps its position alive in Node.
        return [(board.detached(), pi)]

    def stringRepresentation(self, board: PaxBoard) -> str:
        return board.key

    # ---- helpers ----
    @staticmethod
    def seat_to_player(seat: int) -> int:
        return 1 if seat == 0 else -1

    def display(self, board: PaxBoard):
        if board.ended:
            print(f"Game over after {board.decisions} decisions: winners {board.winners} ({board.reason})")
            return
        info = self.bridge.labels(board)
        for line in info["log"]:
            print("  |", line)
        print(f"[{board.decisions}] P{board.player + 1}: {info['prompt']}")
        for i, lab in enumerate(info["options"][: self.max_actions]):
            print(f"   {i:3d}. {lab}")
