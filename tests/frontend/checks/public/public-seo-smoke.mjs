#!/usr/bin/env node
import { fetchWithTimeout, probeReachable, parseTimeoutMs } from '../../support/http.mjs';
import { readAedsResponse } from '../../support/aeds-envelope.mjs';
import { readPublicFixtureIds } from '../../support/public-fixtures.mjs';

const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:8080';
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, 15000);
const aotSettleTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_PUBLIC_AOT_SETTLE_TIMEOUT_MS, 15000);
const publicFixtureIds = readPublicFixtureIds();

const checks = [
  { name: 'home', path: '/', expectedHydrationKind: 'Home' },
  { name: 'about', path: '/about', expectedHydrationKind: 'About' },
  { name: 'privacy', path: '/privacy', expectedHydrationKind: 'Privacy' },
  { name: 'guidelines', path: '/guidelines', expectedHydrationKind: 'Guidelines' },
  { name: 'copyright', path: '/copyright', expectedHydrationKind: 'Copyright' },
  { name: 'archive', path: '/archive', expectedHydrationKind: 'Archive' },
  {
    name: 'article_detail',
    path: `/article/${publicFixtureIds.articleId}`,
    expectedHydrationKind: 'ArticleDetail'
  }
];

const negativeChecks = [
  { name: 'login_spa_only', path: '/login' },
  { name: 'search_spa_only', path: '/search?q=test' },
  { name: 'account_spa_only', path: '/user/profile' }
];

const realStatusChecks = [
  { name: 'unknown_route', path: '/route-that-does-not-exist' },
  { name: 'article_zero', path: '/article/0' },
  { name: 'article_missing', path: '/article/2147483647' },
  { name: 'article_extra_segment', path: `/article/${publicFixtureIds.articleId}/extra` },
  { name: 'category_zero', path: '/category/0' },
  { name: 'category_missing', path: '/category/2147483647' },
  { name: 'category_extra_segment', path: '/category/8/extra' },
  { name: 'tag_zero', path: '/tag/0' },
  { name: 'tag_missing', path: '/tag/__fsusblog_missing_tag_1085__' },
  { name: 'tag_extra_segment', path: '/tag/vue/extra' }
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

function readJsonLd(body, label) {
  const match = body.match(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
  assert(match?.[1], `[${label}] missing JSON-LD body`);
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`[${label}] JSON-LD parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function hasType(node, type) {
  const value = node?.['@type'];
  return Array.isArray(value) ? value.includes(type) : value === type;
}

function findGraphNode(jsonLd, type) {
  const graph = Array.isArray(jsonLd?.['@graph']) ? jsonLd['@graph'] : [];
  return graph.find((node) => hasType(node, type)) || null;
}

function mainEntityUrl(node) {
  const value = node?.mainEntityOfPage;
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object') {
    return value['@id'] || value.url || '';
  }
  return '';
}

function assertSameOrigin(left, right, label) {
  assert(left.origin === right.origin, `${label} canonical origin mismatch: ${left.origin} != ${right.origin}`);
}

function assertJsonLdCoherence(body, item, canonicalUrl, ogUrl) {
  const jsonLd = readJsonLd(body, item.name);
  const website = findGraphNode(jsonLd, 'WebSite');
  const breadcrumb = findGraphNode(jsonLd, 'BreadcrumbList');
  assert(website, `[${item.name}] JSON-LD missing WebSite graph node`);
  assert(breadcrumb, `[${item.name}] JSON-LD missing BreadcrumbList graph node`);

  if (item.name === 'article_detail') {
    const blogPosting = findGraphNode(jsonLd, 'BlogPosting');
    assert(blogPosting, `[${item.name}] JSON-LD missing BlogPosting node`);
    const jsonUrl = new URL(blogPosting.url || '', canonicalUrl);
    const mainEntity = new URL(mainEntityUrl(blogPosting), canonicalUrl);
    assertSameOrigin(canonicalUrl, jsonUrl, `[${item.name}] JSON-LD url`);
    assertSameOrigin(canonicalUrl, mainEntity, `[${item.name}] JSON-LD mainEntityOfPage`);
    assertSameOrigin(canonicalUrl, ogUrl, `[${item.name}] OG URL`);
    assert(normalizePath(jsonUrl.pathname) === normalizePath(canonicalUrl.pathname), `[${item.name}] JSON-LD url path mismatch`);
    assert(normalizePath(mainEntity.pathname) === normalizePath(canonicalUrl.pathname), `[${item.name}] JSON-LD mainEntityOfPage path mismatch`);
    assert(blogPosting.headline, `[${item.name}] BlogPosting missing headline`);
    assert(blogPosting.description, `[${item.name}] BlogPosting missing description`);
    assert(blogPosting.datePublished, `[${item.name}] BlogPosting missing datePublished`);
    assert(blogPosting.dateModified, `[${item.name}] BlogPosting missing dateModified`);
    assert(blogPosting.author?.name, `[${item.name}] BlogPosting missing author.name`);
    assert(!JSON.stringify(blogPosting).match(/draft|moderation|admin/i), `[${item.name}] BlogPosting leaks private article state`);
    return;
  }

  const jsonText = JSON.stringify(jsonLd);
  assert(!jsonText.includes('"@type":"BlogPosting"'), `[${item.name}] static page must not emit BlogPosting`);
  assert(!jsonText.includes('"headline"'), `[${item.name}] static page must not emit article headline`);
  assert(!jsonText.includes('"datePublished"'), `[${item.name}] static page must not emit article dates`);
  assert(!jsonText.includes('"mainEntityOfPage"'), `[${item.name}] static page must not emit article mainEntityOfPage`);
}

async function fetchPublicText(path, accept = 'text/plain') {
  const response = await fetchWithTimeout(`${baseUrl}${path}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (FsusBlog Public SEO Smoke)',
      Accept: accept
    }
  }, requestTimeoutMs);
  const body = await response.text();
  assert(response.ok, `[distribution:${path}] expected 2xx, got ${response.status}`);
  return body;
}

