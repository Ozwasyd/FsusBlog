#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  authBinary,
  baseUrl,
  loginWithPow,
  requestTimeoutMs
} from '../../support/auth-helpers.mjs';
import { decodeAedsFrame } from '../../support/aeds-envelope.mjs';
import { fetchWithTimeout } from '../../support/http.mjs';
import { buildMarkdownExtremeCorpus } from '../../support/markdown-extreme-corpus.mjs';
import { testSessionHeaders } from '../../support/test-session.mjs';

const frontendBaseUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';
const userName = process.env.FSUSBLOG_USER_USERNAME || 'binaryuser';
const userPassword = process.env.FSUSBLOG_USER_PASSWORD || 'BinaryUserPass123!';
const adminName = process.env.FSUSBLOG_ADMIN_USERNAME || 'binaryadmin';
const adminPassword = process.env.FSUSBLOG_ADMIN_PASSWORD || 'BinaryAdminPass123!';
const repoRoot = resolve(process.cwd(), '..', '..');
const evidenceDir = process.env.FSUSBLOG_SECURITY_EVIDENCE_DIR || resolve(repoRoot, '.tmp/security');
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('@playwright/test', { paths: [process.cwd()] }));
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((candidate) => existsSync(candidate));

const DENIED_STATUSES = new Set([400, 401, 403, 404, 405, 409, 413, 415, 422, 428, 429]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function writeEvidence(status, error = null) {
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(resolve(evidenceDir, 'permission-matrix.json'), `${JSON.stringify({
    status,
    generatedAt: new Date().toISOString(),
    baseUrl,
    frontendBaseUrl,
    checks: [
      'static-authorization-boundaries',
      'guest-route-redirects',
      'role-user-boundaries',
      'admin-pow-boundaries',
      'admin-positive-crud',
      'binary-admin-route-policies',
      'upload-admin-policy'
    ],
    error: error ? String(error instanceof Error ? error.message : error) : null
  }, null, 2)}\n`);
}

function unwrap(payload) {
  return payload?.data ?? payload;
}

function toItemArray(payload) {
  const data = unwrap(payload);
  if (Array.isArray(data)) {
    return data;
  }
  if (Array.isArray(data?.items)) {
    return data.items;
  }
  if (Array.isArray(data?.data)) {
    return data.data;
  }
  return [];
}

async function fetchAdminAuthorCategories(adminSession, label = 'admin author category list') {
  const response = await fetchWithTimeout(`${baseUrl}/api/binary/author/taxonomy/categories`, {
    headers: {
      Accept: 'application/octet-stream',
      Cookie: adminSession.cookieHeader,
      'X-Fsus-Device-Fp': 'permission-admin-author-taxonomy',
      ...testSessionHeaders()
    }
  }, requestTimeoutMs);
  assertAllowed(label, response);
  const frame = decodeAedsFrame(await response.arrayBuffer());
  return toItemArray(JSON.parse(new TextDecoder().decode(frame.payload)));
}

function payloadContains(value, needle) {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === 'string') {
    return value.includes(needle);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).includes(needle);
  }

  if (Array.isArray(value)) {
    return value.some((item) => payloadContains(item, needle));
  }

  if (typeof value === 'object') {
    return Object.values(value).some((item) => payloadContains(item, needle));
  }

  return false;
}

function assertNoServerError(name, response) {
  assert(response.status < 500, `${name} must not return 5xx, got ${response.status}`);
}

function assertDenied(name, response, allowedStatuses = DENIED_STATUSES) {
  assertNoServerError(name, response);
  assert(!response.ok, `${name} must not return 2xx, got ${response.status}`);
  assert(allowedStatuses.has(response.status), `${name} returned unexpected denial status ${response.status}`);
}

function assertAllowed(name, response) {
  assertNoServerError(name, response);
  assert(response.ok, `${name} should be allowed, got ${response.status}`);
}

async function expectDenied(name, path, options) {
  const { response } = await authBinary(path, options);
  assertDenied(name, response);
  return response.status;
}

async function expectAllowed(name, path, options) {
  const result = await authBinary(path, options);
  assertAllowed(name, result.response);
  return result;
}

async function readServerFile(relativePath) {
  return await readFile(resolve(repoRoot, relativePath), 'utf8');
}

async function waitForPath(page, predicate, label, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const current = new URL(page.url());
    if (predicate(current)) {
      return current;
    }

    await page.waitForTimeout(100);
  }

  throw new Error(`${label} timed out at ${page.url()}`);
}

function assertIncludes(source, needle, label) {
  assert(source.includes(needle), `${label} missing required authorization boundary: ${needle}`);
}

