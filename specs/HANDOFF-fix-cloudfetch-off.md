# Handoff: branch `fix/cloudfetch-off` (2026-10-06/07)

For the CDF maintainer thread. Please review whether each change makes sense, then reconcile with the other CDF work.
Everything here is local commits on `fix/cloudfetch-off`, cut from `origin/main` at `e6c58ba` (#16). Nothing pushed.
Worktree: `~/Documents/gitprojects/cdf-cloudfetch-wt`. Detailed evidence, timelines and log excerpts:
`specs/cdf-load-findings-2026-10-07.md`.

Provider build running on the fed box (ArcGIS Enterprise 12.1, `34.218.4.139`) since 19:05 UTC 2026-10-07:
**`1.1.5-cloudfetch.5`** (this branch at `a35418a`). Rollback copies of every earlier build are in
`/home/arcgis/cdf-backups/`; staged packages in `/home/ubuntu/cdf-v1.1.5-cloudfetch.{1..5}/`.

Tests: `cd nodejs-provider && npm test` → **475 passing** (was 439 on main). `mcp-server` tests weren't run (no
`node_modules` in this worktree; its code is unchanged).

## Drop before merging

- The five `Build label 1.1.5-cloudfetch.N` commits (`8e23517`, `6810b67`, `c9d81e1`, `fb1e389`, `a35418a`). They only
  change `package.json` `version` so the box shows which test build is running. `CONNECTOR_RELEASE` in
  `src/modules/version.js` was left at `1.1.5` (its test requires `x.y.z`; it's the telemetry version).
- `dist/` artifacts are gitignored; rebuild with `bash build-release.sh`. The committed `cdpk/12.x` and `cdpk/11.x`
  packages were NOT rebuilt.

## What happened, in order

1. The AIS points service (28.2B rows) opened from a raw `?url=` in Map Viewer returned `500 Error performing query
   operation` on every tile. Cause: one large result used CloudFetch, the box can't reach cloud storage (403), and a
   driver bug turned that into an uncaught exception that killed the whole CDF Node process (every service on the box).
2. With the crash fixed, the same traffic queued instead: the pool filled, metadata requests timed out, nothing drew.
   Each cause below was measured on the box or the warehouse before changing code.
3. Fixes were built, unit-tested, deployed to the fed box five times, and checked live after each deploy.

## Changes (each: what, why, evidence, tests)

### 1. CloudFetch off by default — `8f2cb7d`

- **What:** `statementOptions()` in `model.js` passes `useCloudFetch: false` on all five `executeStatement` calls
  unless `DATABRICKS_USE_CLOUDFETCH=true`. `@databricks/sql` pinned to exactly `1.12.0` (was `^1.5.3`) in
  `package.json` and the lockfile root.
- **Why:** `CloudFetchResultHandler.fetchNext()` (driver 1.12.0) starts up to 10 downloads and awaits only the first.
  On a host that can't reach storage, the request fails cleanly, but the other downloads reject unhandled and Node 24
  exits the CDF process. Per statement because the 1.12.0 `DBSQLClient` constructor ignores a `config` argument
  (`DBSQLClient.js:94`); `DBSQLSession.js:185` maps `options.useCloudFetch` → `canDownloadResult`.
- **Evidence:** box log 14:43:45 UTC `uncaughtException: CloudFetch HTTP error 403 Forbidden at
  CloudFetchResultHandler.downloadLink (…/CloudFetchResultHandler.js:95:19)`, process restarted 6 s later.
  `testing/repro-cloudfetch-unhandled.js` reproduces it offline (plain Node exits with the same stack).
  `testing/box-cloudfetch-check.js` run on the box as `arcgis`: default → 403 + 1 unhandled rejection; off → 300K rows
  in 6.8 s. `testing/live-cloudfetch-check.js` (laptop, can reach storage, no result cache, order swapped): inline as
  fast as CloudFetch at 300K–1M rows; CDF-sized pages (2K/8K/50K rows) never used CloudFetch.
- **Tests:** `test/cloudFetch.test.js` — every statement path (DESCRIBE probe, extent, time extent, main query) gets
  `useCloudFetch: false`; env opt-in values; mutation check (tests fail without the option).
- **Live:** no crashes since the first deploy.

### 2. No `ORDER BY` on feature tiles — `107c7f0`

- **What:** `resultType=tile` with no `resultOffset` skips `orderByFields`, in `sql.js` and `lakebaseQuery.js`.
- **Why:** Map Viewer sends `orderByFields=<objectId> ASC` on every tile. Tiles don't page and need no order; the
  sort made the warehouse read and sort every row in the tile before the LIMIT.
- **Evidence:** NY-harbor tile, all history: 33.1 s with `ORDER BY bigid ASC LIMIT 5001`, 2.2 s without, same rows.
  Live after deploy: US tiles 3.4–8 s median instead of 33 s+; 0 of 12 tile SQL statements had ORDER BY.
- **Tests:** `test/sql.test.js`, `test/lakebaseQuery.test.js` (tile drops it; paged tile and non-tile keep it).
- **Please check:** whether any client relies on ordering of `resultType=tile` results.

### 3. Statement timeout that warehouses actually enforce — `107c7f0`

- **What:** the pool opens every session with `configuration: { STATEMENT_TIMEOUT }` (seconds), derived from
  `DATABRICKS_QUERY_TIMEOUT` (ms, default 120000).
- **Why:** the driver's per-statement `queryTimeout` is documented "effective only with Compute clusters. For SQL
  Warehouses, STATEMENT_TIMEOUT configuration should be used" (`IDBSQLSession.d.ts`). Provider queries ran 395 s and
  415 s against a "120 s" timeout and held the pool.
- **Evidence:** `testing/live-statement-timeout-check.js`: session with `STATEMENT_TIMEOUT=5` on the 33 s query →
  `Statement has timed out after 5 seconds.` at 5.3 s. Live: longest CDF query after deploy 112 s.
- **Tests:** `test/connectionPool.test.js` (default 120, ms→s conversion).

### 4. Pool never exceeds `max` — `107c7f0`, `6c045da`

- **What:** `this.creating` counts connections still being opened against `max`; connections are created already
  checked out (`createConnection({ inUse: true })`); the refill path marks an unclaimed new connection idle.
- **Why:** `createConnection()` awaits connect/openSession before pushing to `this.pool`, so concurrent acquires all saw
  room (log: `active: 12/10`). Second race (found by the review panel): a new connection joined the pool marked idle
  before its caller's `await` resumed, so another acquire could take it.
- **Tests:** 15 concurrent acquires on a slow connect open exactly 10 (old code opened 15); the connection is `inUse`
  when pushed.
- **Note:** CLAUDE.md said pool "race conditions are not real"; corrected there (true within a tick, not across awaits).

### 5. Cancel on client abandonment — `3929828`, hardened in `6c045da` — **built, but doesn't fire behind ArcGIS**

- **What:** `getData` watches `req.res` `close` (ignored once the response is written). If the client is gone: cancel
  the running statement, return the connection (not destroyed); skip a queued request whose client already left.
  Hardened: one shared cancel (also used by item 6), awaited before the session is closed or reused; a failed cancel
  destroys the session; no response is built after a cancel; `respond()` answers exactly once even if the callback
  throws.
- **Why:** the browser aborts PBF tile requests on pan/zoom; we hoped to stop their SQL too.
- **Evidence (live, 17:38–17:40 UTC, no other traffic):** slow query through `:6443`, client gave up after 3 s; the
  provider never saw a close, ran the SQL to the end (warehouse FINISHED, 48.7 s) and returned 2,000 features to
  ArcGIS, which discarded them. ArcGIS Server doesn't pass the abort to the CDF runtime (likely a pooled keep-alive
  connection). Kept because it's harmless and correct where a deployment does close the connection.
