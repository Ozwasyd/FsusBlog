import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hexFixture } from './fixture-source.ts';
import { test, type TestContext } from 'node:test';
import { ProtocolError, encodeFrame } from '../../src/Contracts/aeds.ts';
import {
  createCorpusSearch, decodeCorpusDocuments, decodeLocalSearchResult, encodeLocalSearchResult, normalizeLocalSearchQuery,
  normalizePublicSearchSort, queryCorpusPage, scoreAdmittedCorpusPage, searchCorpus, searchShortAsciiPrefixes,
  searchTerms, verifySearchGeneration, type CompactSearchStorage, type CorpusSearch, type PersistedCompactCorpus,
} from '../../src/Contracts/local-search.ts';
import { FrameType, WireHeaders, WireLayouts as L, WireRoutes } from '../../src/Contracts/wire.generated.ts';

const fixtures = (name: string) =>
  Uint8Array.from(hexFixture(`${name}.hex`));
const packageBytes = fixtures('search-fspk-v4');
const expected = fixtures('search-fsr4');

test('FSPK v4 indexes a body-only term and produces the fixed FSR4 result', () => {
  assert.deepEqual(searchTerms('foo ＦＯＯ'), [0xf6a5c420, 0xf6a5c420]);
  const shard = queryCorpusPage(packageBytes, searchTerms('needle'));
  assert.deepEqual([...shard.matches.keys()], [42]);
  assert.deepEqual([...queryCorpusPage(packageBytes, searchTerms('need')).matches.keys()], [42]);
  assert.deepEqual([...queryCorpusPage(packageBytes, searchTerms('tit')).matches.keys()], [42]);
  assert.deepEqual([...queryCorpusPage(packageBytes, searchTerms('not')).matches.keys()], [42]);
  assert.equal(queryCorpusPage(packageBytes, searchTerms('ne')).matches.size, 0);
  assert.equal(queryCorpusPage(packageBytes, searchTerms('雪')).matches.size, 1);
  assert.equal(queryCorpusPage(packageBytes, searchTerms('absent')).matches.size, 0);
  const doc = shard.documents.get(42)!;
  assert.equal(doc.title, 'Title');
  assert.equal(doc.summary, 'note');
  assert(!Object.hasOwn(doc, 'body'));
  assert.equal(doc.revision, 9007199254740993n);
  assert.equal(doc.publication, 9007199254741001n);
  assert.equal(doc.category.name, 'Lab');
  assert.equal(doc.tags[0].name, '雪');
  assert.deepEqual(encodeLocalSearchResult([doc], 1), expected);
  const answer = decodeLocalSearchResult(expected);
  assert.equal(answer.total, 1);
  assert.equal(answer.items[0].publicationNo, 2);
  assert.equal(answer.items[0].publishedAt, 1700000002345);
});

test('position ranges reward contiguous ordered tokens in one field, including repetitions', () => {
  const score = (term: string) => queryCorpusPage(packageBytes, searchTerms(term)).matches.get(42)!;
  assert.equal(score('ＮＥＥＤＬＥ　雪 needle'), score('needle 雪'));
  assert.equal(score('needle 雪 needle'), score('needle 雪 雪') + 1.25);
  assert.equal(score('needle needle'), score('needle'));
  assert.equal(score('title needle'), score('needle title'));
  assert.equal(score('title needle'), score('title') + score('needle'));
  assert.deepEqual(searchTerms('ｎｅｅｄｌｅ雪'), searchTerms('needle 雪'));
  assert.deepEqual(searchTerms('cafe\u0301'), searchTerms('café'));
  assert.throws(() => searchTerms('㍿'.repeat(128)), /normalized query length/);
});

