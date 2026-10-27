"""Inference API — COMPLETE. You should not need to change this.

It imports the SAME model code you are writing in train/llm (mounted read-only
by compose), so the moment a stage lands, this endpoint serves it. No separate
"production model" to keep in sync — that divergence is a real and very common
bug, and this avoids it by construction.

Endpoints
    GET  /health      liveness + which stages are implemented
    GET  /stages      the curriculum tracker, as JSON
    POST /generate    {prompt, max_new_tokens, temperature, top_k, top_p, seed}
"""
from __future__ import annotations

import json
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from llm.config import CONFIG
from llm.model import GPT
from llm.sample import generate
from llm.stages import STAGES, implemented
from llm.tokenizer import Tokenizer

app = FastAPI(title="LLM from scratch", version="0.1.0")

# The UI is a static page on a different port, so it is cross-origin. Wide open
# is fine here and ONLY here: this is a single-user learning stack on localhost.
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

_tokenizer = Tokenizer(CONFIG.vocab_size)
_model = GPT(CONFIG, vocab_size=_tokenizer.vocab_size)


def _checkpoint() -> dict:
    path = os.path.join(CONFIG.checkpoint_dir, "model.json")
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {"trained": False, "note": "no checkpoint yet — run ./dev train"}


class GenerateRequest(BaseModel):
    prompt: str = Field(default="Once upon", max_length=4000)
    max_new_tokens: int = Field(default=100, ge=1, le=2000)
    temperature: float = Field(default=1.0, gt=0.0, le=5.0)
    top_k: int | None = Field(default=None, ge=1)
    top_p: float | None = Field(default=None, gt=0.0, le=1.0)
    seed: int | None = None


@app.get("/health")
def health() -> dict:
    done = [n for n, mod, *_ in STAGES if implemented(mod)]
    return {
        "status": "ok",
        "stages_complete": f"{len(done)}/{len(STAGES)}",
        "stages_done": done,
        "checkpoint": _checkpoint(),
        "vocab_size": _tokenizer.vocab_size,
    }


@app.get("/stages")
def stages() -> dict:
    return {
        "stages": [
            {"n": n, "module": mod, "title": title, "placeholder": ph, "implemented": implemented(mod)}
            for n, mod, title, ph in STAGES
        ]
    }


@app.post("/generate")
def generate_text(req: GenerateRequest) -> dict:
    text = generate(
        _model, _tokenizer, req.prompt,
        max_new_tokens=req.max_new_tokens, temperature=req.temperature,
        top_k=req.top_k, top_p=req.top_p, seed=req.seed,
    )
    ckpt = _checkpoint()
    return {
        "prompt": req.prompt,
        "completion": text,
        # Say so loudly. Output from an untrained placeholder must never be
        # mistaken for a result.
        "trained": bool(ckpt.get("trained")),
        "warning": None if ckpt.get("trained") else (
            "This model is UNTRAINED and most stages are placeholders. "
            "Output is meaningless by design — see CURRICULUM.md."
        ),
    }
