#!/bin/bash
# Smoke tests for BNDY API after deployment
# These tests verify critical endpoints are responding correctly

set -e

API_URL="${API_URL:-https://api.bndy.co.uk}"
FAILED=0
PASSED=0

echo "========================================"
echo "BNDY API Smoke Tests"
echo "Testing: $API_URL"
echo "========================================"

# Test function
test_endpoint() {
  local name="$1"
  local method="$2"
  local path="$3"
  local expected_status="$4"
  local expected_body="$5"

  echo -n "Testing $name... "

  response=$(curl -s -w "\n%{http_code}" -X "$method" "$API_URL$path" -H "Content-Type: application/json" 2>/dev/null)
  body=$(echo "$response" | head -n -1)
  status=$(echo "$response" | tail -n 1)

  if [ "$status" != "$expected_status" ]; then
    echo "FAILED (expected $expected_status, got $status)"
    echo "  Response: $body"
    FAILED=$((FAILED + 1))
    return 1
  fi

  if [ -n "$expected_body" ] && ! echo "$body" | grep -q "$expected_body"; then
    echo "FAILED (response missing: $expected_body)"
    echo "  Response: $body"
    FAILED=$((FAILED + 1))
    return 1
  fi

  echo "PASSED"
  PASSED=$((PASSED + 1))
  return 0
}

# Test CORS headers
test_cors() {
  local origin="$1"
  echo -n "Testing CORS for $origin... "

  response=$(curl -s -I -H "Origin: $origin" "$API_URL/api/events/public?startDate=2026-01-01&endDate=2026-01-02" 2>/dev/null)

  if echo "$response" | grep -qi "access-control-allow-origin: $origin"; then
    echo "PASSED"
    PASSED=$((PASSED + 1))
    return 0
  else
    echo "FAILED (CORS header missing for $origin)"
    FAILED=$((FAILED + 1))
    return 1
  fi
}

echo ""
echo "--- Public Endpoints ---"

# Core public endpoints
test_endpoint "GET /api/events/public" "GET" "/api/events/public?startDate=2026-04-30&endDate=2026-05-01" "200" "events"
test_endpoint "GET /api/events/public/geo" "GET" "/api/events/public/geo?startDate=2026-04-30&endDate=2026-05-01" "200" ""
test_endpoint "GET /api/artists (list)" "GET" "/api/artists" "200" ""
test_endpoint "GET /api/venues (list)" "GET" "/api/venues" "200" ""

# Artist public events - critical for frontstage profile pages
# Using a known artist ID that should exist
test_endpoint "GET /api/artists/{id}/public-events" "GET" "/api/artists/LEaHULH3pxKD5Kk2g32C/public-events?startDate=2026-01-01&endDate=2027-01-01" "200" "events"

# Venue events - critical for frontstage venue pages
test_endpoint "GET /api/venues/{id}/events" "GET" "/api/venues/5399d41a-10a9-4064-b971-774fd096fdaf/events?startDate=2026-01-01&endDate=2027-01-01" "200" ""

echo ""
echo "--- CORS Configuration ---"

test_cors "https://live.bndy.co.uk"
test_cors "https://backstage.bndy.co.uk"
test_cors "https://www.bndy.co.uk"
test_cors "http://localhost:3000"

echo ""
echo "========================================"
echo "Results: $PASSED passed, $FAILED failed"
echo "========================================"

if [ $FAILED -gt 0 ]; then
  echo "SMOKE TESTS FAILED - Deployment may have broken critical endpoints!"
  exit 1
fi

echo "All smoke tests passed!"
exit 0
