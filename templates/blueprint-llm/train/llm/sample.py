"""STAGE 7 — Sampling.

Generation is a loop: forward the context, take the LAST position's logits,
turn them into a distribution, draw one token, append it, repeat.

The knobs are what make output readable:
  * TEMPERATURE divides the logits. ->0 sharpens to argmax; >1 flattens toward
    noise.
  * TOP-K keeps only the k most likely tokens.
  * TOP-P (nucleus) keeps the smallest set whose probability mass exceeds p.
Both truncations exist because the tail of a vocabulary distribution is mostly
garbage that you will nonetheless sample eventually.

Also: crop the context to block_size. The model has no opinion about tokens
beyond its context window and will error or silently misbehave.

See CURRICULUM.md -> Stage 7.

YOUR CONTRACT
    generate(model, tokenizer, prompt: str, max_new_tokens: int,
             temperature: float = 1.0, top_k: int | None = None,
             top_p: float | None = None, seed: int | None = None) -> str
    Exactly max_new_tokens appended; a fixed seed is reproducible.

Run with: ./dev sample "Once upon"
"""
from __future__ import annotations

import sys

from .config import CONFIG
from .model import GPT
from .tokenizer import Tokenizer

IMPLEMENTED = False


def generate(model, tokenizer, prompt: str, max_new_tokens: int = 100,
             temperature: float = 1.0, top_k: int | None = None,
             top_p: float | None = None, seed: int | None = None) -> str:
    """PLACEHOLDER: greedy argmax, no temperature, no truncation.

    Reads exactly as flat and repetitive as greedy decoding always does — a
    good thing to see before you implement the alternatives.
    """
    ids = tokenizer.encode(prompt)
    for _ in range(max_new_tokens):
        window = ids[-CONFIG.block_size:]
        logits, _ = model([window])
        last = logits[0][-1]
        ids.append(max(range(len(last)), key=last.__getitem__))
    return tokenizer.decode(ids)


if __name__ == "__main__":
    prompt = " ".join(sys.argv[1:]) or "Once upon"
    tok = Tokenizer(CONFIG.vocab_size)
    print(generate(GPT(CONFIG, vocab_size=tok.vocab_size), tok, prompt, max_new_tokens=60))
    print("\n[sample] PLACEHOLDER output (Stage 7 unimplemented, and the model is untrained).")
