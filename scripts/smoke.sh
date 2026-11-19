#!/usr/bin/env bash
# End-to-end smoke test against the running stack (docker compose up).
# Uploads a large JPEG through the web container, polls until done, downloads the
# result and checks it is a WebP whose longest side is 1280 px.
set -euo pipefail

BASE="${BASE_URL:-http://localhost:8080}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Git Bash on Windows: native curl needs a Windows path.
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }

fail() { echo "FAIL: $*" >&2; exit 1; }
field() { grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

echo "→ generating a 4000x3000 JPEG"
docker compose exec -T worker php -r '
  $i = new Imagick; $i->newPseudoImage(4000, 3000, "plasma:");
  $i->setImageFormat("jpeg"); $i->setImageCompressionQuality(92); echo $i->getImageBlob();' > "$TMP/in.jpg"
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

dims=$(docker compose exec -T worker php -r '$s = getimagesizefromstring(stream_get_contents(STDIN)); echo "$s[0]x$s[1]";' < "$TMP/out.webp")
[ "$dims" = "1280x960" ] || fail "expected 1280x960, got $dims"

echo "PASS: $(wc -c < "$TMP/out.webp") byte WebP, $dims"
