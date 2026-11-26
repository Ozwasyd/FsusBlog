import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProtocolError } from '../../src/Contracts/aeds.ts';
import { encodeLocalSearchResult, queryCorpusPage } from '../../src/Contracts/local-search.ts';
import type { ArticleCard } from '../../src/Contracts/public-articles.ts';
import { packFspk, type FspkPosition } from './fspk-fixture.ts';

type Position = FspkPosition & { field: 1 | 4 };
type Posting = { id: number; positions: Position[]; frequencies: readonly [number, number, number] };
type Term = { hash: number; idf: number; postings: Posting[] };
type Document = { id: number; length: number; time: number };

const a = 10;
const b = 20;
const c = 30;
const repeated = 40;
const unrelated = 50;
const absent = 60;
const time = 1_700_000_000_000;
const average = 31.875;
const top = 0xffff_fff0;
const documents: Document[] = [
  { id: 7, length: 15, time },
  { id: 11, length: 30, time: time + 1 },
  { id: 17, length: 0xffff_ffff, time },
  { id: 23, length: 8, time },
  { id: 29, length: 160, time },
  { id: 31, length: 160, time },
];
const position = (at: number, width = 1, field: 1 | 4 = 1): Position => ({ offset: at, field, width });
const consecutive = (count: number) => Array.from({ length: count }, (_, index) => position(index));
const posting = (id: number, positions: Position[]): Posting => ({
  id, positions,
  frequencies: [positions.some(hit => hit.field === 1) ? 1 : 0, positions.length === 0 ? 1 : 0,
    positions.some(hit => hit.field === 4) ? 1 : 0],
});
const terms: Term[] = [
  { hash: a, idf: 2 ** -24, postings: [
    posting(7, [position(0), position(1), position(2, 2, 4)]),
    posting(11, [position(17, 2), position(17, 3), position(17, 1, 4)]),
    posting(17, [position(0x8000_0005), position(top, 2, 4)]),
    posting(23, [position(0)]),
  ] },
  { hash: b, idf: 2 ** -24, postings: [
    posting(7, [position(1), position(2), position(4, 2, 4)]),
    posting(11, [position(17, 2)]),
    posting(17, [position(top + 2, 3, 4)]),
    posting(23, []),
  ] },
  { hash: c, idf: 2 ** 30, postings: [
    posting(7, [position(2), position(2, 1, 4)]),
    posting(11, [position(19)]),
    posting(17, [position(top + 5, 1, 4)]),
  ] },
  { hash: repeated, idf: 2.25, postings: [posting(29, consecutive(127)), posting(31, consecutive(128))] },
  { hash: unrelated, idf: 1.75, postings: [posting(11, [position(23)])] },
];

test('bounded FSPK scoring agrees exactly with a materialized position map', () => {
  const bytes = packageFor(documents, terms);
  assert.deepEqual([...rankOracle([a, b, c]).phrases], [7, 17]);
  assert(rankOracle([a, a, b]).phrases.has(7));
  assert(!rankOracle([a, b]).phrases.has(11));
  assert(!rankOracle([a, b]).phrases.has(23));
  assert(!rankOracle([b, a]).phrases.has(7));
  const [smallA, smallB, large] = [a, b, c].map(term => rankOracle([term]).scores.get(7)!);
  assert.notEqual(smallA + smallB + large, large + smallA + smallB);
  const maximum = Array.from({ length: 128 }, () => repeated);
  assert.deepEqual([...rankOracle(maximum.slice(1)).phrases], [29, 31]);
  assert.deepEqual([...rankOracle(maximum).phrases], [31]);

  for (const query of [...queries([a, b, c, unrelated, absent], 4), maximum.slice(1), maximum]) {
    const expected = rankOracle(query).scores;
    const actual = queryCorpusPage(bytes, query);
    assert.deepEqual([...actual.matches], [...expected], `scores for ${query.join(',')}`);
    const ordered = (matches: Map<number, number>) => documents.filter(doc => matches.has(doc.id))
      .sort((left, right) => matches.get(right.id)! - matches.get(left.id)! ||
        right.time - left.time || right.id - left.id);
    const actualFrame = encodeLocalSearchResult(ordered(actual.matches).map(doc => actual.documents.get(doc.id)!), actual.matches.size);
    const expectedFrame = encodeLocalSearchResult(ordered(expected).map(card), expected.size);
    assert.deepEqual(actualFrame, expectedFrame, `FSR4 for ${query.join(',')}`);
  }

  const corrupt = bytes.slice();
  corrupt[corrupt.length - 1] = 2;
  assert.throws(() => queryCorpusPage(corrupt, [a, b, c]), ProtocolError);
  const shared = new Uint8Array(new SharedArrayBuffer(bytes.byteLength));
  shared.set(bytes);
  assert.deepEqual([...queryCorpusPage(shared, [a, b, c]).matches], [...rankOracle([a, b, c]).scores]);
});

