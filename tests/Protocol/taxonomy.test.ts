import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import { decodeTaxonomyList, decodeTaxonomyMetadata } from '../../src/Contracts/taxonomy.ts';
import { FrameType } from '../../src/Contracts/wire.generated.ts';

function fixture(name: string, type: FrameType): Uint8Array {
  const hex = readFileSync(new URL(`fixtures/${name}.hex`, import.meta.url), 'utf8').replace(/\s+/g, '');
  return decodeFrame(Buffer.from(hex, 'hex'), type).payload;
}

test('v1 taxonomy list and independent exact metadata frame preserve their field layouts', () => {
  assert.deepEqual(decodeTaxonomyList(fixture('category-list-v1', FrameType.CategoryList)), [
    { id: 1, name: 'Tech', articleCount: 2 }, { id: 2, name: 'Life', articleCount: 0 },
  ]);
  assert.deepEqual(decodeTaxonomyMetadata(fixture('taxonomy-exact-metadata', FrameType.TaxonomyExactMetadata)),
    { id: 34, name: 'Étoile', description: '旧名不可占用' });
});

test('taxonomy lists and metadata reject malformed text and field bounds', () => {
  const list = fixture('category-list-v1', FrameType.CategoryList);
  const metadata = fixture('taxonomy-exact-metadata', FrameType.TaxonomyExactMetadata);
  const badText = Uint8Array.from(metadata);
  badText[8] = 255;
  assert.throws(() => decodeTaxonomyMetadata(badText), ProtocolError);
  assert.throws(() => decodeTaxonomyMetadata(metadata.subarray(0, metadata.length - 1)), ProtocolError);
  const overflowing = Uint8Array.from(list);
  new DataView(overflowing.buffer).setInt32(0, 0x7fff_ffff, true);
  assert.throws(() => decodeTaxonomyList(overflowing), ProtocolError);
});
