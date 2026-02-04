# Security Features Guide

This document describes the authentication, authorization, and audit logging features added to the Databricks Custom Data Feed Provider.

## Overview

Three security enhancements have been implemented:

1. **authorize() Method** - User-based authorization following Esri's official pattern
2. **Environment Variable Configuration** - No hardcoded credentials
3. **Audit Logging** - Track all authentication and query events

## Quick Start

### 1. Install Dependencies

```bash
cd nodejs-provider
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```env
# Databricks Connection
DATABRICKS_SERVER_HOSTNAME=your-workspace.cloud.databricks.com
DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/your-warehouse-id
DATABRICKS_ACCESS_TOKEN=dapi_your_token_here

# Table Configuration
DATABRICKS_DEFAULT_TABLE=catalog.schema.table
DATABRICKS_GEOMETRY_COLUMN=geometry
DATABRICKS_ID_FIELD=id

# Security Features
ENABLE_AUDIT_LOG=true
ENABLE_SIMPLE_AUTH=true
SIMPLE_AUTH_TOKEN=test-token-12345
```

### 3. Build and Test

```bash
# Build the .cdpk package
npm run build  # Or use ArcGIS Enterprise SDK tools

# Deploy to ArcGIS Server
# (Use Server Manager, Admin Directory, or CLI)

# Test with authentication
curl -H "Authorization: Bearer test-token-12345" \
  "http://your-server:6443/arcgis/rest/services/YourService/FeatureServer/0/query?where=1=1&f=json"
```

---

## Feature 1: User Authentication & Authorization

### How It Works

The `authorize()` method is called automatically by ArcGIS **before** `getData()`. This is Esri's official authentication pattern.

```javascript
/**
 * authorize() - Called before getData()
 * @param {object} req - Request with user info (req._user)
 * @param {function} callback - callback(error, authorized)
 */
Model.prototype.authorize = function(req, callback) {
  const user = req._user;  // Provided by ArcGIS when forwardUserIdentity enabled

  if (!user || !user.username) {
    return callback(new Error('Authentication required'), false);
  }

  // Custom authorization logic here
  // - Check user roles
  // - Check group membership
  // - Query external auth service

  return callback(null, true);  // Allow or deny access
};
```

### Configuration Options

#### Option 1: Simple Token Authentication (Development/Testing)

**Best for:** Local testing, demos, development

```env
ENABLE_SIMPLE_AUTH=true
SIMPLE_AUTH_TOKEN=your-random-token-here
```

**Usage:**
```bash
# Generate a random token
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Use in requests
curl -H "Authorization: Bearer your-random-token-here" \
  "http://localhost:6443/arcgis/rest/services/..."
```

**Testing:**
```bash
# Valid token - should succeed
curl -H "Authorization: Bearer test-token-12345" \
  "http://localhost:6443/arcgis/rest/services/MyService/FeatureServer/0/query?where=1=1&f=json"

# Invalid token - should fail with 401
curl -H "Authorization: Bearer wrong-token" \
  "http://localhost:6443/arcgis/rest/services/MyService/FeatureServer/0/query?where=1=1&f=json"

# Missing token - should fail with 401
curl "http://localhost:6443/arcgis/rest/services/MyService/FeatureServer/0/query?where=1=1&f=json"
```

#### Option 2: ArcGIS User Authentication (Production)

**Best for:** Production deployments with ArcGIS authentication

```env
ENABLE_USER_AUTH=true
ENABLE_SIMPLE_AUTH=false
```

**Configure ArcGIS Feature Service:**
1. When creating the Feature Service in ArcGIS Server Manager:
   - Set `forwardUserIdentity: true` in service parameters
   - This passes authenticated user information to the provider

2. Access user information in authorize():
```javascript
Model.prototype.authorize = function(req, callback) {
  const user = req._user;

  // user.username - ArcGIS username
  // user.groups - Array of user's groups
  // user.role - User's role (admin, publisher, viewer, etc.)

  // Example: Restrict to specific groups
  const allowedGroups = ['GIS_Analysts', 'Data_Viewers'];
  const hasAccess = user.groups.some(g => allowedGroups.includes(g));

  if (!hasAccess) {
    return callback(new Error('Access denied'), false);
  }

  return callback(null, true);
};
```

#### Option 3: No Authentication (Open Access)

**Best for:** Internal networks, public data

```env
ENABLE_USER_AUTH=false
ENABLE_SIMPLE_AUTH=false
```

All requests are allowed without authentication.

---

## Feature 2: Environment Variable Configuration

### Benefits

✅ **No hardcoded credentials** - Secrets stored in environment variables
✅ **Easy deployment** - Different configs for dev/test/prod
✅ **CI/CD friendly** - Configure via environment
✅ **Secure** - `.env` excluded from git

### Configuration File: `.env`

```env
# Databricks Connection (REQUIRED)
DATABRICKS_SERVER_HOSTNAME=your-workspace.cloud.databricks.com
DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/your-warehouse-id
DATABRICKS_ACCESS_TOKEN=dapi_your_token_here

