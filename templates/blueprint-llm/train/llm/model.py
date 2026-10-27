"""STAGE 5 — The full model.

Token embeddings + POSITIONAL information (attention on its own is
permutation-blind — it cannot tell "dog bites man" from "man bites dog"),
then N blocks, a final norm, and a linear projection to vocabulary logits.
Loss is cross-entropy against the next token.

See CURRICULUM.md -> Stage 5.

YOUR CONTRACT
    GPT(config)
    forward(idx, targets=None) -> (logits, loss)
        logits shaped (B, T, vocab_size)
        loss is None when targets is None, else scalar cross-entropy.

THE TWO NUMBERS THAT TELL YOU IT IS RIGHT
    1. Initial loss ~= ln(vocab_size). An untrained model should be uniformly
       uncertain; for vocab 512 that is ~6.24. Far off means your init is
       broken.
    2. It can OVERFIT A SINGLE BATCH to near-zero loss. This is the most
       useful test in the whole repo. A model that cannot overfit one batch
       has a bug — always. Check it before you ever start a long run.
"""
from __future__ import annotations

import math
import random

from .block import Block
from .config import Config

IMPLEMENTED = False


class GPT:
    """PLACEHOLDER: uniform random logits.

    Serveable and completely ignorant, which is the point — the pipeline runs
    end to end on day one. Its loss sits at ln(vocab_size), the number your
    real implementation has to beat.
    """

    def __init__(self, config: Config, vocab_size: int | None = None) -> None:
        # CONTRACT: vocab_size belongs to the TOKENIZER, not to the config.
        # config.vocab_size is only the TARGET you hand to BPE in Stage 1; the
        # real size is whatever the trained tokenizer ended up with. Anything
        # downstream that has a tokenizer must pass tok.vocab_size here.
        #
        # Getting this wrong is not theoretical: the placeholder model first
        # emitted logits over config.vocab_size (512) while the placeholder
        # tokenizer's vocab was 256, so argmax could pick id >= 256 and the
        # byte decoder raised "bytes must be in range(0, 256)". Keep the two
        # in step and that entire class of bug disappears.
        self.config = config
        self.vocab_size = vocab_size if vocab_size is not None else config.vocab_size
        self.blocks = [
            Block(config.n_embd, config.n_head, config.block_size, config.dropout)
            for _ in range(config.n_layer)
        ]
        self._rng = random.Random(config.seed)

    def forward(self, idx, targets=None):
        rows = len(idx)
        cols = len(idx[0]) if rows else 0
        v = self.vocab_size
        logits = [[[self._rng.gauss(0.0, 0.02) for _ in range(v)] for _ in range(cols)] for _ in range(rows)]
        # Uniform logits => cross-entropy == ln(vocab_size). Stated honestly
        # rather than computed, because there is nothing here to compute yet.
        loss = math.log(v) if targets is not None else None
        return logits, loss

    __call__ = forward

    def num_params(self) -> int:
        return 0  # placeholder holds no parameters
