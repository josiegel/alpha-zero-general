import numpy as np


class RandomPlayer:
    """Uniformly random legal option."""

    def __init__(self, game):
        self.game = game

    def play(self, board):
        valids = self.game.getValidMoves(board, 1)
        return int(np.random.choice(np.flatnonzero(valids)))


class HumanPaxPlayer:
    """Plays from the terminal: lists the options and reads an index."""

    def __init__(self, game):
        self.game = game

    def play(self, board):
        self.game.display(board)
        n = min(board.k, self.game.getActionSize())
        while True:
            a = input(f"option [0-{n - 1}]: ").strip()
            if a.isdigit() and int(a) < n:
                return int(a)
