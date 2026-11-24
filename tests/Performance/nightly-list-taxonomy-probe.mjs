import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decodeApiError, decodeFrame } from '../../src/Contracts/aeds.ts';
import { decodeArticleList } from '../../src/Contracts/public-articles.ts';
import { FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts';
import { CURSOR_TOKEN, HEADERS, HEX64, isSignedDecimal, openNightlyWitness, parseNdjson, sha256 } from './nightly-owned-evidence.mjs';

const total = 85_000, size = 10, lastPage = total / size, middlePage = 4_250, bounded = 32 * 1024;
const positive = value => Number.isSafeInteger(value) && value > 0;
const positiveDecimal = value => isSignedDecimal(value, false);
const pathFor = (route, page, id) => {
  const path = route.replace('{page:int}', String(page)).replace('{size:int}', String(size));
  return id === undefined ? path : path.replace('{id:int}', String(id));
};
const home = page => pathFor(WireRoutes.PublicList, page);
const nextQuery = cursor => '?' + new URLSearchParams({ cursor }).toString();

const witness = openNightlyWitness('list-taxonomy', 'list-taxonomy-oracle.ndjson', 24 * 1024 * 1024, total + 1, {
  client: { maxBytes: bounded, truncate: true, overflowMessage: 'AEDS response exceeded the fixture body cap.',
    deadlineMessage: 'Fixture business epoch ended before this request.' },
});
const { read, oracleBytes: rankBytes, scope, rows, shortOracleBytes, shortOracle, release, owner, origin, log } = witness;
assert(scope.total === total && rows.length === total, 'Expected the verified full PostgreSQL rank vector.');
assert(Number(scope.dueUnixMs) > Date.now(), 'Rank oracle business epoch is unavailable.');
assert.equal(shortOracle.total, total);

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
    positiveDecimal(created) && positiveDecimal(revision) && positiveDecimal(publication) && positive(publishedMs) &&
    positive(category) && category <= categories.length && positive(tag) && tag <= tags.length &&
    HEX64.test(titleHash) && HEX64.test(summaryHash), 'Invalid or duplicate ranked PostgreSQL coordinate.');
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
  assert.equal(result.total, count, 'Wrong public page count or width.');
  assert.equal(result.articles.length, expected.length, 'Wrong public page count or width.');
  result.articles.forEach((card, i) => {
    const [id, created, revision, publication, publishedAt, category, tag, titleHash, summaryHash] = expected[i];
    const label = 'Mismatched ranked article ' + id;
    assert.equal(card.id, id, label);
    assert.equal(card.createdAt, Number(BigInt(created) / 1_000n), label);
    assert.equal(String(card.revision), revision, label);
    assert.equal(String(card.publication), publication, label);
    assert.equal(card.publishedAt, publishedAt, label);
    assert.deepEqual(card.category, { id: category, name: scope.categories[category - 1][1] }, label);
    assert.deepEqual(card.tags, [{ id: tag, name: scope.tags[tag - 1][1] }], label);
    assert.equal(sha256(card.title), titleHash, label);
    assert.equal(sha256(card.summary), summaryHash, label);
    assert.equal(card.revisionNo, 3, label);
    assert.equal(card.publicationNo, 1, label);
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
    entry.generation === generation && entry.error === null, 'Unverified prefix page ' + ordinal);
  const body = read('http-responses/' + file, bounded);
  active.body = body;
  assert.equal(entry.bytes, body.length);
  assert.equal(entry.sha256, sha256(body));
  const outgoing = page(decodeFrame(body, FrameType.ArticleList).payload, rows.slice((ordinal - 1) * size, ordinal * size), total);
  assert.match(outgoing, CURSOR_TOKEN);
  return { outgoing, bodySha256: entry.sha256, traceId: entry.traceId };
}

const chain = createHash('sha256');
const seenCursors = new Set();
let generation = null, active, requestCount = 0;

async function observe(caseId, path, incoming, expected, count, retain = false, refused = false) {
  active = { stage: 'request', caseId, path, body: Buffer.alloc(0) };
  const response = await witness.fetch(path + (incoming ? nextQuery(incoming) : ''), Math.min(15_000, Number(scope.dueUnixMs) - Date.now()));
  const { body, headers } = response;
  active.body = body;
  const event = { kind: 'request', number: ++requestCount, caseId, path, status: response.status,
    elapsedMs: response.elapsedMs, bytes: body.length, bodySha256: sha256(body),
    incomingSha256: incoming ? sha256(incoming) : null, generation: headers[HEADERS.generation] ?? null,
    traceId: response.traceId };
  let outgoing;
  try {
    witness.verifyResponse(response, refused ? 400 : 200, caseId);
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
      event.rawFile = caseId + '.aeds';
      witness.save(event.rawFile, body);
    }
    const { outgoing: _cursor, ...receipt } = event;
    log.write(receipt);
  }
}

const recordCase = (id, pageNo, ranks, event, extra) => log.write({
  kind: 'case', id, page: pageNo, ranks, traceId: event.traceId, bodySha256: event.bodySha256,
  incomingSha256: event.incomingSha256 ?? null, outgoingSha256: event.outgoingSha256, ...extra,
});

