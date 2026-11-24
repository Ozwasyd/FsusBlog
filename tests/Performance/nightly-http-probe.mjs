import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeApiError, decodeFrame } from '../../src/Contracts/aeds.ts';
import { decodeArticle, decodeArticleList, decodeSearch } from '../../src/Contracts/public-articles.ts';
import { FrameType, WireLimits, WireRoutes } from '../../src/Contracts/wire.generated.ts';
import { CURSOR_TOKEN, HEADERS, HEX64, createAedsClient, isSignedDecimal, openNdjsonLog, parseLoopbackOrigin, readBoundedJson, sha256 } from './nightly-owned-evidence.mjs';

const pageSize = 10;
const natural = value => Number.isSafeInteger(value) && value > 0;

const args = process.argv.slice(2);
assert.equal(args.length, 6, 'Usage: nightly-http-probe.mjs ORIGIN ORACLE_JSON PLAN_JSON ARTICLE_BYTES_JSON ACTUAL_NDJSON RESPONSES_DIRECTORY');
const [originText, oraclePath, planPath, articleBytesPath, actualPath, responsesPath] = args;
const origin = parseLoopbackOrigin(originText, 'http', 1024, 'Expected a private loopback HTTP fixture origin with an explicit port');
const { bytes: oracleBytes, data: oracle } = readBoundedJson(oraclePath, 1024 * 1024);
validateOracle(oracle);
const { bytes: planBytes, data: plan } = readBoundedJson(planPath, 64 * 1024);
const { bytes: articleBytes, data: byteReceipt } = readBoundedJson(articleBytesPath, 64 * 1024);
const sourceIdentity = validateSource();
const { search: canaries, unpublishedDetailIds } = plan.articleQueryFacts;

