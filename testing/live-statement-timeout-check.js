// Live check: is a session-level STATEMENT_TIMEOUT enforced by a SQL warehouse? (the driver's per-statement
// queryTimeout is documented as compute-clusters-only). Runs a known-slow query (~33 s: ten-year tile with ORDER BY)
// in a session opened with STATEMENT_TIMEOUT=<n> and reports how it ends.
// Run: node testing/live-statement-timeout-check.js <profile> <warehouse-id> <timeout-seconds>
const path = require('path');
const { execFileSync } = require('child_process');
const { DBSQLClient } = require(path.join(__dirname, '../nodejs-provider/node_modules/@databricks/sql'));
const [profile = 'arclake', warehouse = 'ef4aff05eff54de2', secs = '5'] = process.argv.slice(2);
const tok = JSON.parse(execFileSync('databricks', ['auth', 'token', '--profile', profile, '-o', 'json']).toString()).access_token;
const d = JSON.parse(execFileSync('databricks', ['auth', 'describe', '--profile', profile, '-o', 'json']).toString());
const host = (d.details?.host || d.host).replace(/^https?:\/\//, '');
const box = "ST_GeomFromText('POLYGON((-74.3 40.45,-73.8 40.45,-73.8 40.8,-74.3 40.8,-74.3 40.45))',4326)";
const sql = `SELECT base_datetime, bigid FROM atrivedi.ais.ais_historical_noaa WHERE ST_Intersects(geom, ${box}) ORDER BY bigid ASC LIMIT 5001 /* ${Date.now()} */`;
(async () => {
  const client = new DBSQLClient({ logger: { log: () => {} } });
  await client.connect({ host, path: `/sql/1.0/warehouses/${warehouse}`, token: tok });
  const session = await client.openSession({ configuration: { STATEMENT_TIMEOUT: String(secs) } });
  const t0 = Date.now();
  try { const op = await session.executeStatement(sql, { runAsync: true, useCloudFetch: false }); const r = await op.fetchAll(); await op.close(); console.log(JSON.stringify({ outcome: 'finished', rows: r.length, seconds: (Date.now() - t0) / 1000 })); }
  catch (e) { console.log(JSON.stringify({ outcome: 'error', seconds: (Date.now() - t0) / 1000, message: e.message.slice(0, 200) })); }
  await session.close(); await client.close();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
