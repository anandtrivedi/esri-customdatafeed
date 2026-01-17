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

## How to Request a Feature

If you need one of these features:

1. **groupByFields** - Create a SQL view in Databricks instead (recommended)
2. **Time metadata** - Open an issue describing your animation use case
3. **Editing** - Consider if Databricks is the right data store for edits

For questions, see [IMPLEMENTATION_VERIFICATION.md](IMPLEMENTATION_VERIFICATION.md) for current implementation details.
