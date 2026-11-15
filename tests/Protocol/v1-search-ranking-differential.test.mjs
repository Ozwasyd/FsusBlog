import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeLocalSearchResult, queryCorpusPage, searchCorpus, searchTerms } from '../../src/Contracts/local-search.ts';
import { WireHeaders } from '../../src/Contracts/wire.generated.ts';

const cases = JSON.parse(readFileSync(new URL('fixtures/v1-search-ranking.json', import.meta.url), 'utf8'));
const sourcePackage = Buffer.from(readFileSync(new URL('fixtures/v1-search-ranking-fspk.hex', import.meta.url), 'utf8')
  .replace(/\s/g, ''), 'hex');

test('current Node corpus consumer differs from the fixed raw ranking oracle on the same core bytes', async (t) => {
  assert.equal(createHash('sha256').update(sourcePackage).digest('hex'), cases.packageSha256);
  const baseline = cases.sharedCoreDifferential;
  assert.throws(() => queryCorpusPage(sourcePackage, searchTerms(baseline.query)), /package header/);

  // Re-envelope the first, complete core entry only. Its FHS2 bytes are identical.
  assert.equal(sourcePackage.readUInt32LE(12), 0);
  assert.equal(sourcePackage.readUInt32LE(16), 0);
  const begin = sourcePackage.readUInt32LE(20);
  const size = sourcePackage.readUInt32LE(24);
  const core = Buffer.alloc(32 + size);
  sourcePackage.copy(core, 0, 0, 28);
  core.writeUInt32LE(1, 8);
  core.writeUInt32LE(32, 20);
  sourcePackage.copy(core, 32, begin, begin + size);
  const rawCase = cases.cases.find((item) => item.name === 'hash-order-and-overlap');
  assert.deepEqual(rawCase.ids, baseline.rawIds);
  t.mock.method(globalThis, 'fetch', (path, options) => {
    assert.match(path, /\/api\/v2\/public\/search-corpus\?page=1$/);
    assert.equal(options.credentials, 'omit');
    return new Response(core, { headers: {
      'Content-Type': 'application/octet-stream',
      [WireHeaders.SearchIndexGeneration]: '407',
      [WireHeaders.SearchIndexPages]: '1',
    } });
  });
  const current = await searchCorpus(baseline.query);
  assert.equal(current.generation, '407');
  const result = decodeLocalSearchResult(current.frame);
  assert.equal(result.total, rawCase.total);
  assert.deepEqual(result.items.map((article) => article.id), baseline.v2Ids);
  assert.notDeepEqual(baseline.v2Ids, baseline.rawIds);
});
