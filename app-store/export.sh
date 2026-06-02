#!/usr/bin/env bash
# Export App Store PNGs at 1290×2796 — requires: npx, local HTTP server
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/app-store/export"
PORT="${PORT:-8765}"
BASE="http://127.0.0.1:$PORT"

mkdir -p "$OUT"
cd "$ROOT"

started_server=
if ! curl -sf "$BASE/home.html" >/dev/null 2>&1; then
  echo "Starting server on port $PORT..."
  python3 -m http.server "$PORT" >/dev/null 2>&1 &
  started_server=1
  sleep 2
fi

cleanup() {
  if [ -n "$started_server" ]; then
    pkill -f "python3 -m http.server $PORT" 2>/dev/null || true
  fi
}
trap cleanup EXIT

slides=(
  "app-store/screenshot-01-welcome.html|screenshot-01-welcome.png"
  "app-store/screenshot-02-biowell.html|screenshot-02-biowell.png"
  "app-store/screenshot-03-community.html|screenshot-03-community.png"
  "app-store/screenshot-04-academy.html|screenshot-04-academy.png"
  "app-store/screenshot-05-journey.html|screenshot-05-journey.png"
)

echo "Exporting to $OUT ..."

for entry in "${slides[@]}"; do
  IFS='|' read -r html file <<< "$entry"
  echo "→ $file"
  npx --yes playwright screenshot \
    --browser chromium \
    --viewport-size=1290,2796 \
    --wait-for-timeout=3000 \
    "$BASE/$html" \
    "$OUT/$file"
done

echo "Done: $(ls -1 "$OUT"/*.png | wc -l | tr -d ' ') files in app-store/export/"
