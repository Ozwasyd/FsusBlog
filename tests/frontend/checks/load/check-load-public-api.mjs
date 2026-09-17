#!/usr/bin/env node

import { fetchWithTimeout, parseTimeoutMs } from '../../support/http.mjs';
import { baseUrl as apiBaseUrl, requestTimeoutMs as defaultTimeoutMs } from '../../support/auth-helpers.mjs';
import { readAedsResponse } from '../../support/aeds-envelope.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readLoadProfile } from './loadPolicy.mjs';
import { waitForReadyResponse } from './loadReadiness.mjs';
import { fetchRouteSample, producerRouteIds } from '../../../../tools/test/lanes/runtime-http-route-contract.mjs';

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
  const response = await waitForReadyResponse(
    {
      name: 'article_fixture_probe',
      url: `${apiBaseUrl}/api/binary/article/list/home/1/1.aeds`,
      headers: { Accept: 'application/octet-stream' }
    },
    { requestTimeoutMs }
  );
  const page = await readAedsResponse(response);
  const items = Array.isArray(page?.items) ? page.items : [];
  assert(items.length > 0, 'load smoke requires at least one article fixture');
  return items[0].id;
}

async function exerciseEndpoint(definition) {
  const durations = [];
  const successfulSamples = [];
  const failedSamples = [];
  const statusCounts = {};
  let successCount = 0;
  let serverErrors = 0;
  let timeouts = 0;

  for (let round = 0; round < rounds; round += 1) {
    const batch = Array.from({ length: concurrency }, async () => {
      const startedAt = performance.now();
      try {
        const target = new URL(definition.url);
        const response = await fetchRouteSample({ routeId: definition.routeId, baseUrl: target.origin, requestPath: `${target.pathname}${target.search}`, headers: definition.headers, timeoutMs: requestTimeoutMs });
        const elapsed = performance.now() - startedAt;
        statusCounts[response.status] = (statusCounts[response.status] || 0) + 1;
        if (!response.ok) {
          failedSamples.push({
            routeId: response.routeId,
            contractDigest: response.contractDigest,
            status: response.status,
            contentType: response.contentType,
            frameType: response.frameType,
            bodyBytes: response.bodyBytes,
            failureKind: response.failureKind,
            latencyMs: response.latencyMs
          });
          if (response.status >= 500) serverErrors += 1;
          if (response.failureKind === 'timeout') timeouts += 1;
          return;
        }
        durations.push(elapsed);
        successfulSamples.push({ routeId: response.routeId, contractDigest: response.contractDigest, latencyMs: Number(elapsed.toFixed(3)) });
        successCount += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const timeout = message.includes('timeout');
        if (timeout) timeouts += 1;
        failedSamples.push({
          routeId: definition.routeId,
          contractDigest: null,
          status: 0,
          contentType: null,
          frameType: null,
          bodyBytes: 0,
          failureKind: timeout ? 'timeout' : 'probe-exception',
          latencyMs: Number((performance.now() - startedAt).toFixed(3)),
          message
        });
      }
    });

    await Promise.all(batch);
  }

  const expectedTotal = concurrency * rounds;
  const p50 = durations.length > 0 ? percentile(durations, 50) : null;
  const p95 = durations.length > 0 ? percentile(durations, 95) : null;
  const acceptanceFailures = [];
  if (successCount !== expectedTotal) acceptanceFailures.push(`success rate drift: ${successCount}/${expectedTotal}`);
  if (serverErrors !== 0) acceptanceFailures.push(`server errors: ${serverErrors}`);
  if (timeouts !== 0) acceptanceFailures.push(`timeouts: ${timeouts}`);
  if (p95 !== null && p95 > definition.p95BudgetMs) acceptanceFailures.push(`p95 ${p95.toFixed(1)}ms exceeds budget ${definition.p95BudgetMs}ms`);

  const summary = {
    status: acceptanceFailures.length === 0 ? 'ok' : 'failed',
    name: definition.name,
    count: expectedTotal,
    p50Ms: p50 === null ? null : Number(p50.toFixed(1)),
    p95Ms: p95 === null ? null : Number(p95.toFixed(1)),
    p95BudgetMs: definition.p95BudgetMs,
    routeId: definition.routeId,
    routeContractDigest: successfulSamples[0]?.contractDigest ?? null,
    samples: successfulSamples,
    failures: failedSamples,
    acceptanceFailures,
    statusCounts,
    serverErrors,
    timeouts
  };

  console.log(`[check-load-public-api] ${summary.status}: ${definition.name} | count=${expectedTotal} | p50=${summary.p50Ms ?? 'n/a'}ms | p95=${summary.p95Ms ?? 'n/a'}ms`);
  return summary;
}

