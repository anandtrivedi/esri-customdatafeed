# Lakebase vs Databricks SQL — Differences Tracker

This document tracks all behavioral and implementation differences between the two backends in the CDF provider.

| Aspect | Databricks SQL Warehouse | Lakebase (PostgreSQL + PostGIS) |
|--------|--------------------------|--------------------------------|
| **Engine** | Databricks SQL (Photon) | PostgreSQL 16 + PostGIS |
| **Protocol** | Databricks SQL Connector (Thrift) | `pg` npm module (PostgreSQL wire protocol) |
| **Latency** | 500-2000ms per query | 14-16ms per query |
| **Editing** | Read-only (`getData()`) | Read + Write (`getData()` + `editData()`) |

---

## 1. Connection & Pooling

| | Databricks SQL | Lakebase |
|-|----------------|----------|
| **Module** | `connectionPool.js` | `lakebasePool.js` |
| **Library** | `@databricks/sql` (`DBSQLClient`) | `pg` (`Pool`) |
| **Pool Pattern** | Custom pool class with acquire/release | `pg.Pool` built-in pooling |
| **Auth** | `DATABRICKS_ACCESS_TOKEN` (PAT) | `LAKEBASE_PASSWORD` env var |
| **Agent ID** | `esri_databricks-customdatafeed/{version}` | `esri_databricks-lakebase-customdatafeed/{version}` |
| **Agent ID Field** | `userAgentEntry` (HTTP User-Agent header) | `application_name` (pg connection param) |
| **Telemetry Location** | `system.access.audit.user_agent`, `system.query.history` | `pg_stat_activity.application_name` |
| **SSL** | Managed by connector | `ssl: { rejectUnauthorized: false }` |
| **Pool Sizing** | min 2, max 10 (custom) | min 2, max 10 (`pg.Pool`) |
| **Idle Timeout** | 60s (custom cleanup) | 60s (`idleTimeoutMillis`) |

## 2. Query Building

| | Databricks SQL | Lakebase |
|-|----------------|----------|
| **Module** | `sql.js` + `geometry.js` | `lakebaseQuery.js` |
| **Parameterization** | String interpolation (values escaped) | `$1, $2, ...` positional params (pg native) |
| **Table Reference** | `catalog.schema.table` (3-part) | `schema.table` (2-part, PostgreSQL) |
| **Geometry Output** | `ST_AsGeoJSON(ST_GeomFromWKT(...))` (varies by format) | `ST_AsGeoJSON(geometry)` (native geometry type) |
| **SELECT \*** | `* EXCEPT(geometry), ST_AsGeoJSON(...) AS geometry` | `*, ST_AsGeoJSON(geometry) AS geometry` |
| **COUNT** | `SELECT COUNT(1)` | `SELECT COUNT(*) AS count` |
| **Geometry Formats** | WKT, WKB, GeoJSON, GEOMETRY (configurable) | Native GEOMETRY only (PostGIS) |
| **DISTINCT** | Supported via `returnDistinctValues` | Not yet implemented |
| **Time Filter** | Supported via `time` param + `timeColumn` | Not yet implemented |

## 3. Spatial Functions

| Spatial Relation | Databricks SQL | Lakebase (PostGIS) |
|-----------------|----------------|---------------------|
| `esriSpatialRelIntersects` | `ST_Intersects(A, B)` | `ST_Intersects(A, B)` |
| `esriSpatialRelContains` | `ST_Contains(A, B)` | `ST_Contains(A, B)` |
| `esriSpatialRelWithin` | `ST_Within(A, B)` | `ST_Within(A, B)` |
| `esriSpatialRelTouches` | `ST_Touches(A, B)` | `ST_Touches(A, B)` |
| `esriSpatialRelOverlaps` | **DE-9IM workaround** (5 functions) | `ST_Overlaps(A, B)` (native) |
| `esriSpatialRelCrosses` | **DE-9IM workaround** (7 functions) | `ST_Crosses(A, B)` (native) |

### DE-9IM Workarounds (Databricks only)

**ST_Overlaps** — Databricks SQL lacks native `ST_Overlaps`. Implemented as:
```sql
ST_Dimension(A) = ST_Dimension(B)
AND ST_Intersects(A, B)
AND NOT ST_Covers(A, B)
AND NOT ST_Covers(B, A)
AND NOT ST_Touches(A, B)
```

**ST_Crosses** — Databricks SQL lacks native `ST_Crosses`. Implemented as:
```sql
ST_Intersects(A, B)
AND NOT ST_Touches(A, B)
AND NOT ST_Contains(A, B)
AND NOT ST_Within(A, B)
AND ST_Dimension(ST_Intersection(A, B)) < GREATEST(ST_Dimension(A), ST_Dimension(B))
```

