#!/usr/bin/env node

import { createRequire } from 'node:module';
import { loginWithFixtureSessionBypass } from '../../support/auth-helpers.mjs';
import {
  remainingRuntimeTimeout,
  resolveRuntimeBrowserTimeoutPlan
} from '../../support/runtime-browser-timeout.mjs';
import { systemChromiumLaunchOptions } from '../../support/system-chromium.mjs';
import { testSessionHeaders } from '../../support/test-session.mjs';

const frontendBaseUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';
const userName = process.env.FSUSBLOG_USER_USERNAME || 'binaryuser';
const userPassword = process.env.FSUSBLOG_USER_PASSWORD ?? '';
const adminName = process.env.FSUSBLOG_ADMIN_USERNAME || 'binaryadmin';
const adminPassword = process.env.FSUSBLOG_ADMIN_PASSWORD ?? '';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('@playwright/test', { paths: [process.cwd()] }));
const timeoutPlan = resolveRuntimeBrowserTimeoutPlan();
const runtimeDeadlineAtMs = Date.now() + timeoutPlan.stepDeadlineMs;

function runtimeTimeout(preferredMs) {
  return remainingRuntimeTimeout(runtimeDeadlineAtMs, preferredMs);
}

async function gotoRuntime(page, path) {
  await page.goto(path, {
    waitUntil: 'domcontentloaded',
    timeout: runtimeTimeout(timeoutPlan.navigationTimeoutMs)
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForApp(page, deadlineAt) {
  const remaining = Math.max(1, deadlineAt - Date.now());
  await page.waitForFunction(() => document.readyState === 'complete' && Boolean(document.querySelector('#app')), undefined, {
    timeout: remaining
  });
  await page.waitForLoadState('networkidle', { timeout: Math.min(10_000, Math.max(1, deadlineAt - Date.now())) }).catch(() => {});
  await page.waitForTimeout(400);
}

async function addSessionCookies(context, session) {
  const backendHost = new URL(process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:7568').hostname;
  const cookieEntries = session.cookieMap instanceof Map
    ? Array.from(session.cookieMap.entries())
    : String(session.cookieHeader || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const eq = part.indexOf('=');
        return eq > 0 ? [part.slice(0, eq), part.slice(eq + 1)] : null;
      })
      .filter(Boolean);

  await context.addCookies(cookieEntries.map(([name, value]) => {
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

async function assertPageA11y(page, label) {
  const deadlineAt = Date.now() + runtimeTimeout(timeoutPlan.pageAuditTimeoutMs);
  let result;
  while (Date.now() < deadlineAt) {
    try {
      await waitForApp(page, deadlineAt);
      result = await page.evaluate(() => {
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };

    const missingFields = Array.from(document.querySelectorAll('input, textarea, select'))
      .filter((element) => {
        const type = element.getAttribute('type') || '';
        if (type === 'hidden' || element.disabled || !isVisible(element)) {
          return false;
        }
        return !element.getAttribute('id') && !element.getAttribute('name');
      })
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute('type') || '',
        placeholder: element.getAttribute('placeholder') || '',
        role: element.getAttribute('role') || ''
      }));

    const silentButtons = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter((element) => {
        if (!isVisible(element) || element.getAttribute('aria-hidden') === 'true') {
          return false;
        }
        const text = (element.textContent || '').trim();
        const aria = element.getAttribute('aria-label') || '';
        const title = element.getAttribute('title') || '';
        return !text && !aria && !title;
      })
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        classes: element.className
      }));

    return { missingFields, silentButtons };
      });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const navigationRace = /execution context was destroyed|cannot find context with specified id|most likely because of a navigation/iu.test(message);
      if (!navigationRace || Date.now() >= deadlineAt) {
        throw error;
      }
    }
  }

  assert(result, `${label} did not stabilize before the existing page audit deadline`);

  assert(result.missingFields.length === 0, `${label} has ${result.missingFields.length} form fields missing id/name`);
  assert(result.silentButtons.length === 0, `${label} has ${result.silentButtons.length} buttons missing accessible text`);
}

async function withAuditPage(browser, session, action) {
  const context = await browser.newContext({
    baseURL: frontendBaseUrl,
    extraHTTPHeaders: testSessionHeaders()
  });
  try {
    if (session) await addSessionCookies(context, session);
    const page = await context.newPage();
    return await action(page);
  } finally {
    await context.close().catch(() => {});
  }
}

async function auditRoute(page, path, label = path) {
  console.log(`[check-a11y-smoke] audit ${label}`);
  await gotoRuntime(page, path);
  await assertPageA11y(page, label);
}

async function main() {
  console.log(`[check-a11y-smoke] timeoutPlan=${JSON.stringify(timeoutPlan)}`);
  const browser = await chromium.launch(systemChromiumLaunchOptions({ headless: true }));
  try {
    const [userSession, adminSession] = await Promise.all([
      loginWithFixtureSessionBypass(userName, userPassword, false, 'a11y-user'),
      loginWithFixtureSessionBypass(adminName, adminPassword, false, 'a11y-admin')
    ]);
    // The three identities are isolated and every route is read-only. Keep one
    // page/context per identity so route waits overlap without repeatedly
    // launching contexts. Category remains last in the admin branch so its
    // dialog audit reuses the already-audited page instead of navigating twice.
    await Promise.all([
      withAuditPage(browser, null, async (page) => {
        await auditRoute(page, '/login', 'login');
      }),
      withAuditPage(browser, userSession, async (page) => {
        for (const path of ['/user/profile', '/user/messagebox']) {
          await auditRoute(page, path);
        }
      }),
      withAuditPage(browser, adminSession, async (adminPage) => {
        for (const path of [
          '/user/manage/article/write',
          '/user/manage/settings',
          '/user/manage/users',
          '/user/manage/category'
        ]) {
          await auditRoute(adminPage, path);
        }
        console.log('[check-a11y-smoke] audit /user/manage/category dialog');
      const createButton = adminPage.getByRole('button', { name: /新增|创建|新建/ }).first();
      if (await createButton.isVisible()) {
        await createButton.click();
        const dialog = adminPage.locator('.fsusblog-dialog:visible').first();
        await dialog.waitFor({ state: 'visible', timeout: 5000 });
        const dialogTitle = await dialog.locator('.el-dialog__title,[aria-level],h2,h3').first().textContent();
        assert(String(dialogTitle || '').trim().length > 0, 'category dialog should expose a title');
        const focusInsideDialog = await dialog.evaluate((element) => element.contains(document.activeElement));
        assert(focusInsideDialog, 'dialog should retain focus inside modal surface');
        await assertPageA11y(adminPage, 'category-dialog');
      }
      })
    ]);
    console.log(`[check-a11y-smoke] ok | frontend=${frontendBaseUrl}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('[check-a11y-smoke] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
