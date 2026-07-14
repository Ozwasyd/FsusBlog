#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWithTimeout, probeReachable, parseTimeoutMs } from '../../support/http.mjs';
import { decodePublicAotPayload, readAedsResponse } from '../../support/aeds-envelope.mjs';
import { readPublicFixtureIds } from '../../support/public-fixtures.mjs';

const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:8080';
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, 15000);
const aotSettleTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_PUBLIC_AOT_SETTLE_TIMEOUT_MS, 30000);
const settleRetryDelayMs = 400;
const publicFixtureIds = readPublicFixtureIds();
const publicAotHydrationMediaType = 'application/vnd.fsus.aeds';
const hydrationSidecarSummarySchema = 'fsusblog.public-hydration-sidecar-smoke.v1';
const hydrationSidecarSummaryFile = process.env.FSUSBLOG_PUBLIC_HYDRATION_SIDECAR_SUMMARY_FILE
  || fileURLToPath(new URL('../../../../.tmp/release-evidence/public-hydration-sidecar-summary.json', import.meta.url));
const requiredSidecarKinds = ['Home', 'ArticleDetail', 'Archive', 'Filter', 'About', 'Privacy', 'Guidelines', 'Copyright'];
const hydrationSidecarChecks = [];
let missingSidecarCanary = null;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function fetchHtmlResponse(path) {
  const response = await fetchWithTimeout(`${baseUrl}${path}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'text/html'
    }
  }, requestTimeoutMs);

  assert(
    response.ok,
    `${path} failed: ${response.status} (baseUrl=${baseUrl}; make sure the frontend and backend are both running)`
  );
  return {
    response,
    html: await response.text()
  };
}

async function fetchHtml(path) {
  return (await fetchHtmlResponse(path)).html;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHtmlUntil(path, validate, label) {
  const startedAt = Date.now();
  let lastHtml = '';
  let lastError = null;
  let attempts = 0;

  while (Date.now() - startedAt < aotSettleTimeoutMs) {
    attempts += 1;
    lastHtml = await fetchHtml(path);

    try {
      validate(lastHtml);
      return lastHtml;
    } catch (error) {
      lastError = error;
      await sleep(settleRetryDelayMs);
    }
  }

  throw new Error(
    `${label} failed after ${attempts} attempts/${aotSettleTimeoutMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

async function fetchAeds(path) {
  const response = await fetchWithTimeout(`${baseUrl}${path}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/octet-stream'
    }
  }, requestTimeoutMs);

  if (!response.ok) {
    return null;
  }

  try {
    return await readAedsResponse(response);
  } catch {
    return null;
  }
}

function expectIncludes(html, needle, label) {
  assert(html.includes(needle), `expected ${label}: ${needle}`);
}

function expectIncludesAny(html, needles, label) {
  assert(
    needles.some((needle) => html.includes(needle)),
    `expected ${label}: ${needles.join(' or ')}`
  );
}

function expectNotIncludes(html, needle, label) {
  assert(!html.includes(needle), `unexpected ${label}: ${needle}`);
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
  return hrefs;
}

async function assertStylesheetResponsesAreCss(hrefs, label) {
  const uniqueHrefs = Array.from(new Set(hrefs));

  for (const href of uniqueHrefs) {
    const url = new URL(href, `${baseUrl}/`).toString();
    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'text/css,*/*;q=0.1'
      }
    }, requestTimeoutMs);

    assert(response.ok, `${label} stylesheet request failed: ${href} => ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    assert(contentType.includes('text/css'), `${label} stylesheet content-type must be text/css: ${href} => ${contentType || 'none'}`);

    const payload = await response.text();
    assert(
      !payload.includes('__vite__updateStyle') && !payload.includes('import.meta.hot'),
      `${label} stylesheet must not be served as JS module payload: ${href}`
    );
  }
}

function assertMinimalRuntimeHintContract(html, label) {
  assert(
    /<div[^>]*id="global-loader"[^>]*\shidden(?:\s|>|=)/i.test(html),
    `expected ${label} hidden global loader in AOT shell`
  );
  expectNotIncludes(html, 'id="fsus-public-runtime-hint-root"', `${label} runtime hint root before blocking action`);
  assert(
    !/<a[^>]*data-aot-action="page-(?:prev|next)"/i.test(html),
    `${label} pagination actions must use blocking buttons, not anchors`
  );
  assert(
    !/<button[^>]*data-aot-action="open-article"/i.test(html),
    `${label} open-article should stay non-blocking (anchor navigation)`
  );
}

function decodeHtmlEntities(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replaceAll('&#39;', "'")
    .replaceAll('&#x2F;', '/');
}

function readAttribute(tag, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\b${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = tag.match(pattern);
  return decodeHtmlEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? '');
}

function readBinaryScriptMarker(html, id) {
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match = pattern.exec(html);
  while (match) {
    const tag = `<script${match[1]}>`;
    if (readAttribute(tag, 'id') === id) {
      const type = readAttribute(tag, 'type');
      assert(type === 'application/octet-stream', `binary script ${id} type mismatch: ${type || 'none'}`);
      return {
        tag,
        inlineText: decodeHtmlEntities(match[2] ?? ''),
        sidecarUrl: readAttribute(tag, 'data-aeds-src') || readAttribute(tag, 'src')
      };
    }

    match = pattern.exec(html);
  }

  throw new Error(`missing binary script: ${id}`);
}

function readInlineBinaryPayload(html, id) {
  const marker = readBinaryScriptMarker(html, id);
  assert(marker.inlineText.trim().length > 0, `missing inline binary payload: ${id}`);
  return decodePublicAotPayload(marker.inlineText);
}

function decodePublicAotPayloadBytes(bytes) {
  return decodePublicAotPayload(Buffer.from(bytes).toString('base64url'));
}

async function fetchHydrationSidecar(sidecarUrl, routePath, fetcher = fetchWithTimeout) {
  const url = new URL(sidecarUrl, `${baseUrl}/`);
  const response = await fetcher(url.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: publicAotHydrationMediaType
    }
  }, requestTimeoutMs);

  if (!response.ok) {
    throw new Error(`missing public hydration sidecar: ${routePath} -> ${url.pathname} HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  assert(
    contentType.toLowerCase().includes(publicAotHydrationMediaType),
    `${routePath} hydration sidecar content-type mismatch: ${contentType || 'none'}`
  );

  const cacheControl = response.headers.get('cache-control') || '';
  const normalizedCacheControl = cacheControl.toLowerCase();
  assert(
    normalizedCacheControl.includes('public')
      && normalizedCacheControl.includes('max-age=31536000')
      && normalizedCacheControl.includes('immutable'),
    `${routePath} hydration sidecar cache-control mismatch: ${cacheControl || 'none'}`
  );

  const bytes = new Uint8Array(await response.arrayBuffer());
  assert(bytes.byteLength > 0, `${routePath} hydration sidecar is empty: ${url.pathname}`);
  const payload = decodePublicAotPayloadBytes(bytes);
  assert(payload && typeof payload === 'object', `${routePath} hydration sidecar did not decode`);
  return {
    payload,
    sidecarUrl: url.pathname,
    byteLength: bytes.byteLength,
    contentType,
    cacheControl
  };
}

async function readHydrationPayload(html, routePath, expectedKind) {
  const check = {
    route: routePath,
    expectedPageKind: expectedKind,
    mode: null,
    sidecarUrl: null,
    contentType: null,
    cacheControl: null,
    byteLength: 0,
    pageKind: null,
    routeKey: null,
    status: 'failure'
  };

  try {
    const marker = readBinaryScriptMarker(html, 'fsus-aot-hydration-props');
    let payload;
    if (marker.sidecarUrl) {
      const sidecar = await fetchHydrationSidecar(marker.sidecarUrl, routePath);
      payload = sidecar.payload;
      check.mode = 'sidecar-primary';
      check.sidecarUrl = sidecar.sidecarUrl;
      check.contentType = sidecar.contentType;
      check.cacheControl = sidecar.cacheControl;
      check.byteLength = sidecar.byteLength;
    } else {
      assert(marker.inlineText.trim().length > 0, `${routePath} hydration payload missing sidecar and inline fallback`);
      payload = decodePublicAotPayload(marker.inlineText);
      check.mode = 'inline-fallback';
    }

    check.pageKind = payload?.pageKind ?? null;
    check.routeKey = payload?.routeKey ?? null;
    assert(payload?.pageKind === expectedKind, `${routePath} payload pageKind mismatch: ${payload?.pageKind ?? 'none'}`);
    check.status = 'success';
    return payload;
  } catch (error) {
    check.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    hydrationSidecarChecks.push(check);
  }
}

async function assertMissingSidecarFailureVisible() {
  const missingSidecarHtml = '<script id="fsus-aot-hydration-props" type="application/octet-stream" data-aeds-src="/aot-cache/payloads/00/0000000000000000000000000000000000000000000000000000000000000000.aeds"></script>';
  const failingFetcher = async () => ({
    ok: false,
    status: 404,
    headers: {
      get: () => ''
    },
    arrayBuffer: async () => new ArrayBuffer(0)
  });

  try {
    const marker = readBinaryScriptMarker(missingSidecarHtml, 'fsus-aot-hydration-props');
    await fetchHydrationSidecar(marker.sidecarUrl, '/__canary/missing-sidecar', failingFetcher);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(
      message.includes('missing public hydration sidecar') && message.includes('HTTP 404'),
      `missing sidecar canary did not expose HTTP failure: ${message}`
    );
    return { status: 'success', error: message };
  }

  throw new Error('missing sidecar canary unexpectedly passed');
}

function writeHydrationSidecarSummary(status, canary, error = null) {
  const modeCounts = hydrationSidecarChecks.reduce((acc, check) => {
    if (check.mode) {
      acc[check.mode] = (acc[check.mode] || 0) + 1;
    }

    return acc;
  }, { 'sidecar-primary': 0, 'inline-fallback': 0 });
  const missingRequiredKinds = requiredSidecarKinds.filter((kind) =>
    !hydrationSidecarChecks.some((check) =>
      check.status === 'success'
        && check.expectedPageKind === kind
        && check.pageKind === kind
        && check.mode === 'sidecar-primary'));

  const summary = {
    schema: hydrationSidecarSummarySchema,
    status,
    baseUrl,
    mediaType: publicAotHydrationMediaType,
    modeCounts,
    requiredPageKinds: requiredSidecarKinds,
    missingRequiredKinds,
    checks: hydrationSidecarChecks,
    canary,
    error: error ? (error instanceof Error ? error.message : String(error)) : null
  };
  mkdirSync(dirname(hydrationSidecarSummaryFile), { recursive: true });
  writeFileSync(hydrationSidecarSummaryFile, `${JSON.stringify(summary, null, 2)}\n`);
}

function assertRequiredHydrationSidecarCoverage() {
  const missing = requiredSidecarKinds.filter((kind) =>
    !hydrationSidecarChecks.some((check) =>
      check.status === 'success'
        && check.expectedPageKind === kind
        && check.pageKind === kind
        && check.mode === 'sidecar-primary'));
  assert(missing.length === 0, `missing sidecar-primary coverage for: ${missing.join(', ')}`);
}

function assertSharedHydrationMarkers(html, kind) {
  expectIncludes(html, 'id="fsus-aot-shell"', `${kind} shell root`);
  expectIncludes(html, 'id="fsus-aot-bootstrap"', `${kind} bootstrap payload`);
  expectIncludes(html, 'id="fsus-aot-hydration-props"', `${kind} hydration props`);
  expectIncludes(html, `data-public-hydration-kind="${kind}"`, `${kind} hydration kind`);
}

function assertNoPublicAotHitHeaders(response, label) {
  const source = response.headers.get('X-Fsus-Public-Aot-Source') || '';
  const state = response.headers.get('X-Fsus-Public-Aot-State') || '';
  assert(state !== 'fresh' && state !== 'stale', `${label} must not claim a public AOT ${state} hit`);
  assert(source !== 'server-ssr', `${label} must not claim public AOT source ${source}`);
}

async function assertNonAotRuntimeOnlyRoute(path, label) {
  const { response, html } = await fetchHtmlResponse(path);
  expectNotIncludes(html, 'id="fsus-aot-hydration-props"', `${label} hydration props`);
  expectNotIncludes(html, 'data-public-hydration-kind="Home"', `${label} home hydration shell`);
  expectNotIncludes(html, 'data-public-hydration-kind="Filter"', `${label} filter hydration shell`);
  expectNotIncludes(html, 'data-public-hydration-kind="Account"', `${label} account hydration shell`);
  assertNoPublicAotHitHeaders(response, label);
}

function assertDeferredSpaOnly(html, label) {
  expectIncludes(html, 'id="fsus-spa-boot"', `${label} deferred spa boot script`);
  expectIncludes(html, 'data-fsusblog-spa-entry=', `${label} deferred spa entry marker`);
  expectNotIncludes(html, '<script type="module" crossorigin src="/assets/', `${label} eager built spa entry`);
  expectNotIncludes(html, '<script type="module" src="/src/main.ts', `${label} direct src main.ts entry`);
  expectNotIncludes(html, '<script type="module" src="/main.ts', `${label} direct main.ts entry`);
}

function assertPublicChrome(html, label) {
  expectIncludesAny(html, ['aria-label="主导航"', 'aria-label="Primary navigation"'], `${label} public nav`);
  expectIncludes(html, 'data-mobile-nav-mode="menu"', `${label} explicit mobile nav mode`);
  expectIncludes(html, '<details', `${label} native no-js mobile menu`);
  expectIncludes(html, 'href="/search"', `${label} no-js search fallback`);
  expectNotIncludes(html, 'data-fsus-bottom-tab-bar', `${label} fixed bottom navigation`);
  expectNotIncludes(html, 'fsusblog-public-bottom-tab', `${label} Blog fixed bottom navigation`);
  expectIncludes(html, 'href="/feed/rss.xml"', `${label} rss footer link`);
  expectIncludes(html, '回到顶部', `${label} footer back to top`);
}

function assertAotCodeBlocksAreShikiHighlighted(html, label) {
  if (!/<pre[^>]*class="[^"]*\bshiki\b/i.test(html)) {
    return;
  }

  assert(
    /<pre[^>]*class="[^"]*\bshiki\b[\s\S]*?<span class="line">/i.test(html),
    `${label} AOT code blocks must contain Shiki token line spans before hydration`
  );
}

async function main() {
  await probeReachable(`${baseUrl}/`, '[public-hydration-smoke frontend]', requestTimeoutMs);

  const home = await fetchHtmlUntil('/', (html) => {
    assertSharedHydrationMarkers(html, 'Home');
    assertDeferredSpaOnly(html, 'home');
  }, 'home shell contract');
  expectIncludes(home, 'data-fsusblog-public-first-paint="true"', 'home first paint marker');
  const homeStylesheets = assertStylesheetLinkSet(home, 'home');
  await assertStylesheetResponsesAreCss(homeStylesheets, 'home');
  assertMinimalRuntimeHintContract(home, 'home');
  const homePayload = await readHydrationPayload(home, '/', 'Home');
  const homeBootstrap = readInlineBinaryPayload(home, 'fsus-aot-bootstrap');
  assert(homePayload.pageKind === 'Home', 'home payload pageKind mismatch');
  assert(homeBootstrap.kind === 'Home', 'home bootstrap kind mismatch');
  assert(homePayload.routeKey === 'home', 'home payload routeKey mismatch');
  const homeItems = Array.isArray(homePayload.view?.items) ? homePayload.view.items : [];
  assert(Array.isArray(homePayload.view?.items), 'home payload items missing');
  assert(
    typeof homePayload.view?.pagination?.indicator === 'string'
      && /^\d+\s*\/\s*\d+$/.test(homePayload.view.pagination.indicator),
    'home payload pagination mismatch'
  );
  const [currentPage, totalPages] = String(homePayload.view.pagination.indicator).split('/').map((part) => Number.parseInt(part.trim(), 10));
  assert(Number.isFinite(currentPage) && currentPage >= 1, 'home payload current page invalid');
  assert(Number.isFinite(totalPages) && totalPages >= currentPage, 'home payload total pages invalid');
  assert(homeBootstrap.pageIndex === 1, 'home bootstrap pageIndex mismatch');
  assert(
    homeBootstrap.pageSize === homePayload.pageSize,
    `home bootstrap pageSize mismatch: bootstrap=${String(homeBootstrap.pageSize)} payload=${String(homePayload.pageSize)}`
  );
  if (homeItems.length > 0) {
    const homeArticleIds = [
      ...homeItems,
      ...(Array.isArray(homePayload.featuredArticles) ? homePayload.featuredArticles : []),
      ...(Array.isArray(homePayload.hotArticles) ? homePayload.hotArticles : [])
    ].map((item) => Number(item?.id)).filter((id) => Number.isSafeInteger(id) && id > 0);
    expectIncludesAny(home, [
      'ui-article-card',
      'data-home-editorial-lead',
      'data-home-editorial-secondary'
    ], 'home editorial article surface');
    assert(
      homeArticleIds.some((id) => home.includes(`data-article-id="${id}"`)),
      'home rendered editorial surface must bind an article from the hydration payload'
    );
    if (home.includes('ui-article-card')) {
      expectIncludes(home, 'ui-article-title', 'home feed article title class');
      expectIncludes(home, 'ui-article-summary', 'home feed article summary class');
    } else {
      expectIncludesAny(home, [
        'data-home-editorial-lead',
        'data-home-editorial-secondary'
      ], 'home deduplicated editorial surface');
    }
    assert(/^\/article\/\d+$/.test(String(homeItems[0]?.href ?? '')), 'home payload first article href mismatch');
    assert(homeBootstrap.articles?.[0]?.id === homeItems[0]?.id, 'home shared renderer article id mismatch');
    assert(homeBootstrap.articles?.[0]?.title === homeItems[0]?.title, 'home shared renderer article title mismatch');
  } else {
    expectIncludes(home, 'public-content-state', 'home empty article state');
  }
  assert(homeBootstrap.siteTitle === homePayload.siteTitle, 'home shared renderer siteTitle mismatch');
  assert(homeBootstrap.siteDescription === homePayload.siteDescription, 'home shared renderer siteDescription mismatch');
  expectNotIncludes(home, 'public-aside-placeholder', 'home hot articles placeholder');
  if (home.includes('id="fsus-home-hot-articles-slot"')) {
    expectIncludes(home, 'id="fsus-home-hot-articles-slot-content"', 'home hot articles slot content');
  }

  const articlePath = `/article/${publicFixtureIds.articleId}`;
  const article = await fetchHtmlUntil(articlePath, (html) => {
    assertSharedHydrationMarkers(html, 'ArticleDetail');
    assertDeferredSpaOnly(html, 'article');
  }, 'article shell contract');
  assertPublicChrome(article, 'article');
  expectIncludes(article, 'class="public-article-detail', 'article overflow-anchor stylesheet hook');
  const articleStylesheets = assertStylesheetLinkSet(article, 'article');
  await assertStylesheetResponsesAreCss(articleStylesheets, 'article');
  assertMinimalRuntimeHintContract(article, 'article');
  expectIncludes(article, 'data-markdown-renderer="wasm"', 'article markdown wasm marker');
  expectIncludes(article, 'markdown-renderer__body', 'article markdown body class');
  assertAotCodeBlocksAreShikiHighlighted(article, 'article');
  expectIncludes(article, 'safe-inline-wrap', 'article markdown safe inline wrapper');
  expectNotIncludes(article, 'class="aot-rendered-content"', 'legacy article markdown wrapper');
  expectNotIncludes(article, 'ArticleCommentComposer', 'article composer should not be eagerly rendered');
  expectNotIncludes(article, 'ArticleCommentsVirtualList', 'article comments list should not be eagerly rendered');
  expectIncludes(article, 'id="fsus-comments-island"', 'article comments island host');
  expectIncludes(article, 'id="fsus-comments-island-content"', 'article comments island mount target');
  expectNotIncludes(article, '第一条评论会在这里出现。', 'article comments placeholder copy');
  expectNotIncludes(article, 'data-aot-action="activate-comments"', 'article comments activator');
  assert(
    /<div[^>]*class="[^"]*\bmarkdown-renderer__body\b[^"]*"[^>]*role="article"[^>]*aria-live="polite"[^>]*data-markdown-renderer="wasm"[^>]*>/i.test(article),
    'article markdown container contract mismatch'
  );
  assert(
    /<div[^>]*class="[^"]*\bmarkdown-body\b[^"]*\bsafe-inline-wrap\b[^"]*"[^>]*>/i.test(article),
    'article markdown wrapper contract mismatch'
  );
  const articlePayload = await readHydrationPayload(article, articlePath, 'ArticleDetail');
  const articleBootstrap = readInlineBinaryPayload(article, 'fsus-aot-bootstrap');
  assert(articlePayload.pageKind === 'ArticleDetail', 'article payload pageKind mismatch');
  assert(articleBootstrap.kind === 'ArticleDetail', 'article bootstrap kind mismatch');
  assert(articlePayload.routeKey === `article:${publicFixtureIds.articleId}`, 'article payload routeKey mismatch');
  assert(articlePayload.articleId === publicFixtureIds.articleId, 'article payload articleId mismatch');
  assert(articlePayload.detailView?.header?.title?.length > 0, 'article payload header title missing');
  assert(articlePayload.detailView?.relatedReading, 'article payload related-reading contract missing');
  assert(Array.isArray(articlePayload.detailView.relatedReading.items), 'article payload related-reading items must be an array');
  assert('previous' in articlePayload.detailView.relatedReading, 'article payload related-reading previous key missing');
  assert('next' in articlePayload.detailView.relatedReading, 'article payload related-reading next key missing');
  if (articlePayload.detailView.relatedReading.items.length > 0) {
    expectIncludes(article, 'id="fsus-related-reading"', 'article related-reading section');
    expectIncludes(article, 'data-public-related-reading="true"', 'article related-reading marker');
  }
  assert(articleBootstrap.article?.id === articlePayload.articleId, 'article bootstrap articleId mismatch');
  assert(articleBootstrap.relatedReading, 'article bootstrap related-reading contract missing');
  assert(articleBootstrap.article?.title === articlePayload.detailView?.header?.title, 'article shared renderer title mismatch');
  expectNotIncludes(article, 'id="fsus-aot-islands"', 'article islands payload');

  const about = await fetchHtmlUntil('/about', (html) => {
    assertSharedHydrationMarkers(html, 'About');
    assertDeferredSpaOnly(html, 'about');
  }, 'about shell contract');
  const aboutPayload = await readHydrationPayload(about, '/about', 'About');
  assert(aboutPayload.routeKey === 'about', 'about payload routeKey mismatch');

  const archive = await fetchHtmlUntil('/archive', (html) => {
    assertSharedHydrationMarkers(html, 'Archive');
    assertDeferredSpaOnly(html, 'archive');
  }, 'archive shell contract');
  const archivePayload = await readHydrationPayload(archive, '/archive', 'Archive');
  assert(archivePayload.routeKey === 'archive', 'archive payload routeKey mismatch');

  for (const [path, kind, routeKey] of [
    ['/privacy', 'Privacy', 'privacy'],
    ['/guidelines', 'Guidelines', 'guidelines'],
    ['/copyright', 'Copyright', 'copyright']
  ]) {
    const page = await fetchHtmlUntil(path, (html) => {
      assertSharedHydrationMarkers(html, kind);
      assertDeferredSpaOnly(html, kind.toLowerCase());
    }, `${kind.toLowerCase()} shell contract`);
    const payload = await readHydrationPayload(page, path, kind);
    assert(payload.routeKey === routeKey, `${path} payload routeKey mismatch`);
  }

  const categoryList = await fetchAeds('/api/binary/category.aeds');
  const categoryId = typeof categoryList?.[0]?.id === 'number'
    ? categoryList[0].id
    : Number(categoryList?.[0]?.id);
  if (Number.isFinite(categoryId) && categoryId > 0) {
    const category = await fetchHtmlUntil(`/category/${categoryId}`, (html) => {
      assertSharedHydrationMarkers(html, 'Filter');
      assertDeferredSpaOnly(html, 'category');
    }, 'category shell contract');
    assertPublicChrome(category, 'category');
    const categoryPayload = await readHydrationPayload(category, `/category/${categoryId}`, 'Filter');
    const categoryBootstrap = readInlineBinaryPayload(category, 'fsus-aot-bootstrap');
    const categoryName = String(categoryList?.[0]?.name ?? '').trim();
    assert(categoryPayload.routeKey === `category:${categoryId}`, 'category payload routeKey mismatch');
    assert(categoryBootstrap.routeKey === `category:${categoryId}`, 'category bootstrap routeKey mismatch');
    assert(categoryPayload.filter?.filterType === 'category', 'category payload filterType mismatch');
    assert(categoryBootstrap.filter?.filterType === 'category', 'category bootstrap filterType mismatch');
    assert(categoryPayload.filter?.filterKey === `category:${categoryId}`, 'category payload filterKey mismatch');
    assert(categoryBootstrap.filter?.filterKey === `category:${categoryId}`, 'category bootstrap filterKey mismatch');
    assert(categoryPayload.filter?.filterId === categoryId, 'category payload filterId mismatch');
    assert(categoryBootstrap.filter?.filterId === categoryId, 'category bootstrap filterId mismatch');
    assert(categoryBootstrap.filterType === undefined, 'category bootstrap filterType should not be duplicated');
    if (categoryName) {
      assert(categoryPayload.filter?.filterName === categoryName, 'category payload filterName mismatch');
      assert(categoryBootstrap.filter?.filterName === categoryName, 'category bootstrap filterName mismatch');
      assert(categoryPayload.title === categoryName, 'category payload title mismatch');
      assert(categoryBootstrap.title === categoryName, 'category bootstrap title mismatch');
      expectIncludes(category, categoryName, 'category page title text');
    }
  }

  const invalidCategory = await fetchHtmlUntil('/category/0', (html) => {
    assertSharedHydrationMarkers(html, 'Filter');
  }, 'invalid category shell contract');
  assertPublicChrome(invalidCategory, 'invalid category');
  const invalidCategoryPayload = await readHydrationPayload(invalidCategory, '/category/0', 'Filter');
  assert(invalidCategoryPayload.routeKey === 'category:0', 'invalid category payload routeKey mismatch');
  assert(invalidCategoryPayload.filter?.filterType === 'category', 'invalid category payload filterType mismatch');
  assert(invalidCategoryPayload.filter?.filterKey === 'category:0', 'invalid category payload filterKey mismatch');
  expectIncludes(invalidCategory, '没有找到这个分类', 'invalid category empty state');
  expectNotIncludes(invalidCategory, 'Acceptance Public Article', 'invalid category leaked article list');

  const tagList = await fetchAeds('/api/binary/tag.aeds');
  const tagId = typeof tagList?.[0]?.id === 'number'
    ? tagList[0].id
    : Number(tagList?.[0]?.id);
  if (Number.isFinite(tagId) && tagId > 0) {
    const tag = await fetchHtmlUntil(`/tag/${tagId}`, (html) => {
      assertSharedHydrationMarkers(html, 'Filter');
      assertDeferredSpaOnly(html, 'tag');
    }, 'tag shell contract');
    assertPublicChrome(tag, 'tag');
    const tagPayload = await readHydrationPayload(tag, `/tag/${tagId}`, 'Filter');
    const tagBootstrap = readInlineBinaryPayload(tag, 'fsus-aot-bootstrap');
    const tagName = String(tagList?.[0]?.name ?? '').trim();
    assert(tagPayload.routeKey === `tag:${tagId}`, 'tag payload routeKey mismatch');
    assert(tagBootstrap.routeKey === `tag:${tagId}`, 'tag bootstrap routeKey mismatch');
    assert(tagPayload.filter?.filterType === 'tag', 'tag payload filterType mismatch');
    assert(tagBootstrap.filter?.filterType === 'tag', 'tag bootstrap filterType mismatch');
    assert(tagPayload.filter?.filterKey === `tag:${tagId}`, 'tag payload filterKey mismatch');
    assert(tagBootstrap.filter?.filterKey === `tag:${tagId}`, 'tag bootstrap filterKey mismatch');
    assert(tagPayload.filter?.filterId === tagId, 'tag payload filterId mismatch');
    assert(tagBootstrap.filter?.filterId === tagId, 'tag bootstrap filterId mismatch');
    assert(tagBootstrap.filterType === undefined, 'tag bootstrap filterType should not be duplicated');
    if (tagName) {
      assert(tagPayload.filter?.filterName === tagName, 'tag payload filterName mismatch');
      assert(tagBootstrap.filter?.filterName === tagName, 'tag bootstrap filterName mismatch');
      assert(tagPayload.title === tagName, 'tag payload title mismatch');
      assert(tagBootstrap.title === tagName, 'tag bootstrap title mismatch');
      expectIncludes(tag, tagName, 'tag page title text');

      const namedTag = await fetchWithTimeout(`${baseUrl}/tag/${encodeURIComponent(tagName)}`, {
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' }
      }, requestTimeoutMs);
      assert(namedTag.status === 301, 'named tag must redirect to stable ID canonical');
      assert(namedTag.headers.get('location') === `/tag/${tagId}`, 'named tag redirect target mismatch');
    }
  }

  await assertNonAotRuntimeOnlyRoute('/search?q=test', 'search');
  await assertNonAotRuntimeOnlyRoute('/user/profile', 'account profile');

  missingSidecarCanary = await assertMissingSidecarFailureVisible();
  assertRequiredHydrationSidecarCoverage();
  writeHydrationSidecarSummary('success', missingSidecarCanary);
  console.log('[public-hydration-smoke] completed');
}

main().catch((error) => {
  writeHydrationSidecarSummary('failure', missingSidecarCanary, error);
  console.error('[public-hydration-smoke] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
