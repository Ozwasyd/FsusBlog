import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { Agent, get } from 'node:http';
import { join } from 'node:path';
import { decodeApiError, decodeFrame } from '../../src/Contracts/aeds.ts';
import { decodeArticleList } from '../../src/Contracts/public-articles.ts';
import { FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts';

const total = 85_000;
const size = 10;
const lastPage = total / size;
const middlePage = 4_250;
const binary = 'application/octet-stream';
const bounded = 32 * 1024;
const digest = /^[0-9a-f]{64}$/;
const token = /^[A-Za-z0-9_-]{155}$/;
const decoder = new TextDecoder('utf-8', { fatal: true });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const positive = value => Number.isSafeInteger(value) && value > 0;
const decimal = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) &&
  BigInt(value) <= 9223372036854775807n;
const home = page => pathFor(WireRoutes.PublicList, page);
const nextQuery = cursor => '?' + new URLSearchParams({ cursor }).toString();

assert.equal(process.argv.length, 3, 'Usage: nightly-list-taxonomy-probe.mjs OWNED_NIGHTLY_EVIDENCE_DIRECTORY');
const evidence = realpathSync(process.argv[2]);
const rootInfo = lstatSync(evidence);
assert(rootInfo.isDirectory() && rootInfo.uid === process.geteuid() && (rootInfo.mode & 0o077) === 0,
  'Expected the private evidence directory of this nightly run.');

function read(relative, limit = 1_048_576) {
  const path = join(evidence, relative);
  const info = lstatSync(path);
  assert(info.isFile() && info.uid === rootInfo.uid && (info.mode & 0o077) === 0 && info.size > 0 && info.size <= limit,
    'Invalid owned evidence file: ' + relative);
  const bytes = readFileSync(path);
  assert.equal(bytes.length, info.size, 'Evidence size changed: ' + relative);
  return bytes;
}

function ndjson(bytes, maxRows) {
  const rows = [];
  let start = 0;
  while (start < bytes.length) {
    const end = bytes.indexOf(10, start);
    assert(end > start && end - start <= 16_384 && rows.length < maxRows, 'Invalid bounded NDJSON record.');
    rows.push(JSON.parse(decoder.decode(bytes.subarray(start, end))));
    start = end + 1;
  }
  return rows;
}

function pathFor(route, page, id) {
  const path = route.replace('{page:int}', String(page)).replace('{size:int}', String(size));
  return id === undefined ? path : path.replace('{id:int}', String(id));
}

const rankBytes = read('list-taxonomy-oracle.ndjson', 24 * 1024 * 1024);
const [scope, ...rows] = ndjson(rankBytes, total + 1);
assert(scope?.version === 1 && scope.verified === true && scope.total === total && rows.length === total,
  'Expected the verified full PostgreSQL rank vector.');
assert.match(scope.siteId, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
assert(decimal(scope.watermark) && decimal(scope.dueUnixMs) && positive(Number(scope.dueUnixMs)) &&
  Number(scope.dueUnixMs) > Date.now(),
  'Rank oracle business epoch is unavailable.');
assert.equal(scope.fixtureSha256, sha256(read('plan.json')));
assert.equal(scope.readbackSha256, sha256(read('readback.json')));
assert.equal(scope.readbackSha256, decoder.decode(read('readback.sha256', 128)).trim());

const shortOracleBytes = read('http-oracle.json');
const shortOracle = JSON.parse(decoder.decode(shortOracleBytes));
assert.equal(shortOracle.profile, 'nightly');
assert.equal(shortOracle.total, total);
for (const key of ['fixtureSha256', 'readbackSha256', 'watermark']) assert.equal(shortOracle[key], scope[key]);

const release = JSON.parse(decoder.decode(read('http-release-binding.json', 4096)));
for (const key of ['fsusblogCommit', 'fsusuiCommit']) assert.match(release[key], /^[0-9a-f]{40}$/);
for (const key of ['payloadManifestSha256', 'serverSha256', 'migrateSha256']) assert.match(release[key], digest);
const run = decoder.decode(read('run.txt', 16_384)).split('\n');
assert(run.includes(release.fsusblogCommit) && run.includes('profile=nightly') &&
  run.includes('due_unix_ms=' + scope.dueUnixMs), 'Release, fixture, or business epoch differs from the owner run.');

const owner = new Map();
for (const line of decoder.decode(read('http-server.txt', 4096)).trimEnd().split('\n')) {
  const index = line.indexOf('=');
  const key = line.slice(0, index);
  assert(index > 0 && !owner.has(key), 'Invalid Kestrel ownership record.');
  owner.set(key, line.slice(index + 1));
}
const origin = new URL(owner.get('origin'));
assert(origin.origin === owner.get('origin') && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin.origin) &&
  Number(origin.port) >= 1024 && owner.get('readiness') === '204' && !owner.has('server_exit'),
  'This exact private Kestrel process must still be serving.');
