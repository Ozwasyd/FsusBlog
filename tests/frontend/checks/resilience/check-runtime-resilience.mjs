#!/usr/bin/env node

import { createRequire } from 'node:module';
import { authBinary, baseUrl, loginWithFixtureSessionBypass } from '../../support/auth-helpers.mjs';
import { buildMarkdownExtremeCorpus, fnv1a32, normalizeMarkdownExtremeSize } from '../../support/markdown-extreme-corpus.mjs';
import { createAdminStepUpProofToken } from '../../support/session-fixtures.mjs';
import { readPublicFixtures } from '../../support/public-fixtures.mjs';
import { systemChromiumLaunchOptions } from '../../support/system-chromium.mjs';
import { testSessionHeaders } from '../../support/test-session.mjs';
import {
  waitForApplicationReady,
  waitForNotificationSuppressed,
  waitForObservableReadiness,
  waitForVisualFrameReady
} from '../../support/playwright/readiness.mjs';

const frontendBaseUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';
const trustedOrigin = process.env.PLAYWRIGHT_BASE_URL || process.env.FSUSBLOG_DEBUG_FRONTEND_URL || process.env.FSUSBLOG_PUBLIC_BASE_URL || baseUrl;
const userName = process.env.FSUSBLOG_USER_USERNAME || 'binaryuser';
const userPassword = process.env.FSUSBLOG_USER_PASSWORD ?? '';
const adminName = process.env.FSUSBLOG_ADMIN_USERNAME || 'binaryadmin';
const adminPassword = process.env.FSUSBLOG_ADMIN_PASSWORD ?? '';
const markdownExtremeSize = normalizeMarkdownExtremeSize(process.env.FSUSBLOG_MARKDOWN_EXTREME_SIZE);
const hydrationReadyTimeoutMs = Number.parseInt(process.env.FSUSBLOG_HYDRATION_READY_TIMEOUT_MS || '12000', 10);
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('@playwright/test', { paths: [process.cwd()] }));

function selectValues(values, rawSelection, label) {
  const requested = new Set(String(rawSelection ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean));
  if (requested.size === 0) return values;
  const selected = values.filter((value) => requested.has(value));
  const selectedValues = new Set(selected);
  const unknown = [...requested].filter((value) => !selectedValues.has(value));
  if (unknown.length > 0) throw new Error(`unknown ${label}: ${unknown.join(', ')}`);
  return selected;
}

const resilienceScopes = new Set(selectValues(
  ['guest', 'user', 'admin', 'mobile'],
  process.env.FSUSBLOG_RESILIENCE_SCOPES,
  'runtime resilience scope'
));

function selectedRoutes(scope, routes) {
  const envName = `FSUSBLOG_RESILIENCE_${scope.toUpperCase()}_ROUTES`;
  return selectValues(routes, process.env[envName], `${scope} resilience route`);
}

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

async function addRuntimeIsolation(context) {
  await context.addInitScript(() => {
    window.__FSUSBLOG_DISABLE_NOTIFICATION_STREAM__ = true;
    const markNotificationStreamSuppressed = () => {
      const root = document.documentElement;
      if (!root) {
        return false;
      }

      root.dataset.fsusDisableNotificationStream = 'true';
      return true;
    };

    if (!markNotificationStreamSuppressed()) {
      setTimeout(markNotificationStreamSuppressed, 0);
    }
  });
}

async function newRuntimeContext(browser, options = {}) {
  const context = await browser.newContext({
    baseURL: frontendBaseUrl,
    extraHTTPHeaders: testSessionHeaders(),
    ...options
  });
  await addRuntimeIsolation(context);
  return context;
}

async function waitForApp(page) {
  await waitForApplicationReady(page, { timeoutMs: Math.max(45_000, hydrationReadyTimeoutMs) });
  await waitForNotificationSuppressed(page);
}

async function addSessionCookies(context, session) {
  const backendHost = new URL(baseUrl).hostname;
  await context.addCookies(toCookieEntries(session.cookieMap ?? session.cookieHeader).map(([name, value]) => {
    if (name.startsWith('__Host-')) {
      return {
        name,
        value,
        url: `https://${backendHost}/`,
        secure: true,
        httpOnly: true,
        sameSite: 'Lax'
      };
    }

    return {
      name,
      value,
      url: frontendBaseUrl
    };
  }));
}

function toCookieEntries(cookieMapOrHeader) {
  if (cookieMapOrHeader instanceof Map) {
    return Array.from(cookieMapOrHeader.entries());
  }

  return String(cookieMapOrHeader || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=');
      return eq > 0 ? [part.slice(0, eq), part.slice(eq + 1)] : null;
    })
    .filter(Boolean);
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPublicArticleReadable(id, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'unreachable';
  const publicDetailUrl = `${baseUrl}/api/binary/article/${id}.aeds`;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(publicDetailUrl, {
        headers: {
          Accept: 'application/octet-stream',
          ...testSessionHeaders()
        }
      });
      lastStatus = String(response.status);
      if (response.ok) {
        return;
      }
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }

    await delay(500);
  }

  throw new Error(`public article detail ${id} did not become readable; last=${lastStatus}`);
}

function loadFixtureArticle() {
  const fixtures = readPublicFixtures();
  const id = Number(fixtures.articleId);
  const title = String(fixtures.articleTitle ?? '').trim();
  assert(Number.isFinite(id) && id > 0, 'playwright fixture articleId missing');
  assert(title.length > 0, 'playwright fixture articleTitle missing');
  return { id, title };
}