function assertRouteChainIncludes(source, route, needle, label) {
  const routeIndex = source.indexOf(route);
  assert(routeIndex >= 0, `${label} missing route: ${route}`);

  const nextRoutePattern = /\n\s*group\.Map(?:Get|Post|Put|Delete|Patch)\(/g;
  nextRoutePattern.lastIndex = routeIndex + route.length;
  const nextRoute = nextRoutePattern.exec(source);
  const routeChain = source.slice(routeIndex, nextRoute?.index ?? source.length);

  assertIncludes(routeChain, needle, `${label} ${route}`);
}

function toPlaywrightSessionCookies(cookieMap) {
  const backendHost = new URL(baseUrl).hostname;
  return Array.from(cookieMap.entries()).map(([name, value]) => {
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
  });
}

async function assertStaticAuthorizationBoundaries() {
  const binaryRoot = await readServerFile('src/backend/Modules/Endpoints/Binary/BinaryEndpoints.cs');
  assert(!binaryRoot.includes('/aot-bundle'), 'Binary endpoints must not expose client AOT bundle upload routes');

  const articleEndpoints = await readServerFile('src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Articles.cs');
  const articleAdminWriteRoutes = [
    'MapPost("/admin/article"',
    'MapPut("/admin/article/{id:int}"',
    'MapDelete("/admin/article/{id:int}"',
    'MapDelete("/admin/article/permanent/{id:int}"',
    'MapDelete("/admin/article/trash"',
    'MapPut("/admin/article/restore/{id:int}"'
  ];
  for (const route of articleAdminWriteRoutes) {
    assertRouteChainIncludes(
      articleEndpoints,
      route,
      'RequireAuthorization(policy => policy.RequireRole("admin"))',
      'binary article write route'
    );
    assertRouteChainIncludes(
      articleEndpoints,
      route,
      'AddEndpointFilter<RequiresPowFilter>()',
      'binary article write route'
    );
  }
  assert(articleEndpoints.match(/RequireAuthorization\(policy => policy\.RequireRole\("admin"\)\)/g)?.length >= 6, 'binary article write routes must require admin');
  assert(articleEndpoints.match(/AddEndpointFilter<RequiresPowFilter>\(\)/g)?.length >= 6, 'binary article write routes must retain PoW filters');

  const taxonomyEndpoints = await readServerFile('src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Taxonomy.cs');
  assertIncludes(taxonomyEndpoints, 'RequireAuthorization(policy => policy.RequireRole("admin"))', 'binary taxonomy write routes require admin');
  assertIncludes(taxonomyEndpoints, 'AddEndpointFilter<RequiresPowFilter>()', 'binary taxonomy write routes retain PoW filters');

  const systemEndpoints = await readServerFile('src/backend/Modules/Endpoints/Binary/BinaryEndpoints.System.cs');
  assert(systemEndpoints.match(/RequireAuthorization\(policy => policy\.RequireRole\("admin"\)\)/g)?.length >= 4, 'binary system admin routes must require admin');
  assert(systemEndpoints.match(/AddEndpointFilter<RequiresPowFilter>\(\)/g)?.length >= 3, 'binary system write routes must retain PoW filters');

  const uploadEndpoints = await readServerFile('src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Uploads.cs');
  assertIncludes(uploadEndpoints, 'group.MapGroup("/upload")', 'binary upload route group');
  assertIncludes(uploadEndpoints, 'RequireAuthorization(policy => policy.RequireRole("admin"))', 'binary upload routes require admin');
  assertIncludes(uploadEndpoints, 'AddEndpointFilter<RequiresPowFilter>()', 'binary upload routes retain PoW filter');

  const fileEndpoints = await readServerFile('src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Files.cs');
  assertIncludes(fileEndpoints, 'RequireAuthorization(policy => policy.RequireRole("admin"))', 'binary file delete route requires admin');
  assertIncludes(fileEndpoints, 'AddEndpointFilter<RequiresPowFilter>()', 'binary file delete route retains PoW filter');

  const statsEndpoints = await readServerFile('src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Stats.cs');
  assertIncludes(statsEndpoints, 'RequireAuthorization(policy => policy.RequireRole("admin"))', 'binary stats routes require admin');

  const adminUserEndpoints = await readServerFile('src/backend/Modules/Endpoints/Binary/BinaryEndpoints.AdminUsers.cs');
  assertIncludes(adminUserEndpoints, 'RequireAuthorization(policy => policy.RequireRole("admin"))', 'binary admin user routes require admin');
  assertIncludes(adminUserEndpoints, 'AddEndpointFilter<RequiresPowFilter>()', 'binary admin user mutation routes retain PoW filters');

  const commentEndpoints = await readServerFile('src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs');
  assertIncludes(commentEndpoints, 'MapPost("/comment"', 'binary comment create route exists');
  assertIncludes(commentEndpoints, 'MapDelete("/comment/{id:long}"', 'binary comment delete route exists');
  assert(commentEndpoints.match(/RequireAuthorization\(\)/g)?.length >= 3, 'binary comment write/user routes require auth');
  assert(commentEndpoints.match(/AddEndpointFilter<RequiresPowFilter>\(\)/g)?.length >= 2, 'binary comment write routes retain PoW filters');

  const messageEndpoints = await readServerFile('src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Messages.cs');
  assertIncludes(messageEndpoints, 'MapGet("/messages/conversations"', 'binary user message endpoints');
  assertIncludes(messageEndpoints, 'MapGet("/admin/messages/conversations"', 'binary admin message endpoints');
  assertIncludes(messageEndpoints, 'RequireAuthorization(policy => policy.RequireRole("admin"))', 'binary admin message endpoints require admin');
  assert(messageEndpoints.match(/AddEndpointFilter<RequiresPowFilter>\(\)/g)?.length >= 4, 'binary message write endpoints must retain PoW filters');

  const authEndpoints = await readServerFile('src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs');
  assertIncludes(authEndpoints, 'MapPost("/auth/passkey/register/begin"', 'passkey register/begin route exists');
  assertIncludes(authEndpoints, 'MapPost("/auth/passkey/login/begin"', 'passkey login/begin route exists');
  assertIncludes(authEndpoints, 'MapPost("/auth/passkey/login/complete"', 'passkey login/complete route exists');
  assert(authEndpoints.match(/RequireAuthorization\(\)/g)?.length >= 10, 'binary auth protected routes require auth');
  assert(authEndpoints.match(/AddEndpointFilter<RequiresPowFilter>\(\)/g)?.length >= 3, 'binary auth sensitive mutation routes retain PoW filters');
}

async function assertGuestAndRoleRoutes() {
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const guest = await browser.newContext({ baseURL: frontendBaseUrl, extraHTTPHeaders: testSessionHeaders() });
    const guestPage = await guest.newPage();
    await guestPage.goto('/user/profile', { waitUntil: 'domcontentloaded' });
    await waitForPath(guestPage, (url) => url.pathname === '/login', 'guest login redirect');
    assert(guestPage.url().includes('/login'), 'guest visiting /user/profile should redirect to login');
    await guest.close();

    const userSession = await loginWithPow(userName, userPassword, false, 'permission-user');
    const userContext = await browser.newContext({ baseURL: frontendBaseUrl, extraHTTPHeaders: testSessionHeaders() });
    await userContext.addCookies(toPlaywrightSessionCookies(userSession.cookieMap));
    const userPage = await userContext.newPage();
    await userPage.goto('/user/manage', { waitUntil: 'domcontentloaded' });
    await waitForPath(userPage, (url) => url.pathname === '/user/profile', 'normal user admin redirect');
    assert(new URL(userPage.url()).pathname === '/user/profile', 'normal user should be redirected to /user/profile');
    await userContext.close();

    const adminSession = await loginWithPow(adminName, adminPassword, false, 'permission-admin');
    const adminContext = await browser.newContext({ baseURL: frontendBaseUrl, extraHTTPHeaders: testSessionHeaders() });
    await adminContext.addCookies(toPlaywrightSessionCookies(adminSession.cookieMap));
    const adminPage = await adminContext.newPage();
    await adminPage.goto('/user/manage', { waitUntil: 'domcontentloaded' });
    await adminPage.waitForTimeout(2500);
    assert(new URL(adminPage.url()).pathname.startsWith('/user/manage'), 'admin should be able to stay on admin route');
    await adminContext.close();
  } finally {
    await browser.close();
  }
}

