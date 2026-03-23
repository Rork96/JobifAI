#!/usr/bin/env bash
# =============================================================================
# scripts/env-check.sh — Pre-flight environment variable validator
# =============================================================================
#
# Run this before any deploy to verify every required secret is present and
# plausibly valid.  Exits non-zero if anything is missing or obviously wrong.
#
# Usage:
#   ./scripts/env-check.sh              # checks .env in repo root
#   ./scripts/env-check.sh /path/.env   # checks a specific file
#
# =============================================================================

set -euo pipefail

ENV_FILE="${1:-.env}"
ERRORS=0
WARNINGS=0

# Colours (safe: only used when stdout is a terminal)
if [ -t 1 ]; then
  RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
  BOLD='\033[1m'; RESET='\033[0m'
else
  RED=''; YELLOW=''; GREEN=''; BOLD=''; RESET=''
fi

pass()  { printf "  ${GREEN}✔${RESET}  %s\n" "$1"; }
fail()  { printf "  ${RED}✘  %s${RESET}\n" "$1"; ERRORS=$((ERRORS + 1)); }
warn()  { printf "  ${YELLOW}⚠  %s${RESET}\n" "$1"; WARNINGS=$((WARNINGS + 1)); }
header(){ printf "\n${BOLD}%s${RESET}\n" "$1"; }

# ─── Load the env file ────────────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  printf "${RED}ERROR: .env file not found at '%s'${RESET}\n" "$ENV_FILE"
  printf "  Run:  cp .env.example .env  then fill in your secrets.\n"
  exit 1
fi

