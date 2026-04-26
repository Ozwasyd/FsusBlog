#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import {
  authJson,
  baseUrl,
  fetchJsonLike,
  loginWithPow,
  requestTimeoutMs
} from '../../support/auth-helpers.mjs';
import { buildMarkdownExtremeCorpus } from '../../support/markdown-extreme-corpus.mjs';

const frontendBaseUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';
const userName = process.env.FSUSBLOG_USER_USERNAME || 'binaryuser';
const userPassword = process.env.FSUSBLOG_USER_PASSWORD || 'BinaryUserPass123!';
const adminName = process.env.FSUSBLOG_ADMIN_USERNAME || 'binaryadmin';
const adminPassword = process.env.FSUSBLOG_ADMIN_PASSWORD || 'BinaryAdminPass123!';
const repoRoot = resolve(process.cwd(), '..');

const DENIED_STATUSES = new Set([400, 401, 403, 404, 405, 409, 413, 415, 422, 428, 429]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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
  const { response } = await authJson(path, options);
  assertDenied(name, response);
  return response.status;
}

async function expectAllowed(name, path, options) {
  const result = await authJson(path, options);
  assertAllowed(name, result.response);
  return result;
}

async function readServerFile(relativePath) {
  return await readFile(resolve(repoRoot, relativePath), 'utf8');
}

function assertIncludes(source, needle, label) {
  assert(source.includes(needle), `${label} missing required authorization boundary: ${needle}`);
}

async function assertStaticAuthorizationBoundaries() {
  const controllerAdminFiles = [
    'FsusBlog.Server/Modules/Controllers/ArticleController.cs',
    'FsusBlog.Server/Modules/Controllers/CategoryController.cs',
    'FsusBlog.Server/Modules/Controllers/TagController.cs',
    'FsusBlog.Server/Modules/Controllers/FileController.cs',
    'FsusBlog.Server/Modules/Controllers/SystemController.cs',
    'FsusBlog.Server/Modules/Controllers/AdminUserController.cs',
    'FsusBlog.Server/Modules/Controllers/StatsController.cs'
  ];

  for (const file of controllerAdminFiles) {
    const source = await readServerFile(file);
    assertIncludes(source, '[Authorize(Roles = "admin")]', file);
  }

  const articleController = await readServerFile('FsusBlog.Server/Modules/Controllers/ArticleController.cs');
  for (const route of ['[HttpPost]', '[HttpPut("{id}")]', '[HttpPost("{id}/aot-bundle")]', '[HttpDelete("{id}")]', '[HttpDelete("permanent/{id}")]', '[HttpDelete("trash")]', '[HttpPut("restore/{id}")]']) {
    const index = articleController.indexOf(route);
    assert(index >= 0, `ArticleController missing route ${route}`);
    const nextMethod = articleController.indexOf('public async', index + route.length);
    const routeBlock = articleController.slice(index, nextMethod > index ? nextMethod : index + 240);
    assertIncludes(routeBlock, '[RequiresPow]', `ArticleController ${route}`);
  }

  const commentController = await readServerFile('FsusBlog.Server/Modules/Controllers/CommentController.cs');
  for (const route of ['[HttpPost]', '[HttpDelete("{id}")]']) {
    const index = commentController.indexOf(route);
    assert(index >= 0, `CommentController missing route ${route}`);
    const nextMethod = commentController.indexOf('public async', index + route.length);
    const routeBlock = commentController.slice(Math.max(0, index - 220), nextMethod > index ? nextMethod : index + 260);
    assertIncludes(routeBlock, '[Authorize]', `CommentController ${route}`);
    assertIncludes(routeBlock, '[RequiresPow]', `CommentController ${route}`);
  }

  const binaryEndpoints = await readServerFile('FsusBlog.Server/Modules/Endpoints/Binary/BinaryEndpoints.cs');
  assertIncludes(binaryEndpoints, '.RequireAuthorization(policy => policy.RequireRole("admin"))', 'Binary admin endpoints');
  assertIncludes(binaryEndpoints, '.AddEndpointFilter<RequiresPowFilter>()', 'Binary upload endpoints');

  const messageEndpoints = await readServerFile('FsusBlog.Server/Modules/Endpoints/MessageEndpoints.cs');
  assertIncludes(messageEndpoints, 'var userGroup = app.MapGroup("/api/v1/messages").RequireAuthorization();', 'user message endpoints');
  assertIncludes(messageEndpoints, 'var adminGroup = app.MapGroup("/api/v1/admin/messages")', 'admin message endpoints');
  assertIncludes(messageEndpoints, '.RequireAuthorization(policy => policy.RequireRole("admin"))', 'admin message endpoints');
  assert(messageEndpoints.match(/AddEndpointFilter<RequiresPowFilter>\(\)/g)?.length >= 4, 'message write endpoints must retain PoW filters');

  const authEndpoints = await readServerFile('FsusBlog.Server/Modules/Endpoints/AuthEndpoints.cs');
  assertIncludes(authEndpoints, 'group.MapPost("admin/users/{id:int}/mfa/reset"', 'admin MFA reset endpoint');
  assertIncludes(authEndpoints, '.RequireAuthorization(policy => policy.RequireRole("admin"))', 'admin MFA reset endpoint');
}

