# ──────────────────────────────────────────────────────────────────────────────
# JobifAI — FastAPI Backend Dockerfile
# Target platform: linux/arm64 (Raspberry Pi 5, Cortex-A76)
# ──────────────────────────────────────────────────────────────────────────────
#
# We use a multi-stage build to keep the final image lean:
#   Stage 1 "builder" — installs Python deps into a virtualenv
#   Stage 2 "runtime" — copies only the venv and app source (no build tools)
#
# This pattern typically cuts the image from ~600 MB → ~200 MB by leaving
# gcc, pip caches, and wheel artifacts in the builder layer.
# ──────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Builder ──────────────────────────────────────────────────────────
# python:3.11-slim is a multi-arch manifest that automatically pulls the
# correct image for arm64 when built/run on a Raspberry Pi 5.
# If you build on an x86 Mac and push to the Pi, add:
#   docker buildx build --platform linux/arm64 ...
FROM python:3.11-slim AS builder

# Prevents Python from writing .pyc files (saves a tiny bit of disk I/O)
ENV PYTHONDONTWRITEBYTECODE=1
# Disables output buffering — Docker logs appear immediately instead of
# being held until a buffer fills.  Critical for seeing startup errors.
ENV PYTHONUNBUFFERED=1

WORKDIR /build

# Copy dependency manifest first so Docker can cache this layer.
# If requirements.txt doesn't change, Docker reuses the cached layer even
# if you change application code — faster rebuilds.
COPY requirements.txt .

# Create an isolated virtualenv so we can copy it cleanly to stage 2.
# --no-cache-dir keeps the image smaller (no pip wheel cache).
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --upgrade pip --no-cache-dir \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt


# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM python:3.11-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Tell Python to look in the venv first.
# This is equivalent to `source /opt/venv/bin/activate` but persists across
# CMD and ENTRYPOINT instructions.
ENV PATH="/opt/venv/bin:$PATH"
ENV VIRTUAL_ENV="/opt/venv"

# Create a non-root user.  Running as root inside a container is a security
# anti-pattern — if the container is ever compromised, root-inside-container
# can escape to root-on-host in certain configurations.
RUN addgroup --system jobifai \
    && adduser --system --ingroup jobifai --no-create-home jobifai

WORKDIR /app

# Bring in the pre-built venv from stage 1 (no build tools required here)
COPY --from=builder /opt/venv /opt/venv

# Copy application source.  We copy the whole backend directory.
# .dockerignore (in the repo root) should exclude __pycache__, .env, etc.
COPY . /app/backend

# Switch to the non-root user for runtime
USER jobifai

# ── Health check ──────────────────────────────────────────────────────────────
# Docker will hit /health every 30 s.  3 failures → container is "unhealthy"
# and docker-compose can restart it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import httpx; httpx.get('http://localhost:8000/health').raise_for_status()"

# ── Expose & run ─────────────────────────────────────────────────────────────
# Port 8000 is uvicorn's default.  We expose it here as documentation;
# the actual host→container port mapping lives in docker-compose.yml.
EXPOSE 8000

# uvicorn flags:
#   --host 0.0.0.0  → listen on all interfaces (not just loopback)
#   --port 8000     → explicit, so it's obvious in logs
#   --workers 2     → Pi 5 has 4 cores; 2 workers balance memory vs throughput
#   --no-access-log → we have our own timing middleware in main.py
CMD ["uvicorn", "backend.main:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--workers", "2", \
     "--no-access-log"]
