// Reproduces the @databricks/sql CloudFetch crash without a warehouse: two result links, both answer 403.
// fetchNext() starts both downloads but awaits only the first, so the second rejects with no handler. On Node >= 15
// that unhandled rejection exits the process (what killed the CDF runtime on 2026-10-07 14:43:45 UTC).
// Run: node testing/repro-cloudfetch-unhandled.js   (from the repo root; uses nodejs-provider/node_modules)
// Exit 0 = bug reproduced (caught 1 error, saw >= 1 unhandled rejection). Exit 1 = not reproduced.
const path = require('path');
const CloudFetchResultHandler = require(path.join(__dirname, '../nodejs-provider/node_modules/@databricks/sql/dist/result/CloudFetchResultHandler.js')).default;

const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(String(reason && reason.message || reason)));

const link = (n) => ({
  fileLink: `https://storage.example/result-${n}`, httpHeaders: {},
  expiryTime: { toNumber: () => Date.now() + 60_000 }, rowCount: { toNumber: () => 1 },
});
const context = {
  getConfig: () => ({ cloudFetchConcurrentDownloads: 2, cloudFetchSpeedThresholdMBps: 0.1 }),
  getLogger: () => ({ log: () => {} }),
};
const source = { hasMore: async () => false, fetchNext: async () => ({ resultLinks: [link(1), link(2)] }) };

(async () => {
  const handler = new CloudFetchResultHandler(context, source, { lz4Compressed: false });
  // blocked egress: every presigned-URL download is refused
  handler.fetch = async () => ({ ok: false, status: 403, statusText: 'Forbidden', arrayBuffer: async () => new ArrayBuffer(0) });
  let caught = null;
  try { await handler.fetchNext({ limit: 1000 }); } catch (e) { caught = e.message; }
  await new Promise((r) => setTimeout(r, 50)); // let the orphaned download settle
  console.log(JSON.stringify({ caughtByCaller: caught, unhandledRejections: unhandled }));
  process.exit(caught && unhandled.length ? 0 : 1);
})();
