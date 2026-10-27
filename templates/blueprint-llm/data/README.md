# Corpus

Drop `.txt` or `.md` files here. `train/llm/data.py` concatenates everything it
finds, encodes it, and splits 90/10 train/val.

`sample.txt` ships as a tiny public-domain starter so the pipeline runs on a
fresh clone. It is far too small to train anything interesting — a few hundred
KB to a few MB of text is the right range for a model this size.

Good public-domain sources: Project Gutenberg (single novels work well),
Wikipedia dumps, your own writing. Avoid anything you would not want a model
to reproduce verbatim — a model this small memorises aggressively.

Everything here except this README and `sample.txt` is gitignored: corpora are
large and regenerable, and they do not belong in git.
