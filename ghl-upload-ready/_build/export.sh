#!/usr/bin/env bash
# Export ghl-upload-ready PNGs (Playwright)
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUILD="$ROOT/ghl-upload-ready/_build"
OUT="$ROOT/ghl-upload-ready"
PORT="${PORT:-8777}"
BASE="http://127.0.0.1:$PORT"

mkdir -p "$OUT"
cd "$ROOT"

started_server=
if ! curl -sf "$BASE/ghl-upload-ready/_build/carousel-01.html" >/dev/null 2>&1; then
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

echo "Exporting to $OUT ..."

export_one "$BASE/ghl-upload-ready/_build/app-icon.html" 1024 1024 "app-icon-1024x1024.png"
export_one "$BASE/ghl-upload-ready/_build/carousel-01.html" 392 440 "carousel-01-see-energy-before-symptoms-show.png"
export_one "$BASE/ghl-upload-ready/_build/carousel-02.html" 392 440 "carousel-02-powerful-tools-complete-insights.png"
export_one "$BASE/ghl-upload-ready/_build/carousel-03.html" 392 440 "carousel-03-become-a-gaia-healer.png"
export_one "$BASE/ghl-upload-ready/_build/carousel-04.html" 392 440 "carousel-04-join-the-global-network.png"
export_one "$BASE/ghl-upload-ready/_build/play-store-banner.html" 1024 500 "play-store-banner-1024x500.png"

echo ""
echo "PNG exports:"
ls -la "$OUT"/*.png