async function main() {
  const articleId = await fetchFirstArticleId();
  const definitions = [
    {
      name: 'public_home',
      routeId: 'public-home',
      url: `${publicBaseUrl}/`,
      headers: { Accept: 'text/html' },
      p95BudgetMs: 2500
    },
    {
      name: 'public_article',
      routeId: 'public-article',
      url: `${publicBaseUrl}/article/${articleId}`,
      headers: { Accept: 'text/html' },
      p95BudgetMs: 2500
    },
    {
      name: 'public_search_extreme_query',
      routeId: 'public-search-invalid',
      url: `${publicBaseUrl}/search?q=${encodeURIComponent('markdown latex mermaid ' + 'boundary '.repeat(30) + '<script>')}`,
      headers: { Accept: 'text/html' },
      expectedStatuses: [400],
      p95BudgetMs: 2500
    },
    {
      name: 'api_system_seo',
      routeId: 'system-seo',
      url: `${apiBaseUrl}/api/binary/system/seo`,
      headers: { Accept: 'application/octet-stream' },
      p95BudgetMs: 1500
    },
    {
      name: 'api_pow_challenge',
      routeId: 'pow-challenge',
      url: `${apiBaseUrl}/api/binary/auth/pow-challenge`,
      headers: { Accept: 'application/octet-stream' },
      p95BudgetMs: 1500
    },
    {
      name: 'api_article_detail',
      routeId: 'article-detail',
      url: `${apiBaseUrl}/api/binary/article/${articleId}.aeds`,
      headers: { Accept: 'application/octet-stream' },
      p95BudgetMs: 2000
    },
    {
      name: 'api_article_comments',
      routeId: 'article-comments',
      url: `${apiBaseUrl}/api/binary/comment/${articleId}?limit=10`,
      headers: { Accept: 'application/octet-stream' },
      p95BudgetMs: 2000
    },
    {
      name: 'search_manifest',
      routeId: 'search-manifest',
      url: `${publicBaseUrl}/search/index.manifest.aeds`,
      headers: { Accept: 'application/octet-stream' },
      p95BudgetMs: 1500
    },
    {
      name: 'binary_article_list',
      routeId: 'article-list-home-5',
      url: `${apiBaseUrl}/api/binary/article/list/home/1/5.aeds`,
      headers: { Accept: 'application/octet-stream' },
      p95BudgetMs: 2000
    },
    {
      name: 'binary_article_detail',
      routeId: 'article-detail',
      url: `${apiBaseUrl}/api/binary/article/${articleId}.aeds`,
      headers: { Accept: 'application/octet-stream' },
      p95BudgetMs: 2000
    },
    {
      name: 'binary_article_hot',
      routeId: 'article-hot',
      url: `${apiBaseUrl}/api/binary/article/hot/5.aeds`,
      headers: { Accept: 'application/octet-stream' },
      p95BudgetMs: 2000
    },
    {
      name: 'binary_article_comments',
      routeId: 'article-comments',
      url: `${apiBaseUrl}/api/binary/comment/${articleId}?limit=10`,
      headers: { Accept: 'application/octet-stream' },
      p95BudgetMs: 2000
    }
  ];
  const declaredRouteIds = [...new Set(definitions.map((definition) => definition.routeId))].sort();
  const ownedRouteIds = [...producerRouteIds('frontend-load-public-api')].sort();
  assert(JSON.stringify(declaredRouteIds) === JSON.stringify(ownedRouteIds), 'frontend load definitions must exactly match their catalog ownership');

  await Promise.all(definitions.map(async (definition) => {
    const response = await waitForReadyResponse(definition, { requestTimeoutMs });
    await response.arrayBuffer();
  }));

  const results = [];
  for (const definition of definitions) {
    results.push(await exerciseEndpoint(definition));
  }

  const status = results.every((result) => result.status === 'ok') ? 'ok' : 'failed';
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(resolve(evidenceDir, 'load-public-api.json'), `${JSON.stringify({
    status,
    generatedAt: new Date().toISOString(),
    apiBaseUrl,
    publicBaseUrl,
    policy: {
      source: 'tests/performance/perf-policy.yml',
      profile: process.env.FSUSBLOG_LOAD_PROFILE || 'baseline',
      durationMs: policyDurationMs
    },
    concurrency,
    rounds,
    results
  }, null, 2)}\n`);

  assert(status === 'ok', `load public API route contract failed: ${results.filter((result) => result.status !== 'ok').map((result) => result.name).join(',')}`);
  console.log(
    `[check-load-public-api] ok | apiBase=${apiBaseUrl} publicBase=${publicBaseUrl} concurrency=${concurrency} rounds=${rounds}`
  );
}

main().catch((error) => {
  console.error('[check-load-public-api] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
