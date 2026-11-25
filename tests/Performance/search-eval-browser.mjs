#!/usr/bin/env node
/**
 * Real Chromium cold vs warm browser session comparison between server and local search modes (#44).
 * Connects to a live isolated FsusBlog.V2.Server instance and records transferred bytes,
 * time-to-first-usable-results, worker starts, corpus downloads, and warm follow-up latency.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { WireRoutes } from '../../src/Contracts/wire.generated.ts';

const require = createRequire(resolve('src/Web/package.json'));
const { chromium } = require('@playwright/test');

function parseArgs(argv) {
  const opts = { origin: '', mode: 'server', out: '', chrome: process.env.FSUSBLOG_TEST_CHROME || '' };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--origin': opts.origin = argv[++i]; break;
      case '--mode': opts.mode = argv[++i]; break;
      case '--out': opts.out = argv[++i]; break;
      case '--chrome': opts.chrome = argv[++i]; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!opts.origin || !opts.out) throw new Error('Usage: search-eval-browser.mjs --origin URL --mode server|local --out FILE');
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const candidateChromes = [
  opts.chrome,
  chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter(Boolean);
const executablePath = candidateChromes.find((p) => existsSync(p)) || chromium.executablePath();
const queries = ['博客搜索', 'PostgreSQL 18 索引优化', 'issue-2205', '公开页', 'ArticleSearchIndex'];

async function runSession(browser, queryList) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  let workersStarted = 0;
  let searchApiRequests = 0;
  let searchApiBytes = 0;
  let corpusRequests = 0;
  let corpusBytes = 0;
  let headRequests = 0;

  page.on('worker', () => { workersStarted++; });
  page.on('response', async (response) => {
    const url = new URL(response.url());
    const method = response.request().method();
    if (url.pathname === WireRoutes.PublicSearchV2 || url.pathname === WireRoutes.PublicSearch) {
      searchApiRequests++;
      try { searchApiBytes += (await response.body()).byteLength; } catch {}
    } else if (url.pathname === WireRoutes.PublicSearchCorpus || url.pathname.startsWith('/api/v2/public/search-corpus/')) {
      if (method === 'HEAD') headRequests++;
      else {
        corpusRequests++;
        try { corpusBytes += (await response.body()).byteLength; } catch {}
      }
    }
  });

  await page.goto(`${opts.origin}/search`, { waitUntil: 'networkidle' });
  const metricsBefore = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));

  const perQuery = [];
  for (let i = 0; i < queryList.length; i++) {
    const q = queryList[i];
    const beforeBytes = searchApiBytes + corpusBytes;
    const beforeCorpus = corpusRequests;
    const beforeApi = searchApiRequests;
    const t0 = performance.now();
    const input = page.getByRole('searchbox').or(page.locator('form.search-form input[name="q"]')).first();
    await input.fill(q);
    await input.press('Enter');
    await page.locator('ol.article-list li').first().waitFor({ state: 'visible', timeout: 15_000 });
    const elapsedMs = performance.now() - t0;
    const resultCount = await page.locator('ol.article-list li').count();
    perQuery.push({
      query: q,
      phase: i === 0 ? 'cold_first_search' : 'warm_followup',
      timeToFirstUsableMs: elapsedMs,
      renderedItems: resultCount,
      deltaBytes: (searchApiBytes + corpusBytes) - beforeBytes,
      deltaCorpusRequests: corpusRequests - beforeCorpus,
      deltaApiRequests: searchApiRequests - beforeApi,
    });
  }

  const metricsAfter = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const browserTaskCpuMs = Math.max(0, ((metricsAfter.TaskDuration ?? 0) - (metricsBefore.TaskDuration ?? 0)) * 1000);
  const browserJsHeapUsedBytes = metricsAfter.JSHeapUsedSize ?? 0;

  const idbDatabases = await page.evaluate(async () => {
    if (!('databases' in indexedDB)) return [];
    const list = await indexedDB.databases();
    return list.map(d => d.name).filter(Boolean);
  });

  await context.close();
  return {
    workersStarted,
    searchApiRequests,
    searchApiBytes,
    corpusRequests,
    corpusBytes,
    headRequests,
    browserTaskCpuMs,
    browserJsHeapUsedBytes,
    idbDatabases,
    perQuery,
  };
}

const browser = await chromium.launch({ executablePath, headless: true });
try {
  const sessions = [];
  for (let round = 0; round < 3; round++) {
    sessions.push(await runSession(browser, queries));
  }
  const coldTimes = sessions.map(s => s.perQuery[0].timeToFirstUsableMs);
  const warmTimes = sessions.flatMap(s => s.perQuery.slice(1).map(q => q.timeToFirstUsableMs));
  const coldBytes = sessions.map(s => s.perQuery[0].deltaBytes);
  const warmBytes = sessions.flatMap(s => s.perQuery.slice(1).map(q => q.deltaBytes));
  const browserCpuMs = sessions.map(s => s.browserTaskCpuMs);
  const browserHeapBytes = sessions.map(s => s.browserJsHeapUsedBytes);
  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const report = {
    mode: opts.mode,
    origin: opts.origin,
    rounds: sessions.length,
    coldFirstSearchMedianMs: median(coldTimes),
    warmFollowupMedianMs: median(warmTimes),
    coldFirstSearchBytesMedian: median(coldBytes),
    warmFollowupBytesMedian: median(warmBytes),
    browserTaskCpuMedianMs: median(browserCpuMs),
    browserJsHeapUsedMedianBytes: median(browserHeapBytes),
    workersStartedPerSession: sessions.map(s => s.workersStarted),
    corpusRequestsPerSession: sessions.map(s => s.corpusRequests),
    searchApiRequestsPerSession: sessions.map(s => s.searchApiRequests),
    headRequestsPerSession: sessions.map(s => s.headRequests),
    idbDatabases: sessions[0].idbDatabases,
    sessions,
  };
  mkdirSync(dirname(resolve(opts.out)), { recursive: true });
  writeFileSync(opts.out, JSON.stringify(report, null, 2) + '\n', 'utf8');
} finally {
  await browser.close();
}
