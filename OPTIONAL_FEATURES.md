# Optional Features - Future Enhancements

> **📖 Part of:** [ArcGIS Custom Data Feed for Databricks](README.md)
> **Related:** [Working with Data](WORKING_WITH_EXISTING_TABLES.md) | [Implementation Details](IMPLEMENTATION_VERIFICATION.md)

This document explains features that are NOT yet implemented but could be added in the future.

## ✅ Already Implemented (January 17, 2025)

The following features have been completed and are now part of the core provider:
- ✅ **orderByFields** (Sorting) - See README for usage
- ✅ **returnDistinctValues** - See README for usage
- ✅ **time filtering** (Basic Level 1) - See README for usage

For implementation details, see `IMPLEMENTATION_VERIFICATION.md`.

---

## Features Not Yet Implemented

### 1. Advanced Time-Aware Queries (Level 2 & 3)

**Status:** Level 1 (basic filtering) ✅ IMPLEMENTED
**Future Enhancement:** Levels 2 & 3

#### Level 2: Time-Aware Layer Metadata

**What It Does:** Declare time extent in metadata so ArcGIS knows data is temporal

**Implementation Required:**
```javascript
// In metadata response
geojson.metadata = {
  ...
  timeInfo: {
    startTimeField: "timestamp",           // Field containing time values
    endTimeField: null,                     // Optional: for time ranges
    trackIdField: "mmsi",                   // Field for tracking moving objects
    timeExtent: [minTimestamp, maxTimestamp], // Overall time range
    timeInterval: 1,                        // Interval value
    timeIntervalUnits: "esriTimeUnitsHours" // Hours, days, etc.
  }
};
```

**Complexity:** ⭐⭐ MEDIUM (3-4 hours)

**Use Cases:**
- Enable ArcGIS time slider
- Animate vessel movements over time
- Historical playback of events

---

#### Level 3: Time Animation Support

**What It Does:** Support time intervals for animation (e.g., show data hour-by-hour)

**Implementation Required:**
```sql
-- Support time queries with intervals
SELECT
  mmsi,
  vessel_name,
  location,
  timestamp,
  DATE_TRUNC('hour', timestamp) as time_interval
FROM vessel_tracking
WHERE timestamp >= '2024-01-17 00:00:00'
  AND timestamp < '2024-01-18 00:00:00'
ORDER BY timestamp
```

**Complexity:** ⭐⭐⭐ MEDIUM-HIGH (6-8 hours)

**Recommendation:** ⚠️ Consider only if animation is critical use case

---

### 2. Grouping/Aggregation (groupByFields + outStatistics)

**What It Does:** Aggregates features by field values, returning summary statistics per group

#### ArcGIS REST API Pattern
```
/query?
  groupByFields=vessel_type&
  outStatistics=[
    {"statisticType":"count","onStatisticField":"mmsi","outStatisticFieldName":"vessel_count"},
    {"statisticType":"avg","onStatisticField":"sog","outStatisticFieldName":"avg_speed"}
  ]&
  f=json
```

#### Example Output
```json
{
  "features": [
    {"attributes": {"vessel_type": "cargo", "vessel_count": 1523, "avg_speed": 12.3}},
    {"attributes": {"vessel_type": "fishing", "vessel_count": 842, "avg_speed": 8.7}},
    {"attributes": {"vessel_type": "tanker", "vessel_count": 456, "avg_speed": 15.2}}
  ]
}
```

#### Implementation Complexity: **MEDIUM** ⭐⭐

**Code Changes Needed:**
```javascript
// Parse outStatistics JSON parameter
const stats = JSON.parse(req.query.outStatistics);

// Build aggregation SQL
function buildAggregationQuery(groupByFields, outStatistics, table, whereClause) {
  const aggregations = outStatistics.map(stat => {
    const func = mapStatisticType(stat.statisticType); // count, avg, sum, min, max
    return `${func}(${stat.onStatisticField}) as ${stat.outStatisticFieldName}`;
  });

  return `
    SELECT
      ${groupByFields},
      ${aggregations.join(', ')}
    FROM ${table}
    ${whereClause}
    GROUP BY ${groupByFields}
  `;
}
```

**Effort:** ~4-6 hours (implementation)
**Testing:** ~2-3 hours
**Total:** ~6-9 hours

#### Use Cases
- Count vessels by type
- Average speed by vessel type
- Total tonnage by port
- Count events by region

#### Alternative Solution (Recommended)

Instead of implementing groupByFields support, users can create SQL views in Databricks:

```sql
-- Create aggregation view in Databricks
CREATE VIEW vessel_type_stats AS
SELECT
  vessel_type,
  COUNT(mmsi) as vessel_count,
  AVG(sog) as avg_speed,
  ST_Union_Agg(location) as aggregate_geometry  -- Optional: union geometries
FROM vessel_tracking
GROUP BY vessel_type;

-- Then expose as a separate Feature Service
cdf create-service databricks-geospatial-provider \
  https://your-server/arcgis/admin YOUR_TOKEN \
  -s "VesselTypeStats" \
  --service-parameters "tableName:catalog.schema.vessel_type_stats,geometryColumn:aggregate_geometry,idField:vessel_type"
```

