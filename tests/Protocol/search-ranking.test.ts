import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ProtocolError } from '../../src/Contracts/aeds.ts';
import {
  decodeLocalSearchResult,
  LOCAL_SEARCH_PROFILE,
  planLocalSearchQuery,
  scoreAdmittedCorpusGlobal,
} from '../../src/Contracts/local-search.ts';
import {
  planSearchQuery,
  SEARCH_SCORING_PROFILE_VERSION,
} from '../../src/Contracts/search-query-plan.ts';
import { analyzeText, SEARCH_ANALYZER_VERSION } from '../../src/Contracts/search-analyzer.ts';
import { packFspk, type FspkPosition, type FspkTerm } from './fspk-fixture.ts';

interface ExpectedConcept {
  kind: string;
  steps: string[];
  exactSteps?: string[];
  isStrictIdentifier: boolean;
  shortAsciiPrefix: string | null;
}

interface PlanCase {
  name: string;
  input: string;
  isEmpty: boolean;
  isOverlongExactIdentifier: boolean;
  hasStrictIdentifier: boolean;
  quotedPhraseCount: number;
  contentConcepts: ExpectedConcept[];
}

interface PlanVectorFile {
  profileVersion: number;
  analyzerVersion: number;
  cases: PlanCase[];
}

const vectorFile: PlanVectorFile = JSON.parse(
  readFileSync(new URL('./fixtures/search-query-plan-vectors.json', import.meta.url), 'utf8'),
);

test('TypeScript SearchQueryPlan matches shared cross-language golden vectors', () => {
  assert.equal(SEARCH_SCORING_PROFILE_VERSION, vectorFile.profileVersion);
  assert.equal(SEARCH_ANALYZER_VERSION, vectorFile.analyzerVersion);
  assert.equal(LOCAL_SEARCH_PROFILE, 'local-fspk-v4-global-concept-v3');

  for (const tc of vectorFile.cases) {
    const plan = planSearchQuery(tc.input);
    assert.equal(plan.isEmpty, tc.isEmpty, `[${tc.name}] isEmpty mismatch`);
    assert.equal(plan.isOverlongExactIdentifier, tc.isOverlongExactIdentifier, `[${tc.name}] isOverlongExactIdentifier mismatch`);
    assert.equal(plan.hasStrictIdentifier, tc.hasStrictIdentifier, `[${tc.name}] hasStrictIdentifier mismatch`);
    assert.equal(plan.quotedPhrases.length, tc.quotedPhraseCount, `[${tc.name}] quotedPhraseCount mismatch`);
    assert.equal(plan.contentConcepts.length, tc.contentConcepts.length, `[${tc.name}] contentConcepts length mismatch`);

    for (let i = 0; i < tc.contentConcepts.length; i++) {
      const got = plan.contentConcepts[i];
      const exp = tc.contentConcepts[i];
      assert.equal(got.kind, exp.kind, `[${tc.name}][${i}] kind mismatch`);
      assert.equal(got.isStrictIdentifier, exp.isStrictIdentifier, `[${tc.name}][${i}] isStrictIdentifier mismatch`);
      assert.equal(got.shortAsciiPrefix, exp.shortAsciiPrefix, `[${tc.name}][${i}] shortAsciiPrefix mismatch`);
      assert.deepEqual(got.steps.map(s => s.canonicalTerm), exp.steps, `[${tc.name}][${i}] canonical steps mismatch`);
      if (exp.exactSteps) {
        assert.deepEqual(got.steps.map(s => s.exactFormTerm), exp.exactSteps, `[${tc.name}][${i}] exact steps mismatch`);
      }
    }
  }
});

