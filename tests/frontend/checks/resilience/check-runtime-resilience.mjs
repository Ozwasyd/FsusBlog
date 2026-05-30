#!/usr/bin/env node

import { createRequire } from 'node:module';
import { authBinary, loginWithPow } from '../../support/auth-helpers.mjs';
import { buildMarkdownExtremeCorpus, fnv1a32, normalizeMarkdownExtremeSize } from '../../support/markdown-extreme-corpus.mjs';
import { testSessionHeaders } from '../../support/test-session.mjs';

const frontendBaseUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';
const userName = process.env.FSUSBLOG_USER_USERNAME || 'binaryuser';
const userPassword = process.env.FSUSBLOG_USER_PASSWORD || 'BinaryUserPass123!';
const adminName = process.env.FSUSBLOG_ADMIN_USERNAME || 'binaryadmin';
const adminPassword = process.env.FSUSBLOG_ADMIN_PASSWORD || 'BinaryAdminPass123!';
const markdownExtremeSize = normalizeMarkdownExtremeSize(process.env.FSUSBLOG_MARKDOWN_EXTREME_SIZE);
const appSettleDelayMs = Number.parseInt(process.env.FSUSBLOG_PLAYWRIGHT_SETTLE_MS || '2600', 10);
const hydrationReadyTimeoutMs = Number.parseInt(process.env.FSUSBLOG_HYDRATION_READY_TIMEOUT_MS || '12000', 10);
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('@playwright/test', { paths: [process.cwd()] }));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isIgnorableConsole(text) {
  return text.includes('favicon.ico')
    || text.includes('ERR_ABORTED')
    || text.includes('ERR_NETWORK_CHANGED')
    || text.includes('Failed to load resource: the server responded with a status of 401 (Unauthorized)');
}

function attachAudit(page) {
  const events = [];

  page.on('console', (message) => {
    if (message.type() !== 'error' && message.type() !== 'warning') {
      return;
    }
    const text = message.text().trim();
    if (isIgnorableConsole(text)) {
      return;
    }
    events.push(`console:${message.type()}:${text}`);
  });

  page.on('pageerror', (error) => {
    const text = error.message.trim();
    if (isIgnorableConsole(text)) {
      return;
    }
    events.push(`pageerror:${text}`);
  });

  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText || 'request_failed';
    if (failure.includes('ERR_ABORTED') || failure.includes('ERR_NETWORK_CHANGED')) {
      return;
    }
    events.push(`requestfailed:${request.method()} ${request.url()} ${failure}`);
  });

  return () => {
    assert(events.length === 0, `runtime resilience captured unexpected events:\n${events.join('\n')}`);
  };
}

async function waitForApp(page) {
  await page.waitForFunction(() => document.readyState === 'complete' && Boolean(document.querySelector('#app')), undefined, {
    timeout: 45000
  });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

  // Public shell -> full SPA takeover is deferred; wait for hydration/runtime markers
  // when available, then keep an extra settle window for async warnings.
  await page.waitForFunction(() => {
    const win = window;
    const startup = Array.isArray(win.__FSUS_STARTUP_METRICS__) ? win.__FSUS_STARTUP_METRICS__ : [];
    const hydration = Array.isArray(win.__FSUS_PUBLIC_HYDRATION_METRICS__) ? win.__FSUS_PUBLIC_HYDRATION_METRICS__ : [];

    const runtimeReady = startup.some((metric) =>
      metric && typeof metric.name === 'string' &&
      (metric.name === 'entry-to-runtime-ready' || metric.name === 'runtime-gate-wait')
    );

    const hydrationDone = hydration.length > 0;
    return runtimeReady || hydrationDone;
  }, undefined, {
    timeout: hydrationReadyTimeoutMs
  }).catch(() => {});

  await page.waitForTimeout(appSettleDelayMs);
}

async function addSessionCookies(context, session) {
  await context.addCookies(Array.from(session.cookieMap.entries()).map(([name, value]) => ({
    name,
    value,
    url: frontendBaseUrl
  })));
}

async function assertNoHorizontalOverflow(page, label, tolerance = 8) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth
  }));
  assert(
    metrics.scrollWidth <= metrics.innerWidth + tolerance,
    `${label} should not overflow horizontally: scrollWidth=${metrics.scrollWidth}, viewport=${metrics.innerWidth}`
  );
}

async function fetchFirstCategoryId(cookieHeader) {
  const categories = await authBinary('/api/Category', {
    method: 'GET',
    cookieHeader,
    deviceFingerprint: 'runtime-admin-category-list'
  });
  assert(categories.response.ok, `category list failed: ${categories.response.status}`);
  const items = categories.payload?.data ?? categories.payload;
  const first = Array.isArray(items) ? items.find((item) => Number.isFinite(Number(item?.id))) : null;
  assert(first?.id, 'runtime resilience requires at least one category fixture');
  return Number(first.id);
}

