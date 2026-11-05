"""Client for `Pax Renaissance/tools/azserver.mjs`, the Node game-tree server.

The rules engine is JavaScript, so the Python side only holds handles to positions stored in the
Node process. A `PaxBoard` is one position: it knows who is to move, how many options there are and
whether the game has ended. Its encodings (`obs`, `opts`) are fetched lazily, because MCTS only
needs them at the leaves it expands. When the last board referring to a position is garbage
collected, the position is freed in Node.

Pickling a board (as Coach does when it saves training examples) keeps the encodings and drops the
handle, so an unpickled board can be trained on but not played from.
"""
from __future__ import annotations

import json
import shutil
import struct
import subprocess
import threading
import weakref
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent.parent
ENGINE_DIR = REPO / "Pax Renaissance"
SERVER = ENGINE_DIR / "tools" / "azserver.mjs"


class _Handle:
    """Owns one node id in the server; frees it when garbage collected."""
    __slots__ = ("bridge", "id", "__weakref__")

    def __init__(self, bridge: "PaxBridge", node_id: int):
        self.bridge = bridge
        self.id = node_id
        weakref.finalize(self, bridge._release, node_id)


class PaxBoard:
    """One Pax Renaissance position (see module docstring).

    player:    seat (0 or 1) to move; for an ended game, the seat that made the last decision
    k:         number of legal options
    ended:     game over (or the decision cap was hit, which counts as a draw)
    winners:   list of winning seats (empty unless the game ended with a winner)
    key:       position hash, used by MCTS as stringRepresentation
    canonical: True for boards handed to a search (see PaxGame.getCanonicalForm)
    """

    def __init__(self, handle, header: dict, canonical: bool = False, body=None):
        self._handle = handle
        self.player = header["player"]
        self.k = header["k"]
        self.ended = header["ended"]
        self.winners = header["winners"]
        self.reason = header["reason"]
        self.decisions = header["decisions"]
        self.key = header["key"]
        self.obs_size = header["obs_size"]
        self.opt_size = header["opt_size"]
        self.num_cards = header["num_cards"]
        self.canonical = canonical
        self._obs = self._opts = None
        if body is not None:
            self._set_body(body)

    def _set_body(self, body: np.ndarray):
        self._obs = body[: self.obs_size]
        self._opts = body[self.obs_size:].reshape(self.k, self.opt_size)

    def _load(self):
        if self._obs is None:
            if self._handle is None:
                raise RuntimeError("board has no encodings and no server handle")
            _, body = self._handle.bridge.request({"cmd": "encode", "id": self._handle.id})
            self._set_body(body)

    @property
    def obs(self) -> np.ndarray:
        """float32 [obs_size]: the position from the mover's point of view."""
        self._load()
        return self._obs

    @property
    def opts(self) -> np.ndarray:
        """float32 [k, opt_size]: one feature row per legal option, in action-index order."""
        self._load()
        return self._opts

    @property
    def node_id(self) -> int:
        if self._handle is None:
            raise RuntimeError("this board was unpickled and is no longer attached to a game server")
        return self._handle.id

    def as_canonical(self) -> "PaxBoard":
        b = object.__new__(PaxBoard)
        b.__dict__.update(self.__dict__)
        b.canonical = True
        return b

    def detached(self) -> "PaxBoard":
        """Copy holding only the encodings (for training examples), so the server can free the node."""
        self._load()
        b = object.__new__(PaxBoard)
        b.__dict__.update(self.__dict__)
        b._handle = None
        return b

    def __getstate__(self):
        if self._handle is not None:
            self._load()
        d = dict(self.__dict__)
        d["_handle"] = None
        return d

    def __setstate__(self, d):
        self.__dict__.update(d)

    def __repr__(self):
        state = f"ended winners={self.winners} ({self.reason})" if self.ended else f"seat {self.player} to move, {self.k} options"
        return f"<PaxBoard #{self.decisions}: {state}>"


class PaxBridge:
    def __init__(self, node: str | None = None):
        node = node or shutil.which("node") or "node"
        self.proc = subprocess.Popen([node, str(SERVER)], cwd=str(ENGINE_DIR), stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, bufsize=0)
        self._lock = threading.Lock()
        # One _Handle per live node id: the server returns an existing child when an edge is
        # stepped again, and two owners of one id would free it while the other still uses it.
        self._handles: weakref.WeakValueDictionary = weakref.WeakValueDictionary()
        self._to_free: set[int] = set()
        self.calls = 0

    # ---- public API ----
    def new_game(self, seed: int, max_decisions: int, encode: bool = False) -> PaxBoard:
        return self._node({"cmd": "new", "seed": int(seed), "max_decisions": int(max_decisions), "encode": encode})

    def step(self, board: PaxBoard, action: int, encode: bool = False) -> PaxBoard:
        return self._node({"cmd": "step", "id": board.node_id, "a": int(action), "encode": encode}, board.canonical)

    def determinize(self, board: PaxBoard, seed: int, tries: int = 8) -> PaxBoard:
        h, body = self.request({"cmd": "determinize", "id": board.node_id, "seed": int(seed) & 0xFFFFFFFF, "tries": tries})
        if h["id"] == board.node_id:  # no re-deal passed the consistency check: keep the true position
            return board.as_canonical()
        return PaxBoard(self._handle(h["id"]), h, True, body if len(body) else None)

    def labels(self, board: PaxBoard) -> dict:
        h, _ = self.request({"cmd": "labels", "id": board.node_id})
        return h

    def close(self):
        if self.proc.poll() is None:
            try:
                self.proc.stdin.write(b'{"cmd":"close"}\n')
                self.proc.stdin.flush()
                self.proc.wait(timeout=5)
            except (OSError, ValueError, subprocess.TimeoutExpired):
                self.proc.kill()

    # ---- internals ----
    def _node(self, cmd: dict, canonical: bool = False) -> PaxBoard:
        h, body = self.request(cmd)
        return PaxBoard(self._handle(h["id"]), h, canonical, body if len(body) else None)

    def _handle(self, node_id: int) -> _Handle:
        hd = self._handles.get(node_id)
        if hd is None:
            self._to_free.discard(node_id)  # its old handle died, but the server still has it
            hd = self._handles[node_id] = _Handle(self, node_id)
        return hd

    def _release(self, node_id: int):
        self._to_free.add(node_id)  # sent with the next request (finalizers must not do I/O)

    def request(self, cmd: dict):
        with self._lock:
            msg = b""
            if len(self._to_free) >= 256:
                ids, self._to_free = sorted(self._to_free), set()
                msg += (json.dumps({"cmd": "free", "ids": ids}) + "\n").encode()
            msg += (json.dumps(cmd) + "\n").encode()
            self.proc.stdin.write(msg)
            self.proc.stdin.flush()
            (hlen,) = struct.unpack("<I", self._readn(4))
            h = json.loads(self._readn(hlen))
            (blen,) = struct.unpack("<I", self._readn(4))
            body = np.frombuffer(self._readn(blen), dtype="<f4") if blen else np.zeros(0, np.float32)
            self.calls += 1
            return h, body

    def _readn(self, n: int) -> bytearray:
        buf = bytearray()
        while len(buf) < n:
            chunk = self.proc.stdout.read(n - len(buf))
            if not chunk:
                raise RuntimeError(f"azserver exited (code {self.proc.poll()}); see its stderr above")
            buf += chunk
        return buf
