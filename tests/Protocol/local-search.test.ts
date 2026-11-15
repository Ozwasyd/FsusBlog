import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ProtocolError, encodeFrame } from '../../src/Contracts/aeds.ts';
import {
  createCorpusSearch, decodeLocalSearchResult, encodeLocalSearchResult, queryCorpusPage, searchCorpus, searchTerms,
  verifySearchGeneration,
} from '../../src/Contracts/local-search.ts';
import { FrameType, WireHeaders, WireLayouts as L, WireRoutes } from '../../src/Contracts/wire.generated.ts';

const fixtures = (name: string) =>
  Uint8Array.from(Buffer.from(readFileSync(new URL(`fixtures/${name}.hex`, import.meta.url), 'utf8').trim(), 'hex'));
const packageBytes = fixtures('search-fspk-v4');
const expected = fixtures('search-fsr4');

test('FSPK v4 indexes a body-only term and produces the fixed FSR4 result', () => {
  assert.deepEqual(searchTerms('foo ＦＯＯ'), [0xf6a5c420, 0xf6a5c420]);
  const shard = queryCorpusPage(packageBytes, searchTerms('needle'));
  assert.deepEqual([...shard.matches.keys()], [42]);
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

test('route worker cache reuses only fully admitted pages of the confirmed generation', async (t) => {
  const pageWithId = (id: number) => {
    const result = packageBytes.slice();
    const shard = new DataView(result.buffer, L.SearchPackagePayloadOffset);
    shard.setUint32(shard.getUint32(40, true), id, true);
    const postingAt = shard.getUint32(60, true);
    for (let i = 0; i < shard.getUint32(16, true); i++) {
      const termOffset = L.SearchShardHeaderSize + i * L.SearchTermRecordSize;
      shard.setUint8(postingAt + shard.getUint32(termOffset + 8, true) + 1, id);
    }
    return result;
  };
  let generation = '800';
  let corpus = [packageBytes, pageWithId(43)];
  let available = true;
  let corruptValidator = false;
  let invalid304Bytes = false;
  const calls: string[] = [];
  const bodies: number[] = [];
  const tag = (bytes: Uint8Array) => `"${createHash('sha256').update(bytes).digest('hex')}"`;
  t.mock.method(globalThis, 'fetch', (path: string, init: RequestInit) => {
    const url = new URL(path, 'http://localhost');
    const expected = url.searchParams.get('generation');
    const page = Number(url.searchParams.get('page'));
    calls.push(`${init.method}:${expected ?? 'current'}:${page || '-'}`);
    const headers = {
      'Content-Type': 'application/octet-stream',
      [WireHeaders.SearchIndexPages]: String(corpus.length),
      [WireHeaders.SearchIndexGeneration]: generation,
    };
    if (!available) return new Response(null, { status: 503 });
    if (expected !== null && expected !== generation) return new Response(null, { status: 409 });
    if (!page) return new Response(null, { status: 204, headers });
    const bytes = corpus[page - 1];
    const etag = tag(bytes);
    if (new Headers(init.headers).get('If-None-Match') === etag) {
      const response = new Response(null, { status: 304, headers: { ...headers, ETag: corruptValidator ? tag(pageWithId(99)) : etag } });
      Object.defineProperty(response, 'body', { value: new ReadableStream({
        start(stream) {
          if (invalid304Bytes) stream.enqueue(Uint8Array.of(1));
          stream.close();
        },
      }) });
      return response;
    }
    bodies.push(page);
    return new Response(bytes.slice(), { headers: { ...headers, ETag: etag } });
  });

  const search = createCorpusSearch();
  const ids = async (query: string) => {
    const result = await search(query);
    await verifySearchGeneration(result.generation!);
    return decodeLocalSearchResult(result.frame).items.map(article => article.id);
  };
  assert.deepEqual(await ids('needle'), [43, 42]);
  assert.deepEqual(calls.splice(0), ['GET:current:1', 'GET:800:2', 'HEAD:800:-']);
  assert.deepEqual(bodies.splice(0), [1, 2]);
  assert.deepEqual(await ids('needle 雪'), [43, 42]);
  assert.deepEqual(calls.splice(0), ['HEAD:800:-', 'HEAD:800:-']);
  assert.deepEqual(bodies.splice(0), []);

  generation = '801';
  corpus = [packageBytes, pageWithId(44)];
  assert.deepEqual(await ids('needle'), [44, 42]);
  assert.deepEqual(calls.splice(0), ['HEAD:800:-', 'GET:current:1', 'GET:801:2', 'HEAD:801:-']);
  assert.deepEqual(bodies.splice(0), [2]);

  available = false;
  await assert.rejects(ids('needle'), { status: 503 });
  assert.deepEqual(calls.splice(0), ['HEAD:801:-']);
  available = true;
  assert.deepEqual(await ids('needle'), [44, 42]);
  assert.deepEqual(calls.splice(0), ['GET:current:1', 'GET:801:2', 'HEAD:801:-']);
  assert.deepEqual(bodies.splice(0), [1, 2]);

  generation = '802';
  corruptValidator = true;
  await assert.rejects(ids('needle'), /corpus page validator/);
  assert.deepEqual(calls.splice(0), ['HEAD:801:-', 'GET:current:1']);
  assert.deepEqual(bodies.splice(0), []);
  corruptValidator = false;
  await ids('needle');
  calls.length = 0;
  bodies.length = 0;
  generation = '803';
  invalid304Bytes = true;
  await assert.rejects(ids('needle'), /exceeds its byte limit/);
  assert.deepEqual(calls.splice(0), ['HEAD:802:-', 'GET:current:1']);
  assert.deepEqual(bodies.splice(0), []);
  invalid304Bytes = false;
  corpus = [pageWithId(44), pageWithId(44)];
  await assert.rejects(ids('needle'), /duplicate corpus article/);
  assert.deepEqual(calls.splice(0), ['GET:current:1', 'GET:803:2']);
  corpus = [pageWithId(44), pageWithId(45)];
  assert.deepEqual(await ids('needle'), [45, 44]);
  assert.deepEqual(calls.splice(0), ['GET:current:1', 'GET:803:2', 'HEAD:803:-']);
});