test('long validated spans preserve an exact late phrase and reject a near miss', () => {
  const length = 100_000;
  const dense = Array.from({ length: 32_768 }, (_, index) => position(index * 3));
  const last = dense[dense.length - 1].offset;
  const rows: Document[] = [{ id: 1, length, time }];
  const fixture: Term[] = [
    { hash: a, idf: 1.125, postings: [posting(1, dense)] },
    { hash: b, idf: 1.75, postings: [posting(1, [position(last), position(last + 1)])] },
  ];
  const bytes = packageFor(rows, fixture);
  const score = (query: number[]) => queryCorpusPage(bytes, query).matches.get(1)!;
  assert.equal(score([a, b]), score([b, a]) + 1.25);
  assert.equal(score([a, a]), score([a]));
});

test('all 128 distinct query hashes can carry one ordered position each', () => {
  const hashes = Array.from({ length: 128 }, (_, index) => index + 1);
  const bytes = packageFor([{ id: 1, length: 128, time }], hashes.map((hash, index) =>
    ({ hash, idf: 1, postings: [posting(1, [position(index)])] })));
  const ordered = queryCorpusPage(bytes, hashes).matches.get(1);
  const reversed = queryCorpusPage(bytes, [...hashes].reverse()).matches.get(1)!;
  assert.equal(ordered, reversed + 1.25);
});

function* queries(values: number[], length: number, prefix: number[] = []): Iterable<number[]> {
  yield prefix;
  if (length > 0)
    for (const value of values) yield* queries(values, length - 1, [...prefix, value]);
}

function rankOracle(query: number[]) {
  const scores = new Map<number, number>();
  const covered = new Set(query);
  const positions = new Map<number, Map<string, { position: Position; hashes: Set<number> }>>();
  for (const term of terms) {
    if (!covered.has(term.hash)) continue;
    for (const row of term.postings) {
      const doc = documents.find(item => item.id === row.id)!;
      const [title, meta, body] = row.frequencies;
      const weight = title * 2.5 + meta * 0.9 + body;
      const value = Math.fround(term.idf) * (weight * 2.2) / (weight + 1.2 * (0.25 + 0.75 * doc.length / average));
      scores.set(doc.id, (scores.get(doc.id) ?? 0) + value);
      if (!positions.has(doc.id)) positions.set(doc.id, new Map());
      const index = positions.get(doc.id)!;
      for (const hit of row.positions) {
        const key = `${hit.field}:${hit.offset}:${hit.width}`;
        if (!index.has(key)) index.set(key, { position: hit, hashes: new Set() });
        index.get(key)!.hashes.add(term.hash);
      }
    }
  }
  const phrases = new Set<number>();
  if (query.length < 2) return { scores, phrases };
  for (const [id, occurrences] of positions) {
    let endpoints = new Set<string>();
    for (let i = 0; i < query.length; i++) {
      const next = new Set<string>();
      for (const { position: hit, hashes } of occurrences.values()) {
        if (hashes.has(query[i]) && (i === 0 || endpoints.has(`${hit.field}:${hit.offset}`)))
          next.add(`${hit.field}:${hit.offset + hit.width}`);
      }
      endpoints = next;
      if (endpoints.size === 0) break;
    }
    if (endpoints.size > 0) {
      phrases.add(id);
      scores.set(id, scores.get(id)! + 1.25);
    }
  }
  return { scores, phrases };
}

function card({ id, time }: Document): ArticleCard {
  return { id, title: 'T', summary: '', views: 0, createdAt: time, publishedAt: time, updatedAt: null,
    scheduledPublishAt: null, category: { id: 0, name: '' }, tags: [], revision: 1n, revisionNo: 1,
    publication: BigInt(id), publicationNo: 1 };
}

function packageFor(rows: Document[], index: Term[]) {
  return packFspk(
    rows.map(row => ({ ...row, publication: BigInt(row.id), title: { offset: 0, length: 1 } })),
    index,
    [Uint8Array.of(84)],
    average,
  );
}
