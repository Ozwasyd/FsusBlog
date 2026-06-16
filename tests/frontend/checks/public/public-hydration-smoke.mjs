#!/usr/bin/env node

import { fetchWithTimeout, probeReachable, parseTimeoutMs } from '../../support/http.mjs';
import { decodePublicAotPayload, readAedsResponse } from '../../support/aeds-envelope.mjs';
import { readPublicFixtureIds } from '../../support/public-fixtures.mjs';

const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:8080';
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, 15000);
const aotSettleTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_PUBLIC_AOT_SETTLE_TIMEOUT_MS, 15000);
const settleRetryDelayMs = 400;
const publicFixtureIds = readPublicFixtureIds();

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

function readBinaryScript(html, id) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `<script\\b(?=[^>]*\\bid="${escapedId}")(?=[^>]*\\btype="application/octet-stream")[^>]*>([\\s\\S]*?)<\\/script>`,
    'i'
  );
  const match = html.match(pattern);
  assert(match?.[1], `missing binary script: ${id}`);
  return decodePublicAotPayload(decodeHtmlEntities(match[1]));
}

function assertSharedHydrationMarkers(html, kind) {
  expectIncludes(html, 'id="fsus-aot-shell"', `${kind} shell root`);
  expectIncludes(html, 'id="fsus-aot-bootstrap"', `${kind} bootstrap payload`);
  expectIncludes(html, 'id="fsus-aot-hydration-props"', `${kind} hydration props`);
  expectIncludes(html, `data-public-hydration-kind="${kind}"`, `${kind} hydration kind`);
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
  expectIncludes(home, 'ui-article-card', 'home ui article card class');
  expectIncludes(home, 'ui-article-title', 'home ui article title class');
  expectIncludes(home, 'ui-article-summary', 'home ui article summary class');
  expectIncludes(home, 'data-fsusblog-public-first-paint="true"', 'home first paint marker');
  const homeStylesheets = assertStylesheetLinkSet(home, 'home');
  await assertStylesheetResponsesAreCss(homeStylesheets, 'home');
  assertMinimalRuntimeHintContract(home, 'home');
  const homePayload = readBinaryScript(home, 'fsus-aot-hydration-props');
  const homeBootstrap = readBinaryScript(home, 'fsus-aot-bootstrap');
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
  const articlePayload = readBinaryScript(article, 'fsus-aot-hydration-props');
  const articleBootstrap = readBinaryScript(article, 'fsus-aot-bootstrap');
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

  const archive = await fetchHtmlUntil('/archive', (html) => {
    assertSharedHydrationMarkers(html, 'Archive');
    assertDeferredSpaOnly(html, 'archive');
  }, 'archive shell contract');

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
    const categoryPayload = readBinaryScript(category, 'fsus-aot-hydration-props');
    const categoryBootstrap = readBinaryScript(category, 'fsus-aot-bootstrap');
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
    const tagPayload = readBinaryScript(tag, 'fsus-aot-hydration-props');
    const tagBootstrap = readBinaryScript(tag, 'fsus-aot-bootstrap');
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

      const namedTag = await fetchHtmlUntil(`/tag/${encodeURIComponent(tagName)}`, (html) => {
        assertSharedHydrationMarkers(html, 'Filter');
      }, 'named tag shell contract');
      assertPublicChrome(namedTag, 'named tag');
      const namedTagPayload = readBinaryScript(namedTag, 'fsus-aot-hydration-props');
      const namedTagBootstrap = readBinaryScript(namedTag, 'fsus-aot-bootstrap');
      assert(namedTagPayload.routeKey === `tag-name:${tagName}`, 'named tag payload routeKey mismatch');
      assert(namedTagBootstrap.routeKey === `tag-name:${tagName}`, 'named tag bootstrap routeKey mismatch');
      assert(namedTagPayload.filter?.filterKey === `tag-name:${tagName}`, 'named tag payload filterKey mismatch');
      assert(namedTagBootstrap.filter?.filterKey === `tag-name:${tagName}`, 'named tag bootstrap filterKey mismatch');
      assert(namedTagPayload.filter?.filterName === tagName, 'named tag payload filterName mismatch');
      assert(namedTagBootstrap.filter?.filterName === tagName, 'named tag bootstrap filterName mismatch');
      expectIncludes(namedTag, tagName, 'named tag page title text');
    }
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
