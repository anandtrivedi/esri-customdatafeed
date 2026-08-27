#!/bin/bash

# test-auth.sh
# Simple script to test authentication features
#
# Prerequisites:
# 1. Deploy the provider to ArcGIS Server
# 2. Create a Feature Service using the provider
# 3. Update SERVICE_URL below with your actual service URL

# Configuration
SERVICE_URL="http://localhost:6443/arcgis/rest/services/DatabricksService/FeatureServer/0"
VALID_TOKEN="test-token-12345"
INVALID_TOKEN="wrong-token"

echo "============================================"
echo "Authentication Testing Script"
echo "============================================"
echo ""
echo "Service URL: $SERVICE_URL"
echo ""

# Test 1: Request without authentication
echo "Test 1: Request WITHOUT authentication (should fail)"
echo "-----------------------------------------------"
curl -s -w "\nHTTP Status: %{http_code}\n\n" \
  "${SERVICE_URL}/query?where=1=1&f=json" | head -20
echo ""

# Test 2: Request with invalid token
echo "Test 2: Request with INVALID token (should fail)"
echo "-----------------------------------------------"
curl -s -w "\nHTTP Status: %{http_code}\n\n" \
  -H "Authorization: Bearer ${INVALID_TOKEN}" \
  "${SERVICE_URL}/query?where=1=1&f=json" | head -20
echo ""

# Test 3: Request with valid token
echo "Test 3: Request with VALID token (should succeed)"
echo "-----------------------------------------------"
curl -s -w "\nHTTP Status: %{http_code}\n\n" \
  -H "Authorization: Bearer ${VALID_TOKEN}" \
  "${SERVICE_URL}/query?where=1=1&f=json" | head -50
echo ""

# Test 4: Count query with valid token
echo "Test 4: Count query with VALID token (should succeed)"
echo "-----------------------------------------------"
curl -s -w "\nHTTP Status: %{http_code}\n\n" \
  -H "Authorization: Bearer ${VALID_TOKEN}" \
  "${SERVICE_URL}/query?where=1=1&returnCountOnly=true&f=json"
echo ""
echo ""

# Test 5: Filtered query with valid token
echo "Test 5: Filtered query with VALID token (California cities)"
echo "-----------------------------------------------"
curl -s -w "\nHTTP Status: %{http_code}\n\n" \
  -H "Authorization: Bearer ${VALID_TOKEN}" \
  "${SERVICE_URL}/query?where=state='California'&f=json" | head -50
echo ""

# Test 6: Check audit logs
echo "Test 6: Check audit logs"
echo "-----------------------------------------------"
if [ -f "nodejs-provider/logs/audit.log" ]; then
  echo "Last 5 audit log entries:"
  tail -5 nodejs-provider/logs/audit.log | jq '.'
else
  echo "❌ Audit log file not found at nodejs-provider/logs/audit.log"
  echo "   Make sure ENABLE_AUDIT_LOG=true in .env"
fi
echo ""

echo "============================================"
echo "Testing Complete"
echo "============================================"
echo ""
echo "Expected Results:"
echo "  Test 1: HTTP 401 or 403 (unauthorized)"
echo "  Test 2: HTTP 401 or 403 (invalid token)"
echo "  Test 3: HTTP 200 with feature data"
echo "  Test 4: HTTP 200 with count"
echo "  Test 5: HTTP 200 with filtered features"
echo "  Test 6: JSON audit log entries"
echo ""
echo "To view all audit logs:"
echo "  cat nodejs-provider/logs/audit.log | jq '.'"
echo ""
echo "To monitor real-time:"
echo "  tail -f nodejs-provider/logs/audit.log | jq '.'"