**Recommendation:** ⚠️ **Use SQL views** instead of implementing groupByFields

**Rationale:**
- SQL views are more flexible and powerful
- Better performance (can be materialized)
- No additional provider code needed
- Can leverage Databricks optimization features

---

### 3. Editing Capability

**Status:** NOT IMPLEMENTED (by design - read-only provider)

**What It Would Require:**
```javascript
// Model methods to implement
Model.prototype.addFeatures = function(req, callback) { ... }
Model.prototype.updateFeatures = function(req, callback) { ... }
Model.prototype.deleteFeatures = function(req, callback) { ... }
```

**Configuration Change:**
```json
{
  "editingEnabled": true  // Change from false
}
```

**Complexity:** ⭐⭐⭐⭐ HIGH (15-20 hours)

**Challenges:**
- Transaction management
- Conflict resolution
- Validation logic
- Error handling
- Testing complexity

**Recommendation:** ❌ **Skip** - Most Custom Data Feeds are read-only

**Rationale:**
- Databricks is typically used as an analytical data warehouse, not transactional database
- Editing should happen in source systems, Databricks used for visualization
- Adds significant complexity for limited benefit

---

### 4. Advanced Geometry Operations

**Status:** NOT IMPLEMENTED

**Features:**
- Buffer operations (ST_Buffer)
- Generalization (ST_Simplify)
- Advanced CRS transformation

**Complexity:** ⭐⭐⭐ MEDIUM-HIGH (8-12 hours)

**Recommendation:** ❌ **Skip** - Most operations done client-side by ArcGIS

**Rationale:**
- ArcGIS clients typically perform these operations client-side
- Databricks ST_* functions already support most needed operations
- Adds complexity for limited benefit

---

## Summary

| Feature | Complexity | Effort | Usefulness | Recommendation |
|---------|-----------|--------|------------|----------------|
| **Time Metadata (Level 2)** | ⭐⭐ MEDIUM | 4 hrs | MEDIUM | ⚠️ Consider if animation needed |
| **Time Animation (Level 3)** | ⭐⭐⭐ MED-HIGH | 6-8 hrs | LOW | ❌ Skip unless critical |
| **groupByFields** | ⭐⭐ MEDIUM | 6-9 hrs | LOW | ⚠️ Use SQL views instead |
| **Editing** | ⭐⭐⭐⭐ HIGH | 15-20 hrs | LOW | ❌ Skip (read-only is standard) |
| **Advanced Geometry Ops** | ⭐⭐⭐ MED-HIGH | 8-12 hrs | LOW | ❌ Skip (client-side ops) |

---

## Implementation Priority

**Core Features (✅ DONE):**
- Basic queries (where, geometry, spatial filters)
- Pagination with exceeded transfer limit
- Field selection
- Count queries
- Sorting (orderByFields)
- Distinct values (returnDistinctValues)
- Basic time filtering (time parameter)

**Consider for Future:**
- Time-aware metadata (if animation is important use case)

**Alternative Solutions (Recommended):**
- Aggregation → Use SQL views in Databricks
- Editing → Use source system for edits, Databricks for visualization

**Not Recommended:**
- Time animation (Level 3) - Niche use case, high complexity
- Editing capability - Not typical for analytical data warehouse
- Advanced geometry operations - Done client-side by ArcGIS

---

## 5. Authentication & Security Enhancements

**Status:** NOT IMPLEMENTED

**Current Approach:**
- Single Databricks service account token (hardcoded in config)
- All ArcGIS users share the same Databricks token
- ArcGIS Server handles user authentication
- No row-level security based on user identity

### Security Considerations

#### Issue 1: Shared Databricks Token
**Impact:**
- All authenticated ArcGIS users can access all data visible to the service account
- No user-level access control at Databricks layer
- No audit trail of which ArcGIS user queried what in Databricks

**Current Security Model:**
```
User → ArcGIS Auth → ArcGIS Server → Single Databricks Token → Databricks
```

#### Issue 2: Token Storage
**Current:** Token stored in `databricks-config.json` (plain text in .cdpk package)
**Risk:** Token exposed if package is extracted

#### Issue 3: Token Expiration
**Current:** No automatic token refresh mechanism
**Risk:** Service fails when token expires

### Potential Enhancements

#### Option A: User-Level Authentication (COMPLEX - 20-30 hours)

**Approach:** Pass ArcGIS user identity to Databricks
```javascript
Model.prototype.getData = function(req, callback) {
  const arcgisUser = req.user; // Get ArcGIS username

  // Option 1: Pass via session variables
  await session.sql(`SET SESSION arcgis_user = '${arcgisUser}'`);

  // Option 2: Filter in query
  const query = `
    SELECT * FROM table
    WHERE is_authorized('${arcgisUser}', resource_id)
  `;
}
```

**Requires:**
- Unity Catalog row-level security functions
- Session variable support in Databricks
- User mapping (ArcGIS user → Databricks permissions)

**Complexity:** ⭐⭐⭐⭐ VERY HIGH
**Usefulness:** HIGH (for multi-tenant scenarios)

