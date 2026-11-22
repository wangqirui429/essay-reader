/**
 * Diagnose why the dictionary feels slow from the public host: measure each
 * core chunk's real transfer time, how many run concurrently, and whether gzip
 * is doing its job.
 *
 * Usage: node tools/diag-network.mjs [baseUrl]
 */

const BASE = process.argv[2] || 'https://wangqirui429.github.io/essay-reader/';

async function timed(url) {
  const t = Date.now();
  const res = await fetch(url, { headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    ms: Date.now() - t,
    status: res.status,
    encoded: res.headers.get('content-encoding'),
    // Content-Length is the compressed size when the body is compressed.
    wire: Number(res.headers.get('content-length')) || buf.length,
    decoded: buf.length,
  };
}

console.log(`measuring ${BASE}\n`);

// 1. One chunk, alone.
const single = await timed(`${BASE}data/core-0.json`);
console.log('single chunk:');
console.log(`  ${single.ms} ms | wire ${(single.wire / 1024).toFixed(0)} KB | decoded ${(single.decoded / 1024).toFixed(0)} KB | ${single.encoded || 'uncompressed'}`);
if (single.ms > 0) {
  console.log(`  effective throughput: ${((single.wire / 1024) / (single.ms / 1000)).toFixed(0)} KB/s`);
}

// 2. All six chunks in parallel.
const t0 = Date.now();
const all = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => timed(`${BASE}data/core-${i}.json`)));
const parallelMs = Date.now() - t0;
const wireTotal = all.reduce((s, r) => s + r.wire, 0);
console.log('\nsix chunks in parallel:');
for (const [i, r] of all.entries()) {
  console.log(`  core-${i}: ${String(r.ms).padStart(5)} ms | wire ${(r.wire / 1024).toFixed(0)} KB`);
}
console.log(`  total wall time: ${parallelMs} ms`);
console.log(`  total wire     : ${(wireTotal / 1024).toFixed(0)} KB`);
console.log(`  aggregate rate : ${((wireTotal / 1024) / (parallelMs / 1000)).toFixed(0)} KB/s`);

// 3. What a small dictionary would have cost.
const small = await timed(`${BASE}data/shards/q.json`);
console.log(`\nsmall file for comparison:`);
console.log(`  shards/q.json: ${small.ms} ms | wire ${(small.wire / 1024).toFixed(0)} KB`);
console.log('\ninterpretation:');
console.log(`  latency floor (smallest file): ~${small.ms} ms`);
console.log(`  six-chunk wall time          : ~${parallelMs} ms`);
console.log('  if wall time >> latency floor, the connection is bandwidth-bound;');
console.log('  if each chunk takes about the same as one small file, it is latency-bound.');
