#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import {
  authBinary,
  baseUrl,
  loginWithPow,
  requestTimeoutMs
} from '../../support/auth-helpers.mjs';
import { readAedsResponse } from '../../support/aeds-envelope.mjs';
import { fetchWithTimeout } from '../../support/http.mjs';

const adminUsername = process.env.FSUSBLOG_ADMIN_USERNAME || 'binaryadmin';
const adminPassword = process.env.FSUSBLOG_ADMIN_PASSWORD || 'BinaryAdminPass123!';
const publicBaseUrl = process.env.FSUSBLOG_PUBLIC_BASE_URL || baseUrl;
const timeoutMs = Math.max(requestTimeoutMs, 30_000);
const coherenceTimeoutMs = Math.max(timeoutMs * 3, 90_000);
const testSessionIsolation = process.env.FSUSBLOG_TEST_SESSION_ISOLATION === '1';
const publicPageBaseUrl = testSessionIsolation ? baseUrl : publicBaseUrl;
const ArticleStatus = Object.freeze({
  Draft: 0,
  Scheduled: 1,
  Published: 2,
  Archived: 3,
  Deleted: 4
});

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventually(label, assertion, timeout = coherenceTimeoutMs, interval = 600) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  do {
    try {
      return await assertion();
    } catch (error) {
      lastError = error;
      await delay(interval);
    }
  } while (Date.now() < deadline);

  throw new Error(`${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function fetchText(path, base = publicBaseUrl) {
  const response = await fetchWithTimeout(`${base}${path}`, {
    headers: {
      'User-Agent': 'FsusBlog distribution coherence smoke'
    }
  }, timeoutMs);
  assert(response.status < 500, `${path} returned ${response.status}`);
  return {
    status: response.status,
    text: await response.text()
  };
}

async function fetchSearchIndexText() {
  const response = await fetchWithTimeout(`${baseUrl}/search/index.bin`, {}, timeoutMs);
  assert(response.ok, `search index alias failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer()).toString('utf8');
}

async function fetchArticlePage(cookieHeader, isDeleted = false, status = undefined) {
  if (!cookieHeader) {
    const response = await fetchWithTimeout(`${baseUrl}/api/binary/article/list/home/1/10.aeds`, {
      headers: {
        Accept: 'application/octet-stream',
        'X-Fsus-Device-Fp': 'distribution-public-list'
      }
    }, timeoutMs);
    const payload = await readAedsResponse(response).catch(() => null);
    assert(response.ok, `article list public failed: ${response.status}`);
    return Array.isArray(payload?.items) ? payload.items : [];
  }

  const params = new URLSearchParams({
    page: '1',
    size: '50',
    isDeleted: isDeleted ? 'true' : 'false'
  });
  if (status !== undefined) {
    params.set('status', String(status));
  }

  const { response, payload } = await authBinary(`/api/Article?${params.toString()}`, {
    cookieHeader
  });
  assert(response.ok, `article list ${isDeleted ? 'deleted' : 'public'} failed: ${response.status}`);
  return Array.isArray(payload?.items) ? payload.items : [];
}

async function fetchArticleDetail(articleId, cookieHeader = null) {
  if (!cookieHeader) {
    const response = await fetchWithTimeout(`${baseUrl}/api/binary/article/${articleId}.aeds`, {
      headers: {
        Accept: 'application/octet-stream',
        'X-Fsus-Device-Fp': 'distribution-public-detail'
      }
    }, timeoutMs);
    const payload = await readAedsResponse(response).catch(() => null);
    return { response, payload };
  }

  return await authBinary(`/api/Article/${articleId}`, { cookieHeader });
}

async function fetchTaxonomy(path, session, namePrefix) {
  let { response, payload } = await authBinary(path, {
    cookieHeader: session.cookieHeader
  });
  assert(response.ok, `${path} read failed: ${response.status}`);
  if (Array.isArray(payload) && payload.length > 0) {
    return Number(payload[0].id);
  }

  const name = `${namePrefix} ${Date.now()}`;
  ({ response } = await authBinary(path, {
    method: 'POST',
    cookieHeader: session.cookieHeader,
    requiresPow: true,
    deviceFingerprint: `${namePrefix.toLowerCase().replaceAll(' ', '-')}-create`,
    body: { name }
  }));
  assert(response.ok, `${path} create failed: ${response.status}`);

  ({ response, payload } = await authBinary(path, {
    cookieHeader: session.cookieHeader
  }));
  assert(response.ok, `${path} reread failed: ${response.status}`);
  const created = Array.isArray(payload) ? payload.find((item) => item?.name === name) : null;
  assert(created?.id, `${path} created taxonomy missing`);
  return Number(created.id);
}

