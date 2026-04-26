#!/usr/bin/env node

import { fetchWithTimeout, probeReachable, parseTimeoutMs } from '../../support/http.mjs';

const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:8080';
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, 15000);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function fetchHtml(path) {
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
  return await response.text();
}

async function fetchJson(path) {
  const response = await fetchWithTimeout(`${baseUrl}${path}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json'
    }
  }, requestTimeoutMs);

  if (!response.ok) {
    return null;
  }

  try {
    return await response.json();
  } catch {
    return null;
  }
}

function expectIncludes(html, needle, label) {
  assert(html.includes(needle), `expected ${label}: ${needle}`);
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
  assert(
    paths.some((path) => /(?:^|\/)(?:vendor|critical-fonts|public-shell-critical|full-app)(?:-[^/]+)?\.css$/i.test(path)),
    `${label} missing supporting stylesheet (vendor/critical-fonts/public-shell-critical/full-app)`
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

function readJsonScript(html, id) {
  const pattern = new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)<\\/script>`);
  const match = html.match(pattern);
  assert(match?.[1], `missing json script: ${id}`);
  const jsonText = decodeHtmlEntities(match[1]);
  return JSON.parse(jsonText);
}

function assertSharedHydrationMarkers(html, kind) {
  expectIncludes(html, 'id="fsus-aot-shell"', `${kind} shell root`);
  expectIncludes(html, 'id="fsus-aot-bootstrap"', `${kind} bootstrap payload`);
  expectIncludes(html, 'id="fsus-aot-hydration-props"', `${kind} hydration props`);
  expectIncludes(html, `data-public-hydration-kind="${kind}"`, `${kind} hydration kind`);
}

function assertDeferredSpaOnly(html, label) {
  expectIncludes(html, 'id="fsus-spa-boot"', `${label} deferred spa boot script`);
  expectIncludes(html, 'data-fsus-spa-entry=', `${label} deferred spa entry marker`);
  expectNotIncludes(html, '<script type="module" crossorigin src="/assets/', `${label} eager built spa entry`);
  expectNotIncludes(html, '<script type="module" src="/src/main.ts', `${label} direct src main.ts entry`);
  expectNotIncludes(html, '<script type="module" src="/main.ts', `${label} direct main.ts entry`);
}