async function assertRealNotFoundStatus(item) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (FsusBlog Public SEO Status Smoke)',
    Accept: 'text/html,application/xhtml+xml'
  };
  const [getResponse, headResponse] = await Promise.all([
    fetchWithTimeout(`${baseUrl}${item.path}`, { headers }, requestTimeoutMs),
    fetchWithTimeout(`${baseUrl}${item.path}`, { method: 'HEAD', headers }, requestTimeoutMs)
  ]);
  const body = await getResponse.text();
  const headBody = await headResponse.text();

  assert(getResponse.status === 404, `[${item.name}] GET expected 404, got ${getResponse.status}`);
  assert(headResponse.status === 404, `[${item.name}] HEAD expected 404, got ${headResponse.status}`);
  assert((getResponse.headers.get('content-type') || '').includes('text/html'), `[${item.name}] GET must return HTML`);
  assert((headResponse.headers.get('content-type') || '').includes('text/html'), `[${item.name}] HEAD must return HTML metadata`);
  assert(getResponse.headers.get('x-robots-tag') === 'noindex, follow', `[${item.name}] GET missing noindex`);
  assert(headResponse.headers.get('x-robots-tag') === 'noindex, follow', `[${item.name}] HEAD missing noindex`);
  assert(getResponse.headers.get('x-fsus-public-aot-backfill') === 'none', `[${item.name}] must not queue AOT backfill`);
  assert(headResponse.headers.get('x-fsus-public-aot-backfill') === 'none', `[${item.name}] HEAD must not queue AOT backfill`);
  assert(getResponse.headers.get('x-fsus-public-aot-state') === 'not-found', `[${item.name}] wrong AOT state`);
  assert((getResponse.headers.get('cache-control') || '').includes('no-store'), `[${item.name}] 404 must be no-store`);
  assert(body.includes('<meta name="robots" content="noindex,follow">'), `[${item.name}] HTML missing noindex`);
  assert(!body.match(/rel="canonical"|property="og:url"|BlogPosting/i), `[${item.name}] 404 leaked success SEO metadata`);
  assert(!body.includes('<script'), `[${item.name}] 404 must not boot or hydrate the SPA`);
  assert(headBody === '', `[${item.name}] HEAD must not return a body`);
  assert(
    getResponse.headers.get('content-length') === headResponse.headers.get('content-length'),
    `[${item.name}] GET/HEAD content-length mismatch`
  );
}

