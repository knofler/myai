FROM python:3.12-slim

# CPU-only and torch-free by default: every placeholder is pure Python, so the
# image stays small and `./dev up` works on any laptop. Install the torch extra
# when you reach Stage 3 — `./dev shell` then `pip install -e '.[torch]'` — or
# uncomment the line below to bake it in.
WORKDIR /app

RUN pip install --no-cache-dir \
      "fastapi>=0.115" "pydantic>=2.9" "pytest>=8.3" "pytest-cov>=5.0"
# RUN pip install --no-cache-dir "torch>=2.4" --index-url https://download.pytorch.org/whl/cpu

ENV PYTHONPATH=/app PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY . /app
