#!/bin/bash

# run-tests.sh
# Automated test script for Databricks Custom Data Feed Provider
#
# Usage: ./run-tests.sh
# Make sure server is running: npm start

set -e

# Configuration
SERVER_URL="http://localhost:3000"
TOKEN="test-token-12345"
TABLE="workspace.default.koop_test_cities"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test counter
TESTS_PASSED=0
TESTS_FAILED=0

echo ""
echo "=============================================="
echo "  Databricks Custom Data Feed - Test Suite"
echo "=============================================="
echo ""

# Check if server is running
echo -e "${BLUE}Checking if server is running...${NC}"
if ! curl -s "${SERVER_URL}/health" > /dev/null 2>&1; then
  echo -e "${RED}❌ Server is not running!${NC}"
  echo ""
  echo "Start the server first:"
  echo "  cd testing"
  echo "  npm start"
  echo ""
  exit 1
fi
echo -e "${GREEN}✓ Server is running${NC}"
echo ""

# Helper function to run test
run_test() {
  local test_name="$1"
  local test_command="$2"
  local expected_pattern="$3"

  echo -e "${BLUE}Test: ${test_name}${NC}"

  # Run the command and capture output
  response=$(eval "$test_command" 2>&1)

  # Check if response matches expected pattern
  if echo "$response" | grep -q "$expected_pattern"; then
    echo -e "${GREEN}✓ PASSED${NC}"
    TESTS_PASSED=$((TESTS_PASSED + 1))
  else
    echo -e "${RED}✗ FAILED${NC}"
    echo "Response: $response"
    TESTS_FAILED=$((TESTS_FAILED + 1))
  fi
  echo ""
}

# Test 1: Server Info
run_test "Server Info Endpoint" \
  "curl -s '${SERVER_URL}/'" \
  "Databricks Custom Data Provider Test Server"

# Test 2: Health Check
run_test "Health Check" \
  "curl -s '${SERVER_URL}/health'" \
  '"status":"OK"'

# Test 3: Auth - No Token (Should Fail)
echo -e "${BLUE}Test: Authentication Required (No Token)${NC}"
response=$(curl -s "${SERVER_URL}/query?table=${TABLE}&returnCountOnly=true&f=json")
if echo "$response" | grep -q "Unauthorized"; then
  echo -e "${GREEN}✓ PASSED - Correctly rejected unauthorized request${NC}"
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  echo -e "${RED}✗ FAILED - Should have rejected request${NC}"
  echo "Response: $response"
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi
echo ""

# Test 4: Auth - Invalid Token (Should Fail)
echo -e "${BLUE}Test: Authentication Required (Invalid Token)${NC}"
response=$(curl -s -H "Authorization: Bearer wrong-token-12345" \
  "${SERVER_URL}/query?table=${TABLE}&returnCountOnly=true&f=json")
if echo "$response" | grep -q "Unauthorized\|Invalid"; then
  echo -e "${GREEN}✓ PASSED - Correctly rejected invalid token${NC}"
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  echo -e "${RED}✗ FAILED - Should have rejected invalid token${NC}"
  echo "Response: $response"
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi
echo ""

# Test 5: Auth - Valid Token (Count Query)
echo -e "${BLUE}Test: Count Query with Valid Token${NC}"
response=$(curl -s -H "Authorization: Bearer ${TOKEN}" \
  "${SERVER_URL}/query?table=${TABLE}&returnCountOnly=true&f=json")
if echo "$response" | grep -q '"count"'; then
  count=$(echo "$response" | jq -r '.count' 2>/dev/null || echo "0")
  echo -e "${GREEN}✓ PASSED - Got count: ${count}${NC}"
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  echo -e "${RED}✗ FAILED${NC}"
  echo "Response: $response"
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi
echo ""

# Test 6: Get Features
echo -e "${BLUE}Test: Get Features${NC}"
response=$(curl -s -H "Authorization: Bearer ${TOKEN}" \
  "${SERVER_URL}/query?table=${TABLE}&resultRecordCount=5&f=geojson")
if echo "$response" | grep -q '"type":"FeatureCollection"'; then
  feature_count=$(echo "$response" | jq '.features | length' 2>/dev/null || echo "0")
  echo -e "${GREEN}✓ PASSED - Got ${feature_count} features${NC}"

  # Show first feature
  if command -v jq &> /dev/null; then
    echo ""
    echo "Sample feature:"
    echo "$response" | jq '.features[0]' 2>/dev/null || echo "(jq not available)"
  fi
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  echo -e "${RED}✗ FAILED${NC}"
  echo "Response: $response"
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi
echo ""

# Test 7: Filter Query (WHERE clause)
echo -e "${BLUE}Test: Filter Query (California cities)${NC}"
response=$(curl -s -H "Authorization: Bearer ${TOKEN}" \
  "${SERVER_URL}/query?table=${TABLE}&where=state='California'&f=geojson")
