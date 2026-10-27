"""STAGE 4 — The transformer block.

Attention mixes information ACROSS positions. A per-position MLP then gives the
model room to compute WITH what it gathered. Residual connections and layer
norm are what let you stack these deeply without the gradients dying.

Pre-norm — normalise BEFORE the sublayer, add the residual after — trains more
easily than the original post-norm arrangement:

    x = x + attn(norm1(x))
    x = x + mlp(norm2(x))

See CURRICULUM.md -> Stage 4.

YOUR CONTRACT
    Block(n_embd, n_head, block_size, dropout=0.0)
    forward(x) -> same shape as x

WHAT TO IMPLEMENT
    Two layer norms, the attention sublayer, and an MLP that widens by ~4x
    (n_embd -> 4*n_embd -> n_embd) with a GELU between. Both sublayers wrapped
    in residual adds.
"""
from __future__ import annotations

from .attention import MultiHeadAttention

IMPLEMENTED = False


class Block:
    """PLACEHOLDER: attention only — no MLP, no norm, no residual.

    Stack a few of these and watch the activations drift: the missing residual
    path is exactly why deep stacks stopped training before 2015.
    """

    def __init__(self, n_embd: int, n_head: int, block_size: int, dropout: float = 0.0) -> None:
        self.attn = MultiHeadAttention(n_embd, n_head, block_size, dropout)
        self.n_embd = n_embd

    def forward(self, x):
        return self.attn(x)

    __call__ = forward