test('local FSPK explicitly rejects unsupported stopword-only quoted phrases instead of silently drifting', () => {
  assert.throws(
    () => planLocalSearchQuery('"的 了"'),
    (err: unknown) => err instanceof ProtocolError && /Unsupported local search query profile/.test(err.message),
  );
  // Overlong exact identifier returns empty plan cleanly (matches server)
  const overlong = planLocalSearchQuery(`${'a'.repeat(126)}-123`);
  assert.equal(overlong.isOverlongExactIdentifier, true);
  assert.equal(overlong.isEmpty, true);
});

// Minimal synthetic FSPK v4 page builder for adversarial repartitioning / merge invariance tests
interface SyntheticDoc {
  id: number;
  title: string;
  summary: string;
  body: string;
  publishedAt: number;
}

const utf8 = new TextEncoder();
const quantizeTf = (v: number) => v <= 10 ? v : v <= 12 ? 11 : v <= 15 ? 12 : v <= 20 ? 13 : v <= 30 ? 14 : v <= 50 ? 15 : v <= 100 ? 16 : 17;

function buildFspkPage(docsInput: readonly SyntheticDoc[]): Uint8Array {
  const docs = [...docsInput].sort((a, b) => a.id - b.id);
  type Freq = { title: number; meta: number; body: number; positions: FspkPosition[] };
  const docEntries = docs.map(doc => {
    const terms = new Map<number, Freq>();
    let length = 0;
    let maxPosEnd = 0;
    const addField = (text: string, fieldCode: number) => {
      const res = analyzeText(text, 'index', 0, 0);
      length += res.sourceLength;
      for (const tok of res.tokens) {
        let f = terms.get(tok.hash32);
        if (!f) { f = { title: 0, meta: 0, body: 0, positions: [] }; terms.set(tok.hash32, f); }
        if (fieldCode === 1) f.title++;
        else if (fieldCode === 4) f.body++;
        else f.meta++;
        if (!tok.isStopword && (fieldCode === 1 || fieldCode === 4) &&
            (tok.kind === 'exact' || tok.kind === 'cjkBigram' || tok.kind === 'subword' || tok.kind === 'scriptAlias')) {
          f.positions.push({ offset: tok.position, field: fieldCode, width: tok.width });
          if (tok.position + tok.width > maxPosEnd) maxPosEnd = tok.position + tok.width;
        }
      }
    };
    addField(doc.title, 1);
    addField(doc.summary, 0);
    addField(doc.body, 4);
    return { doc, terms, length: Math.max(1, length, maxPosEnd) };
  });

  const inverted = new Map<number, { id: number; tf: Freq }[]>();
  for (const d of docEntries) {
    for (const [hash, tf] of d.terms) {
      const list = inverted.get(hash) ?? [];
      list.push({ id: d.doc.id, tf });
      inverted.set(hash, list);
    }
  }
  const sortedHashes = [...inverted.keys()].sort((a, b) => a - b);

  const terms: FspkTerm[] = [];
  for (const hash of sortedHashes) {
    const postings = inverted.get(hash)!;
    const idf = Math.fround(Math.log(1 + (docEntries.length - postings.length + 0.5) / (postings.length + 0.5)));
    terms.push({
      hash,
      idf,
      postings: postings.map(({ id, tf }) => ({
        id,
        frequencies: [quantizeTf(tf.title), quantizeTf(tf.meta), quantizeTf(tf.body)],
        positions: tf.positions
          .sort((a, b) => a.offset - b.offset || a.field - b.field || a.width - b.width)
          .filter((pos, index, sorted) => {
            const previous = sorted[index - 1];
            return !previous || previous.offset !== pos.offset || previous.field !== pos.field || previous.width !== pos.width;
          }),
      })),
    });
  }

  const stringChunks: Uint8Array[] = [];
  let stringTotal = 0;
  const appendStr = (s: string) => {
    const encoded = utf8.encode(s);
    const offset = stringTotal;
    stringChunks.push(encoded);
    stringTotal += encoded.length;
    return { offset, length: encoded.length };
  };
  const documents = docEntries.map(({ doc, length }) => ({
    id: doc.id,
    length,
    time: doc.publishedAt,
    publication: BigInt(1000 + doc.id),
    title: appendStr(doc.title),
    summary: appendStr(doc.summary),
  }));
  const meanLength = docEntries.reduce((sum, entry) => sum + entry.length, 0) / Math.max(1, docEntries.length);
  return packFspk(documents, terms, stringChunks, meanLength);
}

