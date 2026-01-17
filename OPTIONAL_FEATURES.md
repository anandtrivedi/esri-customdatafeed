# Optional Features Analysis

This document explains the optional features not currently implemented and their complexity.

---

## 1. Advanced Sorting (orderByFields)

### What It Does
Allows clients to sort query results by one or more fields in ascending or descending order.

### ArcGIS REST API Pattern
```
/query?
  where=vessel_type='cargo'&
  orderByFields=vessel_name ASC, sog DESC&
  f=geojson
```

### How It Would Work

**Current Implementation:**
```javascript
// No sorting - returns data in Databricks table order
SELECT mmsi, vessel_name, sog, ST_AsGeoJSON(location) as geometry
FROM vessel_tracking
WHERE vessel_type = 'cargo'
LIMIT 100
```

**With orderByFields Support:**
```javascript
// Parse orderByFields parameter
const orderBy = req.query.orderByFields; // "vessel_name ASC, sog DESC"

// Build ORDER BY clause
SELECT mmsi, vessel_name, sog, ST_AsGeoJSON(location) as geometry
FROM vessel_tracking
WHERE vessel_type = 'cargo'
ORDER BY vessel_name ASC, sog DESC
LIMIT 100
```

### Implementation Complexity: **LOW** ⭐

**Code Changes Needed:**
```javascript
// In sql.js module
function buildOrderByClause(orderByFields) {
  if (!orderByFields) return '';

  // Parse "field1 ASC, field2 DESC" format
  const fields = orderByFields.split(',').map(f => f.trim());

  // Validate field names (prevent SQL injection)
  const validatedFields = fields.map(field => {
    const [name, direction] = field.split(' ');
    const dir = direction?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    return `${sanitizeFieldName(name)} ${dir}`;
  });

  return `ORDER BY ${validatedFields.join(', ')}`;
}

// In buildSqlQuery function
const orderByClause = buildOrderByClause(geoParams.orderByFields);
const sql = `SELECT ${fields} FROM ${table} ${whereClause} ${orderByClause} LIMIT ${limit}`;
```

**Effort:** ~1-2 hours
**Testing:** ~1 hour
**Total:** ~2-3 hours

### Use Cases
- Sort vessels by name alphabetically
- Sort by speed (fastest to slowest)
- Sort by distance from point
- Sort by timestamp (chronological)

### Example Queries
```bash
# Sort vessels by name
curl "http://localhost:3000/query?\
table=vessel_tracking&\
geometryColumn=location&\
idField=mmsi&\
orderByFields=vessel_name ASC&\
f=geojson"

# Sort by speed descending (fastest first)
curl "http://localhost:3000/query?\
table=vessel_tracking&\
geometryColumn=location&\
idField=mmsi&\
where=vessel_type='cargo'&\
orderByFields=sog DESC&\
f=geojson"

# Multiple fields
curl "http://localhost:3000/query?\
table=vessel_tracking&\
geometryColumn=location&\
idField=mmsi&\
orderByFields=vessel_type ASC, vessel_name ASC&\
f=geojson"
```

**Recommendation:** ✅ **WORTH ADDING** - Very common use case, low effort

---

## 2. Grouping/Aggregation (groupByFields)

### What It Does
Aggregates features by field values, returning summary statistics per group.

### ArcGIS REST API Pattern
```
/query?
  groupByFields=vessel_type&
  outStatistics=[
    {"statisticType":"count","onStatisticField":"mmsi","outStatisticFieldName":"vessel_count"},
    {"statisticType":"avg","onStatisticField":"sog","outStatisticFieldName":"avg_speed"}
  ]&
  f=json
```

### How It Would Work

**Example Query:**
```sql
SELECT
  vessel_type,
  COUNT(mmsi) as vessel_count,
  AVG(sog) as avg_speed,
  ST_Union_Agg(location) as geometry  -- Optional: aggregate geometries
FROM vessel_tracking
GROUP BY vessel_type
```