- **Tests:** `test/clientGone.test.js` (mid-query cancel, queued-and-gone, normal close ignored, no `res`; mutation
  check).
- **Please check:** whether to keep it given it doesn't fire behind ArcGIS Server.

### 6. Tile query timeout — `6c045da`

- **What:** `DATABRICKS_TILE_QUERY_TIMEOUT` (ms, default 30000; 0 disables): a provider timer cancels
  `resultType=tile` statements, through the same cancel as item 5. Non-tile queries rely on item 3.
- **Why:** since item 5 can't fire, abandoned tiles otherwise hold a connection until the 2-minute statement timeout.
- **Evidence:** live, 18:4x UTC: 10 tile queries logged `cancelling its SQL (tile query over 30 s)` while the user
  moved the slider.
- **Tests:** tile cancelled and connection reused; non-tile untouched; failed cancel destroys the session; single
  response.

### 7. Per-request log ids — `695e6e5`

- **What:** each request copies its own id (`requestSeq` → per-request `requestCounter`; Lakebase path reads
  `req._cdfRequestId`).
- **Why:** a module-level counter read after awaits labelled lines with whichever request arrived last (one
  `Query 811` showed "using connection A" … "released connection B").

### 8. Log the SQL head and tail — `d6ba315`

- **What:** SQL over 400 chars logs the first 160 and last 240 characters.
- **Why:** the time and objectIds conditions come after the long geometry condition; the old 150-character prefix hid
  them, which led us to wrong conclusions (see findings: "log-based no-time-filter claims were wrong").

### 9. Time instants and open-ended ranges — `d0c287f`

- **What:** `buildTimeFilter` handles all three ArcGIS forms: instant `t` → `col = t`; `null,t` / `t,null` →
  open-ended; `null,null` → unbounded. An unreadable value is an error.
