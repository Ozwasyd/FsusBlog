import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { decodeApiError, decodeFrame } from '../../src/Contracts/aeds.ts';
import { decodeArticle, decodeArticleList, decodeSearch } from '../../src/Contracts/public-articles.ts';
import { FrameType, WireHeader, WireHeaders, WireLimits, WireRoutes } from '../../src/Contracts/wire.generated.ts';

const pageSize = 10;
const maxOracleBytes = 1024 * 1024;
const maxBodyBytes = WireHeader.HeaderSize + WireLimits.MaxPayloadBytes;
const maxSignedLong = 9223372036854775807n;
const binary = 'application/octet-stream';
const generationHeader = WireHeaders.SearchIndexGeneration.toLowerCase();
const pagesHeader = WireHeaders.SearchIndexPages.toLowerCase();
const traceHeader = WireHeaders.TraceId.toLowerCase();
const sha256 = value => createHash('sha256').update(value).digest('hex');
const natural = value => Number.isSafeInteger(value) && value > 0;
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= maxSignedLong;

const args = process.argv.slice(2);
assert.equal(args.length, 4, 'Usage: nightly-http-probe.mjs ORIGIN ORACLE_JSON ACTUAL_NDJSON RESPONSES_DIRECTORY');
const [originText, oraclePath, actualPath, responsesPath] = args;
assert.match(originText, /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/);
const origin = new URL(originText);
assert(origin.origin === originText && Number(origin.port) >= 1024, 'Expected a private loopback HTTP fixture origin with an explicit port');
const info = lstatSync(oraclePath);
assert(info.isFile() && info.size > 0 && info.size <= maxOracleBytes, 'Expected a bounded saved oracle file');
const oracleBytes = readFileSync(oraclePath);
assert.equal(oracleBytes.length, info.size, 'Saved oracle size changed');
const oracle = JSON.parse(oracleBytes.toString('utf8'));
validateOracle(oracle);