function checkListener() {
  for (const key of ['owner_pid', 'postgres_pid', 'server_pid']) {
    const pid = Number(owner.get(key));
    assert(positive(pid) && pid > 1, 'Missing owned process: ' + key);
    process.kill(pid, 0);
  }
  execFileSync('lsof', ['-n', '-P', '-a', '-p', owner.get('server_pid'),
    '-iTCP@127.0.0.1:' + origin.port, '-sTCP:LISTEN'], { timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] });
}

function catalog(name, entries, count, largest) {
  assert(Array.isArray(entries) && entries.length === count, 'Wrong ' + name + ' roster.');
  entries.forEach(([id, label, members], index) => {
    assert(id === index + 1 && typeof label === 'string' && label.length > 0 && Number.isSafeInteger(members) &&
      (id === 1 ? members === largest : id === count ? members === 0 : members > 0 && members < largest),
    'Wrong ' + name + ' maximum or existing empty bucket.');
  });
  return Array.from({ length: count }, () => []);
}

const categories = catalog('category', scope.categories, 32, 42_500);
const tags = catalog('tag', scope.tags, 128, 15_937);
const ids = new Set();
let preceding;
for (const row of rows) {
  const [id, created, revision, publication, publishedMs, category, tag, titleHash, summaryHash] = row;
  assert(row.length === 9 && positive(id) && (id <= 80_000 || id >= 85_001 && id <= 90_000) && !ids.has(id) &&
    decimal(created) && decimal(revision) && decimal(publication) && positive(publishedMs) &&
    positive(category) && category <= categories.length && positive(tag) && tag <= tags.length &&
    digest.test(titleHash) && digest.test(summaryHash), 'Invalid or duplicate ranked PostgreSQL coordinate.');
  if (preceding)
    assert(BigInt(created) < BigInt(preceding[1]) || created === preceding[1] && id < preceding[0],
      'The saved rank vector is not ordered by exact creation time and article ID.');
  ids.add(id);
  categories[category - 1].push(row);
  tags[tag - 1].push(row);
  preceding = row;
}
assert.deepEqual(categories.map(bucket => bucket.length), scope.categories.map(entry => entry[2]));
assert.deepEqual(tags.map(bucket => bucket.length), scope.tags.map(entry => entry[2]));

function page(payload, expected, count) {
  const result = decodeArticleList(payload);
  assert.equal(result.total, count, 'Wrong public result total.');
  assert.equal(result.articles.length, expected.length, 'Wrong public page width.');
  result.articles.forEach((card, i) => {
    const [id, created, revision, publication, publishedAt, category, tag, titleHash, summaryHash] = expected[i];
    assert.deepEqual(
      [card.id, card.createdAt, String(card.revision), String(card.publication), card.publishedAt,
        card.category, card.tags, sha256(card.title), sha256(card.summary), card.revisionNo, card.publicationNo],
      [id, Number(BigInt(created) / 1_000n), revision, publication, publishedAt,
        { id: category, name: scope.categories[category - 1][1] }, [{ id: tag, name: scope.tags[tag - 1][1] }],
        titleHash, summaryHash, 3, 1], 'Mismatched ranked article ' + id);
  });
  return result.nextCursor;
}

function prefix(short, ordinal, id, incoming) {
  const entry = short[ordinal];
  const file = String(ordinal).padStart(3, '0') + '-' + id + '.aeds';
  active = { stage: 'prefix-decode', caseId: id, path: home(ordinal) };
  assert(entry?.kind === 'request' && entry.caseId === id && entry.rawFile === file &&
    entry.path === home(ordinal) + (incoming ? nextQuery(incoming) : '') && entry.status === 200 &&
    entry.method === 'GET' && entry.expectedFrame === FrameType.ArticleList &&
    entry.generation === generation && entry.error === null,
  'Unverified prefix page ' + ordinal);
  const body = read('http-responses/' + file, bounded);
  active.body = body;
  assert.equal(entry.bytes, body.length);
  assert.equal(entry.sha256, sha256(body));
  const outgoing = page(decodeFrame(body, FrameType.ArticleList).payload, rows.slice((ordinal - 1) * size, ordinal * size), total);
  assert.match(outgoing, token);
  return { outgoing, bodySha256: entry.sha256, traceId: entry.traceId };
}

