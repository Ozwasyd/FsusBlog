#!/usr/bin/env node

import { createRequire } from 'node:module';
import { loginWithPow } from '../../support/auth-helpers.mjs';
import { testSessionHeaders } from '../../support/test-session.mjs';

const frontendBaseUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';
const userName = process.env.FSUSBLOG_USER_USERNAME || 'binaryuser';
const userPassword = process.env.FSUSBLOG_USER_PASSWORD || 'BinaryUserPass123!';
const adminName = process.env.FSUSBLOG_ADMIN_USERNAME || 'binaryadmin';
const adminPassword = process.env.FSUSBLOG_ADMIN_PASSWORD || 'BinaryAdminPass123!';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('@playwright/test', { paths: [process.cwd()] }));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForApp(page) {
  await page.waitForFunction(() => document.readyState === 'complete' && Boolean(document.querySelector('#app')), undefined, {
    timeout: 20000
  });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(400);
}

async function addSessionCookies(context, session) {
  const backendHost = new URL(process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:5000').hostname;
  await context.addCookies(Array.from(session.cookieMap.entries()).map(([name, value]) => {
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
  const result = await page.evaluate(() => {
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

  assert(result.missingFields.length === 0, `${label} has ${result.missingFields.length} form fields missing id/name`);
  assert(result.silentButtons.length === 0, `${label} has ${result.silentButtons.length} buttons missing accessible text`);
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const guestContext = await browser.newContext({ baseURL: frontendBaseUrl, extraHTTPHeaders: testSessionHeaders() });
    const guestPage = await guestContext.newPage();
    console.log('[check-a11y-smoke] audit login');
    await guestPage.goto('/login', { waitUntil: 'domcontentloaded' });
    await waitForApp(guestPage);
    await assertPageA11y(guestPage, 'login');
    await guestContext.close();

    const userSession = await loginWithPow(userName, userPassword, false, 'a11y-user');
    const adminSession = await loginWithPow(adminName, adminPassword, false, 'a11y-admin');
    const userContext = await browser.newContext({ baseURL: frontendBaseUrl, extraHTTPHeaders: testSessionHeaders() });
    await addSessionCookies(userContext, userSession);
    const userPage = await userContext.newPage();
    for (const path of ['/user/profile', '/user/messagebox']) {
      console.log(`[check-a11y-smoke] audit ${path}`);
      await userPage.goto(path, { waitUntil: 'domcontentloaded' });
      await waitForApp(userPage);
      await assertPageA11y(userPage, path);
    }
    await userContext.close();

    const adminContext = await browser.newContext({ baseURL: frontendBaseUrl, extraHTTPHeaders: testSessionHeaders() });
    await addSessionCookies(adminContext, adminSession);
    const adminPage = await adminContext.newPage();
    for (const path of ['/user/manage/article/write', '/user/manage/settings', '/user/manage/category', '/user/manage/users']) {
      console.log(`[check-a11y-smoke] audit ${path}`);
      await adminPage.goto(path, { waitUntil: 'domcontentloaded' });
      await waitForApp(adminPage);
      await assertPageA11y(adminPage, path);
    }

    console.log('[check-a11y-smoke] audit /user/manage/category dialog');
    await adminPage.goto('/user/manage/category', { waitUntil: 'domcontentloaded' });
    await waitForApp(adminPage);
    const createButton = adminPage.getByRole('button', { name: /新增|创建|新建/ }).first();
    if (await createButton.isVisible().catch(() => false)) {
      await createButton.click();
      const dialog = adminPage.locator('.el-dialog, [role="dialog"]').first();
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      const dialogTitle = await dialog.locator('.el-dialog__title,[aria-level],h2,h3').first().textContent().catch(() => '');
      assert(String(dialogTitle || '').trim().length > 0, 'category dialog should expose a title');
      const focusInsideDialog = await dialog.evaluate((element) => element.contains(document.activeElement));
      assert(focusInsideDialog, 'dialog should retain focus inside modal surface');
      await assertPageA11y(adminPage, 'category-dialog');
    }

    await adminContext.close();
    console.log(`[check-a11y-smoke] ok | frontend=${frontendBaseUrl}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('[check-a11y-smoke] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