async function createExtremeArticle(session) {
  const content = buildMarkdownExtremeCorpus(Math.min(markdownExtremeSize, 200_000));
  const categoryId = await fetchFirstCategoryId(session.cookieHeader);
  const title = `Runtime Markdown Extreme ${Date.now()}`;
  const create = await authBinary('/api/Article', {
    method: 'POST',
    cookieHeader: session.cookieHeader,
    deviceFingerprint: 'runtime-admin-article-create',
    requiresPow: true,
    timeoutMs: Math.max(60_000, Number(process.env.FSUSBLOG_HTTP_TIMEOUT_MS || '15000') * 4),
    body: {
      title,
      content,
      summary: `runtime markdown extreme hash=${fnv1a32(content)}`,
      categoryId,
      tagIds: [],
      aotBundle: null
    }
  });
  assert(create.response.ok, `extreme article create failed: ${create.response.status}`);
  const data = create.payload?.data ?? create.payload;
  const id = Number(data?.id ?? data?.Id ?? data);
  assert(Number.isFinite(id) && id > 0, 'extreme article create missing id');
  return { id, title };
}

async function cleanupExtremeArticle(session, id) {
  await authBinary(`/api/Article/${id}`, {
    method: 'DELETE',
    cookieHeader: session.cookieHeader,
    deviceFingerprint: 'runtime-admin-article-delete',
    requiresPow: true,
    timeoutMs: 60_000
  }).catch(() => null);
  await authBinary(`/api/Article/permanent/${id}`, {
    method: 'DELETE',
    cookieHeader: session.cookieHeader,
    deviceFingerprint: 'runtime-admin-article-permanent-delete',
    requiresPow: true,
    timeoutMs: 60_000
  }).catch(() => null);
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const guest = await browser.newContext({ baseURL: frontendBaseUrl, extraHTTPHeaders: testSessionHeaders() });
    const guestPage = await guest.newPage();
    const auditGuest = attachAudit(guestPage);
    const extremeQuery = encodeURIComponent('markdown latex mermaid ' + '<script>'.repeat(40) + ' 边界 搜索')
    for (const path of ['/', '/search?q=blog', '/search?q=blog&sort=recent', `/search?q=${extremeQuery}`, '/about', '/archive']) {
      console.log(`[check-runtime-resilience] guest ${path}`);
      await guestPage.goto(path, { waitUntil: 'domcontentloaded' });
      await waitForApp(guestPage);
      await assertNoHorizontalOverflow(guestPage, `guest ${path}`);
    }
    auditGuest();
    await guest.close();

    const userSession = await loginWithPow(userName, userPassword, false, 'runtime-user');
    const userContext = await browser.newContext({ baseURL: frontendBaseUrl, extraHTTPHeaders: testSessionHeaders() });
    await addSessionCookies(userContext, userSession);
    const userPage = await userContext.newPage();
    const auditUser = attachAudit(userPage);
    for (const path of ['/user/profile', '/user/messagebox', '/user/comments', '/user/profile', '/']) {
      console.log(`[check-runtime-resilience] user ${path}`);
      await userPage.goto(path, { waitUntil: 'domcontentloaded' });
      await waitForApp(userPage);
      await userPage.waitForTimeout(800);
      await assertNoHorizontalOverflow(userPage, `user ${path}`);
    }
    auditUser();
    await userContext.close();

    const adminSession = await loginWithPow(adminName, adminPassword, false, 'runtime-admin');
    const adminContext = await browser.newContext({ baseURL: frontendBaseUrl, extraHTTPHeaders: testSessionHeaders() });
    await addSessionCookies(adminContext, adminSession);
    const adminPage = await adminContext.newPage();
    const auditAdmin = attachAudit(adminPage);
    let extremeArticle = null;
    try {
      extremeArticle = await createExtremeArticle(adminSession);
      for (const path of [
      '/user/manage',
      '/user/manage/users',
      '/user/manage/settings',
      '/user/manage/article/trash',
      '/user/manage/article/write',
      `/article/${extremeArticle.id}`,
      '/user/manage',
      '/search?q=blog'
      ]) {
      console.log(`[check-runtime-resilience] admin ${path}`);
      await adminPage.goto(path, { waitUntil: 'domcontentloaded' });
      await waitForApp(adminPage);
      await adminPage.waitForTimeout(900);
      await assertNoHorizontalOverflow(adminPage, `admin ${path}`);
      if (path.startsWith('/article/')) {
        assert((await adminPage.locator('main').innerText()).includes(extremeArticle.title), 'extreme article detail should render title');
      }
    }
    } finally {
      if (extremeArticle) {
        await cleanupExtremeArticle(adminSession, extremeArticle.id);
      }
    }
    auditAdmin();
    await adminContext.close();

    const mobileAdminContext = await browser.newContext({ baseURL: frontendBaseUrl, viewport: { width: 390, height: 844 }, extraHTTPHeaders: testSessionHeaders() });
    await addSessionCookies(mobileAdminContext, adminSession);
    const mobilePage = await mobileAdminContext.newPage();
    const auditMobile = attachAudit(mobilePage);
    for (const path of ['/user/profile', '/user/messagebox', '/user/manage/article/write', '/user/manage/users']) {
      console.log(`[check-runtime-resilience] mobile ${path}`);
      await mobilePage.goto(path, { waitUntil: 'domcontentloaded' });
      await waitForApp(mobilePage);
      await assertNoHorizontalOverflow(mobilePage, `mobile ${path}`);
    }
    auditMobile();
    await mobileAdminContext.close();

    console.log(`[check-runtime-resilience] ok | frontend=${frontendBaseUrl}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('[check-runtime-resilience] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