async function warmPublicSurfaces(articleId, categoryId, tagId) {
  await Promise.allSettled([
    fetchArticlePage(null),
    fetchText('/feed/rss.xml', baseUrl),
    fetchText('/feed/atom.xml', baseUrl),
    fetchText('/feed/feed.json', baseUrl),
    fetchText('/sitemap.xml', baseUrl),
    fetchText(`/article/${articleId}`, publicPageBaseUrl),
    fetchText(`/category/${categoryId}`, publicPageBaseUrl),
    fetchText(`/tag/${tagId}`, publicPageBaseUrl),
    fetchSearchIndexText()
  ]);
}

async function readPublicSurfaces(articleId, categoryId, tagId, cookieHeader) {
  const publicItemsPromise = testSessionIsolation
    ? fetchArticlePage(cookieHeader, false, ArticleStatus.Published)
    : fetchArticlePage(null);
  const scopedDetailPromise = testSessionIsolation
    ? fetchArticleDetail(articleId, cookieHeader)
    : Promise.resolve(null);
  const [publicItems, deletedItems, detail, scopedDetail, rss, atom, jsonFeed, sitemap, articleHtml, categoryHtml, tagHtml, searchIndex] =
    await Promise.all([
      publicItemsPromise,
      fetchArticlePage(cookieHeader, true),
      fetchArticleDetail(articleId),
      scopedDetailPromise,
      fetchText('/feed/rss.xml', baseUrl),
      fetchText('/feed/atom.xml', baseUrl),
      fetchText('/feed/feed.json', baseUrl),
      fetchText('/sitemap.xml', baseUrl),
      fetchText(`/article/${articleId}`, publicPageBaseUrl),
      fetchText(`/category/${categoryId}`, publicPageBaseUrl),
      fetchText(`/tag/${tagId}`, publicPageBaseUrl),
      fetchSearchIndexText()
    ]);

  return {
    publicItems,
    deletedItems,
    detail,
    scopedDetail,
    rss: rss.text,
    atom: atom.text,
    jsonFeed: jsonFeed.text,
    sitemap: sitemap.text,
    articleHtml: articleHtml.text,
    categoryHtml: categoryHtml.text,
    tagHtml: tagHtml.text,
    searchIndex
  };
}

function assertPublicPresent(snapshot, articleId, title, marker) {
  const readableDetail = snapshot.scopedDetail ?? snapshot.detail;
  assert(
    snapshot.publicItems.some((item) => Number(item?.id) === articleId && item?.title === title),
    `${title} missing from public article list; got ${formatPublicItemSummary(snapshot.publicItems)}`
  );
  assert(readableDetail.response.ok, `${title} detail should be readable, got ${readableDetail.response.status}`);
  assert(readableDetail.payload?.title === title, `${title} detail title mismatch`);
  assert(snapshot.rss.includes(title) && snapshot.rss.includes(marker), `${title} missing from RSS`);
  assert(snapshot.atom.includes(title) && snapshot.atom.includes(marker), `${title} missing from Atom`);
  assert(snapshot.jsonFeed.includes(title) && snapshot.jsonFeed.includes(marker), `${title} missing from JSON Feed`);
  assert(snapshot.sitemap.includes(`/article/${articleId}`), `${title} missing from sitemap`);
  assert(snapshot.articleHtml.includes(title), `${title} missing from article AOT page`);
  assert(snapshot.categoryHtml.includes(title), `${title} missing from category AOT page`);
  assert(snapshot.tagHtml.includes(title), `${title} missing from tag AOT page`);
  assert(snapshot.searchIndex.includes(title) && snapshot.searchIndex.includes(marker), `${title} missing from search index alias`);
}

function formatPublicItemSummary(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return '[]';
  }

  return `[${items.map((item) => {
    const id = Number(item?.id);
    const title = typeof item?.title === 'string' ? item.title : '';
    const createTime = typeof item?.createTime === 'string' ? item.createTime : '';
    const status = item?.status ?? '';
    return `{id:${Number.isFinite(id) ? id : 'n/a'},title:${JSON.stringify(title)},createTime:${createTime},status:${status}}`;
  }).join(', ')}]`;
}