# Table Configuration (REQUIRED)
DATABRICKS_DEFAULT_TABLE=catalog.schema.table
DATABRICKS_GEOMETRY_COLUMN=geometry_wkt
DATABRICKS_ID_FIELD=objectid

# Optional Configuration
DATABRICKS_SRID=4326
DATABRICKS_MAX_RECORD_COUNT=2000

# Security Features
ENABLE_USER_AUTH=false
ENABLE_AUDIT_LOG=true
AUDIT_LOG_FILE=./logs/audit.log
ENABLE_SIMPLE_AUTH=true
SIMPLE_AUTH_TOKEN=test-token-12345
```

### Loading Configuration

Configuration is loaded in this order:
1. Environment variables (`.env` file)
2. Fallback to `databricks-config.json` defaults

```javascript
const config = {
  databricks: {
    serverHostname: process.env.DATABRICKS_SERVER_HOSTNAME || defaults.serverHostname,
    httpPath: process.env.DATABRICKS_HTTP_PATH || defaults.httpPath,
    accessToken: process.env.DATABRICKS_ACCESS_TOKEN || defaults.accessToken,
    // ... more fields
  }
};
```

---

## Feature 3: Audit Logging

### What Gets Logged

All security-relevant events are logged:

1. **Authentication Events**
   - Successful logins
   - Failed login attempts
   - Authorization failures

2. **Query Events**
   - Username
   - Table accessed
   - Query parameters (WHERE, fields, etc.)
   - Record count returned
   - IP address

### Log Format

JSON Lines format (one JSON object per line):

```json
{"timestamp":"2024-01-15T10:30:00.000Z","event":"AUTH_SUCCESS","username":"jdoe","method":"simple_token","ipAddress":"192.168.1.100","success":true}
{"timestamp":"2024-01-15T10:30:01.000Z","event":"QUERY","username":"jdoe","tableName":"main.default.cities","queryParams":{"where":"population>1000000","returnCountOnly":false},"recordCount":5,"ipAddress":"192.168.1.100"}
{"timestamp":"2024-01-15T10:31:00.000Z","event":"AUTH_FAILURE","username":"anonymous","method":"simple_token","ipAddress":"192.168.1.101","success":false,"reason":"Invalid token"}
```

### Configuration

```env
# Enable audit logging
ENABLE_AUDIT_LOG=true

# Log file location
AUDIT_LOG_FILE=./logs/audit.log
```

### Viewing Logs

```bash
# View all logs
cat logs/audit.log

# View recent logs
tail -f logs/audit.log

# Filter authentication failures
cat logs/audit.log | grep "AUTH_FAILURE"

# Filter queries by user
cat logs/audit.log | grep '"username":"jdoe"'

# Pretty print with jq
cat logs/audit.log | jq '.'
```

### Analyzing Logs

```bash
# Count queries per user
cat logs/audit.log | jq -r 'select(.event=="QUERY") | .username' | sort | uniq -c

# Find failed authentication attempts
cat logs/audit.log | jq 'select(.event=="AUTH_FAILURE")'

# Track queries to sensitive tables
cat logs/audit.log | jq 'select(.event=="QUERY" and .tableName=="sensitive_data")'
```

---

## Testing Guide

### Test 1: Simple Token Authentication

**Setup:**
```env
ENABLE_SIMPLE_AUTH=true
SIMPLE_AUTH_TOKEN=test-token-12345
ENABLE_AUDIT_LOG=true
```

**Test valid token:**
```bash
curl -H "Authorization: Bearer test-token-12345" \
  "http://localhost:6443/arcgis/rest/services/MyService/FeatureServer/0/query?where=1=1&f=json"
```

**Expected:** Returns features, logged in `logs/audit.log`

**Test invalid token:**
```bash
curl -H "Authorization: Bearer wrong-token" \
  "http://localhost:6443/arcgis/rest/services/MyService/FeatureServer/0/query?where=1=1&f=json"
```

**Expected:** Returns 401 Unauthorized, failure logged

### Test 2: Audit Logging

**Check logs after queries:**
```bash
tail -20 logs/audit.log | jq '.'
```

**Verify logged data:**
- ✅ Timestamp
- ✅ Event type (AUTH_SUCCESS, QUERY, etc.)
- ✅ Username
- ✅ IP address
- ✅ Query parameters
- ✅ Record count

### Test 3: Environment Variables

**Test with different config:**
```bash
# Override table
DATABRICKS_DEFAULT_TABLE=catalog.schema.other_table npm start

