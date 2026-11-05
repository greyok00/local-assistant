#!/usr/bin/env bash
# demo/scripts/build-demo-index.sh
#
# Serves the research library locally and prints the URLs to open. The library
# is read-only: product code and the built artifact are aliased onto it by
# serve-library.py instead of being copied into it.
#
#   1. Open the dashboard URL and press Ingest.
#   2. Save the two downloaded files into demo/build/.
#   3. Open the bench URL to run the measurement harness.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PORT:-4180}"
BUILD="$ROOT/demo/build"
mkdir -p "$BUILD"

LIBRARY="${DEMO_LIBRARY:-$ROOT/../research-library}"

if [ ! -d "$LIBRARY" ]; then
  echo "library not found: $LIBRARY" >&2
  echo "set DEMO_LIBRARY to the library tree to serve" >&2
  exit 1
fi
export DEMO_LIBRARY="$LIBRARY"

echo "Starting demo tenant on 127.0.0.1:${PORT}"
python3 "$ROOT/demo/scripts/serve-library.py" --port "$PORT" &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null || true' EXIT INT TERM

# Wait for the port to answer before printing instructions.
for _ in $(seq 1 50); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; then break; fi
  sleep 0.1
done

echo
echo "Open http://127.0.0.1:${PORT}/local-assistant/dashboard.html"
echo "Site URL: http://127.0.0.1:${PORT}/"
echo "Bench:    http://127.0.0.1:${PORT}/local-assistant/bench/bench.html"
echo "Save the two downloaded files into $BUILD"
echo
echo "Press Ctrl-C to stop the server."
wait "$SERVER"