function assertPublicAbsent(snapshot, articleId, title, marker) {
  assert(!snapshot.publicItems.some((item) => Number(item?.id) === articleId), `${title} leaked in public article list`);
  assert(!snapshot.detail.response.ok, `${title} detail should be unavailable, got ${snapshot.detail.response.status}`);
  assertPublicContentAbsent(snapshot, title, marker);
  assert(!snapshot.sitemap.includes(`/article/${articleId}`), `${title} leaked in sitemap`);
}

function assertPublicContentAbsent(snapshot, title, marker) {
  assert(snapshot.detail.payload?.title !== title, `${title} leaked in article detail title`);
  for (const [name, value] of [
    ['RSS', snapshot.rss],
    ['Atom', snapshot.atom],
    ['JSON Feed', snapshot.jsonFeed],
    ['article AOT', snapshot.articleHtml],
    ['category AOT', snapshot.categoryHtml],
    ['tag AOT', snapshot.tagHtml],
    ['search index', snapshot.searchIndex]
  ]) {
    assert(!value.includes(title), `${title} leaked in ${name}`);
    assert(!value.includes(marker), `${marker} leaked in ${name}`);
  }
}

async function assertAdminState(session, articleId, title, status, isDeleted = false) {
  const [items, detail] = await Promise.all([
    fetchArticlePage(session.cookieHeader, isDeleted, status),
    fetchArticleDetail(articleId, session.cookieHeader)
  ]);

  assert(items.some((item) => Number(item?.id) === articleId && item?.title === title && Number(item?.status) === status), `${title} missing from admin status ${status} list`);
  assert(detail.response.ok, `${title} admin detail failed: ${detail.response.status}`);
  assert(detail.payload?.title === title, `${title} admin detail title mismatch`);
  assert(Number(detail.payload?.status) === status, `${title} admin detail status mismatch: ${detail.payload?.status}`);
}

async function createArticle(session, categoryId, tagId, title, marker, options = {}) {
  const { response, payload } = await authBinary('/api/Article', {
    method: 'POST',
    cookieHeader: session.cookieHeader,
    requiresPow: true,
    deviceFingerprint: `distribution-create-${marker}`,
    body: {
      title,
      content: `# ${title}\n\n${marker} body proves distribution coherence.`,
      summary: `${marker} summary proves feed and search coherence.`,
      categoryId,
      tagIds: [tagId],
      status: options.status ?? ArticleStatus.Published,
      scheduledPublishAt: options.scheduledPublishAt ?? null
    }
  });
  assert(response.ok, `article create failed: ${response.status}`);
  const id = Number(payload?.id);
  assert(Number.isFinite(id) && id > 0, 'article create missing mutation id');
  return id;
}

async function updateArticle(session, articleId, categoryId, tagId, title, marker, options = {}) {
  const { response } = await authBinary(`/api/Article/${articleId}`, {
    method: 'PUT',
    cookieHeader: session.cookieHeader,
    requiresPow: true,
    deviceFingerprint: `distribution-update-${marker}`,
    body: {
      title,
      content: `# ${title}\n\n${marker} updated body proves distribution coherence.`,
      summary: `${marker} updated summary proves feed and search coherence.`,
      categoryId,
      tagIds: [tagId],
      status: options.status ?? ArticleStatus.Published,
      scheduledPublishAt: options.scheduledPublishAt ?? null
    }
  });
  assert(response.ok, `article update failed: ${response.status}`);
}

async function mutateArticle(session, path, method, operation, marker) {
  const { response } = await authBinary(path, {
    method,
    cookieHeader: session.cookieHeader,
    requiresPow: true,
    deviceFingerprint: `distribution-${operation}-${marker}`
  });
  assert(response.ok, `article ${operation} failed: ${response.status}`);
}