async function fetchFirstArticleId(adminSession) {
  const { response, payload } = await authBinary('/api/Article?page=1&size=1', {
    method: 'GET',
    cookieHeader: adminSession.cookieHeader,
    deviceFingerprint: 'permission-article-probe'
  });
  assertAllowed('article list fixture probe', response);
  const items = toItemArray(payload);
  assert(items.length > 0, 'permission matrix requires at least one article fixture');
  return Number(items[0].id);
}

async function fetchFirstCategoryId(adminSession) {
  const categoryProbe = await expectAllowed('category fixture probe', '/api/Category', {
    method: 'GET',
    cookieHeader: adminSession.cookieHeader,
    deviceFingerprint: 'permission-admin-category-probe'
  });
  const categoryId = Number(toItemArray(categoryProbe.payload).find((item) => Number.isFinite(Number(item?.id)))?.id);
  assert(Number.isFinite(categoryId) && categoryId > 0, 'permission matrix requires at least one category');
  return categoryId;
}

async function assertMarkersAbsent(adminSession, marker) {
  const [articles, categories, tags, adminMessages] = await Promise.all([
    authBinary('/api/Article?page=1&size=100', {
      method: 'GET',
      cookieHeader: adminSession.cookieHeader,
      deviceFingerprint: 'permission-marker-articles'
    }),
    authBinary('/api/Category', {
      method: 'GET',
      cookieHeader: adminSession.cookieHeader,
      deviceFingerprint: 'permission-marker-categories'
    }),
    authBinary('/api/Tag', {
      method: 'GET',
      cookieHeader: adminSession.cookieHeader,
      deviceFingerprint: 'permission-marker-tags'
    }),
    authBinary('/api/binary/admin/messages/conversations?page=1&size=50', {
      method: 'GET',
      cookieHeader: adminSession.cookieHeader,
      deviceFingerprint: 'permission-marker-messages'
    })
  ]);

  for (const [name, result] of Object.entries({ articles, categories, tags, adminMessages })) {
    assertAllowed(`${name} marker probe`, result.response);
    assert(!payloadContains(result.payload, marker), `${name} contains forbidden role=user attack marker ${marker}`);
  }
}

