# Curriculum — eight stages to a working LLM

Each stage: the idea, the contract you implement, and how you know it works.
Nothing here contains the implementation. That is deliberate — the answer is
the part you are buying with your time.

**Order matters.** Every stage runs on top of the previous one, and the
pipeline stays runnable the whole way.

---

## Stage 1 — Tokenization · `train/llm/tokenizer.py`

**Idea.** A model sees integers, not text. A tokenizer is an invertible map
between a string and a list of ints, plus a vocabulary size. Every design
choice here is a trade: characters give a tiny vocab and long sequences; words
give a huge vocab and unknown-word problems; **subwords (BPE)** sit in between
and are what real models use.

**Placeholder.** Raw UTF-8 bytes, `vocab_size = 256`. Genuinely works,
genuinely bad: no structure is shared between "run" and "running", and your
sequences are as long as the text is in bytes.

**You implement.** Byte-pair encoding: count adjacent pair frequencies, merge
the most common pair into a new token, repeat until you hit the target vocab.
`encode`/`decode` must round-trip exactly.

**It works when.** `test_stage1` passes: round-trip on held-out text is
lossless, `vocab_size` matches what you asked for, and a merged token compresses
a repeated word to fewer ids than bytes.

**Reading.** Sennrich et al. 2015 (BPE for NMT); Karpathy's `minbpe`.

---

## Stage 2 — Data & batching · `train/llm/data.py`

**Idea.** Training needs `(x, y)` pairs where `y` is `x` shifted by one — the
model always predicts the next token. Batching means sampling many random
windows of `block_size` from a long token stream, stacked.

**Placeholder.** Returns the same single window every call. The model will
memorise one sentence and learn nothing.

**You implement.** A train/validation split, random-offset window sampling, and
a batch of shape `(batch_size, block_size)` for both `x` and `y`.

**It works when.** `test_stage2` passes: shapes are right, `y` is `x` shifted
by exactly one, successive batches differ, and train/val windows never overlap.

---

## Stage 3 — Self-attention · `train/llm/attention.py`

**Idea.** The one that matters. Each position builds a **query**, every position
offers a **key** and a **value**; the query is scored against all keys, scores
become weights via softmax, and the output is the weighted sum of values. It
lets position 9 read position 2 directly, with no recurrence. **Causal
masking** — setting future scores to `-inf` before the softmax — is what keeps
the model from reading the answer.

**Placeholder.** Returns its input unchanged. The model becomes a per-position
lookup table with no context at all.

**You implement.** Scaled dot-product attention, `softmax(QKᵀ/√d_k + mask)V`,
with multiple heads run in parallel and concatenated.

**It works when.** `test_stage3` passes: output shape matches input, attention
weights per row sum to 1, and — the test that actually catches bugs — **a
change to token `t+1` must not alter the output at position `t`**. If it does,
your mask is wrong and your model is cheating.

**Reading.** *Attention Is All You Need* (Vaswani et al. 2017), §3.2.

---

## Stage 4 — The transformer block · `train/llm/block.py`

**Idea.** Attention mixes information **across positions**; a per-position MLP
then gives the model room to compute **with** it. Wrap both in residual
connections and layer norm and you can stack the thing deeply without the
gradients dying. Pre-norm (norm before the sublayer) trains more easily than
the original post-norm.

**Placeholder.** Attention only — no MLP, no norm, no residual.

**You implement.** `x = x + attn(norm(x))` then `x = x + mlp(norm(x))`, with the
MLP widening by ~4× and coming back.

**It works when.** `test_stage4` passes: shape preserved, a deep stack does not
explode or vanish (activation std stays in a sane band), and removing the
residual measurably hurts a short training run.

---

## Stage 5 — The full model · `train/llm/model.py`

**Idea.** Token embeddings + **positional** information (attention alone is
permutation-blind), N blocks, a final norm, and a linear projection to
vocabulary logits. Loss is cross-entropy between logits and the next token.

**Placeholder.** Uniform random logits — a perfectly serveable model that
knows nothing. Loss sits at `ln(vocab_size)`, which is exactly the number to
beat.

**You implement.** The assembly, plus the forward pass returning
`(logits, loss)`.

**It works when.** `test_stage5` passes: logits are `(B, T, vocab)`, initial
loss is within ~10% of `ln(vocab_size)` (if it is far off, your init is
broken), and loss **decreases** when you overfit deliberately on a single
batch. That last one is the single most useful test in this repo — a model that
cannot overfit one batch has a bug, always.

---

## Stage 6 — The training loop · `train/llm/train.py`

**Idea.** Sample a batch, forward, backward, step, repeat — plus the
unglamorous parts that decide whether it works: learning-rate warmup and decay,
gradient clipping, and periodic validation loss so you can see overfitting
start.

**Placeholder.** Saves an untrained checkpoint immediately so `serve/` has
something to load.

**You implement.** The loop, AdamW, a cosine schedule with warmup, grad
clipping, and checkpointing of the best validation loss.

**It works when.** `test_stage6` passes: loss trends down over a short run,
the checkpoint round-trips through save/load to identical logits, and
validation loss is computed with gradients off.

---

## Stage 7 — Sampling · `train/llm/sample.py`

**Idea.** Generation is a loop: forward the context, take the last position's
logits, turn them into a distribution, draw one token, append, repeat.
**Temperature** flattens or sharpens the distribution; **top-k**/**top-p**
truncate its tail. Greedy argmax is the degenerate case and reads like it —
repetitive and flat.

**Placeholder.** Argmax, no temperature, no truncation.

**You implement.** Temperature scaling, top-k and top-p filtering, sampling
from the filtered distribution, and cropping the context to `block_size`.

**It works when.** `test_stage7` passes: `temperature → 0` converges on argmax,
a fixed seed is reproducible, top-k never emits a token outside the top k, and
output length is exactly what was requested.

---

## Stage 8 — Evaluation · `train/llm/eval.py`

**Idea.** "It sounds good" is not a measurement. **Perplexity** —
`exp(cross-entropy)` on held-out text — is the standard one: roughly, how many
tokens the model is effectively choosing between at each step. Lower is
better; it should be far below `vocab_size` and it must be computed on data the
model never trained on.

**Placeholder.** Reports `0.0`, which is the most suspicious possible number
and is meant to annoy you.

**You implement.** Held-out perplexity, a loss curve dump, and a
before/after-training comparison.

**It works when.** `test_stage8` passes: perplexity of an untrained model is
≈ `vocab_size`, perplexity after training is meaningfully lower, and evaluating
the same data twice gives the same number.

---

## After stage 8

You have a small transformer you wrote, trained and served, and you can explain
every line. Natural next steps, none of them scaffolded here: a bigger corpus,
weight tying, KV-caching for faster generation, RoPE instead of learned
positions, instruction fine-tuning.