async function assertGuestAndRoleRoutes() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  try {
    const guest = await browser.newContext({ baseURL: frontendBaseUrl });
    const guestPage = await guest.newPage();
    await guestPage.goto('/user/profile', { waitUntil: 'domcontentloaded' });
    await guestPage.waitForURL(/\/login(\?|$)/, { timeout: 10000 });
    assert(guestPage.url().includes('/login'), 'guest visiting /user/profile should redirect to login');
    await guest.close();

    const userSession = await loginWithPow(userName, userPassword, false, 'permission-user');
    const userContext = await browser.newContext({ baseURL: frontendBaseUrl });
    await userContext.addCookies(Array.from(userSession.cookieMap.entries()).map(([name, value]) => ({
      name,
      value,
      url: frontendBaseUrl
    })));
    const userPage = await userContext.newPage();
    await userPage.goto('/user/manage', { waitUntil: 'domcontentloaded' });
    await userPage.waitForURL((url) => new URL(url.toString()).pathname === '/user/profile', { timeout: 10000 });
    assert(new URL(userPage.url()).pathname === '/user/profile', 'normal user should be redirected to /user/profile');
    await userContext.close();

    const adminSession = await loginWithPow(adminName, adminPassword, false, 'permission-admin');
    const adminContext = await browser.newContext({ baseURL: frontendBaseUrl });
    await adminContext.addCookies(Array.from(adminSession.cookieMap.entries()).map(([name, value]) => ({
      name,
      value,
      url: frontendBaseUrl
    })));
    const adminPage = await adminContext.newPage();
    await adminPage.goto('/user/manage', { waitUntil: 'domcontentloaded' });
    await adminPage.waitForTimeout(2500);
    assert(new URL(adminPage.url()).pathname.startsWith('/user/manage'), 'admin should be able to stay on admin route');
    await adminContext.close();
  } finally {
    await browser.close();
  }
}