function articleBody(title, content, categoryId) {
  return {
    title,
    content,
    summary: `summary ${title}`,
    categoryId,
    tagIds: [],
    aotBundle: null
  };
}

function uploadInitBody(marker) {
  return {
    fileName: `${marker}.png`,
    mimeType: 'image/png',
    targetFormat: 'webp',
    totalBytes: 12,
    chunkSize: 12,
    sha256: '0'.repeat(64)
  };
}

async function assertRoleUserForbiddenMatrix(userSession, adminSession, articleId, categoryId, marker) {
  const largeMarkdownPayload = buildMarkdownExtremeCorpus(120_000);
  const userHeaders = {
    cookieHeader: userSession.cookieHeader,
    timeoutMs: Math.max(60_000, requestTimeoutMs * 4)
  };

  const probes = [
    ['role=user article create attack probe', '/api/Article', {
      method: 'POST',
      requiresPow: true,
      body: articleBody(`${marker}-article-create`, largeMarkdownPayload, categoryId)
    }],
    ['role=user article update attack probe', `/api/Article/${articleId}`, {
      method: 'PUT',
      requiresPow: true,
      body: articleBody(`${marker}-article-update`, `updated by ${marker}`, categoryId)
    }],
    ['role=user article trash delete attack probe', `/api/Article/${articleId}`, {
      method: 'DELETE',
      requiresPow: true
    }],
    ['role=user article permanent delete attack probe', `/api/Article/permanent/${articleId}`, {
      method: 'DELETE',
      requiresPow: true
    }],
    ['role=user article clear trash attack probe', '/api/Article/trash', {
      method: 'DELETE',
      requiresPow: true
    }],
    ['role=user article restore attack probe', `/api/Article/restore/${articleId}`, {
      method: 'PUT',
      requiresPow: true
    }],
    ['role=user category create attack probe', '/api/Category', {
      method: 'POST',
      requiresPow: true,
      body: { name: `${marker}-category` }
    }],
    ['role=user category update attack probe', `/api/Category/${categoryId}`, {
      method: 'PUT',
      requiresPow: true,
      body: { name: `${marker}-category-update` }
    }],
    ['role=user category delete attack probe', `/api/Category/${categoryId}`, {
      method: 'DELETE',
      requiresPow: true
    }],
    ['role=user tag create attack probe', '/api/Tag', {
      method: 'POST',
      requiresPow: true,
      body: { name: `${marker}-tag` }
    }],
    ['role=user tag update attack probe', '/api/Tag/1', {
      method: 'PUT',
      requiresPow: true,
      body: { name: `${marker}-tag-update` }
    }],
    ['role=user tag delete attack probe', '/api/Tag/1', {
      method: 'DELETE',
      requiresPow: true
    }],
    ['role=user system seo update attack probe', '/api/System/seo', {
      method: 'PUT',
      requiresPow: true,
      body: {
        title: marker,
        description: marker,
        keywords: marker,
        author: marker,
        ogImage: '',
        baseUrl: 'https://example.invalid'
      }
    }],
    ['role=user system page update attack probe', '/api/System/page', {
      method: 'PUT',
      requiresPow: true,
      body: { slug: 'about', content: marker }
    }],
    ['role=user system page refresh attack probe', '/api/System/page/refresh/about', {
      method: 'POST',
      requiresPow: true
    }],
    ['role=user file upload init attack probe', '/api/File/upload/init', {
      method: 'POST',
      requiresPow: true,
      body: uploadInitBody(marker)
    }],
    ['role=user file upload status attack probe', `/api/File/upload/${marker}/status`, {
      method: 'GET',
      requiresPow: true
    }],
    ['role=user file upload part attack probe', `/api/File/upload/${marker}/part`, {
      method: 'PUT',
      requiresPow: true,
      body: { partNumber: 1, offset: 0, payloadHash: marker }
    }],
    ['role=user file upload complete attack probe', `/api/File/upload/${marker}/complete`, {
      method: 'POST',
      requiresPow: true,
      body: { sha256: '0'.repeat(64) }
    }],
    ['role=user file upload abort attack probe', `/api/File/upload/${marker}`, {
      method: 'DELETE',
      requiresPow: true
    }],
    ['role=user legacy image upload attack probe', '/api/File/upload', {
      method: 'POST',
      requiresPow: true,
      body: marker,
      headers: { 'Content-Type': 'text/plain' }
    }],
    ['role=user legacy image delete attack probe', `/api/File/delete?url=${encodeURIComponent(`/uploads/illustration/${marker}.png`)}`, {
      method: 'DELETE',
      requiresPow: true
    }],
    ['role=user binary stats attack probe', '/api/binary/stats', {
      method: 'GET'
    }],
    ['role=user binary upload init attack probe', '/api/binary/upload/init', {
      method: 'POST',
      requiresPow: true,
      body: uploadInitBody(marker)
    }],
    ['role=user binary upload status attack probe', `/api/binary/upload/${marker}/status`, {
      method: 'GET',
      requiresPow: true
    }],
    ['role=user binary upload parts attack probe', `/api/binary/upload/${marker}/status/parts`, {
      method: 'GET',
      requiresPow: true
    }],
    ['role=user binary upload part attack probe', `/api/binary/upload/${marker}/part`, {
      method: 'PUT',
      requiresPow: true,
      body: { partNumber: 1, offset: 0 }
    }],
    ['role=user binary upload complete attack probe', `/api/binary/upload/${marker}/complete`, {
      method: 'POST',
      requiresPow: true,
      body: { sha256: '0'.repeat(64) }
    }],
    ['role=user binary upload abort attack probe', `/api/binary/upload/${marker}`, {
      method: 'DELETE',
      requiresPow: true
    }],
    ['role=user admin user list attack probe', '/api/admin/users?page=1&size=10', {
      method: 'GET'
    }],
    ['role=user admin user status attack probe', '/api/admin/users/status', {
      method: 'PUT',
      requiresPow: true,
      body: { userId: 1, status: 1, reason: marker }
    }],
    ['role=user admin messages list attack probe', '/api/binary/admin/messages/conversations?page=1&size=10', {
      method: 'GET'
    }],
    ['role=user admin message detail attack probe', '/api/binary/admin/messages/conversations/1', {
      method: 'GET'
    }],
    ['role=user admin message reply attack probe', '/api/binary/admin/messages/conversations/1/reply', {
      method: 'POST',
      requiresPow: true,
      body: { body: marker }
    }],
    ['role=user admin message status attack probe', '/api/binary/admin/messages/conversations/1/status', {
      method: 'POST',
      requiresPow: true,
      body: { status: 'closed' }
    }],
    ['role=user admin system message attack probe', '/api/binary/admin/messages/system-send', {
      method: 'POST',
      requiresPow: true,
      body: { targetUserId: null, subject: marker, body: marker }
    }],
    ['role=user admin MFA reset attack probe', '/api/Auth/admin/users/1/mfa/reset', {
      method: 'POST'
    }],
    ['role=user deleted article list attack probe', '/api/Article?page=1&size=10&isDeleted=true', {
      method: 'GET'
    }]
  ];

  for (const [name, path, options] of probes) {
    await expectDenied(name, path, {
      ...options,
      cookieHeader: userHeaders.cookieHeader,
      deviceFingerprint: name.replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
      timeoutMs: options.timeoutMs ?? userHeaders.timeoutMs
    });
  }

  await assertMarkersAbsent(adminSession, marker);
}

