import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ProtocolError, encodeFrame } from '../../src/Contracts/aeds.ts';
import {
  decodeLocalSearchResult, encodeLocalSearchResult, queryCorpusPage, searchCorpus, searchTerms, verifySearchGeneration,
} from '../../src/Contracts/local-search.ts';
import { FrameType, WireHeaders, WireLayouts as L, WireRoutes } from '../../src/Contracts/wire.generated.ts';

const fixtures = (name: string) =>
  Uint8Array.from(Buffer.from(readFileSync(new URL(`fixtures/${name}.hex`, import.meta.url), 'utf8').trim(), 'hex'));
const packageBytes = fixtures('search-fspk-v4');
const expected = fixtures('search-fsr4');

test('FSPK v4 indexes a body-only term and produces the fixed FSR4 result', () => {
  assert.deepEqual([...searchTerms('foo FOO')], [0xf6a5c420]);
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

test('admission rejects incorrect package versions, offsets, invalid postings and wrong result contracts', () => {
  for (const end of [0, 12, 104, packageBytes.length - 1]) {
    assert.throws(() => queryCorpusPage(packageBytes.subarray(0, end), new Set()), ProtocolError);
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
  changedPosting[changedPosting.length - 1] = 1;
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
