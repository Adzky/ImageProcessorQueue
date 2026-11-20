#!/usr/bin/env bash
# End-to-end smoke test against the running stack.
# Uploads a large JPEG through the web container, polls until done, downloads the
# result and checks it is a WebP whose longest side is 1280 px.
#
# Laravel stack (default):  bash scripts/smoke.sh
# TypeScript stack:         bash scripts/smoke.sh --ts
#   which is the same as    BASE_URL=http://localhost:8081 #                           COMPOSE="docker compose -f docker-compose.ts.yml" bash scripts/smoke.sh
# BASE_URL and COMPOSE must point at the same stack. The stack is taken from COMPOSE (a value
# containing docker-compose.ts.yml means TypeScript) unless STACK=ts|php is set explicitly.
set -euo pipefail

if [ "${1:-}" = "--ts" ]; then
  BASE_URL="${BASE_URL:-http://localhost:8081}"
  COMPOSE="${COMPOSE:-docker compose -f docker-compose.ts.yml}"
fi

BASE="${BASE_URL:-http://localhost:8080}"
COMPOSE="${COMPOSE:-docker compose}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Git Bash on Windows: native curl needs a Windows path.
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }

fail() { echo "FAIL: $*" >&2; exit 1; }
field() { grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

if [ -z "${STACK:-}" ]; then
  case "$COMPOSE" in *docker-compose.ts.yml*) STACK=ts ;; *) STACK=php ;; esac
fi
case "$STACK" in ts|php) ;; *) fail "STACK must be 'ts' or 'php', got '$STACK'" ;; esac
$COMPOSE exec -T worker true >/dev/null 2>&1   || fail "the $STACK stack's worker container is not running (start it, and check COMPOSE='$COMPOSE' matches BASE_URL='$BASE')"

echo "→ generating a 4000x3000 JPEG ($STACK worker)"
if [ "$STACK" = ts ]; then
  $COMPOSE exec -T worker node scripts/smoke-image.mjs generate 4000 3000 > "$TMP/in.jpg"
else
  $COMPOSE exec -T worker php -r '
    $i = new Imagick; $i->newPseudoImage(4000, 3000, "plasma:");
    $i->setImageFormat("jpeg"); $i->setImageCompressionQuality(92); echo $i->getImageBlob();' > "$TMP/in.jpg"
fi
echo "  $(wc -c < "$TMP/in.jpg") bytes"

echo "→ uploading to $BASE/api/images"
start=$(date +%s)
response=$(curl -sS -w '\n%{http_code}' -F "image=@$(native "$TMP/in.jpg");type=image/jpeg" "$BASE/api/images")
code=$(tail -n1 <<<"$response"); body=$(sed '$d' <<<"$response")
[ "$code" = "202" ] || fail "expected 202, got $code: $body"
id=$(field job_id <<<"$body")
[ -n "$id" ] || fail "no job_id in: $body"
echo "  202 Accepted in $(( $(date +%s) - start ))s, job $id"

echo "→ polling"
status=""
for _ in $(seq 1 120); do
  status=$(curl -sS "$BASE/api/images/$id" | field status)
  echo "  $status"
  case "$status" in completed|failed) break ;; esac
  sleep 1
done
[ "$status" = "completed" ] || fail "job ended as '$status'"

echo "→ downloading"
curl -sS -o "$(native "$TMP/out.webp")" "$BASE/api/images/$id/download"
[ "$(head -c 4 "$TMP/out.webp")" = "RIFF" ] && [ "$(dd if="$TMP/out.webp" bs=1 skip=8 count=4 2>/dev/null)" = "WEBP" ] \
  || fail "download is not a WebP file"

if [ "$STACK" = ts ]; then
  dims=$($COMPOSE exec -T worker node scripts/smoke-image.mjs dims < "$TMP/out.webp")
else
  dims=$($COMPOSE exec -T worker php -r '$s = getimagesizefromstring(stream_get_contents(STDIN)); echo "$s[0]x$s[1]";' < "$TMP/out.webp")
fi
[ "$dims" = "1280x960" ] || fail "expected 1280x960, got $dims"

echo "PASS: $(wc -c < "$TMP/out.webp") byte WebP, $dims"