async function assertGuestForbiddenMatrix(articleId) {
  await expectDenied('guest sessions attack probe', '/api/Auth/sessions', {
    method: 'GET',
    deviceFingerprint: 'permission-guest-sessions'
  }, new Set([401]));

  await expectDenied('guest comment create attack probe', '/api/Comment', {
    method: 'POST',
    deviceFingerprint: 'permission-guest-comment',
    requiresPow: true,
    body: {
      articleId,
      content: 'guest should not comment',
      parentId: null,
      rootId: null,
      replyToCommentId: null
    }
  }, new Set([401]));

  await expectDenied('guest message create attack probe', '/api/binary/messages/conversations', {
    method: 'POST',
    deviceFingerprint: 'permission-guest-message',
    requiresPow: true,
    body: { subject: 'guest attack', body: 'guest should not create messages' }
  });

  await expectDenied('guest passkey credentials list attack probe', '/api/Auth/passkey/credentials', {
    method: 'GET',
    deviceFingerprint: 'permission-guest-passkey-creds'
  }, new Set([401]));

  await expectDenied('guest passkey register begin attack probe', '/api/Auth/passkey/register/begin', {
    method: 'POST',
    deviceFingerprint: 'permission-guest-passkey-reg-begin'
  }, new Set([401]));
}