try {
  mkdirSync(responsesPath, { mode: 0o700 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
assert(lstatSync(responsesPath).isDirectory() && readdirSync(responsesPath).length === 0,
  'Expected an empty response evidence directory');
const actual = openSync(actualPath, 'wx', 0o600);
const deadline = performance.now() + 120_000;
let sequence = 0;
let generation = null;
let caseId = null;

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
  validateRow(value.last, value.total);
  if (rows.has(value.last.id))
    assert.deepEqual(value.last, rows.get(value.last.id), 'Conflicting final article coordinates');

  const terms = [value.titleCanary.term, value.bodyCanary.term, ...value.negativeTerms];
  assert.equal(value.negativeTerms.length, 3);
  assert.equal(new Set(terms).size, terms.length, 'Repeated search terms in saved oracle');
  for (const term of terms) assert.match(term, /^[a-z0-9]{1,128}$/);
  for (const { row } of [value.titleCanary, value.bodyCanary]) {
    validateRow(row, row.rank);
    assert(row.rank <= value.total);
    if (rows.has(row.id)) assert.deepEqual(row, rows.get(row.id), 'Conflicting search article coordinates');
  }
  assert.equal(value.unpublishedIds.length, 3);
  assert.equal(new Set(value.unpublishedIds).size, 3);
  assert(value.unpublishedIds.every(id => natural(id) && !rows.has(id) &&
    id !== value.last.id && id !== value.titleCanary.row.id && id !== value.bodyCanary.row.id),
  'Expected three distinct unpublished articles');
}

function validateRow(row, rank) {
  assert(natural(rank) && row.rank === rank && natural(row.id), 'Invalid article coordinates in saved oracle');
  assert(typeof row.createdAtUtc === 'string' && row.createdAtUtc.length > 0, 'Expected precise creation time in saved oracle');
  assert(typeof row.title === 'string' && row.title.length > 0 && typeof row.summary === 'string', 'Invalid saved article text');
  for (const key of ['createdAt', 'updatedAt', 'publishedAt', 'revisionNo', 'publicationNo'])
    assert(natural(row[key]), `Invalid saved article ${key}`);
  for (const key of ['revision', 'publication', 'rightsSnapshotId'])
    assert(decimal(row[key]) && row[key] !== '0', `Invalid saved article ${key}`);
  assert.match(row.bodySha256, /^[0-9a-f]{64}$/);
  for (const entry of [row.category, ...row.tags]) {
    assert(natural(entry.id) && typeof entry.name === 'string' && entry.name.length > 0, 'Invalid saved taxonomy');
  }
}

function log(entry) {
  writeFileSync(actual, JSON.stringify(entry) + '\n');
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

function request(path) {
  const started = performance.now();
  const allowedMs = Math.min(15_000, Math.ceil(deadline - started));
  if (allowedMs <= 0)
    return Promise.resolve({ body: Buffer.alloc(0), elapsedMs: 0, error: 'Fixture HTTP deadline reached' });

  return new Promise(resolve => {
    let status = null;
    let httpVersion = null;
    let headers = {};
    let length = 0;
    let finished = false;
    const chunks = [];
    const finish = error => {
      if (finished) return;
      finished = true;
      resolve({
        status, httpVersion, headers, error,
        body: Buffer.concat(chunks, length),
        elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
      });
    };
    const call = httpRequest(new URL(path, origin), {
      method: 'GET', agent: false, signal: AbortSignal.timeout(allowedMs),
      headers: { Accept: binary, 'Accept-Encoding': 'identity' },
    }, response => {
      status = response.statusCode;
      httpVersion = response.httpVersion;
      headers = response.headers;
      response.on('data', chunk => {
        const remaining = maxBodyBytes - length;
        if (chunk.length > remaining) {
          if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
          length = maxBodyBytes;
          finish('AEDS body exceeded the response budget');
          call.destroy();
          return;
        }
        chunks.push(chunk);
        length += chunk.length;
      });
      response.once('end', () => finish(response.complete ? null : 'HTTP response was incomplete'));
      response.once('error', error => finish(error.message));
    });
    call.once('error', error => finish(error.message));
    call.end();
  });
}

async function observe(id, path, status, frame) {
  caseId = id;
  const response = await request(path);
  const { body } = response;
  const headers = response.headers ?? {};
  const rawFile = `${String(++sequence).padStart(3, '0')}-${id}.aeds`;
  saveResponse(rawFile, body);
  log({
    kind: 'request', caseId: id, method: 'GET', path, rawFile,
    status: response.status ?? null, expectedStatus: status, expectedFrame: frame, httpVersion: response.httpVersion ?? null,
    elapsedMs: response.elapsedMs, bytes: body.length, sha256: sha256(body),
    contentLength: headers['content-length'] ?? null, contentType: headers['content-type'] ?? null,
    cacheControl: headers['cache-control'] ?? null, contentEncoding: headers['content-encoding'] ?? null,
    generation: headers[generationHeader] ?? null, indexPages: headers[pagesHeader] ?? null,
    traceId: headers[traceHeader] ?? null, error: response.error,
  });

  assert.equal(response.error, null, `${id} transport`);
  assert.equal(response.status, status, `${id} HTTP status`);
  assert.equal(response.httpVersion, '1.1', `${id} HTTP protocol`);
  assert.equal(headers['content-type'], binary, `${id} media type`);
  assert.equal(headers['cache-control'], 'no-store', `${id} cache policy`);
  assert.equal(headers['content-encoding'] ?? 'identity', 'identity', `${id} content encoding`);
  assert.equal(headers['content-length'], String(body.length), `${id} HTTP content length`);
  const observed = headers[generationHeader];
  assert(decimal(observed), `${id} publication generation`);
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

function homePath(page) {
  return WireRoutes.PublicList.replace('{page:int}', String(page)).replace('{size:int}', String(pageSize));
}

async function detail(id, expected) {
  const path = WireRoutes.PublicArticle.replace('{id}', String(expected.id));
  const { payload } = await observe(id, path, 200, FrameType.ArticleDetail);
  const row = decodeArticle(payload);
  compareCard(row, expected, 'detail');
  assert.equal(sha256(row.body), expected.bodySha256, `article ${expected.id} body SHA-256`);
  assert.equal(String(row.rights?.snapshotId), expected.rightsSnapshotId, `article ${expected.id} rights snapshot`);
}

async function search(id, term, expected) {
  const query = new URLSearchParams({ q: term });
  const { payload } = await observe(id, `${WireRoutes.PublicSearch}?${query}`, 200, FrameType.ArticleSearch);
  const result = decodeSearch(payload);
  comparePage(result, expected, expected.length, 'search');
  assert.equal(result.nextCursor, null);
}

try {
  log({ kind: 'begin', origin: originText, profile: oracle.profile, oracleSha256: sha256(oracleBytes), total: oracle.total });
  const first = await observe('article-list-first-page', homePath(1), 200, FrameType.ArticleList);
  const pageOne = decodeArticleList(first.payload);
  comparePage(pageOne, oracle.rows.slice(0, pageSize), oracle.total, 'list');
  assert.match(pageOne.nextCursor, /^[A-Za-z0-9_-]{155}$/);

  const continuation = new URLSearchParams({ cursor: pageOne.nextCursor });
  const second = await observe('article-list-continuation-page-2', `${homePath(2)}?${continuation}`, 200, FrameType.ArticleList);
  const pageTwo = decodeArticleList(second.payload);
  comparePage(pageTwo, oracle.rows.slice(pageSize, 2 * pageSize), oracle.total, 'list');
  if (oracle.total > 2 * pageSize) assert.match(pageTwo.nextCursor, /^[A-Za-z0-9_-]{155}$/);
  else assert.equal(pageTwo.nextCursor, null);

  const index = await observe('legacy-public-summary-index-page-1', `${WireRoutes.PublicIndex}?page=1`, 200, FrameType.ArticleSearch);
  assert.equal(index.headers[pagesHeader], String(Math.ceil(oracle.total / WireLimits.SearchIndexPageSize)));
  comparePage(decodeSearch(index.payload), oracle.rows, oracle.rows.length, 'search');

  await detail('article-detail-first', oracle.rows[0]);
  await detail('article-detail-last', oracle.last);
  const bodyRow = oracle.bodyCanary.row;
  if (bodyRow.id !== oracle.rows[0].id && bodyRow.id !== oracle.last.id)
    await detail('article-detail-visible-scheduled-update', bodyRow);

  for (const id of oracle.unpublishedIds) {
    const path = WireRoutes.PublicArticle.replace('{id}', String(id));
    const { payload, headers } = await observe(`article-detail-unpublished-${id}`, path, 404, FrameType.ApiError);
    const error = decodeApiError(payload, 404);
    assert.equal(error.message, 'Article not found.');
    assert.equal(error.traceId, headers[traceHeader]);
  }

  await search('search-title-canary', oracle.titleCanary.term, [oracle.titleCanary.row]);
  await search('search-body-canary', oracle.bodyCanary.term, [bodyRow]);
  for (const [index, term] of oracle.negativeTerms.entries())
    await search(`search-negative-${index + 1}`, term, []);

  log({ kind: 'verification', verified: true, requests: sequence, generation });
  console.log(`Verified ${sequence} bounded public requests against the saved ${oracle.profile} oracle (generation ${generation}).`);
} catch (error) {
  log({ kind: 'verification', verified: false, requests: sequence, caseId, error: error.message });
  console.error(`Nightly public HTTP probe failed at ${caseId ?? 'startup'}: ${error.message}`);
  process.exitCode = 1;
} finally {
  closeSync(actual);
}
