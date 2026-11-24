import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFrame, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import { decodeArticleHot, encodeArticleHot, type PopularArticle } from '../../src/Contracts/article-hot.ts';
import { api } from '../../src/Contracts/client.ts';
import { decodeCommentChildren, decodeCommentContext, decodeCommentRoots } from '../../src/Contracts/comment-read.ts';
import { decodeArticle, decodeArticleList, decodeSearch } from '../../src/Contracts/public-articles.ts';
import { decodeRelatedReading, publicRelatedReading } from '../../src/Contracts/related-reading.ts';
import { decodeSeoConfig, decodeSiteComplianceConfig } from '../../src/Contracts/site-config.ts';
import { decodeSitePage } from '../../src/Contracts/site-pages.ts';
import { decodeTaxonomyList, decodeTaxonomyMetadata } from '../../src/Contracts/taxonomy.ts';
import {
  decodeTaxonomyAssignment, encodeSession, encodeTaxonomyAssignment, FrameType, WireHeaders, WireLayouts as L, WireRoutes,
} from '../../src/Contracts/wire.generated.ts';
import {
  appendByte, captureFetch, encodedResponse, fixtureBytes, framedFixture, frameResponse, hexFixture,
  rejectBytes, rejectInputs, rejectWrongLength, withByte, withI32, withI64,
} from './fixture-source.ts';

const fixture = (name: string, type: FrameType, ws?: 'trim' | 'strip') => framedFixture(`${name}.hex`, type, ws);

test('public HTTP article frames preserve their current layout, coordinates, and reject legacy or malformed variants', () => {
  const detail = fixture('article-detail-ard5', FrameType.ArticleDetail);
  const list = fixture('article-list-cursor-v2', FrameType.ArticleList);
  const search = fixture('article-search-fas4', FrameType.ArticleSearch);
  const decodedDetail = decodeArticle(detail);
  const decodedList = decodeArticleList(list);
  const decodedSearch = decodeSearch(search);
  assert.equal(decodedDetail.body, '第一行\nsecond line\n');
  assert.equal(decodedDetail.updatedAt, 1700000001234);
  assert.equal(decodedDetail.publishedAt, 1700000002345);
  assert.equal(decodedList.articles[0].publishedAt, decodedDetail.publishedAt);
  assert.equal(decodedList.total, 2);
  assert.equal(decodedList.nextCursor, 'v2_Ab-1');
  assert.equal(decodedSearch.total, 1);
  for (const item of [decodedDetail, decodedList.articles[0], decodedSearch.articles[0]]) {
    assert.equal(item.id, 42);
    assert.equal(item.createdAt, 1700000000123);
    assert.equal(item.revision, 9007199254740993n);
    assert.equal(item.revisionNo, 4);
    assert.equal(item.publication, 9007199254741001n);
    assert.equal(item.publicationNo, 2);
    assert.equal(item.title, '雪原 🐈');
    assert.equal(item.summary, '摘要');
  }

  assert.throws(() => decodeArticle(fixture('article-detail-v1-wire', FrameType.ArticleDetail)), ProtocolError);
  assert.throws(() => decodeArticle(fixture('article-detail-v4-v1-wire', FrameType.ArticleDetail)), ProtocolError);
  assert.throws(() => decodeArticleList(fixture('article-list-v1-wire', FrameType.ArticleList)), ProtocolError);
  assert.throws(() => decodeSearch(fixture('article-search-v1-wire', FrameType.ArticleSearch)), ProtocolError);
  const recordStart = list.length - L.ArticleListRecordSizeCurrent;
  for (const width of [56, 76]) assert.throws(() => decodeArticleList(list.subarray(0, recordStart + width)), ProtocolError);
  assert.throws(() => decodeArticleList(withI32(list, 4, 1)), ProtocolError);

  rejectWrongLength(decodeArticle, detail);
  rejectWrongLength(decodeArticleList, list);
  rejectWrongLength(decodeSearch, search);
  assert.throws(() => decodeArticle(withI64(detail, L.ArticleDetailHeaderSize + L.ArticleDetailCoordinatesOffset, 0n)), ProtocolError);
  assert.throws(() => decodeArticleList(withI32(list, recordStart + L.ArticleListTagCountOffset, 1)), ProtocolError);
  assert.throws(() => decodeArticleList(withByte(list, recordStart + L.ArticleListDeletedOffset + 2, 1)), ProtocolError);
  assert.throws(() => decodeSearch(withByte(search, 12 + L.ArticleSearchTitleOffset, 0xff)), ProtocolError);
});

