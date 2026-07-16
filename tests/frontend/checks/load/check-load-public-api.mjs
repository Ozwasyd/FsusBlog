#!/usr/bin/env node

import { fetchWithTimeout, parseTimeoutMs } from '../../support/http.mjs';
import { baseUrl as apiBaseUrl, requestTimeoutMs as defaultTimeoutMs } from '../../support/auth-helpers.mjs';
import { readAedsResponse } from '../../support/aeds-envelope.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readLoadProfile } from './loadPolicy.mjs';

const publicBaseUrl = process.env.FSUSBLOG_PUBLIC_BASE_URL || process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:8080';
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, defaultTimeoutMs);
const loadPolicy = readLoadProfile(process.env.FSUSBLOG_LOAD_PROFILE || 'baseline');
const concurrency = Number(process.env.FSUSBLOG_LOAD_CONCURRENCY || loadPolicy.concurrency || '10');
const rounds = Number(process.env.FSUSBLOG_LOAD_ROUNDS || loadPolicy.rounds || '6');
const policyDurationMs = Number(loadPolicy.durationMs || 30000);
const evidenceDir = process.env.FSUSBLOG_PERF_EVIDENCE_DIR || resolve(process.cwd(), '..', '..', '.tmp/perf');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function percentile(values, p) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

async function fetchFirstArticleId() {
  const response = await fetchWithTimeout(`${apiBaseUrl}/api/binary/article/list/home/1/1.aeds`, {
    headers: { Accept: 'application/octet-stream' }
  }, requestTimeoutMs);
  assert(response.ok, `article probe failed: ${response.status}`);
  const page = await readAedsResponse(response);
  const items = Array.isArray(page?.items) ? page.items : [];
  assert(items.length > 0, 'load smoke requires at least one article fixture');
  return items[0].id;
}

async function exerciseEndpoint(definition) {
  const durations = [];
  const expectedStatuses = Array.isArray(definition.expectedStatuses)
    ? definition.expectedStatuses
    : null;
  const statusCounts = {};
  let successCount = 0;
  let serverErrors = 0;
  let timeouts = 0;

  for (let round = 0; round < rounds; round += 1) {
    const batch = Array.from({ length: concurrency }, async () => {
      const startedAt = performance.now();
      try {
        const response = await fetchWithTimeout(definition.url, {
          headers: definition.headers
        }, requestTimeoutMs);
        const elapsed = performance.now() - startedAt;
        durations.push(elapsed);
        statusCounts[response.status] = (statusCounts[response.status] || 0) + 1;
        if (response.status >= 500) {
          serverErrors += 1;
          return;
        }
        const hasExpectedStatus = expectedStatuses
          ? expectedStatuses.includes(response.status)
          : response.ok;
        if (!hasExpectedStatus) {
          throw new Error(
            `[${definition.name}] unexpected status ${response.status} for ${definition.url}`
          );
        }
        successCount += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('timeout')) {
          timeouts += 1;
          return;
        }
        throw error;
      }
    });

    await Promise.all(batch);
  }

  const expectedTotal = concurrency * rounds;
  const p50 = percentile(durations, 50);
  const p95 = percentile(durations, 95);
  assert(successCount === expectedTotal, `[${definition.name}] success rate drift: ${successCount}/${expectedTotal}`);
  assert(serverErrors === 0, `[${definition.name}] should not return 5xx under light load`);
  assert(timeouts === 0, `[${definition.name}] should not timeout under light load`);
  assert(p95 <= definition.p95BudgetMs, `[${definition.name}] p95 ${p95.toFixed(1)}ms exceeds budget ${definition.p95BudgetMs}ms`);

  const summary = {
    name: definition.name,
    count: expectedTotal,
    p50Ms: Number(p50.toFixed(1)),
    p95Ms: Number(p95.toFixed(1)),
    p95BudgetMs: definition.p95BudgetMs,
    expectedStatuses: expectedStatuses || ['2xx'],
    statusCounts,
    serverErrors,
    timeouts
  };

  console.log(
    `[check-load-public-api] ok: ${definition.name} | count=${expectedTotal} | p50=${p50.toFixed(1)}ms | p95=${p95.toFixed(1)}ms`
  );
  return summary;
}