async function findOwnCommentId(userSession, marker) {
  const comments = await expectAllowed('role=user own comments list', '/api/Comment/me?limit=50', {
    method: 'GET',
    cookieHeader: userSession.cookieHeader,
    deviceFingerprint: 'permission-user-comment-list'
  });
  const items = toItemArray(comments.payload);
  const comment = items.find((item) => String(item?.content ?? '').includes(marker)) ?? items[0];
  assert(comment?.id, 'role=user own comment list did not expose any deletable comment');
  return Number(comment.id);
}

async function assertRoleUserAllowedBoundaries(userSession, articleId, marker) {
  await expectAllowed('role=user current identity', '/api/Auth/me', {
    method: 'GET',
    cookieHeader: userSession.cookieHeader,
    deviceFingerprint: 'permission-user-me'
  });

  await expectAllowed('role=user sessions list', '/api/Auth/sessions', {
    method: 'GET',
    cookieHeader: userSession.cookieHeader,
    deviceFingerprint: 'permission-user-sessions'
  });

  const revokeMissing = await authBinary('/api/Auth/sessions/permission-missing-session/revoke', {
    method: 'POST',
    cookieHeader: userSession.cookieHeader,
    deviceFingerprint: 'permission-user-revoke-missing'
  });
  assertNoServerError('role=user revoke missing session boundary', revokeMissing.response);
  assert([200, 404].includes(revokeMissing.response.status), `role=user revoke missing session should be 200/404, got ${revokeMissing.response.status}`);

  const mfaProfile = await authBinary('/api/Auth/mfa/profile', {
    method: 'GET',
    cookieHeader: userSession.cookieHeader,
    deviceFingerprint: 'permission-user-mfa-profile'
  });
  assertNoServerError('role=user MFA profile', mfaProfile.response);
  assert([200, 404].includes(mfaProfile.response.status), `role=user MFA profile should be 200/404, got ${mfaProfile.response.status}`);

  const invalidPasswordUpdate = await authBinary('/api/Auth/update-password', {
    method: 'PUT',
    cookieHeader: userSession.cookieHeader,
    deviceFingerprint: 'permission-user-invalid-password-update',
    requiresPow: true,
    body: { oldPassword: 'wrong-password', newPassword: 'short', confirmPassword: 'different' }
  });
  assertNoServerError('role=user invalid password update boundary', invalidPasswordUpdate.response);
  assert(!invalidPasswordUpdate.response.ok, 'invalid role=user password update must not succeed');

  const commentMarker = `${marker}-own-comment`;
  await expectAllowed('role=user own comment create', '/api/Comment', {
    method: 'POST',
    cookieHeader: userSession.cookieHeader,
    deviceFingerprint: 'permission-user-own-comment-create',
    requiresPow: true,
    body: {
      articleId,
      content: commentMarker,
      parentId: null,
      rootId: null,
      replyToCommentId: null
    }
  });

  const ownCommentId = await findOwnCommentId(userSession, commentMarker);

  const deleteForeignOrMissingComment = await authBinary('/api/Comment/9223372036854775807', {
    method: 'DELETE',
    cookieHeader: userSession.cookieHeader,
    deviceFingerprint: 'permission-user-comment-delete-missing',
    requiresPow: true
  });
  assertDenied('role=user cannot delete missing/foreign comment', deleteForeignOrMissingComment.response);

  const ownCommentDelete = await authBinary(`/api/Comment/${ownCommentId}`, {
    method: 'DELETE',
    cookieHeader: userSession.cookieHeader,
    deviceFingerprint: 'permission-user-own-comment-delete',
    requiresPow: true
  });
  assertNoServerError('role=user own comment delete boundary', ownCommentDelete.response);
  assert(
    [200, 403, 404].includes(ownCommentDelete.response.status),
    `role=user own comment delete boundary should be 200/403/404, got ${ownCommentDelete.response.status}`
  );

  const longComment = await authBinary('/api/Comment', {
    method: 'POST',
    cookieHeader: userSession.cookieHeader,
    deviceFingerprint: 'permission-user-long-comment',
    requiresPow: true,
    body: {
      articleId,
      content: `${marker}<script>alert(1)</script>${'x'.repeat(1500)}`,
      parentId: null,
      rootId: null,
      replyToCommentId: null
    }
  });
  assertNoServerError('role=user long comment boundary', longComment.response);

  const messageSubject = `${marker}-ticket`;
  const createConversation = await expectAllowed('role=user own message conversation create', '/api/binary/messages/conversations', {
    method: 'POST',
    cookieHeader: userSession.cookieHeader,
    deviceFingerprint: 'permission-user-message-create',
    requiresPow: true,
    body: { subject: messageSubject, body: `${marker} user-owned support ticket` }
  });
  let conversationId = String(unwrap(createConversation.payload)?.conversationId ?? unwrap(createConversation.payload)?.id ?? '');
  if (!/^\d+$/.test(conversationId)) {
    const conversations = await expectAllowed('role=user own message conversations list', '/api/binary/messages/conversations?page=1&size=20', {
      method: 'GET',
      cookieHeader: userSession.cookieHeader,
      deviceFingerprint: 'permission-user-message-list'
    });
    const conversation = toItemArray(conversations.payload).find((item) => payloadContains(item, messageSubject));
    conversationId = String(conversation?.conversationId ?? conversation?.id ?? '');
  }
  assert(/^\d+$/.test(conversationId), 'created role=user conversation id was not discoverable');

  await expectAllowed('role=user own message conversation detail', `/api/binary/messages/conversations/${conversationId}`, {
    method: 'GET',
    cookieHeader: userSession.cookieHeader,
    deviceFingerprint: 'permission-user-message-detail'
  });

  await expectAllowed('role=user own message reply', `/api/binary/messages/conversations/${conversationId}/reply`, {
    method: 'POST',
    cookieHeader: userSession.cookieHeader,
    deviceFingerprint: 'permission-user-message-reply',
    requiresPow: true,
    body: { body: `${marker} reply` }
  });

  await expectAllowed('role=user own message mark read', `/api/binary/messages/conversations/${conversationId}/read`, {
    method: 'POST',
    cookieHeader: userSession.cookieHeader,
    deviceFingerprint: 'permission-user-message-read'
  });

  const missingConversationReply = await authBinary('/api/binary/messages/conversations/9223372036854775807/reply', {
    method: 'POST',
    cookieHeader: userSession.cookieHeader,
    deviceFingerprint: 'permission-user-message-reply-missing',
    requiresPow: true,
    body: { body: marker }
  });
  assertDenied('role=user cannot reply missing/foreign conversation', missingConversationReply.response);

  const longConversation = await authBinary('/api/binary/messages/conversations', {
    method: 'POST',
    cookieHeader: userSession.cookieHeader,
    deviceFingerprint: 'permission-user-long-message',
    requiresPow: true,
    body: {
      subject: `${marker}-${'s'.repeat(400)}`,
      body: `<script>${marker}</script>${'x'.repeat(20_000)}`
    }
  });
  assertNoServerError('role=user long message boundary', longConversation.response);

  const passkeyCredsList = await authBinary('/api/Auth/passkey/credentials', {
    method: 'GET',
    cookieHeader: userSession.cookieHeader,
    deviceFingerprint: 'permission-user-passkey-creds'
  });
  assertNoServerError('role=user passkey credentials list', passkeyCredsList.response);
  assertAllowed('role=user passkey credentials list', passkeyCredsList.response);

  const passkeyRegBegin = await authBinary('/api/Auth/passkey/register/begin', {
    method: 'POST',
    cookieHeader: userSession.cookieHeader,
    deviceFingerprint: 'permission-user-passkey-reg-begin'
  });
  assertNoServerError('role=user passkey register/begin', passkeyRegBegin.response);
  assertAllowed('role=user passkey register/begin', passkeyRegBegin.response);
}