test('ArticleHot matches frozen v1 AEDS bytes and rejects invalid rows, counts, and framing', () => {
  assert.equal(FrameType.ArticleHot, 3);
  assert.equal(WireRoutes.PublicArticleHot, '/api/binary/article/hot/{size}.aeds');
  const frame = hexFixture('article-hot-v1.hex');
  const items: PopularArticle[] = [
    { id: 42, views: 0, title: '雪 🐈' },
    { id: 7, views: 0x7fffffff, title: '' },
    { id: 19, views: 9, title: '\uFEFFCafe\u0301' },
  ];
  assert.deepEqual(Buffer.from(encodeFrame(FrameType.ArticleHot, encodeArticleHot(items))), frame);
  const { payload } = decodeFrame(frame, FrameType.ArticleHot);
  assert.deepEqual(decodeArticleHot(payload), items);
  const empty = hexFixture('article-hot-empty-v1.hex');
  assert.deepEqual(Buffer.from(encodeFrame(FrameType.ArticleHot, encodeArticleHot([]))), empty);
  assert.deepEqual(decodeArticleHot(decodeFrame(empty, FrameType.ArticleHot).payload), []);

  const title = '界'.repeat(84) + '🐈';
  const maximum = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, views: 0, title }));
  assert.deepEqual(decodeArticleHot(encodeArticleHot(maximum)), maximum);
  rejectInputs(encodeArticleHot, [
    [...maximum, { id: 101, views: 0, title }], [{ id: 1, views: 0, title: title + 'a' }],
    [{ id: 1, views: 0, title: '\uD800' }], [{ id: 1, views: -1, title }],
    [{ id: 1, views: 0x80000000, title }], [{ id: 1, views: NaN, title }],
    [{ id: 0, views: 0, title }], [{ id: 0x80000000, views: 0, title }],
    [{ id: 1, views: 0, title }, { id: 1, views: 0, title }],
  ]);

  const recordsAt = 8 + 17;
  for (const [position, value] of [
    [0, -1], [0, 101], [4, -1], [4, 0x7fffffff], [recordsAt, 0], [recordsAt + 4, -1],
    [recordsAt + 8, 1], [recordsAt + 12, 257], [recordsAt + 16, 42], [recordsAt + 44, 0],
  ]) assert.throws(() => decodeArticleHot(decodeFrame(encodeFrame(FrameType.ArticleHot, withI32(payload, position, value)), FrameType.ArticleHot).payload), ProtocolError);
  assert.throws(() => decodeFrame(encodeFrame(FrameType.ArticleList, payload), FrameType.ArticleHot), ProtocolError);
  rejectWrongLength(decodeArticleHot, payload);
  assert.throws(() => decodeArticleHot(withByte(payload, 8, 0xff)), ProtocolError);
});

test('related reading decodes the pinned v1 frame and rejects malformed payloads and self-links', async t => {
  const bytes = fixture('article-related-reading-v1', FrameType.ArticleRelatedReading, 'strip');
  const result = decodeRelatedReading(bytes);
  assert.deepEqual(result.related, [
    { id: 10, createdAt: 1779019200000, title: 'AEDS public reads', summary: 'Binary contract', reason: '同分类' },
    { id: 11, createdAt: 1779105600000, title: 'Hydration notes', summary: null, reason: '全文关键词' },
  ]);
  assert.equal(result.previous?.title, 'Previous article');
  assert.equal(result.next?.title, 'Next article');
  assert.deepEqual(decodeRelatedReading(new Uint8Array(12)), { related: [], previous: null, next: null });

  for (const length of [0, 11, bytes.length - 1])
    assert.throws(() => decodeRelatedReading(bytes.subarray(0, length)), ProtocolError);
  rejectBytes(decodeRelatedReading, bytes, [
    [0, 7], [L.RelatedReadingPreviousOffset, 2], [6, 1],
    [L.RelatedReadingHeaderSize + L.RelatedReadingItemHasSummaryOffset, 0],
    [L.RelatedReadingHeaderSize + L.RelatedReadingItemTitleOffset, 12],
    [L.RelatedReadingHeaderSize + L.RelatedReadingItemSize, 10],
  ]);
  assert.throws(() => decodeRelatedReading(appendByte(bytes)), ProtocolError);

  const response = encodeFrame(FrameType.ArticleRelatedReading, bytes);
  const calls = captureFetch(t, ({ url }) => {
    assert.equal(url, '/api/binary/article/10/related.aeds?publication=9007199254741001');
    return frameResponse(response);
  });
  await assert.rejects(publicRelatedReading(10, 9007199254741001n, new AbortController().signal), ProtocolError);
  assert.equal(calls.length, 1);
});

