#!/bin/bash
# Helper script to test API endpoints with authentication

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

EMAIL="${1:-<candidate test account>}"
ENDPOINT="${2:-/api/auth/role}"
METHOD="${3:-POST}"
# For complex JSON, pass it as a single quoted string
DATA="${4:-{\"role\":\"candidate\"}}"

echo "Getting auth token for $EMAIL..."
TOKEN=$(npx tsx server/get-token.ts 2>&1 | sed -n '/AUTH TOKEN/,/END AUTH TOKEN/p' | grep -v "AUTH TOKEN" | grep -v "END" | tr -d ' ')

if [ -z "$TOKEN" ]; then
    echo "ERROR: Failed to get auth token"
    exit 1
fi

echo "Testing $METHOD $ENDPOINT"
echo "Token: ${TOKEN:0:50}..."
echo ""

if [ "$METHOD" = "GET" ]; then
    curl -X GET "http://localhost:5000$ENDPOINT" \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/json" \
        -s | jq . 2>/dev/null || curl -X GET "http://localhost:5000$ENDPOINT" \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/json" \
        -s
else
    curl -X "$METHOD" "http://localhost:5000$ENDPOINT" \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/json" \
        -d "$DATA" \
        -s | jq . 2>/dev/null || curl -X "$METHOD" "http://localhost:5000$ENDPOINT" \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/json" \
        -d "$DATA" \
        -s
fi

echo ""