async function main() {
  const session = await loginWithPow(adminUsername, adminPassword, false, 'distribution-admin-login', timeoutMs);
  const categoryId = await fetchTaxonomy('/api/Category', session, 'Distribution Category');
  const tagId = await fetchTaxonomy('/api/Tag', session, 'Distribution Tag');
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const markerV1 = `dc${stamp}alpha`;
  const markerV2 = `dc${stamp}beta`;
  const titleV1 = `Distribution Coherence ${stamp} Alpha`;
  const titleV2 = `Distribution Coherence ${stamp} Beta`;
  const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  let articleId = 0;
  let permanentlyDeleted = false;

  try {
    await warmPublicSurfaces(1, categoryId, tagId);
    articleId = await createArticle(session, categoryId, tagId, titleV1, markerV1, {
      status: ArticleStatus.Draft
    });
    await warmPublicSurfaces(articleId, categoryId, tagId);

    await eventually('draft publication boundary', async () => {
      const snapshot = await readPublicSurfaces(articleId, categoryId, tagId, session.cookieHeader);
      assertPublicAbsent(snapshot, articleId, titleV1, markerV1);
      await assertAdminState(session, articleId, titleV1, ArticleStatus.Draft);
    });
    console.log('[distribution-version-coherence] ok: draft-hidden');

    await updateArticle(session, articleId, categoryId, tagId, titleV1, markerV1, {
      status: ArticleStatus.Scheduled,
      scheduledPublishAt: scheduledAt
    });
    await eventually('scheduled publication boundary', async () => {
      const snapshot = await readPublicSurfaces(articleId, categoryId, tagId, session.cookieHeader);
      assertPublicAbsent(snapshot, articleId, titleV1, markerV1);
      await assertAdminState(session, articleId, titleV1, ArticleStatus.Scheduled);
    });
    console.log('[distribution-version-coherence] ok: scheduled-hidden');

    await updateArticle(session, articleId, categoryId, tagId, titleV1, markerV1, {
      status: ArticleStatus.Archived
    });
    await eventually('archived publication boundary', async () => {
      const snapshot = await readPublicSurfaces(articleId, categoryId, tagId, session.cookieHeader);
      assertPublicAbsent(snapshot, articleId, titleV1, markerV1);
      await assertAdminState(session, articleId, titleV1, ArticleStatus.Archived);
    });
    console.log('[distribution-version-coherence] ok: archived-hidden');

    await updateArticle(session, articleId, categoryId, tagId, titleV1, markerV1, {
      status: ArticleStatus.Published
    });

    await eventually('create distribution coherence', async () => {
      const snapshot = await readPublicSurfaces(articleId, categoryId, tagId, session.cookieHeader);
      assertPublicPresent(snapshot, articleId, titleV1, markerV1);
    });
    console.log('[distribution-version-coherence] ok: create');

    await updateArticle(session, articleId, categoryId, tagId, titleV2, markerV2);
    await eventually('update distribution coherence', async () => {
      const snapshot = await readPublicSurfaces(articleId, categoryId, tagId, session.cookieHeader);
      assertPublicPresent(snapshot, articleId, titleV2, markerV2);
      assertPublicContentAbsent(snapshot, titleV1, markerV1);
    });
    console.log('[distribution-version-coherence] ok: update');

    await mutateArticle(session, `/api/Article/${articleId}`, 'DELETE', 'delete', markerV2);
    await eventually('delete distribution coherence', async () => {
      const snapshot = await readPublicSurfaces(articleId, categoryId, tagId, session.cookieHeader);
      assertPublicAbsent(snapshot, articleId, titleV2, markerV2);
      assert(snapshot.deletedItems.some((item) => Number(item?.id) === articleId), `${titleV2} missing from admin trash list`);
    });
    console.log('[distribution-version-coherence] ok: delete');

    await mutateArticle(session, `/api/Article/restore/${articleId}`, 'PUT', 'restore', markerV2);
    await eventually('restore distribution coherence', async () => {
      const snapshot = await readPublicSurfaces(articleId, categoryId, tagId, session.cookieHeader);
      assertPublicPresent(snapshot, articleId, titleV2, markerV2);
    });
    console.log('[distribution-version-coherence] ok: restore');

    await mutateArticle(session, `/api/Article/${articleId}`, 'DELETE', 'delete-before-permanent', markerV2);
    await mutateArticle(session, `/api/Article/permanent/${articleId}`, 'DELETE', 'permanent-delete', markerV2);
    permanentlyDeleted = true;
    await eventually('permanent delete distribution coherence', async () => {
      const snapshot = await readPublicSurfaces(articleId, categoryId, tagId, session.cookieHeader);
      assertPublicAbsent(snapshot, articleId, titleV2, markerV2);
      assert(!snapshot.deletedItems.some((item) => Number(item?.id) === articleId), `${titleV2} leaked in admin trash after permanent delete`);
    });
    console.log('[distribution-version-coherence] ok: permanent-delete');

    console.log('[distribution-version-coherence] all checks passed');
  } finally {
    if (articleId > 0 && !permanentlyDeleted) {
      await mutateArticle(session, `/api/Article/${articleId}`, 'DELETE', 'cleanup-delete', markerV2).catch(() => null);
      await mutateArticle(session, `/api/Article/permanent/${articleId}`, 'DELETE', 'cleanup-permanent-delete', markerV2).catch(() => null);
    }
  }
}

main().catch((error) => {
  console.error('[distribution-version-coherence] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
