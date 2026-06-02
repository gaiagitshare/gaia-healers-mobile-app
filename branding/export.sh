#!/usr/bin/env bash
# Export GHL mobile branding PNGs
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/branding/export"
PORT="${PORT:-8765}"
BASE="http://127.0.0.1:$PORT"

mkdir -p "$OUT"
cd "$ROOT"

started_server=
if ! curl -sf "$BASE/branding/splash.html" >/dev/null 2>&1; then
  python3 -m http.server "$PORT" >/dev/null 2>&1 &
  started_server=1
  sleep 2
fi
cleanup() { [ -n "$started_server" ] && pkill -f "python3 -m http.server $PORT" 2>/dev/null || true; }
trap cleanup EXIT

export_one() {
  local url="$1" w="$2" h="$3" out="$4"
  echo "→ $out (${w}×${h})"
  npx --yes playwright screenshot \
    --browser chromium \
    --viewport-size="${w},${h}" \
    --wait-for-timeout=1500 \
    "$url" \
    "$OUT/$out"
}

echo "Exporting GHL assets to $OUT ..."

export_one "$BASE/branding/app-icon.html" 1024 1024 "app-icon-1024x1024.png"
export_one "$BASE/branding/splash.html" 1080 1920 "splash-screen-1080x1920.png"
export_one "$BASE/branding/onboarding-01-welcome.html" 1080 1920 "onboarding-01-welcome.png"
export_one "$BASE/branding/onboarding-02-biowell.html" 1080 1920 "onboarding-02-biowell.png"
export_one "$BASE/branding/onboarding-03-community.html" 1080 1920 "onboarding-03-community.png"
export_one "$BASE/branding/onboarding-04-certification.html" 1080 1920 "onboarding-04-certification.png"

# Also export splash at 1284×2778 for larger phones (optional upload)
export_one "$BASE/branding/splash.html" 1284 2778 "splash-screen-1284x2778.png"

echo ""
echo "Done:"
ls -la "$OUT"/*.png
