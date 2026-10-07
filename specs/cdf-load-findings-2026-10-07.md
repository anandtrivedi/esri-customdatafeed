# CDF under load: findings from the fed box, 2026-10-07

Context: ArcGIS Enterprise 12.1 fed box, provider `1.1.5-cloudfetch.1` (this branch) deployed 15:5x UTC. Service
`ais_points_10y_2015_2024` (28.2B rows, `atrivedi.ais.ais_historical_noaa`) opened in Map Viewer straight from its
URL (`/apps/mapviewer/index.html?url=…/ais_points_10y_2015_2024/FeatureServer`). Warehouse `ef4aff05eff54de2`.

## Fixed on this branch

**CloudFetch crashed the whole CDF process.** Large results make the driver download from presigned storage URLs; the
box can't reach them (403). `@databricks/sql` 1.12.0 `CloudFetchResultHandler.fetchNext()` starts up to 10 downloads and
awaits only the first, so the request fails cleanly but the rest reject unhandled and Node exits `customdatanodejsapp`
(14:43:45 UTC: every service on the box returned `500 Error performing query operation` until restart).

- Fix: `statementOptions()` in `model.js`, `useCloudFetch: false` on all five `executeStatement` calls unless
  `DATABRICKS_USE_CLOUDFETCH=true`. Driver pinned to exactly 1.12.0. Tests: `test/cloudFetch.test.js`.