async function waitForMainText(page, expectedText, label, timeoutMs = 20_000) {
  await waitForObservableReadiness(page, {
    description: `${label} main content includes ${JSON.stringify(expectedText)}`,
    timeoutMs,
    argument: expectedText,
    predicate: (text) => document.querySelector('main')?.textContent?.includes(text) === true
  });
}

async function waitForArticleTitle(page, title) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await waitForMainText(page, title, 'public fixture article detail', attempt === 0 ? 12_000 : 20_000);
      return;
    } catch (error) {
      if (attempt > 0) {
        throw error;
      }
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForApp(page);
    }
  }
}

async function visitAuditedRoute(context, path, label, options = {}) {
  const page = await context.newPage();
  const audit = attachAudit(page);
  try {
    console.log(`[check-runtime-resilience] ${label} ${path}`);
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    if (options.waitForVisualFrame) await waitForVisualFrameReady(page);

    await assertNoHorizontalOverflow(page, `${label} ${path}`);
    if (options.after) {
      await options.after(page);
    }

    audit();
  } finally {
    await page.close().catch(() => {});
  }
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
    headers: { Origin: trustedOrigin },
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
  const trashProofToken = createAdminStepUpProofToken({
    adminId: session.adminId,
    sessionId: session.sessionId
  });
  await authBinary(`/api/Article/${id}`, {
    method: 'DELETE',
    cookieHeader: session.cookieHeader,
    deviceFingerprint: 'runtime-admin-article-delete',
    requiresPow: true,
    headers: { Origin: trustedOrigin, 'X-Fsus-Mfa-Proof': trashProofToken },
    timeoutMs: 60_000
  }).catch(() => null);
  const permanentProofToken = createAdminStepUpProofToken({
    adminId: session.adminId,
    sessionId: session.sessionId
  });
  await authBinary(`/api/Article/permanent/${id}`, {
    method: 'DELETE',
    cookieHeader: session.cookieHeader,
    deviceFingerprint: 'runtime-admin-article-permanent-delete',
    requiresPow: true,
    headers: { Origin: trustedOrigin, 'X-Fsus-Mfa-Proof': permanentProofToken },
    timeoutMs: 60_000
  }).catch(() => null);
}

async function main() {
  const browser = await chromium.launch(systemChromiumLaunchOptions({
    headless: true,
    // This lane validates DOM/runtime resilience rather than GPU composition.
    // Keep it off host SwiftShader paths that can terminate a long-running
    // Chromium process independently of the route under test.
    args: ['--disable-gpu']
  }));
  try {
    if (resilienceScopes.has('guest')) {
      const guest = await newRuntimeContext(browser);
      const extremeQuery = encodeURIComponent('markdown latex mermaid ' + '<script>'.repeat(40) + ' 边界 搜索')
      for (const path of selectedRoutes('guest', ['/', '/search?q=blog', '/search?q=blog&sort=recent', `/search?q=${extremeQuery}`, '/about', '/archive'])) {
        await visitAuditedRoute(guest, path, 'guest');
      }
      await guest.close();
    }

    const userSession = await loginWithFixtureSessionBypass(userName, userPassword, false, 'runtime-user');
    const adminSession = await loginWithFixtureSessionBypass(adminName, adminPassword, false, 'runtime-admin');
    if (resilienceScopes.has('user')) {
      const userContext = await newRuntimeContext(browser);
      await addSessionCookies(userContext, userSession);
      for (const path of selectedRoutes('user', ['/user/profile', '/user/messagebox', '/user/comments', '/user/profile', '/'])) {
        await visitAuditedRoute(userContext, path, 'user', { waitForVisualFrame: true });
      }
      await userContext.close();
    }

    if (resilienceScopes.has('admin')) {
      const adminContext = await newRuntimeContext(browser);
      await addSessionCookies(adminContext, adminSession);
      let extremeArticle = null;
      try {
        const publicArticle = loadFixtureArticle();
        await waitForPublicArticleReadable(publicArticle.id);
        extremeArticle = await createExtremeArticle(adminSession);
        for (const path of selectedRoutes('admin', [
          '/user/manage',
          '/user/manage/users',
          '/user/manage/settings',
          '/user/manage/article/trash',
          '/user/manage/article/write',
          `/user/manage/article/edit/${extremeArticle.id}`,
          `/article/${publicArticle.id}`,
          '/user/manage',
          '/search?q=blog'
        ])) {
          await visitAuditedRoute(adminContext, path, 'admin', {
            waitForVisualFrame: true,
            after: path.startsWith('/article/')
              ? (page) => waitForArticleTitle(page, publicArticle.title)
              : null
          });
        }
      } finally {
        if (extremeArticle) {
          await cleanupExtremeArticle(adminSession, extremeArticle.id);
        }
      }
      await adminContext.close();
    }

    if (resilienceScopes.has('mobile')) {
      const mobileAdminContext = await newRuntimeContext(browser, { viewport: { width: 390, height: 844 } });
      await addSessionCookies(mobileAdminContext, adminSession);
      for (const path of selectedRoutes('mobile', ['/user/profile', '/user/messagebox', '/user/manage/article/write', '/user/manage/users'])) {
        await visitAuditedRoute(mobileAdminContext, path, 'mobile');
      }
      await mobileAdminContext.close();
    }

    console.log(`[check-runtime-resilience] ok | frontend=${frontendBaseUrl}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('[check-runtime-resilience] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
