import { deepStrictEqual, equal, rejects } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts';
import { api, ProtocolError } from '../../src/Contracts/client.ts';
import { FrameType, WireHeaders, WireLayouts } from '../../src/Contracts/wire.generated.ts';

const fixture = readFileSync(new URL('./fixtures/article-search-fas4.hex', import.meta.url), 'utf8').trim();
const example = decodeFrame(Uint8Array.from(Buffer.from(fixture, 'hex')), FrameType.ArticleSearch).payload;

function indexFrame(id: number, generation: string, pages = '2'): Response {
  const payload = example.slice();
  new DataView(payload.buffer).setInt32(12 + WireLayouts.ArticleIdOffset, id, true);
  return new Response(encodeFrame(FrameType.ArticleSearch, payload), {
    headers: {
      'Content-Type': 'application/octet-stream',
      [WireHeaders.SearchIndexGeneration]: generation,
      [WireHeaders.SearchIndexPages]: pages,
    },
  });
}

test('local index reads all pages from one publication generation', async t => {
  const urls: string[] = [];
  const mock = t.mock.method(globalThis, 'fetch', async path => {
    urls.push(String(path));
    return indexFrame(urls.length, '9007199254740993');
  });
  const input = new AbortController();
  const index = await api.publicIndex(input.signal);
  equal(index.generation, '9007199254740993');
  equal(index.total, 2);
  deepStrictEqual(index.items.map(item => item.id), [1, 2]);
  deepStrictEqual(urls, [
    '/api/v2/public/index.aeds?page=1',
    '/api/v2/public/index.aeds?page=2&generation=9007199254740993',
  ]);
  equal(mock.mock.calls[0].arguments[1].signal, input.signal);
});

test('local index refuses generation drift or repeated articles without yielding partial results', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => indexFrame(1, '73'));
  mock.mock.mockImplementationOnce(async () => indexFrame(2, '74'), 1);
  await rejects(api.publicIndex(), { name: ProtocolError.name, message: 'Invalid public search index coordinates' });
  await rejects(api.publicIndex(), { name: ProtocolError.name, message: 'Duplicate articles in public search index' });
});
