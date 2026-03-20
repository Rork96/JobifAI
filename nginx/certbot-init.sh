#!/usr/bin/env bash
# =============================================================================
# nginx/certbot-init.sh — First-time SSL certificate provisioning
# =============================================================================
#
# Run this ONCE on the Pi before starting the full production stack.
# It uses the standalone ACME challenge to avoid needing nginx running first.
#
# USAGE
# ─────
#   chmod +x nginx/certbot-init.sh
#   sudo ./nginx/certbot-init.sh your@email.com cv.wealthifai.xyz
#
# WHAT IT DOES
# ─────────────
#   1. Creates the nginx/certbot/{conf,www} volume directories
#   2. Runs certbot standalone (temporarily binds port 80) to get the cert
#   3. Tells you to start the full stack when done
#
# After this, the certbot service in docker-compose.prod.yml handles
# all subsequent renewals automatically every 12 hours.
# =============================================================================

set -euo pipefail

EMAIL="${1:-}"
DOMAIN="${2:-cv.wealthifai.xyz}"

if [[ -z "$EMAIL" ]]; then
  echo "Usage: $0 <email> [domain]"
  echo "       $0 admin@example.com cv.wealthifai.xyz"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_DIR="$SCRIPT_DIR/certbot/conf"
WWW_DIR="$SCRIPT_DIR/certbot/www"

echo "🔐  JobifAI — SSL Certificate Setup"
echo "    Domain: $DOMAIN"
echo "    Email:  $EMAIL"
echo ""

# Create volume directories
mkdir -p "$CONF_DIR" "$WWW_DIR"
echo "✅  Created volume directories"

# Check if certbot is available
if ! command -v certbot &>/dev/null; then
  echo ""
  echo "⬇️   Installing certbot..."
  if command -v apt-get &>/dev/null; then
    sudo apt-get update -q && sudo apt-get install -y certbot
  elif command -v brew &>/dev/null; then
    brew install certbot
  else
    echo "❌  certbot not found. Install it manually: https://certbot.eff.org"
    exit 1
  fi
fi

# Check port 80 is free (nginx not running yet)
if ss -tlnp 2>/dev/null | grep -q ':80 ' || netstat -tlnp 2>/dev/null | grep -q ':80 '; then
  echo ""
  echo "⚠️   Port 80 is already in use. Stop any service on port 80 first."
  echo "    (Stop nginx: docker compose down nginx)"
  exit 1
fi

echo ""
echo "📡  Requesting certificate from Let's Encrypt (standalone mode)..."
echo "    This temporarily binds port 80 to pass the ACME challenge."
echo ""

sudo certbot certonly \
  --standalone \
  --preferred-challenges http \
  --email "$EMAIL" \
  --agree-tos \
  --no-eff-email \
  --config-dir "$CONF_DIR" \
  --work-dir "/tmp/certbot-work" \
  --logs-dir "/tmp/certbot-logs" \
  -d "$DOMAIN"

echo ""
echo "✅  Certificate obtained!"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Next step — start the full production stack:"
echo ""
echo "    docker compose -f docker-compose.prod.yml up -d"
echo ""
echo "  The certbot service will auto-renew every 12 hours."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