test('local search enforces both raw and NFKC-normalized query length limits', async (t) => {
  const expandsToLimit = `needle${'…'.repeat(40)}..`;
  const rawAtLimit = `needle${'．'.repeat(122)}`;
  const normalizedAtLimit = `needle${'.'.repeat(122)}`;
  assert.equal(normalizeLocalSearchQuery(expandsToLimit), normalizedAtLimit);
  assert.equal(normalizeLocalSearchQuery(rawAtLimit), normalizedAtLimit);
  assert.deepEqual(searchTerms(expandsToLimit), searchTerms('needle'));
  assert.equal(normalizeLocalSearchQuery(`${rawAtLimit}.`), undefined);

  const beyondNormalizedLimit = `${expandsToLimit}.`;
  const normalizedLengthError = { name: 'ProtocolError', message: 'Invalid local search normalized query length' };
  assert.equal(normalizeLocalSearchQuery(beyondNormalizedLimit), undefined);
  assert.throws(() => searchTerms(beyondNormalizedLimit), normalizedLengthError);
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('Rejected query fetched the corpus'));
  await assert.rejects(createCorpusSearch()(beyondNormalizedLimit), normalizedLengthError);
  assert.equal(fetch.mock.callCount(), 0);
});

test('weighted CJK words preserve width, scalar matches, and non-positional stopwords', () => {
  const dictionary = fixtures('search-cjk-v4');
  const query = (input: string) => queryCorpusPage(dictionary, searchTerms(input));
  const score = (input: string) => query(input).matches.get(42)!;
  assert.deepEqual(searchTerms('Ａ１博客搜索的公开页'), [0x3494977a, 0xfa0b7541, 0xd1f52d91, 0xa3270e1f, 0x4c2850fa]);
  assert.equal(score('博客搜索'), score('搜索 博客') + 1.25);
  assert.equal(score('博客 搜索'), score('博客搜索'));
  assert.equal(score('搜索 公开页'), score('公开页 搜索'));
  assert.equal(score('的 搜索'), score('搜索 的'));
  assert.equal(score('ABC 博客'), score('博客 ABC'));
  assert.deepEqual([...query('公开').matches.keys()], [42]);
  assert.deepEqual([...query('客').matches.keys()], [42]);
  assert.deepEqual([...query('的').matches.keys()], [42]);
  const shard = new DataView(dictionary.buffer, L.SearchPackagePayloadOffset);
  const term = shard.getUint32(36, true); // First sorted hash is 公开页.
  const posting = shard.getUint32(60, true) + shard.getUint32(term + 8, true);
  shard.setUint8(posting + 7, 4); // Width would advance beyond the body and document.
  assert.throws(() => query('absent'), /posting position/);
});

test('admission rejects incorrect package versions, offsets, invalid postings and wrong result contracts', () => {
  for (const end of [0, 12, 104, packageBytes.length - 1]) {
    assert.throws(() => queryCorpusPage(packageBytes.subarray(0, end), []), ProtocolError);
  }
  const mutate = (offset: number, value: number) => {
    const changed = packageBytes.slice();
    new DataView(changed.buffer).setUint32(offset, value, true);
    assert.throws(() => queryCorpusPage(changed, searchTerms('unknown')), ProtocolError);
  };
  mutate(4, 3);
  mutate(L.SearchPackageEntryOffset + 8, 28);
  mutate(L.SearchPackagePayloadOffset + 64, 1);
  const changedPosting = packageBytes.slice();
  changedPosting[changedPosting.length - 1] = 8;
  assert.throws(() => queryCorpusPage(changedPosting, searchTerms('unknown')), ProtocolError);
  const fas4Frame = encodeFrame(FrameType.ArticleSearch, fixtures('article-search-fas4').subarray(16));
  assert.throws(() => decodeLocalSearchResult(fas4Frame.subarray(16)), ProtocolError);
  assert.throws(() => decodeLocalSearchResult(Uint8Array.from([...expected, 0])), ProtocolError);
});

test('search uses corpus GET and separately revalidates with HEAD, rejecting mixed pages and withdrawal', async (t) => {
  let pages = 1;
  let page2Generation = '700';
  let current = '700';
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', (path: string, init: RequestInit) => {
    const url = new URL(path, 'http://localhost');
    assert.equal(url.pathname, WireRoutes.PublicSearchCorpus);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store');
    const generation = url.searchParams.get('generation');
    const page = Number(url.searchParams.get('page'));
    requests.push(`${init.method}:${generation ?? 'current'}:${page || '-'}`);
    if (init.method === 'HEAD') {
      return new Response(null, {
        status: generation === current ? 204 : 409,
        headers: { [WireHeaders.SearchIndexGeneration]: current },
      });
    }
    return new Response(packageBytes.slice(), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        [WireHeaders.SearchIndexPages]: String(pages),
        [WireHeaders.SearchIndexGeneration]: page === 1 ? current : page2Generation,
      },
    });
  });
  const local = await searchCorpus('needle');
  assert.equal(local.generation, '700');
  assert.deepEqual(local.frame, expected);
  await verifySearchGeneration(local.generation);
  assert.deepEqual(requests, ['GET:current:1', 'HEAD:700:-']);
  current = '701';
  await assert.rejects(verifySearchGeneration(local.generation), { status: 409 });
  pages = 2;
  await assert.rejects(searchCorpus('needle'), ProtocolError);
  page2Generation = '701';
  await assert.rejects(searchCorpus('needle'), /duplicate corpus article/);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(searchCorpus('needle', aborted.signal), { name: 'AbortError' });
});