# Source the file safely: strip comments and blank lines, export each var
set -a
# shellcheck disable=SC1090
source <(grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$') 2>/dev/null || true
set +a

printf "${BOLD}JobifAI — Environment Pre-flight Check${RESET}\n"
printf "  Reading: %s\n" "$(realpath "$ENV_FILE")"

# ─── Helper: check a variable ────────────────────────────────────────────────
# check_var VAR_NAME EXPECTED_MIN_LENGTH EXPECTED_PREFIX [LABEL]
check_var() {
  local var_name="$1"
  local min_len="${2:-1}"
  local prefix="${3:-}"        # empty string = skip prefix check
  local label="${4:-$var_name}"
  local value="${!var_name:-}"

  if [ -z "$value" ]; then
    fail "$label is MISSING or empty"
    return
  fi

  local len=${#value}
  if [ "$len" -lt "$min_len" ]; then
    fail "$label looks truncated (${len} chars, expected ≥ ${min_len})"
    return
  fi

  if [ -n "$prefix" ] && [[ "$value" != ${prefix}* ]]; then
    fail "$label has wrong prefix (got '${value:0:10}...', expected prefix '${prefix}')"
    return
  fi

  pass "$label  (${len} chars, prefix: '${value:0:8}...')"
}

# ─── Backend secrets ─────────────────────────────────────────────────────────
header "Backend secrets"

# Supabase URL — should be https://<project-ref>.supabase.co
if [ -z "${SUPABASE_URL:-}" ]; then
  fail "SUPABASE_URL is MISSING"
elif [[ "$SUPABASE_URL" != https://*.supabase.co* ]]; then
  fail "SUPABASE_URL looks wrong: '${SUPABASE_URL}' (expected https://<ref>.supabase.co)"
else
  pass "SUPABASE_URL  (${SUPABASE_URL})"
fi

# Service role key — starts with 'eyJ', is a full JWT (≥200 chars)
check_var "SUPABASE_KEY" 200 "eyJ" "SUPABASE_KEY (service role)"

# JWT secret — arbitrary string, Supabase dashboard shows it under API → JWT Settings
check_var "SUPABASE_JWT_SECRET" 20 "" "SUPABASE_JWT_SECRET"

# Gemini API key — starts with 'AIzaSy' (~39 chars)
check_var "GEMINI_API_KEY" 35 "AIzaSy" "GEMINI_API_KEY"

# Stripe secret — 'sk_test_...' in dev, 'sk_live_...' in prod
if [ -z "${STRIPE_SECRET_KEY:-}" ]; then
  fail "STRIPE_SECRET_KEY is MISSING"
elif [[ "$STRIPE_SECRET_KEY" == sk_test_* ]]; then
  warn "STRIPE_SECRET_KEY is a TEST key — ok for dev, not for production billing"
  pass "  value looks valid (${#STRIPE_SECRET_KEY} chars)"
elif [[ "$STRIPE_SECRET_KEY" == sk_live_* ]]; then
  pass "STRIPE_SECRET_KEY (live key, ${#STRIPE_SECRET_KEY} chars)"
else
  fail "STRIPE_SECRET_KEY has unexpected prefix: '${STRIPE_SECRET_KEY:0:10}'"
fi

# Stripe webhook secret
check_var "STRIPE_WEBHOOK_SECRET" 20 "whsec_" "STRIPE_WEBHOOK_SECRET"

# ENVIRONMENT flag
if [ -z "${ENVIRONMENT:-}" ]; then
  warn "ENVIRONMENT not set — defaulting to 'dev'"
elif [ "$ENVIRONMENT" = "prod" ]; then
  pass "ENVIRONMENT = prod  ✓ (production mode)"
else
  warn "ENVIRONMENT = '${ENVIRONMENT}' (not 'prod' — docs/debug endpoints may be enabled)"
fi

# ─── Frontend (Vite) public vars ─────────────────────────────────────────────
header "Frontend (Vite) public vars"

# Vite Supabase URL — must match SUPABASE_URL
if [ -z "${VITE_SUPABASE_URL:-}" ]; then
  fail "VITE_SUPABASE_URL is MISSING (needed at Docker build time)"
elif [ "${VITE_SUPABASE_URL:-}" = "${SUPABASE_URL:-}" ]; then
  pass "VITE_SUPABASE_URL  (matches SUPABASE_URL ✓)"
else
  warn "VITE_SUPABASE_URL differs from SUPABASE_URL — make sure this is intentional"
  pass "  value: ${VITE_SUPABASE_URL}"
fi

# Vite anon key — full JWT, starts with 'eyJ'
check_var "VITE_SUPABASE_ANON_KEY" 200 "eyJ" "VITE_SUPABASE_ANON_KEY (anon key)"

# Vite API base URL
if [ -z "${VITE_API_BASE_URL:-}" ]; then
  fail "VITE_API_BASE_URL is MISSING — Sync button will show 'Not Connected'"
else
  pass "VITE_API_BASE_URL  (${VITE_API_BASE_URL})"
fi

# ─── Safety checks ────────────────────────────────────────────────────────────
header "Safety checks"

# Warn if service role key appears to equal the anon key
if [ -n "${SUPABASE_KEY:-}" ] && [ -n "${VITE_SUPABASE_ANON_KEY:-}" ]; then
  if [ "${SUPABASE_KEY}" = "${VITE_SUPABASE_ANON_KEY}" ]; then
    fail "SUPABASE_KEY == VITE_SUPABASE_ANON_KEY — you have exposed the SERVICE ROLE key to the frontend!"
  else
    pass "SUPABASE_KEY ≠ VITE_SUPABASE_ANON_KEY  (service role not leaked to frontend ✓)"
  fi
fi

# Warn if .env is world-readable
if [ "$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%A' "$ENV_FILE" 2>/dev/null)" = "644" ]; then
  warn "$ENV_FILE is world-readable (mode 644). Run: chmod 600 $ENV_FILE"
else
  pass "$ENV_FILE permissions look restricted"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
printf "\n"
if [ "$ERRORS" -gt 0 ]; then
  printf "${RED}${BOLD}✘  %d error(s) found — fix before deploying.${RESET}\n" "$ERRORS"
  [ "$WARNINGS" -gt 0 ] && printf "${YELLOW}⚠  %d warning(s).${RESET}\n" "$WARNINGS"
  exit 1
elif [ "$WARNINGS" -gt 0 ]; then
  printf "${YELLOW}${BOLD}⚠  All required vars present, but %d warning(s) to review.${RESET}\n" "$WARNINGS"
  exit 0
else
  printf "${GREEN}${BOLD}✔  All environment variables look good. Ready to deploy.${RESET}\n"
  exit 0
fi
