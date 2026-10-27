"""Configuration — COMPLETE. Nothing to implement here.

Deliberately small defaults: a ~1M-parameter model that trains on a few MB of
text in minutes on a CPU. Small enough to understand completely, real enough to
generate text. Grow these only after the stage tests pass — a bigger model does
not teach you more, it just fails more slowly.
"""
from __future__ import annotations

import os
from dataclasses import dataclass


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class Config:
    # model
    block_size: int = _int("BLOCK_SIZE", 128)      # context length in tokens
    n_layer: int = _int("N_LAYER", 4)              # transformer blocks
    n_head: int = _int("N_HEAD", 4)                # attention heads per block
    n_embd: int = _int("N_EMBD", 128)              # embedding width
    vocab_size: int = _int("VOCAB_SIZE", 512)      # set by your tokenizer (Stage 1)
    dropout: float = _float("DROPOUT", 0.0)

    # training
    batch_size: int = _int("BATCH_SIZE", 32)
    learning_rate: float = _float("LEARNING_RATE", 3e-4)
    max_iters: int = _int("MAX_ITERS", 2000)
    warmup_iters: int = _int("WARMUP_ITERS", 100)
    grad_clip: float = _float("GRAD_CLIP", 1.0)
    eval_interval: int = _int("EVAL_INTERVAL", 250)

    # environment
    device: str = os.environ.get("DEVICE", "cpu")
    seed: int = _int("SEED", 1337)
    data_dir: str = os.environ.get("DATA_DIR", "/data")
    checkpoint_dir: str = os.environ.get("CHECKPOINT_DIR", "/checkpoints")

    def __post_init__(self) -> None:
        if self.n_embd % self.n_head:
            raise ValueError(
                f"n_embd ({self.n_embd}) must divide evenly by n_head ({self.n_head}) — "
                "each head takes an equal slice of the embedding."
            )


CONFIG = Config()