const output = join(evidence, 'list-taxonomy');
mkdirSync(output, { mode: 0o700 });
const log = openSync(join(output, 'actual.ndjson'), 'wx', 0o600);
const agent = new Agent({ keepAlive: true, maxSockets: 1 });
const chain = createHash('sha256');
const seenCursors = new Set();
let generation = null;
let active;
let requestCount = 0;

function record(value) {
  writeFileSync(log, JSON.stringify(value) + '\n');
}

function save(file, body) {
  writeFileSync(join(output, file + '.aeds'), body, { flag: 'wx', mode: 0o600 });
}

async function request(path, incoming) {
  const chunks = [];
  let bytes = 0;
  let response;
  let failure = null;
  const start = performance.now();
  try {
    const remaining = Number(scope.dueUnixMs) - Date.now();
    assert(remaining > 0, 'Fixture business epoch ended before this request.');
    response = await new Promise((resolve, reject) => get(new URL(path + (incoming ? nextQuery(incoming) : ''), origin),
      { agent, signal: AbortSignal.timeout(Math.min(15_000, remaining)),
        headers: { Accept: binary, 'Accept-Encoding': 'identity' } }, resolve).once('error', reject));
    for await (const chunk of response) {
      if (bytes + chunk.length > bounded) {
        chunks.push(chunk.subarray(0, bounded - bytes));
        bytes = bounded;
        throw new Error('AEDS response exceeded the fixture body cap.');
      }
      chunks.push(chunk);
      bytes += chunk.length;
    }
    assert(response.complete, 'Incomplete HTTP response.');
  } catch (error) {
    failure = error.message;
  }
  return { status: response?.statusCode ?? null, version: response?.httpVersion ?? null,
    headers: response?.headers ?? {}, body: Buffer.concat(chunks, bytes),
    milliseconds: Math.round((performance.now() - start) * 1000) / 1000, failure };
}

async function observe(caseId, path, incoming, expected, count, retain = false, refused = false) {
  active = { stage: 'request', caseId, path, body: Buffer.alloc(0) };
  const response = await request(path, incoming);
  active.body = response.body;
  const { body, headers } = response;
  const event = { kind: 'request', number: ++requestCount, caseId, path, status: response.status,
    elapsedMs: response.milliseconds, bytes: body.length, bodySha256: sha256(body),
    incomingSha256: incoming ? sha256(incoming) : null, generation: headers[WireHeaders.SearchIndexGeneration.toLowerCase()] ?? null,
    traceId: headers[WireHeaders.TraceId.toLowerCase()] ?? null };
  let outgoing;
  try {
    assert.equal(response.failure, null, caseId + ' transport');
    assert.equal(response.status, refused ? 400 : 200, caseId + ' HTTP status');
    assert.equal(response.version, '1.1');
    assert.equal(headers['content-type'], binary);
    assert.equal(headers['cache-control'], 'no-store');
    assert.equal(headers['content-encoding'] ?? 'identity', 'identity');
    assert.equal(headers['content-length'], String(body.length));
    assert.equal(event.generation, generation, 'Publication generation changed.');
    assert(typeof event.traceId === 'string' && event.traceId.length > 0, 'Missing Kestrel trace identity.');
    if (refused) {
      const error = decodeApiError(decodeFrame(body, FrameType.ApiError).payload, 400);
      assert.equal(error.details, 'article_cursor_invalid');
      assert.equal(error.traceId, event.traceId);
      return event;
    }
    outgoing = page(decodeFrame(body, FrameType.ArticleList).payload, expected, count);
    return event;
  } finally {
    event.outgoingSha256 = outgoing ? sha256(outgoing) : null;
    event.outgoing = outgoing ?? null;
    if (retain) {
      save(caseId, body);
      event.rawFile = caseId + '.aeds';
    }
    const { outgoing: _cursor, ...receipt } = event;
    record(receipt);
  }
}