- **Why:** Map Viewer's slider in instant mode sends one value. It parsed as NaN, the filter was dropped, and each tile
  scanned ten years (live: one-hour/instant tiles hit the 30 s tile timeout and came back as ~0.7 KB errors).
- **Evidence (live on `cloudfetch.5`, San Pedro):** instant 17:00:00 → 4 rows all at 17:00:00 (3.2 s); 17–18Z window →
  2,000 rows within the hour (2.6 s); `2024-12-31,null` → rows from 2024-12-31 (2.7 s); `time=yesterday` →
  `Invalid time parameter: yesterday`. On `cloudfetch.4`, the instant and `yesterday` both returned 2,000 arbitrary rows
  from all ten years.
- **Tests:** `test/sql.test.js` (instant, open-ended, unreadable).

### 10. Optional `minScale` service parameter — `6c045da`

- **What:** new manifest parameter (16th) taking a scale (`577791`) or a zoom level (`zoom 10`); `modules/scale.js`
  parses it; both backends put it in layer metadata; malformed values are logged once and ignored. Wizard prompt;
  README table; the field's info text carries the rule of thumb by row count.
- **Why:** standard layer metadata that Map Viewer, Pro and the JS SDK honour, so huge point layers aren't drawn (or
  queried) at continental zooms.
- **Evidence:** the runtime's `FeatureLayerMetadata._setDirectOverrides` copies `metadata.minScale` into the layer JSON
  (`featureserver/src/helpers/feature-layer-metadata.js`). The info text renders in full on the Portal publish form
  (screenshot from the user). Existing services published without the parameter still load and query after deploy —
  this was the untested direction from the parked time-info spec (adding a manifest parameter).
- **Not yet verified:** a service with `minScale` set (Map Viewer stopping when zoomed out).
- **Tests:** `test/scale.test.js`; `test/cloudFetch.test.js` "minScale service parameter".

### Docs

README: "Preparing large tables"-style guidance for `minScale`, `DATABRICKS_USE_CLOUDFETCH` and
`DATABRICKS_TILE_QUERY_TIMEOUT` in the tuning knobs and env reference, `minScale` in the parameter lists and the
createService REST example. CLAUDE.md: parameter count, gotchas for each change above.

## Findings not fixed here (details in the findings file)

- **Time extent is in memory only.** After every restart the first metadata requests go out without
  `timeInfo.timeExtent` until the background query (≈39 s on 28B rows) finishes. Persist the last good extent per table
  or allow a static range.
- **Map Viewer defaults the time slider to one year** (the first year of the extent), every time, and dragging to a
  short window is impractical; instant mode is the default thumb in some cases. A year per tile is the main remaining
  cost. Advertising `timeInfo.timeInterval` (the parked spec's setting) might change Map Viewer's default; untested.
- **Default time window for requests without `time=`** (designed, not built). Review panel consensus: only as opt-in,
  tile-only, anchored to the end of the cached extent, never for counts/ids/statistics/paging; but it wouldn't apply to
  slider users since the slider always sends a window.
- **Uncapped `returnIdsOnly` / `returnDistinctValues`.** On the box a one-day ids-only query returned 1.95M ids (559 MB
  RSS). Map Viewer does issue `returnIdsOnly` requests.
- **`returnGeometry=false` still selects geometry.**
- **Per-feature `Invalid ID value` warnings** (64-bit ids) flood the logs; ArcGIS logs rotate about every 10 s under
  tile load. Log once per service.
- **Metadata waits behind tile queries** in the same pool; consider serving metadata from cache without a connection.
- **H3 covering-set pruning** for tile queries (review-panel idea): fixes the "5,000 points from a few files" clumping
  without touching time semantics.
- **Data quality, not provider:** 2,668 reports above 85°N (bad fixes) draw off the top of Web Mercator; filter them in
  the source view.

## How to reproduce / verify

- Offline driver bug: `node testing/repro-cloudfetch-unhandled.js` (exit 0 = reproduced).
- On the box (as `arcgis`, standalone process, read-only): `testing/box-cloudfetch-check.js <provider-dir> arclake`.
- Laptop, live warehouse: `testing/live-cloudfetch-check.js arclake <warehouse> <rows>`,
  `testing/live-statement-timeout-check.js arclake <warehouse> 5`.
- Deploy on the fed box: `cd /home/ubuntu/cdf-v1.1.5-cloudfetch.N && bash update_provider_federated.sh` (Portal admin
  token; backs up the running provider to `/home/arcgis/cdf-backups/` first; services take about a minute to come back
  and briefly return `Service not found`).
- Box log tips: ArcGIS server logs rotate fast; read several files (`ls -t …/server-*.log | head -10`) or capture live.