test('FSR4 empty pages preserve the distinction between no tokens, no matches, and a past-end page', async (t) => {
  // The fixed v1 empty-page header holds magic, version, total, count, and both offsets.
  const empty = '465352340400000000000000000000001800000018000000';
  const pastEnd = '465352340400000001000000000000001800000018000000';
  const generation = '710';
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', (path: string, init: RequestInit) => {
    const url = new URL(path, 'http://localhost');
    assert.equal(url.pathname, WireRoutes.PublicSearchCorpus);
    calls.push(`${init.method} ${url.search}`);
    const headers = { [WireHeaders.SearchIndexGeneration]: generation };
    if (init.method === 'HEAD') return new Response(null, { status: 204, headers });
    return new Response(packageBytes.slice(), { headers: {
      ...headers,
      'Content-Type': 'application/octet-stream',
      [WireHeaders.SearchIndexPages]: '1',
    } });
  });

  const search = createCorpusSearch();
  const tokenless = await search('!!!');
  assert.equal(tokenless.generation, null);
  assert.equal(Buffer.from(tokenless.frame).toString('hex'), empty);
  assert.deepEqual(calls, []);

  const noMatches = await search('absent');
  assert.equal(noMatches.generation, generation);
  assert.equal(Buffer.from(noMatches.frame).toString('hex'), empty);
  assert.deepEqual(decodeLocalSearchResult(noMatches.frame), { items: [], total: 0, nextCursor: null });
  await verifySearchGeneration(noMatches.generation);
  assert.deepEqual(calls.splice(0), ['GET ?page=1', 'HEAD ?generation=710']);

  const beyondLastPage = await search('needle', undefined, 2, 1);
  assert.equal(beyondLastPage.generation, generation);
  assert.equal(Buffer.from(beyondLastPage.frame).toString('hex'), pastEnd);
  assert.deepEqual(decodeLocalSearchResult(beyondLastPage.frame), { items: [], total: 1, nextCursor: null });
  assert.deepEqual(calls, ['HEAD ?generation=710']);
  await verifySearchGeneration(beyondLastPage.generation);
  assert.deepEqual(calls, ['HEAD ?generation=710', 'HEAD ?generation=710']);
});

function resultIds(frame: Uint8Array) {
  return decodeLocalSearchResult(frame).items.map(article => article.id);
}

function pageWithId(id: number) {
  const result = packageBytes.slice();
  const shard = new DataView(result.buffer, L.SearchPackagePayloadOffset);
  shard.setUint32(shard.getUint32(40, true), id, true);
  const postingAt = shard.getUint32(60, true);
  for (let i = 0; i < shard.getUint32(16, true); i++) {
    const termOffset = L.SearchShardHeaderSize + i * L.SearchTermRecordSize;
    shard.setUint8(postingAt + shard.getUint32(termOffset + 8, true) + 1, id);
  }
  return result;
}

const corpusETag = (bytes: Uint8Array) => `"${createHash('sha256').update(bytes).digest('hex')}"`;