- Evidence: `testing/repro-cloudfetch-unhandled.js` (offline repro, exits plain Node with the box's stack);
  `testing/box-cloudfetch-check.js` run on the box as `arcgis`: default → 403 + 1 unhandled rejection; off → 300K rows
  in 6.8 s. `testing/live-cloudfetch-check.js`: inline as fast as CloudFetch at 300K–1M rows; CDF pages (≤50K rows)
  never used CloudFetch.
- Verified after deploy: the same Map Viewer case no longer crashes the process.

## Found after the fix (not fixed here)

With crashes gone, the same traffic now queues instead. Observed 15:5x–16:0x UTC: warehouse 4 RUNNING + 5 QUEUED for
3+ min, pool `Waiting for available connection (active: 12/10)`, `Connection acquisition timeout` on new requests, the
points service's own metadata returning `500 Connection acquisition timeout`, and Map Viewer showing nothing new after
zooming out. Two provider queries had to be cancelled by hand (running 395 s and 415 s).

Order of events: restart → in-memory time extent lost → first metadata request didn't get it within
`CDF_EXTENT_WAIT_MS`-style 10 s budget (`time extent … not ready in 10000 ms — recomputing in the background`) →
metadata went out with no `timeExtent` → Map Viewer showed no time slider and sent no `time=` → every tile became a
ten-year scan (`WHERE (1=1) AND ST_Intersects(…)`) → slow queries held all pool connections → everything else waited.

Recommended fixes, roughly in priority order:

0. **[Fixed on this branch] Drop `ORDER BY` on tile queries.** Map Viewer's feature-tile requests carry `resultType=tile`,
   `orderByFields=bigid ASC` (the objectId), `returnExceededLimitFeatures=false`, a 5,000-row page. The provider passes
   the order through, so "first 5,000 by bigid in this tile" means scanning and sorting every matching row. Measured on
   the warehouse, NY-harbor tile, all history: **33.1 s with `ORDER BY bigid ASC LIMIT 5001`, 2.2 s without** (same
   5,001 rows returned). Tiles don't page and need no particular order, so for `resultType=tile` ignore `orderByFields`
   (at least when it's only the idField). With dozens of US tiles and a 10-connection pool, this is why zooming in
   showed nothing for minutes. Check whether other clients rely on the order for tile results before shipping.
   Also verified while chasing this: tile results are spatially correct. Every returned point is inside its tile and
   JSON/PBF decode to the same positions (`trident-ais/.uitest/pbfdecode.py`); the dense block Map Viewer draws in the
   South Pacific is real data (American Samoa area), as is the one near Guam/Marianas.
   Separately, Map Viewer opened from a raw `?url=` (anonymous, headless) showed no time slider and sent no `time=` for
   either the points or the hex service even with `timeInfo.timeExtent` present, so it can't be relied on to apply time.

1. **[Built on this branch — but ArcGIS Server doesn't pass the abort through] Cancel the SQL when the client goes
   away.** `1.1.5-cloudfetch.3` cancels on `req.res` `close` (unit-tested). Tested live 17:38–17:40 UTC with no other
   traffic: a slow query through `:6443`, client gave up after 3 s; the provider never saw a close, ran the SQL to the end
   (warehouse FINISHED, 48.7 s) and returned 2,000 features to ArcGIS, which discarded them. The browser cancels its PBF
   requests, but ArcGIS Server keeps its (likely pooled, keep-alive) connection to the CDF runtime, so Node gets no
   signal. The code stays (harmless; works if a deployment does close the connection), but it doesn't help here. The
   effective caps are the statement timeout (item 3) and not issuing ten-year tile scans in the first place (item 7,
   default time window); consider a shorter `DATABRICKS_QUERY_TIMEOUT` for tile-heavy services.
   Original note: Map Viewer abandons tiles on zoom/pan, but the provider keeps their
   queries running and holding connections. Hook the request's close/abort and `cancel()` the operation; release the
   connection. This is the main cause of "zoom out and nothing new arrives".
2. **Keep the time extent across restarts.** It's computed at runtime and held in memory only (the publish step sets
   `timeColumn`, not the range). Persist the last good `[min, max]` per table (file next to the provider, or a
   service setting with a static range) and serve it immediately after a restart while the background refresh runs. A
   time-enabled layer should never go out without a range.
3. **[Fixed on this branch: session `STATEMENT_TIMEOUT`, verified live] Enforce the statement timeout.** `DATABRICKS_QUERY_TIMEOUT` defaults to 120 s, yet provider queries ran 395 s and
   415 s. Check whether `queryTimeout` is honoured with `runAsync: true` in 1.12.0; if not, cancel the operation from the
   provider after the timeout.
4. **[Fixed on this branch: in-flight creations count against max] Pool counter exceeds its max.** Log shows `active: 12/10`. Find the path that increments `activeConnections`
   without a matching decrement or bypasses the max (likely around destroy-after-error or the time-extent background
   connection).
5. **Don't let tile traffic starve metadata.** Metadata requests (and other services' requests) wait behind heavy tile
   queries in the same pool. Options: serve metadata from cache without taking a pool connection; reserve a connection
   for metadata; or a per-service concurrency cap so one heavy layer can't take all 10 connections.
6. **Cap `returnIdsOnly` / `returnDistinctValues`.** `sql.js` omits `LIMIT` for both. On the box, a one-day West Coast
   ids-only query returned 1.95M ids and took the process to 559 MB RSS; ten years in one tile would be far larger and
   can exhaust memory (and, before this branch, was the shape that triggered CloudFetch).
7. **Protect against all-history scans on huge time-enabled tables.** Consider, per service: advertise `minScale` for
   point layers so Map Viewer doesn't request points when zoomed out (standard layer metadata clients honour); and/or
   an opt-in default time window applied when a request on a time-enabled layer has no `time=`. Both are publisher
   choices, documented in the README.

Correction and Map Viewer findings (18:3x UTC):

- **Log-based "no time filter" claims were wrong.** `sql.js` appends the time condition after the geometry condition, and
  the provider logged only the first 150 characters, so the time window never showed. Claims based on request URLs stand
  (the anonymous headless Map Viewer sent `time: null`); claims based only on logged SQL ("184 queries with no time
  filter") don't. [Fixed on this branch: the log shows the SQL head and tail, so the time window is always visible.]
- **Signed-in Map Viewer with the time slider on defaults to a one-year window** (12/31/2014–1/1/2016, the first year of
  the extent), every time, and the slider is hard to set to a short window by dragging. So a "default window when
  `time=` is absent" would not apply to slider users; each tile is a year of data (2.6–9.5 s per tile, capped at 5,000).
  This makes the parked `timeInterval` setting worth testing: if Map Viewer derives its default step/window from
  `timeInfo.timeInterval`, advertising "1 hour" would make the first view light. Untested.
- **Reports above 85°N draw off the top of the map.** 2,668 rows in ten years (683 vessels in one longitude band, many at
  exactly 90.0°, at US longitudes): bad position fixes. Web Mercator ends at ~85.05°, so they render above the map, and
  they appear first because polar tiles are nearly empty and return fast. A data-quality filter in the source view
  (lat between -85 and 85, lon between -180 and 180) is the fix; it's not a provider issue.

Logging made this hard to troubleshoot (found while testing cancel-on-abandon):

- **[Fixed on this branch] Log ids were shared across requests.** `requestCounter` was module-level and read after
  awaits, so one `Query N` mixed lines from several concurrent requests (e.g. "using connection A" … "released
  connection B"). Each request now copies its own id (`requestSeq` → per-request `requestCounter`).
- **ArcGIS Server logs rotate about every 10 s** under tile load, keeping only a minute or two. The volume is mostly the
  per-feature `Invalid ID value` warnings (64-bit ids) plus debug-level server logging. Worth: logging that warning once
  per service, and a lower ArcGIS log level in normal use.
- **`returnGeometry=false` still selects geometry.** An ids/attributes request with `returnGeometry=false` produced
  `SELECT bigid, ST_AsGeoJSON(geom) …`; skipping the geometry would make those requests cheaper.

Also seen, lower priority:

- `LZ4 native module failed to load: Architecture or version mismatch` at every start. Harmless: the driver then
  doesn't request LZ4, results come back uncompressed. `npm rebuild lz4` on the box would remove the warning.
- Map Viewer requested each tile twice (same bytes) in a headless repro; may be Map Viewer behaviour, worth a look
  only if load stays a problem.

## Guidance for publishers / users (README candidates)

- A 28B-row point layer is not meant to be drawn zoomed out across ten years. Pair it with the H3 density services
  for small scales; set the points layer's visibility range in the web map (or via `minScale`, item 7).
- Share it as a saved web map with time enabled and a default window (e.g. one hour), not as a raw service URL. A raw
  URL works, but until items 1–2 land it depends on the time extent being cached.