test('adversarial repartitioning and merging never change global local-FSPK ordering for relevance or latest', () => {
  // Adversarial distribution: 12 docs with common "commonterm" and 2 docs with rare "rareterm" + unknown CJK "量子纠缠"
  const baseTime = 1700000000000;
  const docs: SyntheticDoc[] = [];
  for (let i = 1; i <= 14; i++) {
    const isRare = i === 3 || i === 13;
    const isLong = i <= 6;
    const filler = isLong ? ' filler word padding extra text repeated length check '.repeat(8) : ' short';
    docs.push({
      id: i,
      title: isRare ? `RareTerm CommonTerm doc ${i}` : i === 14 ? '量子纠缠 架构' : i === 12 ? '量度子集纠偏缠绕' : `CommonTerm entry ${i}`,
      summary: isRare ? 'RareTerm summary' : 'CommonTerm summary',
      body: isRare
        ? `RareTerm CommonTerm C# ${filler}`
        : i === 14
          ? `详解量子纠缠与 C# 架构 ${filler}`
          : `CommonTerm ${filler}`,
      publishedAt: baseTime + i * 1000,
    });
  }

  // Partition 1: single merged page (all 14 docs)
  const merged = [buildFspkPage(docs)];
  // Partition 2: adversarial skew (page 1 has 12 common docs, page 2 has ONLY the 2 rare/special tail docs!)
  const skewed = [buildFspkPage(docs.slice(0, 12)), buildFspkPage(docs.slice(12))];
  // Partition 3: 5 small pages of varying sizes (2, 4, 3, 2, 3)
  const fragmented = [
    buildFspkPage(docs.slice(0, 2)),
    buildFspkPage(docs.slice(2, 6)),
    buildFspkPage(docs.slice(6, 9)),
    buildFspkPage(docs.slice(9, 11)),
    buildFspkPage(docs.slice(11, 14)),
  ];

  const queries = [
    'commonterm',
    'rareterm commonterm',
    '量子纠缠',
    '"量子纠缠 架构"',
    'rareterm commonterm c#',
    '不存在的组合词',
  ];

  for (const sort of ['relevance', 'latest'] as const) {
    for (const q of queries) {
      const plan = planLocalSearchQuery(q);
      const rMerged = decodeLocalSearchResult(scoreAdmittedCorpusGlobal(merged, plan, 1, 20, sort));
      const rSkewed = decodeLocalSearchResult(scoreAdmittedCorpusGlobal(skewed, plan, 1, 20, sort));
      const rFrag = decodeLocalSearchResult(scoreAdmittedCorpusGlobal(fragmented, plan, 1, 20, sort));

      assert.equal(rSkewed.total, rMerged.total, `[${sort}:${q}] skewed total drifted`);
      assert.equal(rFrag.total, rMerged.total, `[${sort}:${q}] fragmented total drifted`);
      assert.deepEqual(rSkewed.items.map(a => a.id), rMerged.items.map(a => a.id), `[${sort}:${q}] skewed order drifted`);
      assert.deepEqual(rFrag.items.map(a => a.id), rMerged.items.map(a => a.id), `[${sort}:${q}] fragmented order drifted`);
    }
  }

  // Verify unknown CJK "量子纠缠" admits ONLY doc 14, NEVER distractor doc 12 with isolated chars
  const cjkRes = decodeLocalSearchResult(scoreAdmittedCorpusGlobal(skewed, planLocalSearchQuery('量子纠缠'), 1, 20, 'relevance'));
  assert.deepEqual(cjkRes.items.map(a => a.id), [14]);
});
