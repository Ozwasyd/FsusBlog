import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  analyzeQuery,
  analyzeText,
  hashTerm32,
  hashTerm64,
  SEARCH_ANALYZER_VERSION,
} from '../../src/Contracts/search-analyzer.ts';

type ExpectedToken = {
  term: string;
  kind: string;
  position: number;
  width: number;
  advance: number;
  sourceStart: number;
  sourceEnd: number;
  isStopword: boolean;
};

type VectorFile = {
  analyzerVersion: number;
  textCases: {
    name: string;
    mode: 'index' | 'query';
    input: string;
    expectedSourceLength: number;
    mustContain: ExpectedToken[];
    mustNotContainTerms: string[];
  }[];
  queryCases: {
    name: string;
    input: string;
    isExactIdentifier: boolean;
    isOverlongExactIdentifier: boolean;
    expectedTerms: string[];
  }[];
};

const vectors: VectorFile = JSON.parse(
  readFileSync(new URL('fixtures/search-analyzer-vectors.json', import.meta.url), 'utf8'),
);

test('unified TypeScript analyzer passes all shared cross-language golden vectors', () => {
  assert.equal(SEARCH_ANALYZER_VERSION, vectors.analyzerVersion);

  for (const tc of vectors.textCases) {
    const result = analyzeText(tc.input, tc.mode, 0, 0);
    assert.equal(result.sourceLength, tc.expectedSourceLength, `[${tc.name}] sourceLength mismatch`);

    for (const tok of result.tokens) {
      assert.equal(tok.key, hashTerm64(tok.term));
      assert.equal(tok.hash32, hashTerm32(tok.term));
      assert(tok.sourceStart >= 0 && tok.sourceEnd >= tok.sourceStart && tok.sourceEnd <= tc.input.length,
        `[${tc.name}] invalid source span [${tok.sourceStart}, ${tok.sourceEnd})`);
      // Ensure UTF-16 surrogate pairs are never split
      if (tok.sourceStart < tc.input.length) {
        const c = tc.input.charCodeAt(tok.sourceStart);
        assert(!(c >= 0xdc00 && c <= 0xdfff), `[${tc.name}] sourceStart splits surrogate pair`);
      }
      if (tok.sourceEnd > 0 && tok.sourceEnd < tc.input.length) {
        const c = tc.input.charCodeAt(tok.sourceEnd);
        assert(!(c >= 0xdc00 && c <= 0xdfff), `[${tc.name}] sourceEnd splits surrogate pair`);
      }
    }

    for (const exp of tc.mustContain) {
      const found = result.tokens.some(t =>
        t.term === exp.term &&
        t.kind === exp.kind &&
        t.position === exp.position &&
        t.width === exp.width &&
        t.advance === exp.advance &&
        t.sourceStart === exp.sourceStart &&
        t.sourceEnd === exp.sourceEnd &&
        t.isStopword === exp.isStopword);
      assert(found, `[${tc.name}] missing expected token ${JSON.stringify(exp)}`);
    }

    for (const forbidden of tc.mustNotContainTerms) {
      assert(result.tokens.every(t => t.term !== forbidden), `[${tc.name}] emitted forbidden term '${forbidden}'`);
    }
  }

  for (const qc of vectors.queryCases) {
    const analyzed = analyzeQuery(qc.input);
    assert.equal(analyzed.isExactIdentifier, qc.isExactIdentifier, `[${qc.name}] isExactIdentifier`);
    assert.equal(analyzed.isOverlongExactIdentifier, qc.isOverlongExactIdentifier, `[${qc.name}] isOverlongExactIdentifier`);
    assert.deepEqual(analyzed.tokens.map(t => t.term), qc.expectedTerms, `[${qc.name}] terms`);
  }
});

test('TypeScript analyzer handles malformed surrogates and >4096 CJK runs safely', () => {
  const malformed = 'alpha\uD800beta\0gamma';
  const res = analyzeText(malformed, 'index');
  const terms = new Set(res.tokens.map(t => t.term));
  assert(terms.has('alpha') && terms.has('beta') && terms.has('gamma'));

  const longCjk = '博客' + '雪'.repeat(4100) + '搜索';
  const longRes = analyzeText(longCjk, 'index');
  assert.equal(longRes.sourceLength, longCjk.length);
  assert(longRes.tokens.some(t => t.term === '博客' && t.position === 0));
  assert(longRes.tokens.some(t => t.term === '搜索' && t.position === 4102));
});