test('comment vectors preserve 64-bit nodes, author views, recursive coordinates, and reject invalid contexts', () => {
  const roots = decodeCommentRoots(fixture('comment-root-current', FrameType.CommentTreeRootCursor));
  const childrenPayload = fixture('comment-children-current', FrameType.CommentChildCursor);
  const children = decodeCommentChildren(childrenPayload, '9007199254740993', '9007199254740993');
  const contextPayload = fixture('comment-context-current', FrameType.CommentPermalinkContext);
  const path = decodeCommentContext(contextPayload);
  assert.equal(roots.cursor, null);
  assert.equal(roots.items[0].node.id, '9007199254740993');
  assert.equal(roots.items[0].node.edited, true);
  assert.equal(children.items[0].id, '9007199254740994');
  assert.equal(children.items[0].content, 'Visible reply 独立');
  assert.equal(children.items[0].replyToAuthor?.displayName, 'Writer');
  assert.equal(children.items[0].author.scope, 'some scope');
  assert.deepEqual(roots.items[0].preview, children.items);
  assert.deepEqual(path?.ancestors, [roots.items[0].node]);
  assert.deepEqual(path?.target, children.items[0]);

  assert.throws(() => decodeCommentChildren(childrenPayload, '9007199254740994'), ProtocolError);
  assert.throws(() => decodeCommentChildren(childrenPayload.subarray(0, -1)), ProtocolError);
  assert.throws(() => decodeCommentContext(withByte(contextPayload, 24, 1)), ProtocolError);
  assert.equal(decodeCommentContext(withByte(new Uint8Array(32), 24, 1)), null);
});

test('v1 taxonomy list, exact metadata, and assignment preserve layouts and bounds', () => {
  const list = fixture('category-list-v1', FrameType.CategoryList, 'strip');
  const metadata = fixture('taxonomy-exact-metadata', FrameType.TaxonomyExactMetadata, 'strip');
  assert.deepEqual(decodeTaxonomyList(list), [{ id: 1, name: 'Tech', articleCount: 2 }, { id: 2, name: 'Life', articleCount: 0 }]);
  assert.deepEqual(decodeTaxonomyMetadata(metadata), { id: 34, name: 'Étoile', description: '旧名不可占用' });
  assert.throws(() => decodeTaxonomyMetadata(withByte(metadata, 8, 255)), ProtocolError);
  assert.throws(() => decodeTaxonomyMetadata(metadata.subarray(0, -1)), ProtocolError);
  assert.throws(() => decodeTaxonomyList(withI32(list, 0, 0x7fff_ffff)), ProtocolError);

  const assignment = fixture('taxonomy-assignment', FrameType.TaxonomyAssignment, 'strip');
  const decoded = decodeTaxonomyAssignment(assignment);
  assert.deepEqual(decoded, {
    id: 42, expectedRevision: 9007199254740993n, idempotencyKey: '01020304-0506-4040-8080-000000000003',
    categoryId: 3, tagIds: [101, 105],
  });
  assert.deepEqual(encodeFrame(FrameType.TaxonomyAssignment, encodeTaxonomyAssignment(decoded)), fixtureBytes('taxonomy-assignment.hex'));
  assert.throws(() => decodeTaxonomyAssignment(withI32(assignment, 32, 33)), ProtocolError);
});