---

#### Option B: Environment Variables for Token Storage (LOW - 1-2 hours)

**Approach:** Read token from environment variable instead of hardcoded
```javascript
// databricks-config.json
{
  "accessToken": "${DATABRICKS_TOKEN}"  // Reference env var
}

// Or in model.js:
const token = process.env.DATABRICKS_TOKEN;
```

**Complexity:** ⭐ LOW
**Usefulness:** MEDIUM
**Recommendation:** ✅ **ADD** - Simple security improvement

---

#### Option C: OAuth 2.0 / Service Principal (MEDIUM - 6-8 hours)

**Approach:** Use OAuth client credentials flow for automatic token refresh
```javascript
const { OAuth2Client } = require('@databricks/oauth');

const client = new OAuth2Client({
  clientId: process.env.DATABRICKS_CLIENT_ID,
  clientSecret: process.env.DATABRICKS_CLIENT_SECRET,
  tokenUrl: 'https://accounts.cloud.databricks.com/oauth2/token'
});

// Token auto-refreshes
const token = await client.getAccessToken();
```

**Benefits:**
- Tokens auto-refresh
- No manual token rotation
- Service principal best practice

**Complexity:** ⭐⭐ MEDIUM
**Usefulness:** HIGH
**Recommendation:** ⚠️ **CONSIDER** for production deployments

---

#### Option D: Unity Catalog Row-Level Security (MEDIUM - 4-6 hours)

**Approach:** Define access policies in Databricks Unity Catalog
```sql
-- Create row filter in Unity Catalog
CREATE FUNCTION is_authorized(user STRING, resource STRING)
RETURNS BOOLEAN
RETURN user IN (SELECT authorized_user FROM permissions WHERE resource = resource);

-- Apply to table
ALTER TABLE sensitive_data SET ROW FILTER is_authorized(SESSION.user, resource_id);
```

**Challenge:** How to pass ArcGIS user to Databricks session
**Complexity:** ⭐⭐⭐ MEDIUM-HIGH
**Usefulness:** HIGH (for sensitive data)
**Recommendation:** ⚠️ **CONSIDER** if user-level access control is required

---

#### Option E: External Secrets Manager (MEDIUM - 4-6 hours)

**Approach:** Store token in AWS Secrets Manager, Azure Key Vault, or HashiCorp Vault
```javascript
const AWS = require('aws-sdk');
const secretsManager = new AWS.SecretsManager();

async function getDatabricksToken() {
  const secret = await secretsManager.getSecretValue({
    SecretId: 'databricks/token'
  }).promise();
  return JSON.parse(secret.SecretString).token;
}
```

**Benefits:**
- Centralized secret management
- Automatic rotation
- Audit logging

**Complexity:** ⭐⭐ MEDIUM
**Usefulness:** MEDIUM
**Recommendation:** ⚠️ **CONSIDER** for enterprise deployments

---

### Recommended Security Approach by Use Case

**For Public Dashboards / Internal Visualization:**
```
✅ Current approach is fine
- ArcGIS controls access to Feature Services
- Single service account token
- Consider: Environment variable for token storage
```

**For Production Deployments:**
```
✅ Implement these:
1. Store token in environment variable (not hardcoded)
2. Use Unity Catalog service principal with OAuth
3. Enable auto-token refresh
```

**For Multi-Tenant / Sensitive Data:**
```
⚠️ Requires significant work:
1. Everything above, PLUS
2. Implement user-level authentication (pass ArcGIS user to Databricks)
3. Unity Catalog row-level security
4. Audit logging
```

**For High-Security Environments:**
```
⚠️ Maximum security:
1. Everything above, PLUS
2. External secrets manager (AWS Secrets Manager, etc.)
3. Network isolation (private endpoints)
4. Certificate-based authentication
```

---

## Summary

| Enhancement | Complexity | Effort | Usefulness | Recommendation |
|-------------|-----------|--------|------------|----------------|
| **Environment Variable Token** | ⭐ LOW | 1-2 hrs | MEDIUM | ✅ **ADD** for basic security |
| **OAuth / Service Principal** | ⭐⭐ MEDIUM | 6-8 hrs | HIGH | ⚠️ Consider for production |
| **External Secrets Manager** | ⭐⭐ MEDIUM | 4-6 hrs | MEDIUM | ⚠️ Consider for enterprise |
| **Unity Catalog Row Filters** | ⭐⭐⭐ MED-HIGH | 4-6 hrs | HIGH | ⚠️ If user-level access needed |
| **User-Level Authentication** | ⭐⭐⭐⭐ VERY HIGH | 20-30 hrs | HIGH | ⚠️ Only if truly required |

---

## How to Request a Feature

If you need one of these features:

1. **groupByFields** - Create a SQL view in Databricks instead (recommended)
2. **Time metadata** - Open an issue describing your animation use case
3. **Editing** - Consider if Databricks is the right data store for edits
4. **Security enhancements** - Assess your security requirements (see above recommendations)

For questions, see [IMPLEMENTATION_VERIFICATION.md](IMPLEMENTATION_VERIFICATION.md) for current implementation details.