function mockCorpus(t: TestContext, state: () => { generation: string; corpus: Uint8Array<ArrayBuffer>[]; available: boolean },
  notModified = (headers: Record<string, string>, etag: string) => new Response(null, { status: 304, headers: { ...headers, ETag: etag } })) {
  const calls: string[] = [];
  const bodies: number[] = [];

  t.mock.method(globalThis, 'fetch', (path: string, init: RequestInit) => {
    const { generation, corpus, available } = state();
    const url = new URL(path, 'http://localhost');
    const pinned = url.searchParams.get('generation');
    const page = Number(url.searchParams.get('page'));
    calls.push(`${init.method}:${pinned ?? 'current'}:${page || '-'}`);
    const headers = {
      'Content-Type': 'application/octet-stream',
      [WireHeaders.SearchIndexPages]: String(corpus.length),
      [WireHeaders.SearchIndexGeneration]: generation,
    };
    if (!available) return new Response(null, { status: 503 });
    if (pinned !== null && pinned !== generation) return new Response(null, { status: 409 });
    if (!page) return new Response(null, { status: 204, headers });
    const bytes = corpus[page - 1];
    const etag = corpusETag(bytes);
    if (new Headers(init.headers).get('If-None-Match') === etag) {
      return notModified(headers, etag);
    }
    bodies.push(page);
    return new Response(bytes.slice(), { headers: { ...headers, ETag: etag } });
  });
  function expectTraffic(requests: string[], pages: number[]) {
    assert.deepEqual(calls.splice(0), requests);
    assert.deepEqual(bodies.splice(0), pages);
  }
  return { calls, bodies, expectTraffic };
}

test('route worker cache reuses only fully admitted pages of the confirmed generation', async (t) => {
  let generation = '800';
  let corpus = [packageBytes, pageWithId(43)];
  let available = true;
  let corruptValidator = false;
  let invalid304Bytes = false;
  const { calls, bodies, expectTraffic } = mockCorpus(t, () => ({ generation, corpus, available }), (headers, etag) => {
    const response = new Response(null, { status: 304, headers: { ...headers, ETag: corruptValidator ? corpusETag(pageWithId(99)) : etag } });
    Object.defineProperty(response, 'body', { value: new ReadableStream({
      start(stream) {
        if (invalid304Bytes) stream.enqueue(Uint8Array.of(1));
        stream.close();
      },
    }) });
    return response;
  });

  const search = createCorpusSearch();
  const ids = async (query: string) => {
    const result = await search(query);
    await verifySearchGeneration(result.generation!);
    return resultIds(result.frame);
  };
  assert.deepEqual(await ids('needle'), [43, 42]);
  expectTraffic(['GET:current:1', 'GET:800:2', 'HEAD:800:-'], [1, 2]);
  assert.deepEqual(await ids('needle 雪'), [43, 42]);
  expectTraffic(['HEAD:800:-', 'HEAD:800:-'], []);

  generation = '801';
  corpus = [packageBytes, pageWithId(44)];
  assert.deepEqual(await ids('needle'), [44, 42]);
  expectTraffic(['HEAD:800:-', 'GET:current:1', 'GET:801:2', 'HEAD:801:-'], [2]);

  available = false;
  await assert.rejects(ids('needle'), { status: 503 });
  assert.deepEqual(calls.splice(0), ['HEAD:801:-']);
  available = true;
  assert.deepEqual(await ids('needle'), [44, 42]);
  expectTraffic(['GET:current:1', 'GET:801:2', 'HEAD:801:-'], [1, 2]);

  generation = '802';
  corruptValidator = true;
  await assert.rejects(ids('needle'), /corpus page validator/);
  expectTraffic(['HEAD:801:-', 'GET:current:1'], []);
  corruptValidator = false;
  await ids('needle');
  calls.length = 0;
  bodies.length = 0;
  generation = '803';
  invalid304Bytes = true;
  await assert.rejects(ids('needle'), /exceeds its byte limit/);
  expectTraffic(['HEAD:802:-', 'GET:current:1'], []);
  invalid304Bytes = false;
  corpus = [pageWithId(44), pageWithId(44)];
  await assert.rejects(ids('needle'), /duplicate corpus article/);
  assert.deepEqual(calls.splice(0), ['GET:current:1', 'GET:803:2']);
  corpus = [pageWithId(44), pageWithId(45)];
  assert.deepEqual(await ids('needle'), [45, 44]);
  assert.deepEqual(calls.splice(0), ['GET:current:1', 'GET:803:2', 'HEAD:803:-']);
});

