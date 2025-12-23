#!/bin/bash
set -e

ENV="${1:-staging}"
case "$ENV" in
  production) API_URL="https://api.docket.law"; WEB_URL="https://app.docket.law";;
  staging)    API_URL="https://api-staging.docket.law"; WEB_URL="https://app-staging.docket.law";;
  local)      API_URL="http://localhost:8787"; WEB_URL="http://localhost:5173";;
  *) echo "Usage: $0 [production|staging|local]"; exit 1;;
esac

PASSED=0; FAILED=0

check() {
  local name="$1" url="$2" expected="$3" method="${4:-GET}" body="$5"
  [ -n "$body" ] && status=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" -H "Content-Type: application/json" -d "$body" "$url") \
                 || status=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" "$url")
  [ "$status" = "$expected" ] && { echo "✓ $name"; PASSED=$((PASSED + 1)); } || { echo "✗ $name ($status)"; FAILED=$((FAILED + 1)); }
}

check "Root 404" "$API_URL/" "404"
check "Unknown 404" "$API_URL/unknown" "404"
check "Teams GET 405" "$API_URL/api/messages" "405"
check "Teams POST" "$API_URL/api/messages" "200" "POST" '{"type":"conversationUpdate"}'
check "Clio callback" "$API_URL/clio/callback" "302"
check "Web app" "$WEB_URL/" "200"

echo "Passed: $PASSED, Failed: $FAILED"
[ "$FAILED" -gt 0 ] && exit 1