# Override auth settings
ENABLE_SIMPLE_AUTH=false npm start
```

**Verify configuration is loaded correctly from startup logs.**

---

## Deployment to Databricks Community Edition

### Prerequisites

- Databricks Community Edition account (aat0995@yahoo.com)
- Existing table: `workspace.default.koop_test_cities` (10 US cities)

### Configuration

Use the provided `.env` file (already configured):

```env
DATABRICKS_SERVER_HOSTNAME=your-workspace.cloud.databricks.com
DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/your-warehouse-id
DATABRICKS_ACCESS_TOKEN=dapi_your_token_here
DATABRICKS_DEFAULT_TABLE=catalog.schema.table
DATABRICKS_GEOMETRY_COLUMN=geometry_wkt
DATABRICKS_ID_FIELD=objectid
```

### Build and Deploy

```bash
# 1. Install dependencies
npm install

# 2. Build .cdpk package
# Use ArcGIS Enterprise SDK build tools

# 3. Register with ArcGIS Server
# Option A: Server Manager UI
# Option B: Admin Directory
# Option C: ArcGIS Server CLI

# 4. Create Feature Service
# Use the registered provider to create a service
```

### Testing on Community Edition

```bash
# Test query
curl -H "Authorization: Bearer test-token-12345" \
  "http://your-server/arcgis/rest/services/Cities/FeatureServer/0/query?where=1=1&f=json"

# Expected: 10 US cities with Point geometries

# Test filtered query
curl -H "Authorization: Bearer test-token-12345" \
  "http://your-server/arcgis/rest/services/Cities/FeatureServer/0/query?where=state='California'&f=json"

# Expected: 2 cities (San Francisco, Los Angeles)
```

---

## Security Best Practices

### 1. Token Management

✅ **Generate strong random tokens:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

✅ **Rotate tokens regularly** (monthly or quarterly)

✅ **Use different tokens for dev/test/prod**

✅ **Store tokens in secret management** (AWS Secrets Manager, Azure Key Vault, etc.)

### 2. Audit Log Management

✅ **Monitor logs regularly** for suspicious activity

✅ **Set up log rotation** to prevent disk space issues

✅ **Archive old logs** to long-term storage

✅ **Alert on failed authentication attempts**

### 3. Network Security

✅ **Use HTTPS** in production (not HTTP)

✅ **Restrict IP access** via firewall rules

✅ **Use VPN or private networks** for sensitive data

### 4. Database Security

✅ **Use Databricks Service Principal** (not personal access token) in production

✅ **Grant minimum permissions** (SELECT only on needed tables)

✅ **Enable audit logging** in Databricks workspace

✅ **Use Unity Catalog** for fine-grained access control

---

## Troubleshooting

### Issue: "Authorization required" error

**Cause:** Missing or invalid `Authorization` header

**Solution:**
```bash
# Include Bearer token
curl -H "Authorization: Bearer your-token-here" "http://..."
```

### Issue: Audit logs not being created

**Cause:** Missing log directory or disabled audit logging

**Solution:**
```bash
# Check configuration
echo $ENABLE_AUDIT_LOG  # Should be 'true'

# Create log directory
mkdir -p logs

# Check file permissions
ls -la logs/
```

### Issue: Environment variables not loading

**Cause:** `.env` file missing or in wrong location

**Solution:**
```bash
# Verify .env exists
ls -la .env

# Check .env is in nodejs-provider directory
cd nodejs-provider
cat .env
```

---

## References

### Esri Documentation

- [Custom Data Feed Provider API](https://developers.arcgis.com/rest/services-reference/)
- [forwardUserIdentity Service Parameter](https://enterprise.arcgis.com/en/server/latest/publish-services/)
- [ArcGIS Security Best Practices](https://enterprise.arcgis.com/en/server/latest/administer/windows/best-practices-for-security.htm)

### Implementation Files

- `src/model.js` - authorize() and getData() methods
- `src/modules/auditLog.js` - Audit logging implementation
- `.env.example` - Configuration template
- `SECURITY_FEATURES.md` - This document

---

## Summary

The security enhancements provide:

1. **Flexible Authentication**
   - Simple token auth for testing
   - ArcGIS user auth for production
   - Easy to extend with custom logic

2. **Configuration Management**
   - No hardcoded credentials
   - Environment-based configuration
   - CI/CD friendly

3. **Audit Trail**
   - Track all authentication events
   - Log all data access
   - Analyze security events

All features work together to provide enterprise-grade security while maintaining ease of use for development and testing.
