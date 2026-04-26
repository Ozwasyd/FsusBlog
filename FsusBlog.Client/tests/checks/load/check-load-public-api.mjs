#!/usr/bin/env node

import { fetchWithTimeout, parseTimeoutMs } from '../../support/http.mjs';
import { baseUrl as apiBaseUrl, requestTimeoutMs as defaultTimeoutMs } from '../../support/auth-helpers.mjs';

const publicBaseUrl = process.env.FSUSBLOG_PUBLIC_BASE_URL || process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:8080';
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, defaultTimeoutMs);
const concurrency = Number(process.env.FSUSBLOG_LOAD_CONCURRENCY || '10');
const rounds = Number(process.env.FSUSBLOG_LOAD_ROUNDS || '6');

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
  const response = await fetchWithTimeout(`${apiBaseUrl}/api/Article?page=1&size=1`, {
    headers: { Accept: 'application/json' }
  }, requestTimeoutMs);
  assert(response.ok, `article probe failed: ${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  let payload;
  if (contentType.includes('application/json')) {
    payload = await response.json();
  } else {
    const raw = Buffer.from(await response.arrayBuffer()).toString('utf8');
    const jsonStart = raw.indexOf('{"code"');
    const jsonEnd = raw.lastIndexOf('}');
    assert(jsonStart >= 0 && jsonEnd > jsonStart, 'article probe returned a non-JSON payload without an embedded JSON envelope');
    payload = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
  }
  const page = payload?.data ?? payload;
  const items = Array.isArray(page?.items) ? page.items : [];
  assert(items.length > 0, 'load smoke requires at least one article fixture');
  return items[0].id;
}

async function exerciseEndpoint(definition) {
  const durations = [];
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
        if (response.status >= 500) {
          serverErrors += 1;
          return;
        }
        if (!response.ok) {
          throw new Error(`unexpected status ${response.status}`);
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

  console.log(
    `[check-load-public-api] ok: ${definition.name} | count=${expectedTotal} | p50=${p50.toFixed(1)}ms | p95=${p95.toFixed(1)}ms`
  );
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
      p95BudgetMs: 2500
    },
    {
      name: 'api_system_seo',
      url: `${apiBaseUrl}/api/System/seo`,
      headers: { Accept: 'application/json' },
      p95BudgetMs: 1500
    },
    {
      name: 'api_pow_challenge',
      url: `${apiBaseUrl}/api/Auth/pow-challenge`,
      headers: { Accept: 'application/json' },
      p95BudgetMs: 1500
    },
    {
      name: 'api_article_detail',
      url: `${apiBaseUrl}/api/Article/${articleId}`,
      headers: { Accept: 'application/json' },
      p95BudgetMs: 2000
    },
    {
      name: 'api_article_comments',
      url: `${apiBaseUrl}/api/Comment/${articleId}?limit=10`,
      headers: { Accept: 'application/json' },
      p95BudgetMs: 2000
    },
    {
      name: 'search_manifest',
      url: `${publicBaseUrl}/search/index.manifest.json`,
      headers: { Accept: 'application/json' },
      p95BudgetMs: 1500
    },
    {
      name: 'binary_article_list',
      url: `${apiBaseUrl}/api/binary/article?page=1&size=5`,
      headers: { Accept: 'application/octet-stream' },
      p95BudgetMs: 2000
    },
    {
      name: 'binary_article_detail',
      url: `${apiBaseUrl}/api/binary/article/${articleId}`,
      headers: { Accept: 'application/octet-stream' },
      p95BudgetMs: 2000
    },
    {
      name: 'binary_article_hot',
      url: `${apiBaseUrl}/api/binary/article/hot?size=5`,
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

  for (const definition of definitions) {
    await exerciseEndpoint(definition);
  }

  console.log(
    `[check-load-public-api] ok | apiBase=${apiBaseUrl} publicBase=${publicBaseUrl} concurrency=${concurrency} rounds=${rounds}`
  );
}

main().catch((error) => {
  console.error('[check-load-public-api] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
