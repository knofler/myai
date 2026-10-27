"""Stage tracker — COMPLETE. `./dev stage` runs this.

The registry is the single source of truth for "where am I": the test suite
reads it to decide what to skip, and this module prints it. A stage counts as
done when its module sets IMPLEMENTED = True *and* its test passes.
"""
from __future__ import annotations

import importlib

STAGES = [
    (1, "tokenizer", "Tokenization", "raw bytes, vocab 256"),
    (2, "data", "Data & batching", "one repeated window"),
    (3, "attention", "Self-attention", "returns its input unchanged"),
    (4, "block", "Transformer block", "attention with no MLP"),
    (5, "model", "The full model", "random logits"),
    (6, "train", "Training loop", "saves an untrained checkpoint"),
    (7, "sample", "Sampling", "argmax, no temperature"),
    (8, "eval", "Evaluation", "always reports 0.0"),
]


def implemented(module_name: str) -> bool:
    """True when the learner has flipped IMPLEMENTED in that stage module."""
    try:
        mod = importlib.import_module(f"llm.{module_name}")
    except Exception:
        return False
    return bool(getattr(mod, "IMPLEMENTED", False))


def main() -> None:
    done = []
    todo = []
    for num, mod, title, placeholder in STAGES:
        (done if implemented(mod) else todo).append((num, mod, title, placeholder))

    width = 62
    print("=" * width)
    print(f"  LLM from scratch — stage {len(done)}/{len(STAGES)} complete")
    print("=" * width)
    for num, mod, title, _ in done:
        print(f"  [x] Stage {num}  {title:<22} train/llm/{mod}.py")
    for i, (num, mod, title, placeholder) in enumerate(todo):
        marker = "-->" if i == 0 else "[ ]"
        print(f"  {marker} Stage {num}  {title:<22} train/llm/{mod}.py")
        if i == 0:
            print(f"        currently: {placeholder}")
    print("=" * width)
    if todo:
        nxt = todo[0]
        print(f"  NEXT: Stage {nxt[0]} — {nxt[2]}")
        print(f"    1. read CURRICULUM.md -> 'Stage {nxt[0]}'")
        print(f"    2. read the docstring in train/llm/{nxt[1]}.py (it states the contract)")
        print("    3. write it yourself first; ask the agent to REVIEW, not to author")
        print(f"    4. set IMPLEMENTED = True, then ./dev test")
    else:
        print("  All eight stages done. You built a language model.")
        print("  Try: ./dev train && ./dev eval && ./dev sample \"Once upon\"")
    print()


if __name__ == "__main__":
    main()
