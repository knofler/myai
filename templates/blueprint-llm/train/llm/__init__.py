"""A small language model, built one stage at a time.

Every module in this package is either COMPLETE (infrastructure — you should
not need to touch it) or a STAGE (a placeholder you replace). Each stage module
declares `IMPLEMENTED = False` at the top; flip it to True when your
implementation is real and the stage's test will stop skipping and start
holding you to it.

Run `python -m llm.stages` (or `./dev stage`) for your current position.
"""
__all__ = ["config", "tokenizer", "data", "attention", "block", "model", "train", "sample", "eval", "stages"]