try { mkdirSync(responsesPath, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
assert(lstatSync(responsesPath).isDirectory() && readdirSync(responsesPath).length === 0, 'Expected an empty response evidence directory');
const actual = openNdjsonLog(actualPath);
const client = createAedsClient(origin, { truncate: true });
const deadline = performance.now() + 120_000;
let sequence = 0, generation = null, caseId = null;

function validateSource() {
  const planSha256 = sha256(planBytes);
  assert.equal(plan.format, 'fsusblog-v2-nightly-postgres-fixture-v2');
  assert.equal(plan.profile, oracle.profile);
  assert.equal(plan.activePublications, oracle.total);
  assert.equal(planSha256, oracle.fixtureSha256, 'PostgreSQL oracle plan digest');
  assert.match(plan.articlePlanSha256, HEX64, 'Article TSV digest');
  assert.equal(byteReceipt.version, 1);
  assert.equal(byteReceipt.profile, plan.profile);
  assert.equal(byteReceipt.planSha256, planSha256, 'PostgreSQL article byte receipt plan digest');
  assert.equal(byteReceipt.articlePlanSha256, plan.articlePlanSha256, 'PostgreSQL article byte receipt TSV digest');
  assert(natural(plan.revisions) && byteReceipt.verifiedRevisions === plan.revisions, 'Complete revision byte readback');

  const facts = plan.articleQueryFacts;
  assert.equal(facts.version, 1);
  const roles = [
    ['publicTitle', 'published', 3, 'title', 'titleSearchTerm', 'publicationId', 'originalBodySha256'],
    ['retainedBody', 'scheduled-update', 3, 'body', 'bodySearchTerm', 'publicationId', 'originalBodySha256'],
    ['pendingUpdate', 'scheduled-update', 5, 'body', 'pendingOnlyTerm', null, 'currentBodySha256'],
    ['archivedInterim', 'archived', 5, 'body', 'archiveInterimOnlyTerm', 'archiveSupersededReleaseId', 'archiveInterimBodySha256'],
    ['deletedPrior', 'deleted', 3, 'body', 'bodySearchTerm', 'historicalFirstPublicationId', 'originalBodySha256'],
  ];
  assert.deepEqual(Object.keys(facts.search).sort(), roles.map(([role]) => role).sort(), 'Sealed search roles');
  for (const [role, kind, revision, field, termKey, publicationKey, bodyHash] of roles) {
    const canary = facts.search[role];
    const { source, term } = canary;
    const article = plan.articleCases.find(row => row.kind === kind);
    assert.match(term, /^[a-z0-9]{1,128}$/, role);
    assert.equal(term, article[termKey], role);
    assert.equal(source.articleId, article.id, role);
    assert.equal(source.revision, revision, role);
    assert.equal(source.field, field, role);
    assert.equal(source.publicationId, publicationKey === null ? null : article[publicationKey], role);
    assert.equal(source.categoryId, article.category, role);
    assert.equal(source.tagId, article.tag, role);
    const active = source.revision === article.publicRevision && source.publicationId === article.publicationId;
    assert.deepEqual(canary.anonymousMatchIds, active ? [article.id] : [], role);
    for (const hash of [source.titleSha256, source.bodySha256, source.summarySha256]) assert.match(hash, HEX64, role);
    assert.equal(source.bodySha256, article[bodyHash], role);
    assert(Number.isSafeInteger(source.utf8Offset) && source.utf8Offset >= 0 && source.utf8Length === term.length &&
      natural(source.fieldBytes) && source.utf8Offset + source.utf8Length <= source.fieldBytes, role + ' source byte range');
  }
  assert.deepEqual(facts.unpublishedDetailIds, ['scheduled', 'archived', 'deleted'].map(kind => plan.articleCases.find(row => row.kind === kind).id));
  assert.deepEqual(oracle.unpublishedIds, facts.unpublishedDetailIds, 'PostgreSQL oracle unpublished detail roles');
  assert.deepEqual(oracle.negativeTerms, ['pendingUpdate', 'archivedInterim', 'deletedPrior'].map(role => facts.search[role].term),
    'PostgreSQL oracle hidden search terms');
  for (const [observed, expected] of [[oracle.titleCanary, facts.search.publicTitle], [oracle.bodyCanary, facts.search.retainedBody]]) {
    const { row, term } = observed;
    const { source } = expected;
    assert.equal(term, expected.term, 'PostgreSQL oracle public search term');
    assert.equal(row.id, source.articleId);
    assert.equal(row.revision, String(source.revision));
    assert.equal(row.publication, String(source.publicationId));
    assert.equal(row.revisionNo, source.revision);
    assert.equal(row.publicationNo, 1);
    assert.equal(row.category.id, source.categoryId);
    assert.deepEqual(row.tags.map(tag => tag.id), [source.tagId]);
    assert.equal(sha256(row.title), source.titleSha256);
    assert.equal(sha256(row.summary), source.summarySha256);
    assert.equal(row.bodySha256, source.bodySha256);
  }
  compareSourceRange(oracle.titleCanary.row.title, facts.search.publicTitle);
  return { planSha256, articlePlanSha256: plan.articlePlanSha256, articleByteReceiptSha256: sha256(articleBytes) };
}

function compareSourceRange(text, { term, source }) {
  const bytes = Buffer.from(text, 'utf8');
  assert.equal(bytes.length, source.fieldBytes, 'Search canary source length');
  const at = source.utf8Offset;
  assert.equal(bytes.subarray(at, at + source.utf8Length).toString('utf8').toLowerCase(), term, 'Search canary source byte range');
}

function validateOracle(value) {
  assert.equal(value.version, 1, 'Unexpected saved oracle version');
  assert(['pilot', 'nightly'].includes(value.profile), 'Unexpected saved oracle profile');
  assert.equal(value.total, value.profile === 'pilot' ? 17 : 85_000);
  assert.equal(value.rows.length, Math.min(value.total, WireLimits.SearchIndexPageSize));
  const rows = new Map();
  for (const [index, row] of value.rows.entries()) {
    validateRow(row, index + 1);
    assert(!rows.has(row.id), 'Repeated article in saved oracle ordering');
    rows.set(row.id, row);
  }
  for (const [row, rank] of [[value.last, value.total], [value.titleCanary.row, value.titleCanary.row.rank], [value.bodyCanary.row, value.bodyCanary.row.rank]]) {
    validateRow(row, rank);
    assert(rank <= value.total);
    if (rows.has(row.id)) assert.deepEqual(row, rows.get(row.id), 'Conflicting oracle article coordinates');
  }
  const terms = [value.titleCanary.term, value.bodyCanary.term, ...value.negativeTerms];
  assert.equal(value.negativeTerms.length, 3);
  assert.equal(new Set(terms).size, terms.length, 'Repeated search terms in saved oracle');
  for (const term of terms) assert.match(term, /^[a-z0-9]{1,128}$/);
  assert.equal(value.unpublishedIds.length, 3);
  assert.equal(new Set(value.unpublishedIds).size, 3);
  assert(value.unpublishedIds.every(id => natural(id) && !rows.has(id) && id !== value.last.id && id !== value.titleCanary.row.id && id !== value.bodyCanary.row.id),
    'Expected three distinct unpublished articles');
}

function validateRow(row, rank) {
  assert(natural(rank) && row.rank === rank && natural(row.id), 'Invalid article coordinates in saved oracle');
  assert(typeof row.createdAtUtc === 'string' && row.createdAtUtc.length > 0, 'Expected precise creation time in saved oracle');
  assert(typeof row.title === 'string' && row.title.length > 0 && typeof row.summary === 'string', 'Invalid saved article text');
  for (const key of ['createdAt', 'updatedAt', 'publishedAt', 'revisionNo', 'publicationNo'])
    assert(natural(row[key]), `Invalid saved article ${key}`);
  for (const key of ['revision', 'publication', 'rightsSnapshotId'])
    assert(isSignedDecimal(row[key], false), `Invalid saved article ${key}`);
  assert.match(row.bodySha256, HEX64);
  for (const entry of [row.category, ...row.tags])
    assert(natural(entry.id) && typeof entry.name === 'string' && entry.name.length > 0, 'Invalid saved taxonomy');
}

function saveResponse(name, bytes) {
  const file = join(responsesPath, name);
  const staging = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(staging, bytes, { flag: 'wx', mode: 0o600 });
    linkSync(staging, file);
  } finally {
    try { unlinkSync(staging); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function observe(id, path, status, frame) {
  caseId = id;
  const response = await client.fetch(path, Math.min(15_000, Math.ceil(deadline - performance.now())));
  const { body, headers } = response;
  const rawFile = `${String(++sequence).padStart(3, '0')}-${id}.aeds`;
  saveResponse(rawFile, body);
  actual.write({
    kind: 'request', caseId: id, method: 'GET', path, rawFile,
    expectedStatus: status, expectedFrame: frame, sha256: sha256(body),
    ...response.summary, generation: headers[HEADERS.generation] ?? null,
    indexPages: headers[HEADERS.pages] ?? null, error: response.error,
  });
  client.verifyResponse(response, status, id);
  const observed = headers[HEADERS.generation];
  assert(isSignedDecimal(observed), `${id} publication generation`);
  generation ??= observed;
  assert.equal(observed, generation, `${id} changed publication generation`);
  return { payload: decodeFrame(body, frame).payload, headers };
}

function compareCard(row, expected, format) {
  const label = `article ${expected.id} at rank ${expected.rank}`;
  for (const key of ['id', 'title', 'summary', 'createdAt', 'revisionNo', 'publicationNo'])
    assert.equal(row[key], expected[key], `${label} ${key}`);
  assert.equal(String(row.revision), expected.revision, `${label} revision`);
  assert.equal(String(row.publication), expected.publication, `${label} publication`);
  assert.deepEqual(row.category, expected.category, `${label} category`);
  assert.deepEqual(row.tags, expected.tags, `${label} ordered tags`);
  assert.equal(row.publishedAt, format === 'search' ? null : expected.publishedAt, `${label} publishedAt`);
  assert.equal(row.updatedAt, format === 'detail' ? expected.updatedAt : null, `${label} updatedAt`);
  assert.equal(row.scheduledPublishAt, null, `${label} published revision has no exposed pending schedule`);
}

function comparePage(result, expected, total, format) {
  assert.equal(result.total, total, 'Unexpected decoded result count');
  assert.equal(result.articles.length, expected.length, 'Unexpected decoded page length');
  result.articles.forEach((row, index) => compareCard(row, expected[index], format));
}

const homePath = page => WireRoutes.PublicList.replace('{page:int}', String(page)).replace('{size:int}', String(pageSize));

async function detail(id, expected) {
  const { payload } = await observe(id, WireRoutes.PublicArticle.replace('{id}', String(expected.id)), 200, FrameType.ArticleDetail);
  const row = decodeArticle(payload);
  compareCard(row, expected, 'detail');
  assert.equal(sha256(row.body), expected.bodySha256, `article ${expected.id} body SHA-256`);
  assert.equal(String(row.rights?.snapshotId), expected.rightsSnapshotId, `article ${expected.id} rights snapshot`);
  if (row.id === canaries.retainedBody.source.articleId) compareSourceRange(row.body, canaries.retainedBody);
}

async function search(id, term, expected) {
  const { payload } = await observe(id, `${WireRoutes.PublicSearch}?${new URLSearchParams({ q: term })}`, 200, FrameType.ArticleSearch);
  const result = decodeSearch(payload);
  comparePage(result, expected, expected.length, 'search');
  assert.equal(result.nextCursor, null);
}

try {
  actual.write({ kind: 'begin', origin: originText, profile: oracle.profile, oracleSha256: sha256(oracleBytes), total: oracle.total, ...sourceIdentity });
  const pageOne = decodeArticleList((await observe('article-list-first-page', homePath(1), 200, FrameType.ArticleList)).payload);
  comparePage(pageOne, oracle.rows.slice(0, pageSize), oracle.total, 'list');
  assert.match(pageOne.nextCursor, CURSOR_TOKEN);

  const pageTwo = decodeArticleList((await observe('article-list-continuation-page-2', `${homePath(2)}?${new URLSearchParams({ cursor: pageOne.nextCursor })}`, 200, FrameType.ArticleList)).payload);
  comparePage(pageTwo, oracle.rows.slice(pageSize, 2 * pageSize), oracle.total, 'list');
  if (oracle.total > 2 * pageSize) assert.match(pageTwo.nextCursor, CURSOR_TOKEN);
  else assert.equal(pageTwo.nextCursor, null);

  const index = await observe('legacy-public-summary-index-page-1', `${WireRoutes.PublicIndex}?page=1`, 200, FrameType.ArticleSearch);
  assert.equal(index.headers[HEADERS.pages], String(Math.ceil(oracle.total / WireLimits.SearchIndexPageSize)));
  comparePage(decodeSearch(index.payload), oracle.rows, oracle.rows.length, 'search');

  await detail('article-detail-first', oracle.rows[0]);
  await detail('article-detail-last', oracle.last);
  const bodyRow = oracle.bodyCanary.row;
  if (bodyRow.id !== oracle.rows[0].id && bodyRow.id !== oracle.last.id)
    await detail('article-detail-visible-scheduled-update', bodyRow);

  for (const id of unpublishedDetailIds) {
    const { payload, headers } = await observe(`article-detail-unpublished-${id}`, WireRoutes.PublicArticle.replace('{id}', String(id)), 404, FrameType.ApiError);
    const error = decodeApiError(payload, 404);
    assert.equal(error.message, 'Article not found.');
    assert.equal(error.traceId, headers[HEADERS.trace]);
  }

  await search('search-title-canary', canaries.publicTitle.term, [oracle.titleCanary.row]);
  await search('search-body-canary', canaries.retainedBody.term, [bodyRow]);
  for (const [index, canary] of [canaries.pendingUpdate, canaries.archivedInterim, canaries.deletedPrior].entries())
    await search(`search-negative-${index + 1}`, canary.term, []);

  actual.write({ kind: 'verification', verified: true, requests: sequence, generation });
  console.log(`Verified ${sequence} bounded public requests against the saved ${oracle.profile} oracle (generation ${generation}).`);
} catch (error) {
  actual.write({ kind: 'verification', verified: false, requests: sequence, caseId, error: error.message });
  console.error(`Nightly public HTTP probe failed at ${caseId ?? 'startup'}: ${error.message}`);
  process.exitCode = 1;
} finally {
  actual.close();
}
