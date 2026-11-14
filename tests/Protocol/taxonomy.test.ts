import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeFrame, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import { decodeTaxonomyList, decodeTaxonomyMetadata } from '../../src/Contracts/taxonomy.ts';
import { decodeTaxonomyAssignment, encodeTaxonomyAssignment, FrameType } from '../../src/Contracts/wire.generated.ts';

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

test('taxonomy assignment preserves revision, command identity, and bounded tag IDs', () => {
  const expected = fixture('taxonomy-assignment', FrameType.TaxonomyAssignment);
  const decoded = decodeTaxonomyAssignment(expected);
  assert.deepEqual(decoded, {
    id: 42, expectedRevision: 9007199254740993n, idempotencyKey: '01020304-0506-4040-8080-000000000003',
    categoryId: 3, tagIds: [101, 105],
  });
  assert.deepEqual(encodeFrame(FrameType.TaxonomyAssignment, encodeTaxonomyAssignment(decoded)),
    Uint8Array.from(Buffer.from(readFileSync(new URL('fixtures/taxonomy-assignment.hex', import.meta.url), 'utf8').trim(), 'hex')));
  const tooMany = Uint8Array.from(expected);
  new DataView(tooMany.buffer).setInt32(32, 33, true);
  assert.throws(() => decodeTaxonomyAssignment(tooMany), ProtocolError);
});