async function assertAdminPowBoundaries(adminSession, categoryId, largeMarkdownPayload) {
  const missingPowCategory = await authBinary('/api/Category', {
    method: 'POST',
    cookieHeader: adminSession.cookieHeader,
    deviceFingerprint: 'permission-admin-no-pow',
    body: { name: `perm-admin-missing-pow-${Date.now()}` }
  });
  assertDenied('admin category create without pow', missingPowCategory.response);

  const adminLargeArticleNoPow = await authBinary('/api/Article', {
    method: 'POST',
    cookieHeader: adminSession.cookieHeader,
    deviceFingerprint: 'permission-admin-large-article-no-pow',
    timeoutMs: Math.max(60_000, requestTimeoutMs * 4),
    body: articleBody(`permission-admin-large-no-pow-${Date.now()}`, largeMarkdownPayload, categoryId)
  });
  assertDenied('admin large article create without pow', adminLargeArticleNoPow.response);
}

async function assertAdminPositivePowCrud(adminSession) {
  const createdCategoryName = `perm-admin-${Date.now()}`;
  const createCategory = await expectAllowed('admin category create with pow', '/api/Category', {
    method: 'POST',
    cookieHeader: adminSession.cookieHeader,
    deviceFingerprint: 'permission-admin-category',
    requiresPow: true,
    body: { name: createdCategoryName }
  });

  const createdTagName = `perm-admin-tag-${Date.now()}`;
  const createTag = await expectAllowed('admin tag create with pow', '/api/Tag', {
    method: 'POST',
    cookieHeader: adminSession.cookieHeader,
    deviceFingerprint: 'permission-admin-tag',
    requiresPow: true,
    body: { name: createdTagName }
  });
  const createdTagId = Number(unwrap(createTag.payload)?.id ?? unwrap(createTag.payload));

  const categories = await fetchAdminAuthorCategories(adminSession, 'category list after admin create');
  const createdCategory = categories.find((item) => item.name === createdCategoryName);
  assert(createdCategory?.id, 'created category not visible after creation');

  try {
    const updateCategoryNoPow = await authBinary(`/api/Category/${createdCategory.id}`, {
      method: 'PUT',
      cookieHeader: adminSession.cookieHeader,
      deviceFingerprint: 'permission-admin-category-no-pow',
      body: { name: `${createdCategoryName}-updated` }
    });
    assertDenied('admin category update without pow', updateCategoryNoPow.response);

    const deleteCategoryNoPow = await authBinary(`/api/Category/${createdCategory.id}`, {
      method: 'DELETE',
      cookieHeader: adminSession.cookieHeader,
      deviceFingerprint: 'permission-admin-category-delete-no-pow'
    });
    assertDenied('admin category delete without pow', deleteCategoryNoPow.response);

    await expectAllowed('admin category update with pow', `/api/Category/${createdCategory.id}`, {
      method: 'PUT',
      cookieHeader: adminSession.cookieHeader,
      deviceFingerprint: 'permission-admin-category-update',
      requiresPow: true,
      body: { name: `${createdCategoryName}-updated` }
    });

    const updateTagNoPow = await authBinary(`/api/Tag/${createdTagId}`, {
      method: 'PUT',
      cookieHeader: adminSession.cookieHeader,
      deviceFingerprint: 'permission-admin-tag-no-pow',
      body: { name: `${createdTagName}-updated` }
    });
    assertDenied('admin tag update without pow', updateTagNoPow.response);

    const deleteTagNoPow = await authBinary(`/api/Tag/${createdTagId}`, {
      method: 'DELETE',
      cookieHeader: adminSession.cookieHeader,
      deviceFingerprint: 'permission-admin-tag-delete-no-pow'
    });
    assertDenied('admin tag delete without pow', deleteTagNoPow.response);

    await expectAllowed('admin tag update with pow', `/api/Tag/${createdTagId}`, {
      method: 'PUT',
      cookieHeader: adminSession.cookieHeader,
      deviceFingerprint: 'permission-admin-tag-update',
      requiresPow: true,
      body: { name: `${createdTagName}-updated` }
    });
  } finally {
    const cleanupCategory = await authBinary(`/api/Category/${createdCategory.id}`, {
      method: 'DELETE',
      cookieHeader: adminSession.cookieHeader,
      deviceFingerprint: 'permission-admin-category-delete',
      requiresPow: true
    });
    assertAllowed('admin category cleanup', cleanupCategory.response);

    const cleanupTag = await authBinary(`/api/Tag/${createdTagId}`, {
      method: 'DELETE',
      cookieHeader: adminSession.cookieHeader,
      deviceFingerprint: 'permission-admin-tag-delete',
      requiresPow: true
    });
    assertAllowed('admin tag cleanup', cleanupTag.response);
  }
}

