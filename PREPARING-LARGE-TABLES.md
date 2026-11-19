# Preparing large tables

Lessons from serving 28 billion AIS position reports (10 years) through one ArcGIS Server running this provider. Most apply to any table above a few hundred million rows.

**Table layout**
- **Store geometry as native `GEOMETRY` (SRID 4326).** No parsing per row.
- **Liquid-cluster on time + a spatial key**, e.g. `CLUSTER BY (event_date, h3_cell)`. Map tiles filter on both.
- **Run `OPTIMIZE` after an `UPDATE`/`MERGE` fix-up.** The corrected rows land in new files that span every date, so every query has to read them until they're compacted.
- **Unwrap dateline-crossing polygons in the data.** The provider unwraps them on output (v1.1.5+); fixing the data keeps other clients clean too.

**What to publish**
- **Pre-aggregate for small scales.** Serve H3 hex tables when zoomed out, and raw points only when zoomed in.
- **Precompute "latest per entity" as its own table.** The provider serves rows; it can't pick the newest row per vessel or asset.
- **Keep the `idField` in Esri's range where you can.** OBJECTIDs are 32-bit (max 2,147,483,647). Larger ids (needed past ~2 billion rows) worked in our testing but are outside Esri's range, so use them at your own risk; the ArcGIS runtime also logs an `Invalid ID value` warning per feature. Above 9,007,199,254,740,991 (2^53 − 1) the provider refuses edits and lookups for those ids (see [Known Limitations](README.md#known-limitations)).

**Service settings**
- **Set a `timeColumn` on anything with history.** Without it Map Viewer shows no time slider and every tile scans all of history: about 10 s per tile over 10 years, versus about 1 s for one day.
- **Set a Minimum Scale on big point layers**, so clients stop requesting features when zoomed out to a whole continent.
- **Raise Max Record Count to 5,000–15,000 for dense point layers, not unlimited.** Each page is one SQL round trip; very large pages (about 3–4 MB) failed in testing. The AIS point layers run at 15,000.
- **Leave PBF on** (the default since v1.1.5). Pages are about 9× smaller than JSON.

**Capacity**
- **One provider process serves every request on a machine.** A single heavy client (e.g. Map Viewer with no time filter) slows every other user. `DATABRICKS_POOL_MAX` (default 10) caps the concurrent warehouse queries per machine; see the [`.env` settings](README.md#2-add-your-databricks-connection-env).
- **No storage access is needed for large results.** Results come back inline from the warehouse (CloudFetch is off by default since v1.1.6), so the server doesn't need to reach the workspace's storage bucket.