**Response:**
```json
{
  "features": [
    {"attributes": {"vessel_type": "cargo", "vessel_count": 1523, "avg_speed": 12.3}},
    {"attributes": {"vessel_type": "fishing", "vessel_count": 842, "avg_speed": 8.7}},
    {"attributes": {"vessel_type": "tanker", "vessel_count": 456, "avg_speed": 15.2}}
  ]
}
```

### Implementation Complexity: **MEDIUM** ⭐⭐

**Code Changes Needed:**
```javascript
// Parse outStatistics JSON parameter
const stats = JSON.parse(req.query.outStatistics);
// [
//   {statisticType: "count", onStatisticField: "mmsi", outStatisticFieldName: "vessel_count"},
//   {statisticType: "avg", onStatisticField: "sog", outStatisticFieldName: "avg_speed"}
// ]

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

**Effort:** ~4-6 hours
**Testing:** ~2-3 hours
**Total:** ~6-9 hours

### Use Cases
- Count vessels by type
- Average speed by vessel type
- Total tonnage by port
- Count events by region
- Statistics by time period

### Example Queries
```bash
# Count vessels by type
curl "http://localhost:3000/query?\
table=vessel_tracking&\
groupByFields=vessel_type&\
outStatistics=[{\"statisticType\":\"count\",\"onStatisticField\":\"mmsi\",\"outStatisticFieldName\":\"vessel_count\"}]&\
f=json"

# Average speed by vessel type
curl "http://localhost:3000/query?\
table=vessel_tracking&\
groupByFields=vessel_type&\
outStatistics=[{\"statisticType\":\"avg\",\"onStatisticField\":\"sog\",\"outStatisticFieldName\":\"avg_speed\"}]&\
f=json"
```

**Recommendation:** ⚠️ **CONSIDER** - Useful for dashboards, but can be done via separate queries or views

---

## 3. Time-Aware Queries

### What It Does
Filters data based on temporal ranges and enables time-based animation in ArcGIS clients.

### ArcGIS REST API Pattern
```
/query?
  where=1=1&
  time=1609459200000,1640995199000&  // Unix timestamps (2021-01-01 to 2021-12-31)
  f=geojson
```

### Levels of Time Awareness

#### Level 1: Basic Time Filtering (EASY)
**What:** Support `time` parameter for temporal range queries

**Implementation:**
```javascript
// Parse time parameter: "startTime,endTime" (Unix milliseconds)
const timeRange = req.query.time;
if (timeRange) {
  const [startMs, endMs] = timeRange.split(',').map(Number);
  const startTime = new Date(startMs).toISOString();
  const endTime = new Date(endMs).toISOString();

  whereClauses.push(`timestamp >= '${startTime}' AND timestamp <= '${endTime}'`);
}
```

**Complexity:** ⭐ LOW (1-2 hours)

**Example:**
```bash
# Get vessels from January 2024
curl "http://localhost:3000/query?\
table=vessel_tracking&\
geometryColumn=location&\
idField=mmsi&\
time=1704067200000,1706745599000&\
f=geojson"
```

---

#### Level 2: Time-Aware Layer Metadata (MEDIUM)
**What:** Declare time extent in metadata so ArcGIS knows data is temporal

**Implementation:**
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

**Requires:**
- Query min/max timestamp from table
- Define appropriate time interval
- Specify tracking field for animations

**Complexity:** ⭐⭐ MEDIUM (3-4 hours)

**Use Cases:**
- Enable ArcGIS time slider
- Animate vessel movements over time
- Historical playback of events
- Time-series visualization

---

#### Level 3: Time Animation Support (COMPLEX)
**What:** Support time intervals for animation (e.g., show data hour-by-hour)

**Implementation:**
```javascript
// Support time queries with intervals
// e.g., "Show vessel positions for each hour in this day"