const retained = new Map([
  [middlePage - 1, 'before-middle'], [middlePage, 'article-list-middle-page'],
  [lastPage - 1, 'before-final'], [lastPage, 'article-list-last-page'],
]);
try {
  active = { stage: 'prefix-receipt' };
  const shortBytes = read('http-actual.ndjson');
  const short = ndjson(shortBytes, 32);
  const shortEnd = short.at(-1);
  generation = shortEnd?.generation ?? null;
  assert(short[0]?.kind === 'begin' && short[0].origin === origin.origin && short[0].profile === 'nightly' &&
    short[0].oracleSha256 === sha256(shortOracleBytes) && shortEnd?.kind === 'verification' && shortEnd.verified === true &&
    shortEnd.requests === short.length - 2 && decimal(generation), 'Unverified or different first two pages.');
  record({ kind: 'begin', generation, serverPid: Number(owner.get('server_pid')), release,
    fixtureSha256: scope.fixtureSha256, readbackSha256: scope.readbackSha256, dueUnixMs: scope.dueUnixMs,
    rankOracleSha256: sha256(rankBytes), prefixSha256: sha256(shortBytes), plan: 'not-collected' });
  const first = prefix(short, 1, 'article-list-first-page', null);
  const second = prefix(short, 2, 'article-list-continuation-page-2', first.outgoing);
  assert.notEqual(first.outgoing, second.outgoing, 'The retained prefix repeated a cursor.');
  active = { stage: 'listener-before' };
  checkListener();
  seenCursors.add(sha256(first.outgoing));
  seenCursors.add(sha256(second.outgoing));
  for (const [number, entry] of [first, second].entries())
    chain.update(JSON.stringify([number + 1, entry.bodySha256, sha256(entry.outgoing)]) + '\n');
  record({ kind: 'case', id: 'article-list-first-page', page: 1, ranks: [1, 10], prefixSequence: 1,
    bodySha256: first.bodySha256, traceId: first.traceId, incomingSha256: null, outgoingSha256: sha256(first.outgoing) });
  let incoming = second.outgoing;
  let final;
  for (let number = 3; number <= lastPage; number++) {
    const start = (number - 1) * size;
    const id = retained.get(number);
    const event = await observe(id ?? 'home-' + number, home(number), incoming, rows.slice(start, start + size), total, id !== undefined);
    if (number < lastPage) {
      assert.match(event.outgoing, token, 'A nonterminal page omitted its emitted cursor.');
      assert(!seenCursors.has(event.outgoingSha256), 'A cursor was repeated.');
      seenCursors.add(event.outgoingSha256);
    } else {
      assert.equal(event.outgoing, null, 'The final page must be terminal.');
    }
    chain.update(JSON.stringify([number, event.bodySha256, event.outgoingSha256]) + '\n');
    if (number === middlePage || number === lastPage) {
      record({ kind: 'case', id, page: number, ranks: [start + 1, start + size], request: event.number,
        traceId: event.traceId, bodySha256: event.bodySha256, rawFile: event.rawFile,
        incomingSha256: event.incomingSha256, outgoingSha256: event.outgoingSha256 });
      if (number === lastPage) final = event;
    }
    incoming = event.outgoing;
  }
  record({ kind: 'case', id: 'article-list-deep-cursor', page: lastPage, ranks: [84_991, 85_000], anchorRank: 84_990,
    request: final.number, traceId: final.traceId, bodySha256: final.bodySha256, rawFile: final.rawFile,
    incomingSha256: final.incomingSha256, outgoingSha256: final.outgoingSha256,
    observedPrefixPages: lastPage - 1, orderedChainSha256: chain.digest('hex'), sharedWarmChain: true });

  let categoryCursor;
  for (const [label, route, buckets] of [['category', WireRoutes.CategoryArticles, categories], ['tag', WireRoutes.TagArticles, tags]]) {
    const records = buckets[0];
    const largest = await observe(label + '-largest', pathFor(route, 1, 1), null, records.slice(0, size), records.length, true);
    assert.match(largest.outgoing, token);
    const continuation = await observe(label + '-largest-continuation', pathFor(route, 2, 1), largest.outgoing,
      records.slice(size, 2 * size), records.length, true);
    assert.match(continuation.outgoing, token);
    const empty = await observe(label + '-empty', pathFor(route, 1, buckets.length), null, [], 0, true);
    assert.equal(empty.outgoing, null);
    if (label === 'category') categoryCursor = largest.outgoing;
  }
  await observe('cross-scope-cursor-refused', pathFor(WireRoutes.TagArticles, 2, 1), categoryCursor, [], 0, true, true);
  active = { stage: 'completion' };
  assert.equal(requestCount, lastPage - 2 + 7, 'The full continuation or taxonomy witness is incomplete.');
  assert.equal(seenCursors.size, lastPage - 1, 'The home chain did not observe each nonterminal cursor.');
  checkListener();
  assert(Number(scope.dueUnixMs) > Date.now(), 'Fixture business epoch changed during the chain.');
  record({ kind: 'verification', verified: true, homePages: lastPage, newRequests: requestCount, generation,
    plan: 'not-collected', terminal: true });
} catch (error) {
  record({ kind: 'verification', verified: false, newRequests: requestCount, generation, stage: active.stage,
    caseId: active.caseId ?? null, path: active.path ?? null,
    firstFailureRaw: active.body ? 'first-failure.aeds' : null, error: error.message });
  if (active.body) save('first-failure', active.body);
  console.error('Nightly list/taxonomy probe failed:', error.message);
  process.exitCode = 1;
} finally {
  agent.destroy();
  closeSync(log);
}