PostGIS has all 6 spatial predicates natively with GIST index support — no workarounds needed.

## 4. CRS / Spatial Reference Handling

| | Databricks SQL | Lakebase |
|-|----------------|----------|
| **From GeoJSON** | `ST_GeomFromGeoJSON(...)` (always SRID 4326) | `ST_SetSRID(ST_GeomFromGeoJSON($N), srid)` |
| **Transform** | `ST_Transform(ST_SetSRID(geom, sourceSR), targetSR)` | `ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($N), sourceSR), targetSR)` |
| **inSR Parsing** | `getSpatialReference()` in `geometry.js` | `parseInSR()` in `lakebaseQuery.js` |
| **latestWkid** | Supported (Esri spatial reference object) | Not yet implemented |
| **WKT CRS** | Throws "not supported" | Not yet implemented |

## 5. Editing (Lakebase only)

Databricks SQL Warehouse does not support interactive editing (DML latency too high). Lakebase provides all edit operations.

| Operation | SQL Pattern | Notes |
|-----------|-------------|-------|
| **Add** | `INSERT INTO schema.table (...) VALUES ($1, ...) RETURNING id` | Auto-generated ID via RETURNING |
| **Update** | `UPDATE schema.table SET col=$1, ... WHERE id=$N` | Must include idField in attributes; rowCount=0 reports failure |
| **Delete** | `DELETE FROM schema.table WHERE id IN ($1, ...) RETURNING id` | Per-row failure via RETURNING |
| **Geometry** | `ST_SetSRID(ST_GeomFromGeoJSON($N), srid)` | Esri JSON auto-converted to GeoJSON |
| **Transactions** | `BEGIN` / `COMMIT` / `ROLLBACK` | `rollbackOnFailure=true` wraps all ops in transaction |

### Error Codes (Esri standard)

| Code | Meaning | When Used |
|------|---------|-----------|
| 1017 | Insert failure | Add operation fails (SQL error or constraint violation) |
| 1018 | Delete failure | Delete targets non-existent ID (via RETURNING check) |
| 1019 | Update failure | Update targets non-existent ID (rowCount=0) or SQL error |
| 1003 | Rolled back | All results when `rollbackOnFailure=true` and any operation fails |

### Editing Templates

Lakebase metadata includes editing templates for ArcGIS clients (Pro "Create Features" pane, JS API Editor widget):

```json
{
  "name": "New Feature",
  "drawingTool": "esriFeatureEditToolPoint",
  "prototype": { "attributes": { "name": null, "height": null } }
}
```

Drawing tool mapped from geometry type: Point, LineString/Polyline, Polygon.

## 6. Configuration

| Parameter | Databricks SQL | Lakebase |
|-----------|----------------|----------|
| **Table** | `tableName` (catalog.schema.table) | `lakebaseTable` + `lakebaseSchema` |
| **Host** | `DATABRICKS_SERVER_HOSTNAME` env | `lakebaseHost` service param |
| **Port** | `DATABRICKS_HTTP_PATH` env | `lakebasePort` service param (default 5432) |
| **Database** | N/A (workspace-scoped) | `lakebaseDatabase` service param |
| **Auth** | `DATABRICKS_ACCESS_TOKEN` env | `LAKEBASE_PASSWORD` env |
| **Edit Flag** | N/A | `editingEnabled: true` in cdconfig.json |

## 7. Response Differences

Both backends return identical GeoJSON FeatureCollection responses. Key handling differences:

| | Databricks SQL | Lakebase |
|-|----------------|----------|
| **Count Field** | `rows[0]["count(1)"]` | `rows[0].count` (aliased as `count`) |
| **Extent Calc** | `ST_Envelope_Agg()` (aggregate function) | Not yet implemented |
| **ID Type** | String from BIGINT (needs `Number()` cast) | Native integer |
| **Geometry Column** | Returned as string (JSON-encoded) | Returned by `ST_AsGeoJSON()` as string |

## 8. Features Not Yet in Lakebase Path

- [ ] `returnDistinctValues` support
- [ ] `time` filter / `timeColumn` support
- [ ] Extent calculation (`ST_Envelope` / `ST_Extent` aggregate)
- [ ] `latestWkid` in spatial reference parsing
- [ ] WKT spatial reference parsing
- [ ] Multiple geometry format support (WKT, WKB storage)
- [ ] Metadata-only request optimization (fetch 1 row)

---

*Last updated: 2026-02-17*
*Test count: 270 passing (175 Databricks + 70 Lakebase edit + 25 PostGIS spatial)*