test('site config and site page v1 PODs preserve fields and reject corrupt offsets', () => {
  const seo = fixture('seo-config-v1', FrameType.SeoConfig, 'strip');
  assert.deepEqual(decodeSeoConfig(seo), {
    title: 'A️⃣ 公开 · Site', description: '独立描述 & café\nLine two 🐈', keywords: 'k=α', author: 'Fsu🐈',
    ogImage: 'https://cdn.example.test/og.png', baseUrl: 'https://scope.example.test:8443', faviconSvgUrl: '/assets/site.svg',
    faviconIcoUrl: '/favicon.ico', faviconPngUrl: '/fav.png', appleTouchIconUrl: '/apple.png', manifestName: '测试清单',
    manifestShortName: '名字', pwaIcon192Url: '/pwa192.png', pwaIcon512Url: '/pwa512.png', pwaMaskableIconUrl: '/maskable.png',
    themeColor: '#112233', backgroundColor: '#445566', siteLogoUrl: '/light.svg', siteLogoDarkUrl: '/dark.svg',
    siteWordmarkUrl: '/wordmark.svg', adminLogoUrl: '/backoffice.svg', adminCollapsedIconUrl: '/compact.svg', loginLogoUrl: '/login.svg',
    loginIconUrl: 'x'.repeat(252) + '🧪',
  });
  assert.throws(() => decodeSeoConfig(seo.subarray(0, -1)), ProtocolError);
  for (const offset of [255, 256, 260, L.SeoConfigPodBytes, L.SeoConfigBlobOffset, seo.length - 1])
    assert.throws(() => decodeSeoConfig(withByte(seo, offset, 0xff)), ProtocolError);

  const compliance = fixture('site-compliance-v1', FrameType.SiteComplianceConfig, 'strip');
  assert.deepEqual(decodeSiteComplianceConfig(compliance), {
    enabled: true, regionMode: 'mainland-cn', copyrightStartYear: 2024, copyrightOwner: '站点所有者', copyrightText: '©保留 · 独立\nRésumé 🧭',
    contentLicenseName: 'CC BY 4.0', contentLicenseUrl: 'https://creativecommons.org/licenses/by/4.0/', icpRecordNumber: '示例ICP备123号',
    icpRecordUrl: 'https://icp.example.test/check', policeRecordNumber: '示例网安备012号', policeRecordUrl: 'https://police.example.test/check',
    policeBadgeIconUrl: '/badge.svg', operatorName: '测试 Operator', contactEmail: 'public@example.test',
  });
  assert.throws(() => decodeSiteComplianceConfig(appendByte(compliance)), ProtocolError);
  rejectBytes(decodeSiteComplianceConfig, compliance, [[0, 2], [1, 97], [36, 128], [164, 0xff], [L.SiteComplianceCopyrightTextOffset, 1]]);
  const unknownYear = Uint8Array.from(compliance);
  unknownYear.fill(0, L.SiteComplianceCopyrightStartYearOffset, L.SiteComplianceCopyrightOwnerOffset);
  assert.equal(decodeSiteComplianceConfig(unknownYear).copyrightStartYear, null);

  const page = fixture('page-content-v1', FrameType.PageContent);
  assert.deepEqual(decodeSitePage(page), { slug: 'about', markdown: '# About\n\nHydration-safe binary payload.' });
  for (const offset of [5, 129, 132, 136, page.length - 1]) assert.throws(() => decodeSitePage(withByte(page, offset, 0xff)));
  assert.throws(() => decodeSitePage(page.subarray(0, -1)));
});

test('local index reads all pages from one generation and rejects drift or duplicates', async t => {
  const example = fixture('article-search-fas4', FrameType.ArticleSearch);
  const indexFrame = (id: number, generation: string, pages = '2') =>
    encodedResponse(FrameType.ArticleSearch, withI32(example, 12 + L.ArticleIdOffset, id), {
      [WireHeaders.SearchIndexGeneration]: generation, [WireHeaders.SearchIndexPages]: pages,
    });
  const calls = captureFetch(t, (_call, init) => {
    if (calls.length === 1) assert.equal(init?.signal, input.signal);
    return indexFrame(calls.length, '9007199254740993');
  });
  const input = new AbortController();
  const index = await api.publicIndex(input.signal);
  assert.equal(index.generation, '9007199254740993');
  assert.equal(index.total, 2);
  assert.deepEqual(index.items.map(item => item.id), [1, 2]);
  assert.deepEqual(calls.map(c => c.url), [
    '/api/v2/public/index.aeds?page=1', '/api/v2/public/index.aeds?page=2&generation=9007199254740993',
  ]);

  let attempt = 0;
  captureFetch(t, () => ++attempt === 2 ? indexFrame(2, '74') : indexFrame(1, '73'));
  await assert.rejects(api.publicIndex(), { name: ProtocolError.name, message: 'Invalid public search index coordinates' });
  await assert.rejects(api.publicIndex(), { name: ProtocolError.name, message: 'Duplicate articles in public search index' });
});

test('operator session parses UTC expiry, site session handle, and rejects malformed headers', async t => {
  const sessionFrame = encodeFrame(FrameType.OperatorSession, encodeSession({ name: 'operator', generation: 3n, canAuthor: true }));
  const reply = (expiry?: string, current?: string) => frameResponse(sessionFrame, {
    ...(expiry !== undefined ? { [WireHeaders.AccessExpiresAtUtc]: expiry } : {}),
    ...(current !== undefined ? { [WireHeaders.CurrentSession]: current } : {}),
  });
  let next = reply('2026-11-15T12:45:09.1234567Z');
  captureFetch(t, () => next);
  const admitted = await api.session();
  assert.equal(admitted.name, 'operator');
  assert.equal(admitted.generation, 3n);
  assert.equal(admitted.expiresAt, Date.UTC(2026, 10, 15, 12, 45, 9, 123));

  const expiry = '2026-11-15T12:45:09Z';
  const current = 'ac'.repeat(32);
  next = reply(expiry, current);
  assert.equal((await api.session()).siteSessionId, current);
  for (const bad of [reply(expiry, 'not-a-handle'), reply(), reply('2026-11-15T12:45:09')]) {
    next = bad;
    await assert.rejects(api.session(), { name: ProtocolError.name, message: 'Invalid operator session' });
  }
});
