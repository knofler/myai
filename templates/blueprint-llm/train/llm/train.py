"""STAGE 6 — The training loop.

Sample a batch, forward, backward, step, repeat. The loop itself is four lines;
the parts that decide whether it actually works are the unglamorous ones:

  * LR WARMUP then decay — a cold model takes a huge first step and diverges.
  * GRADIENT CLIPPING — one bad batch can otherwise wreck the run.
  * PERIODIC VALIDATION LOSS — the only way to see overfitting begin. Compute
    it with gradients OFF, or you are training on your validation set.

See CURRICULUM.md -> Stage 6.

YOUR CONTRACT
    train(config) -> dict   # the history you want to plot
    Save the best-validation-loss checkpoint to config.checkpoint_dir.
    A saved checkpoint must reload to IDENTICAL logits.

Run with: ./dev train
"""
from __future__ import annotations

import json
import os

from .config import CONFIG, Config
from .data import Dataset
from .model import GPT
from .tokenizer import Tokenizer

IMPLEMENTED = False


def train(config: Config = CONFIG) -> dict:
    """PLACEHOLDER: writes an untrained checkpoint and returns immediately.

    It exists so serve/ has something to load on a fresh clone — the pipeline
    is end-to-end from minute one. It does not train anything.
    """
    tok = Tokenizer(config.vocab_size)
    ds = Dataset()
    ds.load(config.data_dir, tok)
    model = GPT(config, vocab_size=tok.vocab_size)

    os.makedirs(config.checkpoint_dir, exist_ok=True)
    path = os.path.join(config.checkpoint_dir, "model.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(
            {
                "trained": False,
                "note": "Placeholder checkpoint — Stage 6 is not implemented.",
                "vocab_size": tok.vocab_size,
                "block_size": config.block_size,
                "n_layer": config.n_layer,
                "n_head": config.n_head,
                "n_embd": config.n_embd,
                "train_tokens": len(ds.train_ids),
                "val_tokens": len(ds.val_ids),
            },
            fh,
            indent=2,
        )

    print(f"[train] PLACEHOLDER — wrote untrained checkpoint to {path}")
    print(f"[train] corpus: {len(ds.train_ids)} train / {len(ds.val_ids)} val tokens")
    print("[train] implement Stage 6 in train/llm/train.py to actually train.")
    return {"iters": 0, "train_loss": [], "val_loss": [], "trained": False}


if __name__ == "__main__":
    train()
