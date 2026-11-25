#!/usr/bin/env node
/**
 * Evaluate the real TypeScript local FSPK v4 search path against emitted corpus pages
 * and the versioned query dataset (#44). Measures cold vs warm sessions, transferred bytes,
 * rare vs common query latency, cancellation, concurrency, CPU time, and memory.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  createCorpusSearch,
  decodeLocalSearchResult,
  normalizeLocalSearchQuery,
} from '../../src/Contracts/local-search.ts';
import { WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts';

function parseArgs(argv) {
  const opts = { fspkDir: '', queries: '', out: '', concurrency: 4 };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--fspk-dir': opts.fspkDir = argv[++i]; break;
      case '--queries': opts.queries = argv[++i]; break;
      case '--out': opts.out = argv[++i]; break;
      case '--concurrency': opts.concurrency = Number(argv[++i]); break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!opts.fspkDir || !opts.queries || !opts.out) {
    throw new Error('Usage: search-eval-local.mjs --fspk-dir DIR --queries FILE --out FILE');
  }
  return opts;
}

function summarize(values) {
  if (values.length === 0) return { count: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const pct = (p) => {
    if (sorted.length === 1) return sorted[0];
    const rank = p * (sorted.length - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
  };
  return {
    count: sorted.length,
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50: pct(0.50),
    p95: pct(0.95),
    p99: pct(0.99),
    max: sorted[sorted.length - 1],
  };
}

const opts = parseArgs(process.argv.slice(2));
const manifest = JSON.parse(readFileSync(join(opts.fspkDir, 'manifest.json'), 'utf8'));
const queryDoc = JSON.parse(readFileSync(opts.queries, 'utf8'));

const pages = [];
const etags = [];
for (let p = 1; p <= manifest.pageCount; p++) {
  const raw = readFileSync(join(opts.fspkDir, `page-${String(p).padStart(3, '0')}.fspk`));
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  pages.push(bytes);
  etags.push(`"${createHash('sha256').update(bytes).digest('hex')}"`);
}

const generation = '440001';
let transferredBytes = 0;
let getRequests = 0;
let headRequests = 0;

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
  if (url.pathname !== WireRoutes.PublicSearchCorpus) {
    return new Response(null, { status: 404 });
  }
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = {
    'Content-Type': 'application/octet-stream',
    [WireHeaders.SearchIndexGeneration]: generation,
    [WireHeaders.SearchIndexPages]: String(pages.length),
  };
  if (method === 'HEAD') {
    headRequests++;
    return new Response(null, { status: 204, headers });
  }
  getRequests++;
  const page = Number(url.searchParams.get('page') ?? '1');
  const bytes = pages[page - 1];
  if (!bytes) return new Response(null, { status: 404 });
  transferredBytes += bytes.byteLength;
  return new Response(bytes.slice(), { headers: { ...headers, ETag: etags[page - 1] } });
};

function cpuMsSince(start) {
  const diff = process.cpuUsage(start);
  return (diff.user + diff.system) / 1000.0;
}

// 1. Cold session (fresh worker/session downloads all FSPK pages, validates, runs first query)
const coldQuery = queryDoc.queries[0].query;
const coldLatencies = [];
const coldCpuStart = process.cpuUsage();
let coldTransferred = 0;
let coldPagesFetched = 0;
for (let c = 0; c < 3; c++) {
  transferredBytes = 0;
  getRequests = 0;
  headRequests = 0;
  const freshSearch = createCorpusSearch();
  const t0 = performance.now();
  const res = await freshSearch(coldQuery, undefined, 1, 10, 'relevance');
  decodeLocalSearchResult(res.frame);
  coldLatencies.push(performance.now() - t0);
  if (c === 0) {
    coldTransferred = transferredBytes;
    coldPagesFetched = getRequests;
  }
}
const coldCpuMs = cpuMsSince(coldCpuStart);

// 2. Warm session: build one warm corpus cache and run all 360 queries
transferredBytes = 0;
getRequests = 0;
headRequests = 0;
const warmSearch = createCorpusSearch();
await warmSearch(coldQuery, undefined, 1, 10, 'relevance');
// Warm-up 20 queries
for (const q of queryDoc.queries.slice(0, 20)) {
  if (normalizeLocalSearchQuery(q.query) !== undefined) {
    await warmSearch(q.query, undefined, 1, 10, 'relevance');
  }
}

transferredBytes = 0;
getRequests = 0;
headRequests = 0;
const results = [];
const allLatencies = [];
const rareLatencies = [];
const commonLatencies = [];
let failedCount = 0;
let rejectedCount = 0;
const memBefore = process.memoryUsage();
const qCpuStart = process.cpuUsage();
const qWallStart = performance.now();

for (const q of queryDoc.queries) {
  const t0 = performance.now();
  try {
    const res = await warmSearch(q.query, undefined, 1, 20, 'relevance');
    const decoded = decodeLocalSearchResult(res.frame);
    const ms = performance.now() - t0;
    allLatencies.push(ms);
    if (q.rarity === 'rare') rareLatencies.push(ms);
    else if (q.rarity === 'common') commonLatencies.push(ms);
    results.push({
      id: q.id,
      ok: true,
      total: decoded.total,
      articleIds: decoded.items.map((item) => item.id),
      latencyMs: ms,
      responseBytes: res.frame.byteLength,
    });
  } catch (err) {
    const ms = performance.now() - t0;
    // Overlong query rejection is tracked separately vs unexpected failures
    const msg = err instanceof Error ? err.message : String(err);
    const isRejected = msg.includes('query length');
    if (isRejected) rejectedCount++;
    else failedCount++;
    results.push({
      id: q.id,
      ok: false,
      rejected: isRejected,
      error: msg,
      total: 0,
      articleIds: [],
      latencyMs: ms,
      responseBytes: 0,
    });
  }
}
const qWallMs = performance.now() - qWallStart;
const qCpuMs = cpuMsSince(qCpuStart);
const memAfter = process.memoryUsage();
const warmHeadRequests = headRequests;
const warmGetRequests = getRequests;
const warmTransferred = transferredBytes;

// 3. Cancellation check
let cancelledCleanly = 0;
const cancelLatencies = [];
for (let i = 0; i < 10; i++) {
  const ac = new AbortController();
  ac.abort();
  const t0 = performance.now();
  try {
    await warmSearch('博客搜索 公开页', ac.signal, 1, 10, 'relevance');
  } catch (err) {
    if (err && typeof err === 'object' && err.name === 'AbortError') cancelledCleanly++;
  }
  cancelLatencies.push(performance.now() - t0);
}

// 4. Concurrent warm searches (bounded Promise.all workers over valid queries)
const validQueries = queryDoc.queries.filter((q) => normalizeLocalSearchQuery(q.query) !== undefined);
const concLatencies = [];
let concFailures = 0;
const concCpuStart = process.cpuUsage();
const concWallStart = performance.now();
let cursor = 0;
async function worker() {
  while (cursor < validQueries.length) {
    const idx = cursor++;
    const q = validQueries[idx];
    const t0 = performance.now();
    try {
      const res = await warmSearch(q.query, undefined, 1, 10, 'relevance');
      decodeLocalSearchResult(res.frame);
    } catch {
      concFailures++;
    }
    concLatencies.push(performance.now() - t0);
  }
}
await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, () => worker()));
const concWallMs = performance.now() - concWallStart;
const concCpuMs = cpuMsSince(concCpuStart);

const report = {
  engine: 'local-fspk-v4',
  runtime: `node ${process.version}`,
  os: `${process.platform} ${process.arch}`,
  corpus: {
    documentCount: manifest.documentCount,
    fspkPageCount: manifest.pageCount,
    fspkTotalBytes: manifest.totalBytes,
  },
  coldSession: {
    runs: coldLatencies.length,
    transferredBytes: coldTransferred,
    pagesFetched: coldPagesFetched,
    cpuMs: coldCpuMs,
    latencyMs: summarize(coldLatencies),
  },
  warmSession: {
    offered: queryDoc.queries.length,
    succeeded: queryDoc.queries.length - failedCount - rejectedCount,
    failed: failedCount,
    rejected: rejectedCount,
    headRequests: warmHeadRequests,
    getRequests: warmGetRequests,
    transferredBytes: warmTransferred,
    wallMs: qWallMs,
    cpuMs: qCpuMs,
    rssBytes: memAfter.rss,
    heapUsedBeforeBytes: memBefore.heapUsed,
    heapUsedAfterBytes: memAfter.heapUsed,
    latencyMs: summarize(allLatencies),
    rareLatencyMs: summarize(rareLatencies),
    commonLatencyMs: summarize(commonLatencies),
  },
  concurrent: {
    workers: opts.concurrency,
    offered: validQueries.length,
    succeeded: validQueries.length - concFailures,
    failed: concFailures,
    wallMs: concWallMs,
    throughputQps: concWallMs > 0 ? ((validQueries.length - concFailures) * 1000) / concWallMs : 0,
    cpuMs: concCpuMs,
    latencyMs: summarize(concLatencies),
  },
  cancellation: {
    attempted: 10,
    cancelledCleanly,
    latencyMs: summarize(cancelLatencies),
  },
  results,
};

mkdirSync(dirname(resolve(opts.out)), { recursive: true });
writeFileSync(opts.out, JSON.stringify(report, null, 2) + '\n', 'utf8');
