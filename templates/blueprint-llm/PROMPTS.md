# Prompts that teach instead of prompts that finish

This repo is meant to be worked with an agent beside you. The difference
between learning and watching is entirely in how you ask.

**The rule: never ask for the body of a stage function.** Ask for the idea, the
review, or the counter-example.

## Good

- "Explain causal masking in attention as if I have never seen it. Use a 4-token
  example and show me the score matrix before and after the mask."
- "Here is my `MultiHeadAttention.forward`. Review it — do not rewrite it. Point
  at what is wrong and tell me which test would catch it."
- "My stage-5 initial loss is 9.1 but ln(vocab) is 6.24. What classes of bug
  produce a loss that is too HIGH at init?"
- "Why does pre-norm train more easily than post-norm? What breaks with post-norm
  at depth?"
- "I implemented top-k but output is still repetitive. What else controls that?"
- "Quiz me on stage 3 before I move to stage 4."

## Bad

- "Write `train/llm/attention.py`." — you will have a working repo and no
  understanding, which is the one outcome this blueprint is designed to prevent.
- "Fix my code." — ask what is wrong and why.
- "Do stages 1-8." — then you own a model you cannot debug.

## When you are stuck for more than an hour

Ask for a **hint ladder**: "Give me a hint for stage 3, then a bigger hint if I
ask again. Do not show me code unless I say the word 'solution'."

Being stuck is the part that does the teaching. An hour is about the right
amount; a day is not.