test('FSPT admits an exact target in the normal Worker cache and retries a damaged patch only at its pin', async (t) => {
  const baseGeneration = '9007199254740995';
  const targetGeneration = '9007199254740996';
  const media = 'application/vnd.fsus.search-patch';
  const base = pageWithId(43);
  const target = base.slice();
  const revisionOffset = 32 + Buffer.from(target).readUInt32LE(72) + 52;
  const targetRevision = 9007199254740994n;
  new DataView(target.buffer).setBigInt64(revisionOffset, targetRevision, true);
  const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();
  const tag = (bytes: Uint8Array) => `"${sha(bytes).toString('hex')}"`;

  // Independent encoder with one explicit edit from the fixed FSPK fixture.
  const sample = Buffer.alloc(116);
  sample.write('FSPT');
  sample.writeUInt32LE(4, 4);
  sample.writeBigInt64LE(BigInt(baseGeneration), 8);
  sample.writeBigInt64LE(BigInt(targetGeneration), 16);
  sample.writeUInt32LE(2, 24);
  sample.writeUInt32LE(base.length, 28);
  sample.writeUInt32LE(target.length, 32);
  sample.writeUInt32LE(revisionOffset, 36);
  sample.writeUInt32LE(base.length - revisionOffset - 8, 40);
  sha(base).copy(sample, 44);
  sha(target).copy(sample, 76);
  sample.writeBigInt64LE(targetRevision, 108);

  let current = baseGeneration;
  let patch: Uint8Array = Uint8Array.from(sample);
  let withdrewDuringFallback = false;
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', (path: string, init: RequestInit) => {
    const url = new URL(path, 'http://localhost');
    const pinned = url.searchParams.get('generation');
    const page = Number(url.searchParams.get('page'));
    const offer = url.searchParams.get('baseGeneration');
    const request = new Headers(init.headers);
    calls.push(`${init.method}:${pinned ?? 'current'}:${page || '-'}${offer === null ? '' : ':patch'}`);
    const headers = { [WireHeaders.SearchIndexGeneration]: current, [WireHeaders.SearchIndexPages]: '2' };
    if (pinned !== null && pinned !== current) return new Response(null, { status: 409 });
    if (init.method === 'HEAD') return new Response(null, { status: 204, headers });
    const bytes = page === 1 ? packageBytes : current === baseGeneration ? base : target;
    if (offer !== null) {
      assert.equal(offer, baseGeneration);
      assert.equal(pinned, targetGeneration);
      assert.equal(page, 2);
      assert.equal(request.get('Accept'), `${media}, application/octet-stream`);
      assert.equal(request.get('If-None-Match'), tag(base));
      return new Response(Uint8Array.from(patch), { headers: { ...headers, 'Content-Type': media,
        [WireHeaders.SearchCorpusTargetDigest]: sha(target).toString('hex'),
      } });
    }
    if (withdrewDuringFallback && page === 2 && pinned === targetGeneration) return new Response(null, { status: 409 });
    const etag = tag(bytes);
    if (request.get('If-None-Match') === etag) return new Response(null, { status: 304, headers: { ...headers, ETag: etag } });
    return new Response(bytes.slice(), { headers: { ...headers, 'Content-Type': 'application/octet-stream', ETag: etag } });
  });

  const refresh = [`HEAD:${baseGeneration}:-`, 'GET:current:1', `GET:${targetGeneration}:2:patch`];
  for (const corruptAt of [-1, 4, 8, 16, 24, 28, 32, 36, 44, 76, 108, -2]) {
    current = baseGeneration;
    const search = createCorpusSearch();
    assert.equal((await search('needle')).generation, baseGeneration);
    calls.length = 0;
    patch = Uint8Array.from(sample);
    if (corruptAt >= 0) patch[corruptAt] ^= 0x80;
    if (corruptAt === -2) {
      // The replacement and its embedded digest agree, but not with the separately sealed target.
      patch.set(base.subarray(revisionOffset, revisionOffset + 8), 108);
      patch.set(sha(base), 76);
    }
    current = targetGeneration;
    const result = await search('needle');
    const cold = await searchCorpus('needle');
    assert.deepEqual(result.frame, cold.frame);
    assert.equal(decodeLocalSearchResult(result.frame).items[0].revision, targetRevision);
    await verifySearchGeneration(result.generation!);
    assert.deepEqual(calls, [...refresh, ...(corruptAt === -1 ? [] : [`GET:${targetGeneration}:2`]),
      'GET:current:1', `GET:${targetGeneration}:2`, `HEAD:${targetGeneration}:-`]);
  }

  current = baseGeneration;
  const search = createCorpusSearch();
  await search('needle');
  calls.length = 0;
  current = targetGeneration;
  withdrewDuringFallback = true;
  await assert.rejects(search('needle'), { status: 409 });
  assert.deepEqual(calls, [...refresh, `GET:${targetGeneration}:2`]);
});

