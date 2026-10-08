// Live check against a real warehouse (from a machine that CAN reach storage): the same large query with the
// driver default and with useCloudFetch: false. The driver logs "Result File Download speed from cloud storage" for
// every CloudFetch download, so counting those lines tells which path served the result.
// Run: node testing/live-cloudfetch-check.js <databricks-cli-profile> <warehouse-id> <rows>
// The token is minted with the Databricks CLI and kept in memory; it's never printed.
const path = require('path');
const { execFileSync } = require('child_process');
const { DBSQLClient } = require(path.join(__dirname, '../nodejs-provider/node_modules/@databricks/sql'));
const [profile = 'arclake', warehouse = 'ef4aff05eff54de2', rows = '300000'] = process.argv.slice(2);

const tok = JSON.parse(execFileSync('databricks', ['auth', 'token', '--profile', profile, '-o', 'json']).toString());
const host = execFileSync('databricks', ['auth', 'describe', '--profile', profile, '-o', 'json']).toString();
const hostname = JSON.parse(host).details?.host?.replace(/^https?:\/\//, '') || JSON.parse(host).host?.replace(/^https?:\/\//, '');

let downloads = 0;
const logger = { log: (level, msg) => { if (/download speed from cloud storage/i.test(msg)) downloads++; } };
const sqlFor = (day) => `SELECT bigid, mmsi, base_datetime, lon, lat, sog, cog, vessel_name
             FROM atrivedi.ais.ais_historical_noaa WHERE event_date = DATE'${day}' LIMIT ${parseInt(rows)}`;

(async () => {
  const client = new DBSQLClient({ logger });
  await client.connect({ host: hostname, path: `/sql/1.0/warehouses/${warehouse}`, token: tok.access_token });
  const session = await client.openSession();
  // a different day per run so no run is served from the warehouse result cache; order swapped across rounds
  const plan = [['driver default', {}, '2024-07-01'], ['useCloudFetch: false', { useCloudFetch: false }, '2024-07-02'],
                ['useCloudFetch: false', { useCloudFetch: false }, '2024-07-03'], ['driver default', {}, '2024-07-05']];
  for (const [label, opts, day] of plan) {
    const sql = sqlFor(day);
    downloads = 0;
    const t0 = Date.now();
    const op = await session.executeStatement(sql, { runAsync: true, ...opts });
    const out = await op.fetchAll();
    await op.close();
    console.log(JSON.stringify({ mode: label, day, rows: out.length, cloudFetchDownloads: downloads, seconds: ((Date.now() - t0) / 1000).toFixed(1) }));
  }
  await session.close(); await client.close();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