async function main() {
  await probeReachable(`${baseUrl}/`, '[public-hydration-smoke frontend]', requestTimeoutMs);

  const home = await fetchHtml('/');
  assertSharedHydrationMarkers(home, 'Home');
  assertDeferredSpaOnly(home, 'home');
  expectIncludes(home, 'ui-article-card', 'home ui article card class');
  expectIncludes(home, 'ui-article-title', 'home ui article title class');
  expectIncludes(home, 'ui-article-summary', 'home ui article summary class');
  expectIncludes(home, 'data-fsus-public-first-paint="true"', 'home first paint marker');
  const homeStylesheets = assertStylesheetLinkSet(home, 'home');
  await assertStylesheetResponsesAreCss(homeStylesheets, 'home');
  assertMinimalRuntimeHintContract(home, 'home');
  const homePayload = readJsonScript(home, 'fsus-aot-hydration-props');
  const homeBootstrap = readJsonScript(home, 'fsus-aot-bootstrap');
  assert(homePayload.pageKind === 'Home', 'home payload pageKind mismatch');
  assert(homeBootstrap.kind === 'Home', 'home bootstrap kind mismatch');
  assert(homePayload.routeKey === 'home', 'home payload routeKey mismatch');
  assert(Array.isArray(homePayload.view?.items) && homePayload.view.items.length > 0, 'home payload items missing');
  assert(
    typeof homePayload.view?.pagination?.indicator === 'string'
      && /^\d+\s*\/\s*\d+$/.test(homePayload.view.pagination.indicator),
    'home payload pagination mismatch'
  );
  const [currentPage, totalPages] = String(homePayload.view.pagination.indicator).split('/').map((part) => Number.parseInt(part.trim(), 10));
  assert(Number.isFinite(currentPage) && currentPage >= 1, 'home payload current page invalid');
  assert(Number.isFinite(totalPages) && totalPages >= currentPage, 'home payload total pages invalid');
  assert(/^\/article\/\d+$/.test(String(homePayload.view?.items?.[0]?.href ?? '')), 'home payload first article href mismatch');
  assert(homeBootstrap.pageIndex === 1, 'home bootstrap pageIndex mismatch');
  assert(
    homeBootstrap.pageSize === homePayload.pageSize,
    `home bootstrap pageSize mismatch: bootstrap=${String(homeBootstrap.pageSize)} payload=${String(homePayload.pageSize)}`
  );
  assert(homeBootstrap.articles?.[0]?.id === homePayload.view?.items?.[0]?.id, 'home shared renderer article id mismatch');
  assert(homeBootstrap.articles?.[0]?.title === homePayload.view?.items?.[0]?.title, 'home shared renderer article title mismatch');
  assert(homeBootstrap.siteTitle === homePayload.siteTitle, 'home shared renderer siteTitle mismatch');
  assert(homeBootstrap.siteDescription === homePayload.siteDescription, 'home shared renderer siteDescription mismatch');
  expectNotIncludes(home, 'public-aside-placeholder', 'home hot articles placeholder');
  expectIncludes(home, 'id="fsus-home-hot-articles-slot"', 'home hot articles slot');
  expectIncludes(home, 'id="fsus-home-hot-articles-slot-content"', 'home hot articles slot content');

  const article = await fetchHtml('/article/1');
  assertSharedHydrationMarkers(article, 'ArticleDetail');
  assertDeferredSpaOnly(article, 'article');
  assert(
    article.includes('style="overflow-anchor:none;"') || article.includes('style="overflow-anchor: none;"'),
    'article overflow-anchor inline style'
  );
  const articleStylesheets = assertStylesheetLinkSet(article, 'article');
  await assertStylesheetResponsesAreCss(articleStylesheets, 'article');
  assertMinimalRuntimeHintContract(article, 'article');
  expectIncludes(article, 'data-markdown-renderer="wasm"', 'article markdown wasm marker');
  expectIncludes(article, 'markdown-renderer__body', 'article markdown body class');
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
  const articlePayload = readJsonScript(article, 'fsus-aot-hydration-props');
  const articleBootstrap = readJsonScript(article, 'fsus-aot-bootstrap');
  assert(articlePayload.pageKind === 'ArticleDetail', 'article payload pageKind mismatch');
  assert(articleBootstrap.kind === 'ArticleDetail', 'article bootstrap kind mismatch');
  assert(articlePayload.routeKey === 'article:1', 'article payload routeKey mismatch');
  assert(articlePayload.articleId === 1, 'article payload articleId mismatch');
  assert(articlePayload.detailView?.header?.title?.length > 0, 'article payload header title missing');
  assert(articleBootstrap.article?.id === articlePayload.articleId, 'article bootstrap articleId mismatch');
  assert(articleBootstrap.article?.title === articlePayload.detailView?.header?.title, 'article shared renderer title mismatch');
  expectNotIncludes(article, 'id="fsus-aot-islands"', 'article islands payload');

  const about = await fetchHtml('/about');
  assertSharedHydrationMarkers(about, 'About');
  assertDeferredSpaOnly(about, 'about');

  const archive = await fetchHtml('/archive');
  assertSharedHydrationMarkers(archive, 'Archive');
  assertDeferredSpaOnly(archive, 'archive');

  const categoryJson = await fetchJson('/api/Category');
  const categoryId = typeof categoryJson?.data?.[0]?.id === 'number'
    ? categoryJson.data[0].id
    : Number(categoryJson?.data?.[0]?.id);
  if (Number.isFinite(categoryId) && categoryId > 0) {
    const category = await fetchHtml(`/category/${categoryId}`);
    assertSharedHydrationMarkers(category, 'Filter');
    assertDeferredSpaOnly(category, 'category');
  }

  const tagJson = await fetchJson('/api/Tag');
  const tagId = typeof tagJson?.data?.[0]?.id === 'number'
    ? tagJson.data[0].id
    : Number(tagJson?.data?.[0]?.id);
  if (Number.isFinite(tagId) && tagId > 0) {
    const tag = await fetchHtml(`/tag/${tagId}`);
    assertSharedHydrationMarkers(tag, 'Filter');
    assertDeferredSpaOnly(tag, 'tag');
  }

  const search = await fetchHtml('/search?q=test');
  expectNotIncludes(search, 'id="fsus-aot-hydration-props"', 'search hydration props');
  expectNotIncludes(search, 'data-public-hydration-kind="Home"', 'search home hydration shell');
  expectNotIncludes(search, 'data-public-hydration-kind="ArticleDetail"', 'search article hydration shell');

  console.log('[public-hydration-smoke] completed');
}

main().catch((error) => {
  console.error('[public-hydration-smoke] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