test('admitted binary-search scoring and lazy decode match full shard parsing bit-for-bit', () => {
  assert.deepEqual(searchShortAsciiPrefixes('A AE ＡＥ a AEDS Fsu'), ['a', 'ae']);
  const dictionary = fixtures('search-cjk-v4');
  for (const [bytes, queries] of [
    [packageBytes, ['needle', '雪', 'needle 雪', '雪 needle', 'needle 雪 needle', 'title needle', 'needle needle',
      't', 'ti', 'no', 'la', 'ne', 'it', 'absent']],
    [dictionary, ['博客搜索', '搜索 博客', '博客 搜索', '公开页', '公开', '客', '的', '的 搜索', 'ABC 博客',
      'a', 'ab', 'bc', 'absent']],
  ] as const) {
    for (const query of queries) {
      const terms = searchTerms(query);
      const shortPrefixes = searchShortAsciiPrefixes(query);
      const full = queryCorpusPage(bytes, terms, shortPrefixes);
      const hits = scoreAdmittedCorpusPage(bytes, terms, shortPrefixes);
      assert.equal(hits.length, full.matches.size, `hit count mismatch for "${query}"`);
      for (const hit of hits) {
        const expectedDoc = full.documents.get(hit.id)!;
        assert.equal(hit.score, full.matches.get(hit.id), `score mismatch for "${query}"`);
        assert.equal(hit.publishedAt, expectedDoc.publishedAt);
        assert.equal(hit.views, expectedDoc.views);
      }
      const decoded = decodeCorpusDocuments(bytes, hits.map(hit => hit.row));
      assert.equal(decoded.length, hits.length);
      for (let i = 0; i < decoded.length; i++) {
        const expectedDoc = full.documents.get(hits[i].id)!;
        const { length: _len, row: _row, ...expectedCard } = expectedDoc;
        assert.deepEqual(decoded[i], expectedCard);
      }
    }
  }
  // 1-2 char ASCII matches metadata word prefixes (Title/note/Lab/ABC), not body-only or mid-word substrings.
  function expectPrefixes(bytes: Uint8Array, queries: string[], count: number) {
    for (const query of queries)
      assert.equal(scoreAdmittedCorpusPage(bytes, searchTerms(query), searchShortAsciiPrefixes(query)).length, count);
  }
  expectPrefixes(packageBytes, ['t', 'ti', 'no', 'la'], 1);
  expectPrefixes(packageBytes, ['ne', 'it'], 0);
  expectPrefixes(dictionary, ['a', 'ab'], 1);
  expectPrefixes(dictionary, ['bc'], 0);
});