async function assertDistributionCanonicalCoherence(canonical) {
  const [sitemap, rss, atom, jsonFeedText] = await Promise.all([
    fetchPublicText('/sitemap.xml', 'application/xml,text/xml'),
    fetchPublicText('/feed/rss.xml', 'application/rss+xml,application/xml,text/xml'),
    fetchPublicText('/feed/atom.xml', 'application/atom+xml,application/xml,text/xml'),
    fetchPublicText('/feed/feed.json', 'application/feed+json,application/json')
  ]);

  assert(sitemap.includes(`<loc>${canonical}</loc>`), `[distribution] sitemap missing article canonical URL: ${canonical}`);
  assert(rss.includes(`<link>${canonical}</link>`) || rss.includes(`isPermaLink="true">${canonical}</guid>`), `[distribution] RSS missing article canonical URL: ${canonical}`);
  assert(atom.includes(`<id>${canonical}</id>`) || atom.includes(`href="${canonical}"`), `[distribution] Atom missing article canonical URL: ${canonical}`);

  let jsonFeed;
  try {
    jsonFeed = JSON.parse(jsonFeedText);
  } catch (error) {
    throw new Error(`[distribution] JSON Feed parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  assert(
    Array.isArray(jsonFeed.items) && jsonFeed.items.some((entry) => entry.url === canonical || entry.external_url === canonical),
    `[distribution] JSON Feed missing article canonical URL: ${canonical}`
  );
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

function assertAotCodeBlocksAreShikiHighlighted(body, label) {
  if (!/<pre[^>]*class="[^"]*\bshiki\b/i.test(body)) {
    return;
  }

  assert(
    /<pre[^>]*class="[^"]*\bshiki\b[\s\S]*?<span class="line">/i.test(body),
    `[${label}] AOT code blocks must contain Shiki token line spans before hydration`
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
  assert(!body.includes('<noscript>'), `[${item.name}] should not emit noscript fallback that triggers scanner noise`);
  assert(body.includes('<link rel="canonical"'), `[${item.name}] missing canonical tag`);
  assert(body.includes('<meta name="description"'), `[${item.name}] missing description meta`);
  assert(body.includes('<meta property="og:title"'), `[${item.name}] missing og:title`);
  assert(body.includes('<meta property="og:description"'), `[${item.name}] missing og:description`);
  assert(body.includes('<meta property="og:type"'), `[${item.name}] missing og:type`);
  assert(body.includes('<meta property="og:url"'), `[${item.name}] missing og:url`);
  assert(body.includes('<meta name="twitter:card" content="summary_large_image"'), `[${item.name}] missing twitter card`);
  assert(body.includes('<meta name="twitter:title"'), `[${item.name}] missing twitter:title`);
  assert(body.includes('<meta name="twitter:description"'), `[${item.name}] missing twitter:description`);
  assert(body.includes('rel="alternate" type="application/rss+xml"'), `[${item.name}] missing RSS discovery`);
  assert(body.includes('href="/feed/rss.xml"'), `[${item.name}] missing RSS href`);
  assert(body.includes('rel="alternate" type="application/atom+xml"'), `[${item.name}] missing Atom discovery`);
  assert(body.includes('href="/feed/atom.xml"'), `[${item.name}] missing Atom href`);
  assert(body.includes('rel="alternate" type="application/feed+json"'), `[${item.name}] missing JSON Feed discovery`);
  assert(body.includes('href="/feed/feed.json"'), `[${item.name}] missing JSON Feed href`);
  assert(/<script\b[^>]*type="application\/ld\+json"[^>]*>/i.test(body), `[${item.name}] missing JSON-LD script`);
  assert(body.includes('"@graph"'), `[${item.name}] JSON-LD must use @graph`);
  assert(body.includes('"@type":"WebSite"'), `[${item.name}] JSON-LD missing WebSite`);
  assert(body.includes('"@type":"SearchAction"'), `[${item.name}] JSON-LD missing SearchAction`);
  assert(body.includes('"@type":"BreadcrumbList"'), `[${item.name}] JSON-LD missing BreadcrumbList`);
  assert(
    body.includes(item.name === 'article_detail' ? '"@type":"BlogPosting"' : '"@type":"WebSite"'),
    `[${item.name}] JSON-LD page type mismatch`
  );
  assert(body.includes('id="fsus-spa-boot"'), `[${item.name}] missing deferred spa boot script`);
  assert(body.includes('data-fsusblog-spa-entry='), `[${item.name}] missing deferred spa entry marker`);
  assert(!body.includes('<script type="module" crossorigin src="/assets/'), `[${item.name}] unexpected eager spa module entry`);
  assertPublicHydrationContract(body, item);
  assertStylesheetLinkSet(body, `[${item.name}]`);
  assertMinimalRuntimeHintContract(body, item.name);

  const canonical = readMetaContent(body, /<link rel="canonical" href="([^"]+)"/, `${item.name} canonical href`);
  const ogUrl = readMetaContent(body, /<meta property="og:url" content="([^"]+)"/, `${item.name} og:url`);
  const canonicalUrl = new URL(canonical);
  const openGraphUrl = new URL(ogUrl);
  const canonicalPath = normalizePath(canonicalUrl.pathname);
  const ogPath = normalizePath(openGraphUrl.pathname);
  const expectedPath = normalizePath(item.path);
  assert(canonicalPath === expectedPath, `[${item.name}] canonical path mismatch: expected ${expectedPath}, got ${canonicalPath}`);
  assert(ogPath === expectedPath, `[${item.name}] og:url path mismatch: expected ${expectedPath}, got ${ogPath}`);
  assertSameOrigin(canonicalUrl, openGraphUrl, `[${item.name}] OG URL`);
  assert(!canonicalUrl.search, `[${item.name}] canonical should not include query`);
  assert(!openGraphUrl.search, `[${item.name}] og:url should not include query`);
  assertJsonLdCoherence(body, item, canonicalUrl, openGraphUrl);

  if (item.name === 'article_detail') {
    await assertDistributionCanonicalCoherence(canonical);
    assert(body.includes('data-markdown-renderer="wasm"'), `[${item.name}] missing markdown wasm host marker`);
    assert(body.includes('markdown-renderer__body'), `[${item.name}] missing markdown renderer body class`);
    assertAotCodeBlocksAreShikiHighlighted(body, item.name);
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

  const categoryId = await resolvePublicId('/api/binary/category.aeds');
  const tagId = await resolvePublicId('/api/binary/tag.aeds');

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
      const source = response.headers.get('X-Fsus-Public-Aot-Source') || '';
      const state = response.headers.get('X-Fsus-Public-Aot-State') || '';
      assert(response.ok, `[${item.name}] expected 2xx, got ${response.status}`);
      assert(!body.includes('id="fsus-aot-shell"'), `[${item.name}] unexpected public aot shell on non-public route`);
      assert(!body.includes('id="fsus-spa-boot"'), `[${item.name}] unexpected deferred public spa boot on non-public route`);
      assert(state !== 'fresh' && state !== 'stale', `[${item.name}] unexpected public AOT ${state} header`);
      assert(source !== 'server-ssr', `[${item.name}] unexpected public AOT source header`);
      console.log(`[public-seo-smoke] ok: ${item.name}`);
    } catch (error) {
      failures.push(`[public-seo-smoke] fail: ${item.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const item of realStatusChecks) {
    try {
      await assertRealNotFoundStatus(item);
      console.log(`[public-seo-smoke] ok: ${item.name}`);
    } catch (error) {
      failures.push(`[public-seo-smoke] fail: ${item.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    const trailingSlash = await fetchWithTimeout(`${baseUrl}/article/${publicFixtureIds.articleId}/`, {
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (FsusBlog Public SEO Status Smoke)',
        Accept: 'text/html,application/xhtml+xml'
      }
    }, requestTimeoutMs);
    assert(trailingSlash.status === 301, `[trailing_slash] expected 301, got ${trailingSlash.status}`);
    assert(
      trailingSlash.headers.get('location') === `/article/${publicFixtureIds.articleId}`,
      `[trailing_slash] wrong canonical redirect: ${trailingSlash.headers.get('location') || 'missing'}`
    );
    console.log('[public-seo-smoke] ok: trailing_slash');
  } catch (error) {
    failures.push(`[public-seo-smoke] fail: trailing_slash: ${error instanceof Error ? error.message : String(error)}`);
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
        Accept: 'application/octet-stream'
      }
    }, requestTimeoutMs);

    if (!response.ok) {
      return null;
    }

    const data = await readAedsResponse(response);
    if (!Array.isArray(data)) {
      return null;
    }
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
