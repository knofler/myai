"""STAGE 3 — Self-attention. The one that matters.

Each position forms a QUERY; every position offers a KEY and a VALUE. Score
each query against all keys, softmax the scores into weights, and output the
weighted sum of values. That is how position 9 reads position 2 directly, with
no recurrence and in one parallel step.

CAUSAL MASKING is what stops the model cheating: before the softmax, set every
score for a FUTURE position to -inf, so position t can only attend to <= t.
Get this wrong and your loss will look wonderful and your model will be
worthless, because it has been reading the answer.

See CURRICULUM.md -> Stage 3.

YOUR CONTRACT
    MultiHeadAttention(n_embd, n_head, block_size, dropout=0.0)
    forward(x) -> same shape as x, i.e. (B, T, n_embd)

WHAT TO IMPLEMENT
    softmax(Q @ K.T / sqrt(d_k) + causal_mask) @ V
    with n_head heads computed in parallel and concatenated, then projected.
    d_k = n_embd // n_head.

THE TEST THAT CATCHES THE REAL BUG
    Changing token t+1 must NOT change the output at position t.
    If it does, your mask is wrong. Everything else can look fine.
"""
from __future__ import annotations

IMPLEMENTED = False


class MultiHeadAttention:
    """PLACEHOLDER: returns its input unchanged (identity).

    With no attention the model degenerates into a per-position lookup table:
    it can learn letter frequencies and nothing whatsoever about context.
    """

    def __init__(self, n_embd: int, n_head: int, block_size: int, dropout: float = 0.0) -> None:
        if n_embd % n_head:
            raise ValueError("n_embd must divide evenly by n_head")
        self.n_embd, self.n_head, self.block_size = n_embd, n_head, block_size
        self.head_dim = n_embd // n_head
        self.dropout = dropout

    def forward(self, x):
        return x

    __call__ = forward