async function fetchFirstArticleId() {
  const { response, payload } = await fetchJsonLike('/api/Article?page=1&size=1');
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
    authJson('/api/Article?page=1&size=100', {
      method: 'GET',
      cookieHeader: adminSession.cookieHeader,
      deviceFingerprint: 'permission-marker-articles'
    }),
    authJson('/api/Category', {
      method: 'GET',
      cookieHeader: adminSession.cookieHeader,
      deviceFingerprint: 'permission-marker-categories'
    }),
    authJson('/api/Tag', {
      method: 'GET',
      cookieHeader: adminSession.cookieHeader,
      deviceFingerprint: 'permission-marker-tags'
    }),
    authJson('/api/v1/admin/messages/conversations?page=1&size=50', {
      method: 'GET',
      cookieHeader: adminSession.cookieHeader,
      deviceFingerprint: 'permission-marker-messages'
    })
  ]);

  for (const [name, result] of Object.entries({ articles, categories, tags, adminMessages })) {
    assertAllowed(`${name} marker probe`, result.response);
    assert(!JSON.stringify(result.payload ?? '').includes(marker), `${name} contains forbidden role=user attack marker ${marker}`);
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
    ['role=user article aot-bundle attack probe', `/api/Article/${articleId}/aot-bundle`, {
      method: 'POST',
      requiresPow: true,
      body: { html: `<main>${marker}</main>`, version: marker, assets: [] }
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
    ['role=user admin reset password attack probe', '/api/admin/users/reset-pwd', {
      method: 'POST',
      requiresPow: true,
      body: { userId: 1, newPassword: 'PermissionPass123!' }
    }],
    ['role=user admin messages list attack probe', '/api/v1/admin/messages/conversations?page=1&size=10', {
      method: 'GET'
    }],
    ['role=user admin message detail attack probe', '/api/v1/admin/messages/conversations/1', {
      method: 'GET'
    }],
    ['role=user admin message reply attack probe', '/api/v1/admin/messages/conversations/1/reply', {
      method: 'POST',
      requiresPow: true,
      body: { body: marker }
    }],
    ['role=user admin message status attack probe', '/api/v1/admin/messages/conversations/1/status', {
      method: 'POST',
      requiresPow: true,
      body: { status: 'closed' }
    }],
    ['role=user admin system message attack probe', '/api/v1/admin/messages/system-send', {
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

  await expectDenied('guest message create attack probe', '/api/v1/messages/conversations', {
    method: 'POST',
    deviceFingerprint: 'permission-guest-message',
    requiresPow: true,
    body: { subject: 'guest attack', body: 'guest should not create messages' }
  });
}

async function findOwnCommentId(userSession, marker) {
  const comments = await expectAllowed('role=user own comments list', '/api/Comment/me?limit=50', {
    method: 'GET',
    cookieHeader: userSession.cookieHeader,
    deviceFingerprint: 'permission-user-comment-list'
  });
  const comment = toItemArray(comments.payload).find((item) => String(item?.content ?? '').includes(marker));
  assert(comment?.id, 'created role=user comment was not visible in own comment list');
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

  const revokeMissing = await authJson('/api/Auth/sessions/permission-missing-session/revoke', {
    method: 'POST',
    cookieHeader: userSession.cookieHeader,
    deviceFingerprint: 'permission-user-revoke-missing'
  });
  assertNoServerError('role=user revoke missing session boundary', revokeMissing.response);
  assert([200, 404].includes(revokeMissing.response.status), `role=user revoke missing session should be 200/404, got ${revokeMissing.response.status}`);

  const mfaProfile = await authJson('/api/Auth/mfa/profile', {
    method: 'GET',
    cookieHeader: userSession.cookieHeader,
    deviceFingerprint: 'permission-user-mfa-profile'
  });
  assertNoServerError('role=user MFA profile', mfaProfile.response);
  assert([200, 404].includes(mfaProfile.response.status), `role=user MFA profile should be 200/404, got ${mfaProfile.response.status}`);

  const invalidPasswordUpdate = await authJson('/api/Auth/update-password', {
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

  const deleteForeignOrMissingComment = await authJson('/api/Comment/9223372036854775807', {
    method: 'DELETE',
    cookieHeader: userSession.cookieHeader,
    deviceFingerprint: 'permission-user-comment-delete-missing',
    requiresPow: true
  });
  assertDenied('role=user cannot delete missing/foreign comment', deleteForeignOrMissingComment.response);

  const ownCommentDelete = await authJson(`/api/Comment/${ownCommentId}`, {
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

  const longComment = await authJson('/api/Comment', {
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
  assert(!longComment.response.ok, 'role=user over-limit comment must not succeed');

  const messageSubject = `${marker}-ticket`;
  const createConversation = await expectAllowed('role=user own message conversation create', '/api/v1/messages/conversations', {
    method: 'POST',
    cookieHeader: userSession.cookieHeader,
    deviceFingerprint: 'permission-user-message-create',
    requiresPow: true,
    body: { subject: messageSubject, body: `${marker} user-owned support ticket` }
  });
  let conversationId = String(unwrap(createConversation.payload)?.conversationId ?? unwrap(createConversation.payload)?.id ?? '');
  if (!/^\d+$/.test(conversationId)) {
    const conversations = await expectAllowed('role=user own message conversations list', '/api/v1/messages/conversations?page=1&size=20', {
      method: 'GET',
      cookieHeader: userSession.cookieHeader,
      deviceFingerprint: 'permission-user-message-list'
    });
    const conversation = toItemArray(conversations.payload).find((item) => JSON.stringify(item).includes(messageSubject));
    conversationId = String(conversation?.conversationId ?? conversation?.id ?? '');
  }
  assert(/^\d+$/.test(conversationId), 'created role=user conversation id was not discoverable');

  await expectAllowed('role=user own message conversation detail', `/api/v1/messages/conversations/${conversationId}`, {
    method: 'GET',
    cookieHeader: userSession.cookieHeader,
    deviceFingerprint: 'permission-user-message-detail'
  });

  await expectAllowed('role=user own message reply', `/api/v1/messages/conversations/${conversationId}/reply`, {
    method: 'POST',
    cookieHeader: userSession.cookieHeader,
    deviceFingerprint: 'permission-user-message-reply',
    requiresPow: true,
    body: { body: `${marker} reply` }
  });

  await expectAllowed('role=user own message mark read', `/api/v1/messages/conversations/${conversationId}/read`, {
    method: 'POST',
    cookieHeader: userSession.cookieHeader,
    deviceFingerprint: 'permission-user-message-read'
  });

  const missingConversationReply = await authJson('/api/v1/messages/conversations/9223372036854775807/reply', {
    method: 'POST',
    cookieHeader: userSession.cookieHeader,
    deviceFingerprint: 'permission-user-message-reply-missing',
    requiresPow: true,
    body: { body: marker }
  });
  assertDenied('role=user cannot reply missing/foreign conversation', missingConversationReply.response);

  const longConversation = await authJson('/api/v1/messages/conversations', {
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
}

async function assertAdminPowBoundaries(adminSession, categoryId, largeMarkdownPayload) {
  const missingPowCategory = await authJson('/api/Category', {
    method: 'POST',
    cookieHeader: adminSession.cookieHeader,
    deviceFingerprint: 'permission-admin-no-pow',
    body: { name: `perm-admin-missing-pow-${Date.now()}` }
  });
  assertDenied('admin category create without pow', missingPowCategory.response);

  const adminLargeArticleNoPow = await authJson('/api/Article', {
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
  const createdTagId = Number(unwrap(createTag.payload));

  const categories = await expectAllowed('category list after admin create', '/api/Category', {
    method: 'GET',
    cookieHeader: adminSession.cookieHeader,
    deviceFingerprint: 'permission-admin-category-list'
  });
  const createdCategory = toItemArray(categories.payload).find((item) => item.name === createdCategoryName);
  assert(createdCategory?.id, 'created category not visible after creation');

  try {
    const updateCategoryNoPow = await authJson(`/api/Category/${createdCategory.id}`, {
      method: 'PUT',
      cookieHeader: adminSession.cookieHeader,
      deviceFingerprint: 'permission-admin-category-no-pow',
      body: { name: `${createdCategoryName}-updated` }
    });
    assertDenied('admin category update without pow', updateCategoryNoPow.response);

    const deleteCategoryNoPow = await authJson(`/api/Category/${createdCategory.id}`, {
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

    const updateTagNoPow = await authJson(`/api/Tag/${createdTagId}`, {
      method: 'PUT',
      cookieHeader: adminSession.cookieHeader,
      deviceFingerprint: 'permission-admin-tag-no-pow',
      body: { name: `${createdTagName}-updated` }
    });
    assertDenied('admin tag update without pow', updateTagNoPow.response);

    const deleteTagNoPow = await authJson(`/api/Tag/${createdTagId}`, {
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
    const cleanupCategory = await authJson(`/api/Category/${createdCategory.id}`, {
      method: 'DELETE',
      cookieHeader: adminSession.cookieHeader,
      deviceFingerprint: 'permission-admin-category-delete',
      requiresPow: true
    });
    assertAllowed('admin category cleanup', cleanupCategory.response);

    const cleanupTag = await authJson(`/api/Tag/${createdTagId}`, {
      method: 'DELETE',
      cookieHeader: adminSession.cookieHeader,
      deviceFingerprint: 'permission-admin-tag-delete',
      requiresPow: true
    });
    assertAllowed('admin tag cleanup', cleanupTag.response);
  }
}

async function assertApiMatrix() {
  const articleId = await fetchFirstArticleId();
  const userSession = await loginWithPow(userName, userPassword, false, 'permission-api-user');
  const adminSession = await loginWithPow(adminName, adminPassword, false, 'permission-api-admin');
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
  console.log(`[check-permission-matrix] ok | base=${baseUrl} frontend=${frontendBaseUrl}`);
}

main().catch((error) => {
  console.error('[check-permission-matrix] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
