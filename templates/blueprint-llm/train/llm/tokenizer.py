"""STAGE 1 — Tokenization.

A tokenizer is an invertible map between text and a list of ints, plus a
vocabulary size. See CURRICULUM.md -> Stage 1.

YOUR CONTRACT
    train(text: str, vocab_size: int) -> None
        Learn merges from `text` until the vocabulary reaches `vocab_size`.
    encode(text: str) -> list[int]
    decode(ids: list[int]) -> str
        Must round-trip EXACTLY: decode(encode(s)) == s for any s.
    vocab_size -> int
        The real size after training.

WHAT TO IMPLEMENT (byte-pair encoding)
    1. Start from raw bytes (256 base tokens).
    2. Count every adjacent pair in the token stream.
    3. Merge the most frequent pair into one new token id.
    4. Repeat until you reach vocab_size. Record merges in order —
       encode replays them, decode inverts them.

Flip IMPLEMENTED to True when yours is real.
"""
from __future__ import annotations

IMPLEMENTED = False


class Tokenizer:
    """PLACEHOLDER: raw UTF-8 bytes.

    It works and it round-trips, which is why the pipeline runs. It is also
    bad in a way worth feeling: nothing is shared between "run" and "running",
    and a sequence is as long as the text is in bytes, so your 128-token
    context holds about 128 characters instead of ~128 words.
    """

    def __init__(self, vocab_size: int = 256) -> None:
        self._target = vocab_size
        self.merges: list[tuple[int, int]] = []

    def train(self, text: str, vocab_size: int | None = None) -> None:
        # Placeholder learns nothing — bytes need no training.
        self._target = vocab_size or self._target

    def encode(self, text: str) -> list[int]:
        return list(text.encode("utf-8"))

    def decode(self, ids: list[int]) -> str:
        return bytes(ids).decode("utf-8", errors="replace")

    @property
    def vocab_size(self) -> int:
        return 256