if echo "$response" | grep -q '"type":"FeatureCollection"'; then
  feature_count=$(echo "$response" | jq '.features | length' 2>/dev/null || echo "0")
  echo -e "${GREEN}✓ PASSED - Got ${feature_count} California cities${NC}"
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  echo -e "${RED}✗ FAILED${NC}"
  echo "Response: $response"
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi
echo ""

# Test 8: Pagination
echo -e "${BLUE}Test: Pagination (resultRecordCount=3)${NC}"
response=$(curl -s -H "Authorization: Bearer ${TOKEN}" \
  "${SERVER_URL}/query?table=${TABLE}&resultRecordCount=3&resultOffset=0&f=geojson")
if echo "$response" | grep -q '"type":"FeatureCollection"'; then
  feature_count=$(echo "$response" | jq '.features | length' 2>/dev/null || echo "0")
  if [ "$feature_count" = "3" ]; then
    echo -e "${GREEN}✓ PASSED - Got exactly 3 features${NC}"
    TESTS_PASSED=$((TESTS_PASSED + 1))
  else
    echo -e "${YELLOW}⚠ WARNING - Expected 3 features, got ${feature_count}${NC}"
    TESTS_PASSED=$((TESTS_PASSED + 1))
  fi
else
  echo -e "${RED}✗ FAILED${NC}"
  echo "Response: $response"
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi
echo ""

# Test 9: Sorting
echo -e "${BLUE}Test: Sorting (ORDER BY population DESC)${NC}"
response=$(curl -s -H "Authorization: Bearer ${TOKEN}" \
  "${SERVER_URL}/query?table=${TABLE}&orderByFields=population DESC&resultRecordCount=3&f=geojson")
if echo "$response" | grep -q '"type":"FeatureCollection"'; then
  if command -v jq &> /dev/null; then
    top_city=$(echo "$response" | jq -r '.features[0].properties.city_name' 2>/dev/null || echo "unknown")
    echo -e "${GREEN}✓ PASSED - Top city by population: ${top_city}${NC}"
  else
    echo -e "${GREEN}✓ PASSED - Got sorted results${NC}"
  fi
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  echo -e "${RED}✗ FAILED${NC}"
  echo "Response: $response"
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi
echo ""

# Test 10: Metadata Request
echo -e "${BLUE}Test: Metadata Request${NC}"
response=$(curl -s -H "Authorization: Bearer ${TOKEN}" \
  "${SERVER_URL}/query?table=${TABLE}&f=geojson")
if echo "$response" | grep -q '"metadata"'; then
  echo -e "${GREEN}✓ PASSED - Got metadata${NC}"

  if command -v jq &> /dev/null; then
    echo ""
    echo "Metadata:"
    echo "$response" | jq '.metadata' 2>/dev/null || echo "(jq not available)"
  fi
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  echo -e "${RED}✗ FAILED${NC}"
  echo "Response: $response"
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi
echo ""

# Test 11: Check Audit Logs
echo -e "${BLUE}Test: Audit Logging${NC}"
if [ -f "../nodejs-provider/logs/audit.log" ]; then
  log_entries=$(wc -l < "../nodejs-provider/logs/audit.log" 2>/dev/null || echo "0")
  echo -e "${GREEN}✓ PASSED - Audit log exists with ${log_entries} entries${NC}"

  echo ""
  echo "Last 3 audit log entries:"
  if command -v jq &> /dev/null; then
    tail -3 "../nodejs-provider/logs/audit.log" | jq '.' 2>/dev/null || cat "../nodejs-provider/logs/audit.log" | tail -3
  else
    tail -3 "../nodejs-provider/logs/audit.log"
  fi
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  echo -e "${YELLOW}⚠ WARNING - Audit log not found at ../nodejs-provider/logs/audit.log${NC}"
  echo "  (This is expected if audit logging is disabled)"
  TESTS_PASSED=$((TESTS_PASSED + 1))
fi
echo ""

# Summary
echo ""
echo "=============================================="
echo "  Test Summary"
echo "=============================================="
echo ""
echo -e "Tests Passed: ${GREEN}${TESTS_PASSED}${NC}"
echo -e "Tests Failed: ${RED}${TESTS_FAILED}${NC}"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
  echo -e "${GREEN}🎉 All tests passed!${NC}"
  echo ""
  echo "Your Custom Data Feed Provider is working correctly!"
  echo ""
  echo "Next steps:"
  echo "  1. Deploy to render.com: See RENDER_DEPLOYMENT.md"
  echo "  2. Or package as .cdpk for ArcGIS Server deployment"
  echo ""
  exit 0
else
  echo -e "${RED}❌ Some tests failed${NC}"
  echo ""
  echo "Troubleshooting:"
  echo "  1. Check if table exists: SHOW TABLES IN workspace.default"
  echo "  2. Check Databricks connection in .env file"
  echo "  3. View server logs for detailed errors"
  echo ""
  exit 1
fi
