import assert from 'node:assert/strict';
import { hexFixture } from './fixture-source.ts';
import { test } from 'node:test';
import { decodeFrame } from '../../src/Contracts/aeds.ts';
import { decodeSitePage } from '../../src/Contracts/site-pages.ts';
import { FrameType } from '../../src/Contracts/wire.generated.ts';

const golden = hexFixture('page-content-v1.hex');

test('v1 site page golden and malformed PODs', () => {
  const { payload } = decodeFrame(golden, FrameType.PageContent);
  assert.deepEqual(decodeSitePage(payload), { slug: 'about', markdown: '# About\n\nHydration-safe binary payload.' });
  for (const index of [5, 129, 132, 136, payload.length - 1]) {
    const corrupt = payload.slice();
    corrupt[index] = 0xff;
    assert.throws(() => decodeSitePage(corrupt));
  }
  assert.throws(() => decodeSitePage(payload.subarray(0, payload.length - 1)));
});
