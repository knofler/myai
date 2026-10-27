"""STAGE 8 — Evaluation.

"It sounds good" is not a measurement. PERPLEXITY = exp(cross-entropy) on
HELD-OUT text is the standard one. Intuition: roughly how many tokens the model
is effectively choosing between at each step. An untrained model scores about
vocab_size (it is choosing uniformly); a trained one should score far lower.

It must be computed on data the model never trained on. Perplexity on the
training set measures memorisation, which you already know it can do.

See CURRICULUM.md -> Stage 8.

YOUR CONTRACT
    perplexity(model, dataset, split="val", iters=50) -> float
    Deterministic: same data twice gives the same number.

Run with: ./dev eval
"""
from __future__ import annotations

from .config import CONFIG
from .data import Dataset
from .model import GPT
from .tokenizer import Tokenizer

IMPLEMENTED = False


def perplexity(model, dataset, split: str = "val", iters: int = 50) -> float:
    """PLACEHOLDER: returns 0.0.

    0.0 is the most suspicious possible number — a perfect model that has never
    been trained. It is meant to annoy you into implementing this stage. A real
    untrained model scores ~vocab_size.
    """
    return 0.0


if __name__ == "__main__":
    tok = Tokenizer(CONFIG.vocab_size)
    ds = Dataset()
    ds.load(CONFIG.data_dir, tok)
    ppl = perplexity(GPT(CONFIG, vocab_size=tok.vocab_size), ds)
    print(f"[eval] perplexity = {ppl:.2f}   (vocab_size = {tok.vocab_size})")
    print("[eval] PLACEHOLDER — 0.0 is not a real score. Implement Stage 8.")
