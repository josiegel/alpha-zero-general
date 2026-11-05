# Pax Renaissance for alpha-zero-general

This folder plugs the Pax Renaissance 2E rules engine in `../Pax Renaissance` (JavaScript) into this repo's `Coach` / `MCTS` / `Arena`.

```
python main_pax.py                                           # train from scratch
python main_pax.py --init "Pax Renaissance/runs/ppo2/best.pt"   # start from the PPO-trained net
python main_pax.py --load                                    # resume ./temp/pax/best.pth.tar
python -m paxrenaissance.test_pax 2 8                        # smoke test (no PyTorch needed)
```

Run these from the repo root. You need Node.js on `PATH` and PyTorch, numpy, tqdm and coloredlogs.

## How it fits

| Piece | File |
|---|---|
| Node server that stores immutable game-tree nodes, so MCTS can branch from any position | `Pax Renaissance/tools/azserver.mjs` |
| Python client; `PaxBoard` is a handle to a node, with its encodings fetched lazily | `PaxBridge.py` |
| `Game` implementation | `PaxGame.py` |
| `NeuralNet` wrapper around `PaxNet` from `Pax Renaissance/train/model.py` | `pytorch/NNet.py` |
| Random player and terminal player for `Arena` / `pit.py` | `PaxPlayers.py` |
| Training entry point with Pax-sized defaults | `../main_pax.py` |

### Mapping decisions

- **Actions.** Every engine decision is a list of k legal options, each with a 244-feature encoding. Action `i` means option `i`. `getActionSize()` is a cap of 64. The largest decision seen in 320 test games had 28 options. Options past the cap are not offered, and `game.truncated` counts how often that happens.
- **Network.** `PaxNet` scores each option from the 3,825-float observation and the option's features, so the policy head handles any k. The network's policy is a softmax over the k options, padded with zeros to 64. Training uses cross-entropy against the MCTS visit distribution plus the MSE of the value.
- **Non-alternating turns.** A player makes several decisions per turn, and the opponent sometimes answers mid-turn (taxes, for example). `getNextState` returns `player` when the same seat decides again and `-player` otherwise. `MCTS.py` was changed to keep the value's sign when `next_player == 1`. Existing games always alternate, so they behave exactly as before.
- **Hidden information.** Encodings never include deck order or face-down cards that were never seen. With `determinize=True` (the default), `getCanonicalForm` re-deals hidden cards and the RNG from the mover's point of view before each search. Search therefore can't see future draws. The re-dealt position is checked to look identical to the mover: same observation and same option list. Children of a canonical board aren't re-dealt again, so each search runs in one consistent sampled world. `--no-determinize` turns this off, which is faster but lets search see hidden cards.
- **Results.** Win +1, loss −1. A game that hits `max_decisions` (3,000) is a draw (1e-4). Random games end in about 85 decisions.
- **Memory.** Training examples are stored without their server handle (`getSymmetries` returns `board.detached()`). Each example holds about 25 KB of encodings.

### Throughput

With a dummy network, a 50-simulation self-play game takes about 2 s of engine and bridge time on one CPU core. The real network's forward pass (about 1 ms on CPU) usually dominates, so expect around 4,000 predictions per game.
