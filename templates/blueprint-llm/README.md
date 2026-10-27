# LLM from scratch — a learning blueprint

A **complete, deployable pipeline for a small language model, with the model
itself left unbuilt on purpose.** You train it, you serve it, you talk to it —
and you write every interesting line yourself, one stage at a time.

> **The framework is finished. The LLM is not.** That is the whole design. On a
> fresh clone `./dev up` gives you a working end-to-end system: a tokenizer, a
> data pipeline, a model, a training loop, an HTTP API and a chat page. Every
> one of those is a deliberately trivial **placeholder** that runs but is not a
> real implementation. You replace them in order, and after each stage the same
> pipeline still runs — now slightly less stupid.

## Why it is built this way

Most "build an LLM" tutorials give you a finished file to read. Reading is not
learning. The other failure mode is a blank repo, where you spend three days on
Docker and CUDA and never reach attention.

So: **infrastructure done, understanding deferred.** You never debug a
Dockerfile to learn about softmax, and you never get a green test suite for
free either.

## Run it

```bash
cp env.example .env          # nothing secret needed to start
./dev up                     # train + serve + ui, all containerised
./dev test                   # the stage suite — see what is unimplemented
open http://localhost:8080   # chat with your (currently very stupid) model
```

**Docker-only, like every project in this framework.** Never run `pip`,
`python` or `npm` on the host — `./dev <cmd>` runs it in the container. A
laptop that can't fit PyTorch still works: the placeholder path is pure Python.

```bash
./dev up            # bring the stack up
./dev down          # stop it
./dev test          # pytest — the stage suite
./dev train         # run the training loop on data/
./dev sample "Once" # generate from the current checkpoint
./dev shell         # a shell inside the train container
./dev stage         # which stage am I on? what's next?
```

## The curriculum

Eight stages, each one a concept plus the file that implements it. Full detail,
including what "it works" means for each, is in **[CURRICULUM.md](CURRICULUM.md)**.

| Stage | Concept | You write | Placeholder it replaces |
|-------|---------|-----------|-------------------------|
| 1 | Tokenization | `train/llm/tokenizer.py` | raw bytes, vocab 256 |
| 2 | Data & batching | `train/llm/data.py` | one repeated window |
| 3 | Self-attention | `train/llm/attention.py` | returns its input unchanged |
| 4 | The transformer block | `train/llm/block.py` | attention with no MLP |
| 5 | The full model | `train/llm/model.py` | random logits |
| 6 | The training loop | `train/llm/train.py` | saves an untrained checkpoint |
| 7 | Sampling | `train/llm/sample.py` | argmax, no temperature |
| 8 | Evaluation | `train/llm/eval.py` | always reports loss 0.0 |

Each stage has a test that is **skipped, not failed**, while its placeholder is
in place — so CI is green from day one and turns meaningful as you go. `./dev
stage` tells you where you are.

## How to work through it

This repo is meant to be worked **interactively with an agent**, not read.
The intended loop, per stage:

1. `./dev stage` — see the current stage and its reading.
2. Read that stage's section in `CURRICULUM.md` and the docstring in the file.
3. **Attempt it yourself first.** The docstring states the contract (shapes in,
   shapes out) without giving the body.
4. Ask the agent to review what you wrote, or to explain the part that didn't
   click — *not* to write it for you. `PROMPTS.md` has prompts for this that
   are phrased to get explanation rather than code.
5. `./dev test` — the stage's test un-skips itself once your implementation is
   real, and must pass.
6. `./dev train && ./dev sample "..."` — watch the output get better.

There is no stage 9. When stage 8 passes you have a working, trained,
served small language model that you built and can explain.

## What this is not

Not a frontier model, and not efficient. It is a **few-million-parameter,
character-or-BPE-level transformer** that trains on a laptop in minutes on a
few megabytes of text. That is the point: small enough to understand
completely, real enough to actually generate text.
