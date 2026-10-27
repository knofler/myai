"""STAGE 2 — Data & batching.

The model always predicts the NEXT token, so training data is `(x, y)` pairs
where y is x shifted by one. See CURRICULUM.md -> Stage 2.

YOUR CONTRACT
    load(data_dir: str, tokenizer) -> None
        Read the corpus, encode it, split into train/val.
    get_batch(split: str, batch_size: int, block_size: int) -> (x, y)
        x, y each shaped (batch_size, block_size).
        y[i][t] == x[i][t + 1] — exactly one step of shift.
        Windows sampled at RANDOM offsets, so successive calls differ.
        Train and val windows must never overlap.

WHY THE SHIFT IS THE WHOLE TRICK
    One forward pass over a length-T window produces T next-token predictions,
    not one. That is what makes language modelling trainable at scale.
"""
from __future__ import annotations

import os

IMPLEMENTED = False


class Dataset:
    """PLACEHOLDER: returns the same single window every call.

    The model will memorise one sentence and learn nothing about language.
    Loss will drop to ~0 and mean nothing — a useful lesson in why a falling
    loss is not evidence of anything on its own.
    """

    def __init__(self) -> None:
        self.train_ids: list[int] = []
        self.val_ids: list[int] = []

    def load(self, data_dir: str, tokenizer) -> None:
        text = ""
        if os.path.isdir(data_dir):
            for name in sorted(os.listdir(data_dir)):
                if name.endswith((".txt", ".md")):
                    with open(os.path.join(data_dir, name), encoding="utf-8", errors="replace") as fh:
                        text += fh.read()
        if not text:
            text = "the quick brown fox jumps over the lazy dog. " * 64
        ids = tokenizer.encode(text)
        cut = int(0.9 * len(ids))
        self.train_ids, self.val_ids = ids[:cut], ids[cut:]

    def get_batch(self, split: str, batch_size: int, block_size: int):
        ids = self.train_ids if split == "train" else self.val_ids
        if len(ids) < block_size + 1:
            ids = (ids * (block_size * 2 // max(len(ids), 1) + 2))
        # Placeholder: offset 0, every time, for every row in the batch.
        x = [ids[0:block_size] for _ in range(batch_size)]
        y = [ids[1:block_size + 1] for _ in range(batch_size)]
        return x, y