// Query pattern for hourly snapshots
SELECT
  mmsi,
  vessel_name,
  location,
  timestamp,
  DATE_TRUNC('hour', timestamp) as time_interval
FROM vessel_tracking
WHERE timestamp >= '2024-01-17 00:00:00'
  AND timestamp < '2024-01-18 00:00:00'
  AND mmsi = 367123456
ORDER BY timestamp
```

**Requires:**
- Understanding of time interval queries
- Efficient queries for temporal data
- Proper indexing on timestamp field

**Complexity:** ⭐⭐⭐ MEDIUM-HIGH (6-8 hours)

---

### Complete Time-Aware Implementation

**Code Changes:**
```javascript
// 1. Parse time parameter
function parseTimeQuery(timeParam) {
  if (!timeParam) return null;

  const [startMs, endMs] = timeParam.split(',').map(Number);
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString()
  };
}

// 2. Add time filter to WHERE clause
const timeRange = parseTimeQuery(req.query.time);
if (timeRange) {
  whereClauses.push(
    `timestamp >= '${timeRange.start}' AND timestamp <= '${timeRange.end}'`
  );
}

// 3. Add timeInfo to metadata (if table has timestamp field)
async function getTimeExtent(table, timestampField) {
  const query = `
    SELECT
      MIN(${timestampField}) as min_time,
      MAX(${timestampField}) as max_time
    FROM ${table}
  `;
  const result = await executeQuery(query);
  return result;
}

// 4. Include in metadata
if (sourceConfig.timeField) {
  const timeExtent = await getTimeExtent(tableName, sourceConfig.timeField);
  geojson.metadata.timeInfo = {
    startTimeField: sourceConfig.timeField,
    trackIdField: sourceConfig.idField,
    timeExtent: [
      new Date(timeExtent.min_time).getTime(),
      new Date(timeExtent.max_time).getTime()
    ],
    timeInterval: 1,
    timeIntervalUnits: "esriTimeUnitsHours"
  };
}
```

**Service Parameters to Add:**
```javascript
// In cdconfig.json serviceParameters
{
  "key": "timeField",
  "label": "Time Field",
  "description": "Timestamp field for temporal queries (optional)"
}
```

**Total Effort for Full Time Support:**
- Level 1 (Basic filtering): ~2 hours ⭐
- Level 2 (Metadata): ~4 hours ⭐⭐
- Level 3 (Animation support): ~6 hours ⭐⭐⭐
- **Total:** ~12 hours

---

## 4. Distinct Values (returnDistinctValues)

### What It Does
Returns unique values for a specified field (for dropdown filters, legends, etc.)

### ArcGIS REST API Pattern
```
/query?
  returnDistinctValues=true&
  returnGeometry=false&
  outFields=vessel_type&
  f=json