const retained = new Map([
  [middlePage - 1, 'before-middle'], [middlePage, 'article-list-middle-page'],
  [lastPage - 1, 'before-final'], [lastPage, 'article-list-last-page'],
]);
try {
  active = { stage: 'prefix-receipt' };
  const shortBytes = read('http-actual.ndjson');
  const short = parseNdjson(shortBytes, 32);
  const shortEnd = short.at(-1);
  generation = shortEnd?.generation ?? null;
  assert(short[0]?.kind === 'begin' && short[0].origin === origin.origin && short[0].profile === 'nightly' &&
    short[0].oracleSha256 === sha256(shortOracleBytes) && shortEnd?.kind === 'verification' && shortEnd.verified === true &&
    shortEnd.requests === short.length - 2 && positiveDecimal(generation), 'Unverified or different first two pages.');
  log.write({ kind: 'begin', generation, serverPid: Number(owner.get('server_pid')), release,
    fixtureSha256: scope.fixtureSha256, readbackSha256: scope.readbackSha256, dueUnixMs: scope.dueUnixMs,
    rankOracleSha256: sha256(rankBytes), prefixSha256: sha256(shortBytes), plan: 'not-collected' });
  const first = prefix(short, 1, 'article-list-first-page', null);
  const second = prefix(short, 2, 'article-list-continuation-page-2', first.outgoing);
  assert.notEqual(first.outgoing, second.outgoing, 'The retained prefix repeated a cursor.');
  active = { stage: 'listener-before' };
  witness.checkListener();
  for (const [number, entry] of [first, second].entries()) {
    const outgoingHash = sha256(entry.outgoing);
    seenCursors.add(outgoingHash);
    chain.update(JSON.stringify([number + 1, entry.bodySha256, outgoingHash]) + '\n');
  }
  recordCase('article-list-first-page', 1, [1, 10], { ...first, outgoingSha256: sha256(first.outgoing) }, { prefixSequence: 1 });
  let incoming = second.outgoing, final;
  for (let number = 3; number <= lastPage; number++) {
    const start = (number - 1) * size;
    const id = retained.get(number);
    const event = await observe(id ?? 'home-' + number, home(number), incoming, rows.slice(start, start + size), total, id !== undefined);
    if (number < lastPage) {
      assert.match(event.outgoing, CURSOR_TOKEN, 'A nonterminal page omitted its emitted cursor.');
      assert(!seenCursors.has(event.outgoingSha256), 'A cursor was repeated.');
      seenCursors.add(event.outgoingSha256);
    } else assert.equal(event.outgoing, null, 'The final page must be terminal.');
    chain.update(JSON.stringify([number, event.bodySha256, event.outgoingSha256]) + '\n');
    if (number === middlePage || number === lastPage) {
      recordCase(id, number, [start + 1, start + size], event, { request: event.number, rawFile: event.rawFile });
      if (number === lastPage) final = event;
    }
    incoming = event.outgoing;
  }
  recordCase('article-list-deep-cursor', lastPage, [84_991, 85_000], final, {
    anchorRank: 84_990, request: final.number, rawFile: final.rawFile,
    observedPrefixPages: lastPage - 1, orderedChainSha256: chain.digest('hex'), sharedWarmChain: true,
  });

  let categoryCursor;
  for (const [label, route, buckets] of [['category', WireRoutes.CategoryArticles, categories], ['tag', WireRoutes.TagArticles, tags]]) {
    const records = buckets[0];
    const largest = await observe(label + '-largest', pathFor(route, 1, 1), null, records.slice(0, size), records.length, true);
    assert.match(largest.outgoing, CURSOR_TOKEN);
    const continuation = await observe(label + '-largest-continuation', pathFor(route, 2, 1), largest.outgoing,
      records.slice(size, 2 * size), records.length, true);
    assert.match(continuation.outgoing, CURSOR_TOKEN);
    assert.equal((await observe(label + '-empty', pathFor(route, 1, buckets.length), null, [], 0, true)).outgoing, null);
    if (label === 'category') categoryCursor = largest.outgoing;
  }
  await observe('cross-scope-cursor-refused', pathFor(WireRoutes.TagArticles, 2, 1), categoryCursor, [], 0, true, true);
  active = { stage: 'completion' };
  assert.equal(requestCount, lastPage - 2 + 7, 'The full continuation or taxonomy witness is incomplete.');
  assert.equal(seenCursors.size, lastPage - 1, 'The home chain did not observe each nonterminal cursor.');
  witness.checkListener();
  assert(Number(scope.dueUnixMs) > Date.now(), 'Fixture business epoch changed during the chain.');
  log.write({ kind: 'verification', verified: true, homePages: lastPage, newRequests: requestCount, generation, plan: 'not-collected', terminal: true });
} catch (error) {
  log.write({ kind: 'verification', verified: false, newRequests: requestCount, generation, stage: active.stage,
    caseId: active.caseId ?? null, path: active.path ?? null,
    firstFailureRaw: active.body ? 'first-failure.aeds' : null, error: error.message });
  if (active.body) witness.save('first-failure.aeds', active.body);
  console.error('Nightly list/taxonomy probe failed:', error.message);
  process.exitCode = 1;
} finally {
  witness.close();
}