async function assertApiMatrix() {
  const userSession = await loginWithPow(userName, userPassword, false, 'permission-api-user');
  const adminSession = await loginWithPow(adminName, adminPassword, false, 'permission-api-admin');
  const articleId = await fetchFirstArticleId(adminSession);
  const categoryId = await fetchFirstCategoryId(adminSession);
  const marker = `perm-user-attack-${Date.now()}`;
  const largeMarkdownPayload = buildMarkdownExtremeCorpus(120_000);

  await assertGuestForbiddenMatrix(articleId);
  await assertRoleUserForbiddenMatrix(userSession, adminSession, articleId, categoryId, marker);
  await assertRoleUserAllowedBoundaries(userSession, articleId, marker);
  await assertAdminPowBoundaries(adminSession, categoryId, largeMarkdownPayload);
  await assertAdminPositivePowCrud(adminSession);
}

async function main() {
  await assertStaticAuthorizationBoundaries();
  await assertGuestAndRoleRoutes();
  await assertApiMatrix();
  await writeEvidence('ok');
  console.log(`[check-permission-matrix] ok | base=${baseUrl} frontend=${frontendBaseUrl}`);
}

main().catch((error) => {
  writeEvidence('failed', error).catch((writeError) => {
    console.error('[check-permission-matrix] evidence write failed:', writeError instanceof Error ? writeError.message : String(writeError));
  }).finally(() => {
    console.error('[check-permission-matrix] fatal:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
});