```

### How It Would Work
```sql
-- Get distinct vessel types
SELECT DISTINCT vessel_type
FROM vessel_tracking
WHERE vessel_type IS NOT NULL
ORDER BY vessel_type
```

**Response:**
```json
{
  "features": [
    {"attributes": {"vessel_type": "cargo"}},
    {"attributes": {"vessel_type": "fishing"}},
    {"attributes": {"vessel_type": "passenger"}},
    {"attributes": {"vessel_type": "tanker"}}
  ]
}
```

### Implementation Complexity: **VERY LOW** ⭐

**Code Changes:**
```javascript
// In buildSqlQuery
if (geoParams.returnDistinctValues === true) {
  const field = geoParams.outFields; // Single field expected

  return `
    SELECT DISTINCT ${field}
    FROM ${tableName}
    ${whereClause}
    ORDER BY ${field}
  `;
}
```

**Effort:** ~1 hour
**Testing:** ~30 minutes
**Total:** ~1.5 hours

### Use Cases
- Populate dropdown filters
- Generate legend categories
- Get list of unique values for analysis

**Recommendation:** ✅ **WORTH ADDING** - Very simple, very useful

---

## Summary and Recommendations

| Feature | Complexity | Effort | Usefulness | Recommendation |
|---------|-----------|--------|------------|----------------|
| **orderByFields** | ⭐ LOW | 2-3 hrs | HIGH | ✅ **ADD** |
| **returnDistinctValues** | ⭐ VERY LOW | 1.5 hrs | HIGH | ✅ **ADD** |
| **Time Queries (Level 1)** | ⭐ LOW | 2 hrs | MEDIUM | ⚠️ Consider |
| **Time Queries (Level 2)** | ⭐⭐ MEDIUM | 4 hrs | MEDIUM | ⚠️ Consider |
| **Time Queries (Level 3)** | ⭐⭐⭐ MEDIUM-HIGH | 6 hrs | LOW | ❌ Skip for now |
| **groupByFields** | ⭐⭐ MEDIUM | 6-9 hrs | LOW | ❌ Skip for now |

---

## Quick Win Features (Recommend Adding)

### 1. orderByFields (~2-3 hours)
**Why:** Very common use case, minimal code
**Benefit:** Enables sorted lists, ranked results

### 2. returnDistinctValues (~1.5 hours)
**Why:** Extremely simple, enables filter UIs
**Benefit:** Powers dropdown filters, legend generation

### 3. Basic Time Filtering (~2 hours)
**Why:** Simple WHERE clause addition
**Benefit:** Temporal queries for time-series data

**Total Effort for Quick Wins:** ~6 hours

---

## Skip For Now (Can Add Later)

### 1. groupByFields/Aggregation
**Why:** Can be done via SQL views or separate queries
**Alternative:** Users can create aggregation views in Databricks

```sql
-- Instead of groupByFields query, create a view
CREATE VIEW vessel_type_stats AS
SELECT
  vessel_type,
  COUNT(mmsi) as vessel_count,
  AVG(sog) as avg_speed
FROM vessel_tracking
GROUP BY vessel_type;

-- Then expose as a separate Feature Service
```

### 2. Advanced Time Animation
**Why:** Complex, niche use case
**Alternative:** Basic time filtering covers 80% of use cases

---

## Implementation Priority

**Phase 1 (Now - Already Done):**
- ✅ Basic queries (where, geometry, spatial filters)
- ✅ Pagination
- ✅ Field selection
- ✅ Count queries

**Phase 2 (Quick Wins - Recommend):**
- ⭐ Add orderByFields (2-3 hrs)
- ⭐ Add returnDistinctValues (1.5 hrs)
- ⭐ Add basic time filtering (2 hrs)
- **Total:** ~6 hours

**Phase 3 (Future - If Needed):**
- Add time-aware metadata (4 hrs)
- Add groupByFields support (6-9 hrs)
- Add advanced time animation (6 hrs)

**Phase 4 (Probably Never):**
- Editing capabilities
- Advanced geometry operations
- Complex aggregations

---

## Code Structure for Adding Features

All these features would be added to existing modules:

```javascript
// sql.js
function buildSqlQuery(geoParams, ...) {
  // ... existing code ...

  // NEW: Add ORDER BY
  const orderByClause = buildOrderByClause(geoParams.orderByFields);

  // NEW: Add time filter
  const timeFilter = buildTimeFilter(geoParams.time, sourceConfig.timeField);
  if (timeFilter) whereClauses.push(timeFilter);

  // NEW: Handle distinct values
  if (geoParams.returnDistinctValues) {
    return buildDistinctQuery(geoParams.outFields, tableName, whereClause);
  }

  // NEW: Handle grouping
  if (geoParams.groupByFields) {
    return buildGroupByQuery(geoParams.groupByFields, geoParams.outStatistics, ...);
  }

  return `SELECT ${fields} FROM ${table} ${whereClause} ${orderByClause} LIMIT ${limit}`;
}
```

All additions are **non-breaking** - existing functionality remains unchanged.