test('persistent compact storage reuses across sessions, refreshes via 304, discards corruption, and supports latest sort', async (t) => {
  assert.equal(normalizePublicSearchSort('latest'), 'latest');
  assert.equal(normalizePublicSearchSort('relevance'), 'relevance');
  assert.equal(normalizePublicSearchSort('hot'), 'relevance');
  assert.equal(normalizePublicSearchSort(undefined), 'relevance');

  function pageWith(id: number, publishedAt: bigint, titleOnly = false) {
    const result = pageWithId(id);
    const shard = new DataView(result.buffer, L.SearchPackagePayloadOffset);
    const docAt = shard.getUint32(40, true);
    shard.setBigInt64(docAt + 24, publishedAt, true);
    if (titleOnly) {
      // Lower body TF on the needle term to create a distinct BM25 score vs recency order.
      const postingAt = shard.getUint32(60, true);
      for (let i = 0; i < shard.getUint32(16, true); i++) {
        const termOffset = L.SearchShardHeaderSize + i * L.SearchTermRecordSize;
        if (shard.getUint32(termOffset, true) === searchTerms('needle')[0]) {
          const at = postingAt + shard.getUint32(termOffset + 8, true);
          // Posting layout: docCount(1), idDelta(1), titleTf, metaTf, bodyTf
          shard.setUint8(at + 2, 1);
          shard.setUint8(at + 4, 1);
        }
      }
    }
    return result;
  }

  // Page 1 (id 42, older, higher score for 'needle' because title+body TF boosted)
  // Page 2 (id 43, newer by +1 day, lower score for 'needle')
  const olderHigher = pageWith(42, 1700000000000n, true);
  const newerLower = pageWith(43, 1700086400000n, false);
  assert(scoreAdmittedCorpusPage(olderHigher, searchTerms('needle'))[0].score >
    scoreAdmittedCorpusPage(newerLower, searchTerms('needle'))[0].score);

  let generation = '900';
  let available = true;
  let corpus = [olderHigher, newerLower];
  const { calls, expectTraffic } = mockCorpus(t, () => ({ generation, corpus, available }));

  let stored: PersistedCompactCorpus | undefined;
  const discards: string[] = [];
  const storage: CompactSearchStorage = {
    async load() { return stored; },
    async save(next) { stored = { generation: next.generation, pages: next.pages.map(p => p.slice()) }; },
    async discard(gen) {
      discards.push(gen);
      if (stored?.generation === gen) stored = undefined;
    },
  };

  function expectIds(result: Awaited<ReturnType<CorpusSearch>>, ids: number[]) {
    assert.deepEqual(resultIds(result.frame), ids);
  }

  // First session: cold download saves to persistent storage; relevance puts olderHigher (42) before newerLower (43).
  const firstSession = createCorpusSearch({ storage });
  expectIds(await firstSession('needle', undefined, 1, 10, 'relevance'), [42, 43]);
  assert.equal(stored?.generation, '900');
  expectTraffic(['GET:current:1', 'GET:900:2'], [1, 2]);

  // Same session warm RAM hit with sort='latest' puts newerLower (43) before olderHigher (42) with zero page GETs.
  expectIds(await firstSession('needle', undefined, 1, 10, 'latest'), [43, 42]);
  expectTraffic(['HEAD:900:-'], []);

  // Second session (simulating reload / return to /search / second tab): reuses persisted storage with ZERO page GETs.
  const secondSession = createCorpusSearch({ storage });
  expectIds(await secondSession('needle', undefined, 1, 10, 'relevance'), [42, 43]);
  expectTraffic(['HEAD:900:-'], []);

  // Subsequent query in second session uses promoted RAM fast path for 'latest'.
  expectIds(await secondSession('needle', undefined, 1, 10, 'latest'), [43, 42]);
  expectTraffic(['HEAD:900:-'], []);

  // Third session after generation advances: persisted page 1 hits 304, only page 2 downloads, storage updates to 901.
  generation = '901';
  corpus = [olderHigher, pageWith(44, 1700172800000n, false)];
  const thirdSession = createCorpusSearch({ storage });
  expectIds(await thirdSession('needle', undefined, 1, 10, 'latest'), [44, 42]);
  assert.equal(stored?.generation, '901');
  expectTraffic(['HEAD:900:-', 'GET:current:1', 'GET:901:2'], [2]);

  // Corrupted persisted storage is detected, discarded, and cleanly refetched from network.
  const corruptedPage = stored!.pages[0].slice();
  corruptedPage[4] ^= 0xff;
  stored = { generation: '901', pages: [corruptedPage, stored!.pages[1]] };
  const fourthSession = createCorpusSearch({ storage });
  expectIds(await fourthSession('needle', undefined, 1, 10, 'relevance'), [42, 44]);
  assert.deepEqual(discards.splice(0), ['901']);
  assert.equal(stored?.generation, '901');
  expectTraffic(['HEAD:901:-', 'GET:current:1', 'GET:901:2'], [1, 2]);

  // 503 on HEAD against persisted storage discards obsolete compact cache.
  available = false;
  const fifthSession = createCorpusSearch({ storage });
  await assert.rejects(fifthSession('needle'), { status: 503 });
  assert.deepEqual(discards.splice(0), ['901']);
  assert.equal(stored, undefined);
  assert.deepEqual(calls.splice(0), ['HEAD:901:-']);

  // invalidate() clears RAM and invokes storage.discard().
  available = true;
  await fifthSession('needle');
  assert.equal(stored?.generation, '901');
  await fifthSession.invalidate('901');
  assert.equal(stored, undefined);
  assert.deepEqual(discards.splice(0), ['901']);
});
