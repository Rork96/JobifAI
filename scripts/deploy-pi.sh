#!/usr/bin/env bash
# =============================================================================
# scripts/deploy-pi.sh — "Pull & Fly" production deployment script
# =============================================================================
#
# Runs on the Raspberry Pi 5.  Pulls latest code, rebuilds only changed
# containers, rotates them with zero manual steps, then prunes Docker artefacts
# to preserve SD card / SSD space.
#
# Usage:
#   ./scripts/deploy-pi.sh                  # deploy main branch
#   ./scripts/deploy-pi.sh my-feature-branch  # deploy a specific branch
#   SKIP_ENV_CHECK=1 ./scripts/deploy-pi.sh   # skip env validation (CI)
#
# Requirements on the Pi:
#   - git, docker, docker compose v2 (docker compose, not docker-compose)
#   - .env file populated (run env-check.sh first if unsure)
#
# =============================================================================

set -euo pipefail

BRANCH="${1:-main}"
COMPOSE_FILE="docker-compose.prod.yml"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Colours ──────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
  CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
else
  RED=''; YELLOW=''; GREEN=''; CYAN=''; BOLD=''; RESET=''
fi

step()  { printf "\n${CYAN}${BOLD}▶  %s${RESET}\n" "$1"; }
ok()    { printf "  ${GREEN}✔${RESET}  %s\n" "$1"; }
warn()  { printf "  ${YELLOW}⚠${RESET}  %s\n" "$1"; }
die()   { printf "\n${RED}${BOLD}✘  DEPLOY FAILED: %s${RESET}\n" "$1" >&2; exit 1; }

cd "$REPO_ROOT"

# ─── 0. Pre-flight: env check ────────────────────────────────────────────────
step "Pre-flight: environment check"
if [ "${SKIP_ENV_CHECK:-0}" = "1" ]; then
  warn "Skipping env check (SKIP_ENV_CHECK=1)"
else
  bash "$SCRIPT_DIR/env-check.sh" .env || die "Environment check failed. Fix .env before deploying."
fi

# ─── 1. Stash local changes, pull latest ────────────────────────────────────
step "Pulling latest code (branch: ${BOLD}${BRANCH}${RESET}${CYAN})"

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
  warn "Currently on '$CURRENT_BRANCH', switching to '$BRANCH'"
  git checkout "$BRANCH"
fi

# Fail fast if there are uncommitted local changes that would block the pull
if ! git diff --quiet; then
  warn "Working tree has uncommitted changes — stashing before pull"
  git stash push -m "deploy-pi auto-stash $(date -u +%Y%m%dT%H%M%SZ)"
fi

git pull --ff-only origin "$BRANCH" || die "git pull failed. Resolve conflicts manually."

COMMIT=$(git rev-parse --short HEAD)
ok "Now at commit ${COMMIT}  ($(git log -1 --format='%s'))"

# ─── 2. Build changed containers only ───────────────────────────────────────
step "Building Docker images (changed layers only)"

# --pull refreshes base images (python:3.11-slim, nginx:stable-alpine).
# Docker's layer cache means unchanged dependencies don't reinstall.
# On Pi 5 with a warm cache this typically takes < 60 s.
docker compose -f "$COMPOSE_FILE" build --pull \
  || die "docker compose build failed. Check the output above."

ok "Images built successfully"

# ─── 3. Rotate containers (zero-downtime swap) ───────────────────────────────
step "Rotating containers"

# --remove-orphans cleans up containers from services that were removed from
# the compose file (e.g. if you removed certbot).
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans \
  || die "docker compose up failed. Run: docker compose -f $COMPOSE_FILE logs"

ok "All containers up"

# ─── 4. Health check ─────────────────────────────────────────────────────────
step "Waiting for backend health check"

MAX_ATTEMPTS=20
ATTEMPT=0
until docker compose -f "$COMPOSE_FILE" exec -T backend \
        wget -qO- http://localhost:8000/health > /dev/null 2>&1; do
  ATTEMPT=$((ATTEMPT + 1))
  if [ "$ATTEMPT" -ge "$MAX_ATTEMPTS" ]; then
    warn "Backend did not become healthy within $((MAX_ATTEMPTS * 3)) seconds"
    warn "Check logs: docker compose -f $COMPOSE_FILE logs backend"
    break
  fi
  printf "  ⏳ attempt %d/%d …\n" "$ATTEMPT" "$MAX_ATTEMPTS"
  sleep 3
done

if [ "$ATTEMPT" -lt "$MAX_ATTEMPTS" ]; then
  ok "Backend is healthy  (/health returned 200)"
fi

# ─── 5. Prune old Docker artefacts ───────────────────────────────────────────
step "Pruning old Docker images (saves SD card / SSD space)"

# Remove dangling images (untagged layers from previous builds).
# Does NOT remove images currently used by running containers.
RECLAIMED=$(docker image prune -f 2>&1 | grep "reclaimed" | grep -Eo '[0-9]+(\.[0-9]+)? [KMG]B' || echo "0B")
ok "Dangling images removed (reclaimed: ${RECLAIMED:-unknown})"

# ─── 6. Print live status ────────────────────────────────────────────────────
step "Live container status"
docker compose -f "$COMPOSE_FILE" ps --format "table {{.Service}}\t{{.Status}}\t{{.Ports}}"

# ─── Done ────────────────────────────────────────────────────────────────────
printf "\n${GREEN}${BOLD}🚀  Deploy complete — commit ${COMMIT} is live on cv.wealthifai.xyz${RESET}\n\n"
printf "  Tail logs:     ${CYAN}docker compose -f %s logs -f${RESET}\n" "$COMPOSE_FILE"
printf "  Backend logs:  ${CYAN}docker compose -f %s logs -f backend${RESET}\n" "$COMPOSE_FILE"
printf "  Stop all:      ${CYAN}docker compose -f %s down${RESET}\n\n" "$COMPOSE_FILE"