async function main() {
  const articleId = await fetchFirstArticleId();
  const definitions = [
    {
      name: 'public_home',
      url: `${publicBaseUrl}/`,
      headers: { Accept: 'text/html' },
      p95BudgetMs: 2500
    },
    {
      name: 'public_article',
      url: `${publicBaseUrl}/article/${articleId}`,
      headers: { Accept: 'text/html' },
      p95BudgetMs: 2500
    },
    {
      name: 'public_search_extreme_query',
      url: `${publicBaseUrl}/search?q=${encodeURIComponent('markdown latex mermaid ' + 'boundary '.repeat(30) + '<script>')}`,
      headers: { Accept: 'text/html' },
      expectedStatuses: [400],
      p95BudgetMs: 2500
    },
    {
      name: 'api_system_seo',
      url: `${apiBaseUrl}/api/binary/system/seo`,
      headers: { Accept: 'application/octet-stream' },
      p95BudgetMs: 1500
    },
    {
      name: 'api_pow_challenge',
      url: `${apiBaseUrl}/api/binary/auth/pow-challenge`,
      headers: { Accept: 'application/octet-stream' },
      p95BudgetMs: 1500
    },
    {
      name: 'api_article_detail',
      url: `${apiBaseUrl}/api/binary/article/${articleId}.aeds`,
      headers: { Accept: 'application/octet-stream' },
      p95BudgetMs: 2000
    },
    {
      name: 'api_article_comments',
      url: `${apiBaseUrl}/api/binary/comment/${articleId}?limit=10`,
      headers: { Accept: 'application/octet-stream' },
      p95BudgetMs: 2000
    },
    {
      name: 'search_manifest',
      url: `${publicBaseUrl}/search/index.manifest.aeds`,
      headers: { Accept: 'application/octet-stream' },
      p95BudgetMs: 1500
    },
    {
      name: 'binary_article_list',
      url: `${apiBaseUrl}/api/binary/article/list/home/1/5.aeds`,
      headers: { Accept: 'application/octet-stream' },
      p95BudgetMs: 2000
    },
    {
      name: 'binary_article_detail',
      url: `${apiBaseUrl}/api/binary/article/${articleId}.aeds`,
      headers: { Accept: 'application/octet-stream' },
      p95BudgetMs: 2000
    },
    {
      name: 'binary_article_hot',
      url: `${apiBaseUrl}/api/binary/article/hot/5.aeds`,
      headers: { Accept: 'application/octet-stream' },
      p95BudgetMs: 2000
    },
    {
      name: 'binary_article_comments',
      url: `${apiBaseUrl}/api/binary/comment/${articleId}?limit=10`,
      headers: { Accept: 'application/octet-stream' },
      p95BudgetMs: 2000
    }
  ];

  const results = [];
  for (const definition of definitions) {
    results.push(await exerciseEndpoint(definition));
  }

  await mkdir(evidenceDir, { recursive: true });
  await writeFile(resolve(evidenceDir, 'load-public-api.json'), `${JSON.stringify({
    status: 'ok',
    generatedAt: new Date().toISOString(),
    apiBaseUrl,
    publicBaseUrl,
    policy: {
      source: 'tests/perf/perf-policy.yml',
      profile: process.env.FSUSBLOG_LOAD_PROFILE || 'baseline',
      durationMs: policyDurationMs
    },
    concurrency,
    rounds,
    results
  }, null, 2)}\n`);

  console.log(
    `[check-load-public-api] ok | apiBase=${apiBaseUrl} publicBase=${publicBaseUrl} concurrency=${concurrency} rounds=${rounds}`
  );
}

main().catch((error) => {
  console.error('[check-load-public-api] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
