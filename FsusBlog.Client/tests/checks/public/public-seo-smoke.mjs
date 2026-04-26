#!/usr/bin/env node
import { fetchWithTimeout, probeReachable, parseTimeoutMs } from '../../support/http.mjs';

const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:8080';
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, 15000);
const aotSettleTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_PUBLIC_AOT_SETTLE_TIMEOUT_MS, 15000);

const checks = [
  { name: 'home', path: '/', expectedHydrationKind: 'Home' },
  { name: 'about', path: '/about', expectedHydrationKind: 'About' },
  { name: 'archive', path: '/archive', expectedHydrationKind: 'Archive' },
  {
    name: 'article_detail',
    path: '/article/1',
    expectedHydrationKind: 'ArticleDetail'
  }
];

const negativeChecks = [
  { name: 'login_spa_only', path: '/login' },
  { name: 'search_spa_only', path: '/search?q=test' }
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readStylesheetHrefs(html) {
  const hrefs = [];
  const linkPattern = /<link\s+[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/gi;
  let match = linkPattern.exec(html);
  while (match) {
    if (match[1]) {
      hrefs.push(match[1]);
    }
    match = linkPattern.exec(html);
  }
  return hrefs;
}

function normalizeHrefPathname(href) {
  try {
    return new URL(href, 'http://localhost').pathname.toLowerCase();
  } catch {
    return String(href || '').split('?')[0].split('#')[0].toLowerCase();
  }
}

function assertStylesheetLinkSet(html, label) {
  const hrefs = readStylesheetHrefs(html);
  const paths = hrefs.map((href) => normalizeHrefPathname(href));
  assert(hrefs.length >= 2, `${label} missing stylesheet links`);
  assert(
    paths.every((path) => path.endsWith('.css')),
    `${label} stylesheet links must target css files`
  );
  assert(
    hrefs.some((href) => href.includes('/assets/') || href.includes('/src/assets/')),
    `${label} stylesheet links missing expected assets/src paths`
  );
  assert(
    paths.some((path) => /(?:^|\/)(?:public-page|index|full-app|main)(?:-[^/]+)?\.css$/i.test(path)),
    `${label} missing primary app stylesheet (public-page/index/full-app/main)`
  );
  assert(
    paths.some((path) => /(?:^|\/)(?:vendor|critical-fonts|public-shell-critical|full-app)(?:-[^/]+)?\.css$/i.test(path)),
    `${label} missing supporting stylesheet (vendor/critical-fonts/public-shell-critical/full-app)`
  );
}

function assertMinimalRuntimeHintContract(html, label) {
  assert(
    /<div[^>]*id="global-loader"[^>]*\shidden(?:\s|>|=)/i.test(html),
    `[${label}] global loader should stay hidden on server-first AOT shell`
  );
  assert(
    !html.includes('id="fsus-public-runtime-hint-root"'),
    `[${label}] runtime hint root should not render until a blocking action happens`
  );
  assert(
    !/<a[^>]*data-aot-action="page-(?:prev|next)"/i.test(html),
    `[${label}] pagination actions must not be anchors`
  );
  assert(
    !/<button[^>]*data-aot-action="open-article"/i.test(html),
    `[${label}] non-blocking open-article actions must not be buttons`
  );
}

function readMetaContent(body, pattern, label) {
  const match = body.match(pattern);
  assert(match?.[1], `missing ${label}`);
  return match[1];
}

function normalizePath(path) {
  if (!path || path === '/') {
    return '/';
  }
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

function assertPublicHydrationContract(body, item) {
  if (!item.expectedHydrationKind) {
    return;
  }

  assert(
    body.includes('id="fsus-aot-hydration-props"'),
    `[${item.name}] missing hydration props payload`
  );
  assert(
    body.includes(`data-public-hydration-kind="${item.expectedHydrationKind}"`),
    `[${item.name}] hydration kind mismatch or missing (${item.expectedHydrationKind})`
  );
}

async function runCheck(item) {
  const { response, body } = await fetchSettledPublicHtml(item.path);
  const contentType = response.headers.get('content-type') || '';

  assert(response.ok, `[${item.name}] expected 2xx, got ${response.status}`);
  assert(contentType.includes('text/html'), `[${item.name}] expected text/html, got ${contentType || 'none'}`);
  assert(body.includes('<div id="app">'), `[${item.name}] missing #app root`);
  assert(body.includes('id="fsus-aot-shell"'), `[${item.name}] missing server AOT shell`);
  assert(body.includes('id="fsus-aot-bootstrap"'), `[${item.name}] missing bootstrap payload`);
  assert(body.includes('<noscript>'), `[${item.name}] missing noscript fallback`);
  assert(body.includes('<link rel="canonical"'), `[${item.name}] missing canonical tag`);
  assert(body.includes('id="fsus-spa-boot"'), `[${item.name}] missing deferred spa boot script`);
  assert(body.includes('data-fsus-spa-entry='), `[${item.name}] missing deferred spa entry marker`);
  assert(!body.includes('<script type="module" crossorigin src="/assets/'), `[${item.name}] unexpected eager spa module entry`);
  assertPublicHydrationContract(body, item);
  assertStylesheetLinkSet(body, `[${item.name}]`);
  assertMinimalRuntimeHintContract(body, item.name);

  const canonical = readMetaContent(body, /<link rel="canonical" href="([^"]+)"/, `${item.name} canonical href`);
  const ogUrl = readMetaContent(body, /<meta property="og:url" content="([^"]+)"/, `${item.name} og:url`);
  const canonicalPath = normalizePath(new URL(canonical).pathname);
  const ogPath = normalizePath(new URL(ogUrl).pathname);
  const expectedPath = normalizePath(item.path);
  assert(canonicalPath === expectedPath, `[${item.name}] canonical path mismatch: expected ${expectedPath}, got ${canonicalPath}`);
  assert(ogPath === expectedPath, `[${item.name}] og:url path mismatch: expected ${expectedPath}, got ${ogPath}`);
  assert(!new URL(canonical).search, `[${item.name}] canonical should not include query`);
  assert(!new URL(ogUrl).search, `[${item.name}] og:url should not include query`);

  if (item.name === 'article_detail') {
    assert(body.includes('data-markdown-renderer="wasm"'), `[${item.name}] missing markdown wasm host marker`);
    assert(body.includes('markdown-renderer__body'), `[${item.name}] missing markdown renderer body class`);
    assert(
      /<div[^>]*class="[^"]*\bmarkdown-renderer__body\b[^"]*"[^>]*role="article"[^>]*aria-live="polite"[^>]*data-markdown-renderer="wasm"[^>]*>/i.test(body),
      `[${item.name}] markdown container contract mismatch`
    );
    assert(!body.includes('class="aot-rendered-content"'), `[${item.name}] legacy article markdown wrapper still present`);
    assert(body.includes('id="fsus-comments-island"'), `[${item.name}] article comments slot host must render in AOT`);
    assert(body.includes('id="fsus-comments-island-content"'), `[${item.name}] article comments slot content must render in AOT`);
    assert(!body.includes('第一条评论会在这里出现。'), `[${item.name}] article comment placeholder copy must be removed from AOT`);
    assert(!body.includes('data-aot-action="activate-comments"'), `[${item.name}] article comments activator must be removed from AOT`);
  }

  if (item.name === 'home') {
    assert(!body.includes('public-aside-placeholder'), `[${item.name}] home hot-articles placeholder must be removed from AOT`);
    assert(body.includes('id="fsus-home-hot-articles-slot"'), `[${item.name}] home hot-articles slot must render in AOT`);
    assert(body.includes('id="fsus-home-hot-articles-slot-content"'), `[${item.name}] home hot-articles slot content must render in AOT`);
  }

  for (const text of item.expectedText ?? []) {
    assert(body.includes(text), `[${item.name}] missing expected text: ${text}`);
  }
}

async function fetchSettledPublicHtml(path) {
  const startedAt = Date.now();
  let lastResponse = null;
  let lastBody = '';

  while (Date.now() - startedAt < aotSettleTimeoutMs) {
    const response = await fetchWithTimeout(`${baseUrl}${path}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (FsusBlog Public SEO Smoke)',
        Accept: 'text/html,application/xhtml+xml'
      }
    }, requestTimeoutMs);
    const body = await response.text();
    const source = response.headers.get('X-Fsus-Public-Aot-Source') || 'unknown';

    lastResponse = response;
    lastBody = body;

    if (source !== 'spa-fallback' && source !== 'spa-index' && body.includes('id="fsus-aot-shell"')) {
      return { response, body };
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  assert(lastResponse, `unable to fetch ${path}`);
  return { response: lastResponse, body: lastBody };
}

async function main() {
  await probeReachable(`${baseUrl}/api/System/seo`, '[public-seo-smoke backend]', requestTimeoutMs);

  const categoryId = await resolvePublicId('/api/Category');
  const tagId = await resolvePublicId('/api/Tag');

  if (categoryId) {
    checks.push({ name: 'filter_category', path: `/category/${categoryId}`, expectedHydrationKind: 'Filter' });
  }

  if (tagId) {
    checks.push({ name: 'filter_tag', path: `/tag/${tagId}`, expectedHydrationKind: 'Filter' });
  }

  const failures = [];
  for (const item of checks) {
    try {
      await runCheck(item);
      console.log(`[public-seo-smoke] ok: ${item.name}`);
    } catch (error) {
      failures.push(`[public-seo-smoke] fail: ${item.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const item of negativeChecks) {
    try {
      const response = await fetchWithTimeout(`${baseUrl}${item.path}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (FsusBlog Public SEO Smoke)',
          Accept: 'text/html,application/xhtml+xml'
        }
      }, requestTimeoutMs);

      const body = await response.text();
      assert(response.ok, `[${item.name}] expected 2xx, got ${response.status}`);
      assert(!body.includes('id="fsus-aot-shell"'), `[${item.name}] unexpected public aot shell on non-public route`);
      assert(!body.includes('id="fsus-spa-boot"'), `[${item.name}] unexpected deferred public spa boot on non-public route`);
      console.log(`[public-seo-smoke] ok: ${item.name}`);
    } catch (error) {
      failures.push(`[public-seo-smoke] fail: ${item.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    for (const line of failures) {
      console.error(line);
    }
    process.exit(1);
  }

  console.log('[public-seo-smoke] all checks passed');
}

async function resolvePublicId(path) {
  try {
    const response = await fetchWithTimeout(`${baseUrl}${path}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (FsusBlog Public SEO Smoke)',
        Accept: 'application/json'
      }
    }, requestTimeoutMs);

    if (!response.ok) {
      return null;
    }

    const json = await response.json();
    const data = Array.isArray(json?.data) ? json.data : [];
    const first = data[0];
    const id = typeof first?.id === 'number' ? first.id : Number(first?.id);
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

main().catch((error) => {
  console.error('[public-seo-smoke] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
