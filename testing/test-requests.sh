#!/bin/bash

# test-requests.sh
# Shell script to test the Databricks Custom Data Provider
#
# Usage: sh test-requests.sh

BASE_URL="http://localhost:3000"
TABLE="catalog.schema.restaurants"

echo "========================================="
echo "Databricks Provider Test Suite"
echo "========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test 1: Health Check
echo -e "${BLUE}Test 1: Health Check${NC}"
curl -s "${BASE_URL}/health" | python3 -m json.tool
echo ""
echo ""

# Test 2: Get All Features
echo -e "${BLUE}Test 2: Get All Features${NC}"
curl -s "${BASE_URL}/query?table=${TABLE}&f=geojson" | python3 -m json.tool | head -50
echo ""
echo ""

# Test 3: WHERE Clause Filter
echo -e "${BLUE}Test 3: WHERE Clause Filter (category='Italian')${NC}"
curl -s "${BASE_URL}/query?table=${TABLE}&where=category='Italian'&f=geojson" | python3 -m json.tool
echo ""
echo ""

# Test 4: Spatial Query (Bounding Box)
echo -e "${BLUE}Test 4: Spatial Query (Bounding Box)${NC}"
curl -s "${BASE_URL}/query?table=${TABLE}&geometry=-74,40,-73,41&spatialRel=esriSpatialRelIntersects&f=geojson" | python3 -m json.tool | head -50
echo ""
echo ""

# Test 5: Count Only
echo -e "${BLUE}Test 5: Count Only${NC}"
curl -s "${BASE_URL}/query?table=${TABLE}&returnCountOnly=true&f=json" | python3 -m json.tool
echo ""
echo ""

# Test 6: IDs Only
echo -e "${BLUE}Test 6: IDs Only${NC}"
curl -s "${BASE_URL}/query?table=${TABLE}&returnIdsOnly=true&f=json" | python3 -m json.tool
echo ""
echo ""

# Test 7: Pagination
echo -e "${BLUE}Test 7: Pagination (limit 3, offset 0)${NC}"
curl -s "${BASE_URL}/query?table=${TABLE}&resultRecordCount=3&resultOffset=0&f=geojson" | python3 -m json.tool
echo ""
echo ""

# Test 8: Order By
echo -e "${BLUE}Test 8: Order By (rating DESC)${NC}"
curl -s "${BASE_URL}/query?table=${TABLE}&orderByFields=rating DESC&f=geojson" | python3 -m json.tool | head -50
echo ""
echo ""

# Test 9: Field Selection
echo -e "${BLUE}Test 9: Field Selection (outFields=name,category,rating)${NC}"
curl -s "${BASE_URL}/query?table=${TABLE}&outFields=name,category,rating&f=geojson" | python3 -m json.tool | head -50
echo ""
echo ""

# Test 10: Object IDs
echo -e "${BLUE}Test 10: Object IDs (objectIds=1,3,5)${NC}"
curl -s "${BASE_URL}/query?table=${TABLE}&objectIds=1,3,5&f=geojson" | python3 -m json.tool
echo ""
echo ""

echo -e "${GREEN}========================================="
echo "All Tests Complete!"
echo "=========================================${NC}"
echo ""
echo "Tips:"
echo "  - Check the console logs in test-server.js for detailed info"
echo "  - Open viewer.html in browser to see data on a map"
echo "  - Modify TABLE variable at top of script to test different tables"
