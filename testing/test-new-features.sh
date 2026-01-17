#!/bin/bash
# Test script for new features: orderByFields, returnDistinctValues, time filtering

BASE_URL="http://localhost:3000"
TABLE="atrivedi.geospatial.vessel_tracking_spatial"
GEOM_COL="location"
ID_FIELD="mmsi"

echo "=================================================="
echo "Testing New Features"
echo "=================================================="
echo ""

# Test 1: orderByFields (Sorting)
echo "Test 1: Sort vessels by name (ASC)"
echo "---------------------------------------------------"
curl -s "${BASE_URL}/query?\
table=${TABLE}&\
geometryColumn=${GEOM_COL}&\
idField=${ID_FIELD}&\
orderByFields=vessel_name ASC&\
resultRecordCount=5&\
f=geojson" | python3 -m json.tool | head -30
echo ""
echo ""

# Test 2: orderByFields (Multiple fields)
echo "Test 2: Sort by vessel_type ASC, sog DESC"
echo "---------------------------------------------------"
curl -s "${BASE_URL}/query?\
table=${TABLE}&\
geometryColumn=${GEOM_COL}&\
idField=${ID_FIELD}&\
orderByFields=vessel_type ASC, sog DESC&\
resultRecordCount=5&\
f=geojson" | python3 -m json.tool | head -30
echo ""
echo ""

# Test 3: returnDistinctValues
echo "Test 3: Get unique vessel types"
echo "---------------------------------------------------"
curl -s "${BASE_URL}/query?\
table=${TABLE}&\
geometryColumn=${GEOM_COL}&\
idField=${ID_FIELD}&\
returnDistinctValues=true&\
returnGeometry=false&\
outFields=vessel_type&\
f=json" | python3 -m json.tool
echo ""
echo ""

# Test 4: returnDistinctValues with WHERE
echo "Test 4: Get unique vessel types WHERE sog > 10"
echo "---------------------------------------------------"
curl -s "${BASE_URL}/query?\
table=${TABLE}&\
geometryColumn=${GEOM_COL}&\
idField=${ID_FIELD}&\
where=sog>10&\
returnDistinctValues=true&\
returnGeometry=false&\
outFields=vessel_type&\
f=json" | python3 -m json.tool
echo ""
echo ""

# Test 5: Time filtering (January 2024)
echo "Test 5: Time filter - January 17, 2024 (10:00-11:00)"
echo "---------------------------------------------------"
# Unix timestamps: 2024-01-17 10:00:00 = 1705489200000
#                  2024-01-17 11:00:00 = 1705492800000
curl -s "${BASE_URL}/query?\
table=${TABLE}&\
geometryColumn=${GEOM_COL}&\
idField=${ID_FIELD}&\
time=1705489200000,1705492800000&\
resultRecordCount=5&\
f=geojson" | python3 -m json.tool | head -30
echo ""
echo ""

# Test 6: Combined - orderByFields + WHERE
echo "Test 6: Combined - WHERE vessel_type='cargo' ORDER BY sog DESC"
echo "---------------------------------------------------"
curl -s "${BASE_URL}/query?\
table=${TABLE}&\
geometryColumn=${GEOM_COL}&\
idField=${ID_FIELD}&\
where=vessel_type='cargo'&\
orderByFields=sog DESC&\
resultRecordCount=3&\
f=geojson" | python3 -m json.tool | head -30
echo ""
echo ""

# Test 7: Check filtersApplied for time
echo "Test 7: Check filtersApplied includes time=true"
echo "---------------------------------------------------"
curl -s "${BASE_URL}/query?\
table=${TABLE}&\
geometryColumn=${GEOM_COL}&\
idField=${ID_FIELD}&\
time=1705489200000,1705492800000&\
resultRecordCount=1&\
f=geojson" | python3 -c "import json, sys; data=json.load(sys.stdin); print('filtersApplied:', json.dumps(data.get('filtersApplied', {}), indent=2))"
echo ""
echo ""

# Test 8: Check filtersApplied for orderByFields
echo "Test 8: Check filtersApplied includes orderByFields=true"
echo "---------------------------------------------------"
curl -s "${BASE_URL}/query?\
table=${TABLE}&\
geometryColumn=${GEOM_COL}&\
idField=${ID_FIELD}&\
orderByFields=vessel_name ASC&\
resultRecordCount=1&\
f=geojson" | python3 -c "import json, sys; data=json.load(sys.stdin); print('filtersApplied:', json.dumps(data.get('filtersApplied', {}), indent=2))"
echo ""
echo ""

echo "=================================================="
echo "All tests completed!"
echo "=================================================="
