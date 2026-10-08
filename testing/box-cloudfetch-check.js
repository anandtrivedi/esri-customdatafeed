// Run ON the ArcGIS box, as the arcgis user, in its own Node process (never inside the CDF runtime):
//   sudo -u arcgis <node> box-cloudfetch-check.js <provider-dir> [profile]
// Uses the provider's installed @databricks/sql and the [profile] host/token from ~/.databrickscfg (never printed).
// Shows, on the box's real network, whether CloudFetch downloads are refused, and that useCloudFetch:false works.
// Read-only queries. Unhandled rejections are counted (not fatal) so the script reports instead of dying.
const fs = require('fs'); const os = require('os'); const path = require('path');
const [providerDir, profile = 'arclake'] = process.argv.slice(2);
const { DBSQLClient } = require(path.join(providerDir, 'node_modules/@databricks/sql'));

const cfg = {}; let sect = null;
for (const line of fs.readFileSync(path.join(os.homedir(), '.databrickscfg'), 'utf8').split('\n')) {
  const s = line.match(/^\s*\[(.+)\]\s*$/); if (s) { sect = s[1]; continue; }
  const kv = line.match(/^\s*([\w-]+)\s*=\s*(.*?)\s*$/); if (kv && sect === profile) cfg[kv[1]] = kv[2];
}
if (!cfg.host || !cfg.token) { console.error(`profile [${profile}] needs host + token`); process.exit(2); }

const unhandled = []; process.on('unhandledRejection', (r) => unhandled.push(String(r && r.message || r)));
let downloads = 0;
const logger = { log: (lvl, msg) => { if (/download speed from cloud storage/i.test(msg)) downloads++; } };
const T = 'atrivedi.ais.ais_historical_noaa';
const cases = [
  ['300K rows, driver default', `SELECT bigid, mmsi, base_datetime, lon, lat, sog, cog, vessel_name FROM ${T} WHERE event_date = DATE'2024-07-08' LIMIT 300000`, {}],
  ['300K rows, useCloudFetch:false', `SELECT bigid, mmsi, base_datetime, lon, lat, sog, cog, vessel_name FROM ${T} WHERE event_date = DATE'2024-07-09' LIMIT 300000`, { useCloudFetch: false }],
  // shape of the provider's returnIdsOnly SQL: id column only, filters, and no LIMIT (sql.js skips it for ids-only)
  ['ids-only, no LIMIT, driver default', `SELECT bigid FROM ${T} WHERE event_date = DATE'2024-07-10' AND lon BETWEEN -125 AND -115`, {}],
  ['ids-only, no LIMIT, useCloudFetch:false', `SELECT bigid FROM ${T} WHERE event_date = DATE'2024-07-11' AND lon BETWEEN -125 AND -115`, { useCloudFetch: false }],
];

(async () => {
  const client = new DBSQLClient({ logger });
  await client.connect({ host: cfg.host.replace(/^https?:\/\//, '').replace(/\/$/, ''), path: '/sql/1.0/warehouses/ef4aff05eff54de2', token: cfg.token });
  const session = await client.openSession();
  for (const [label, sql, opts] of cases) {
    downloads = 0; const before = unhandled.length; const t0 = Date.now(); let rows = null; let err = null;
    try { const op = await session.executeStatement(sql, { runAsync: true, ...opts }); rows = (await op.fetchAll()).length; await op.close(); }
    catch (e) { err = e.message; }
    await new Promise((r) => setTimeout(r, 1500)); // let any orphaned downloads settle
    console.log(JSON.stringify({ case: label, rows, error: err, cloudFetchDownloadsOk: downloads, newUnhandledRejections: unhandled.length - before,
      seconds: ((Date.now() - t0) / 1000).toFixed(1), rssMB: Math.round(process.memoryUsage().rss / 1e6) }));
  }
  await session.close(); await client.close();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
