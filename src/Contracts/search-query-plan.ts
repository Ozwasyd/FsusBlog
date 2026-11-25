import { WireLimits as Limit } from './wire.generated.ts';
import {
  analyzeText,
  hashTerm32,
  hashTerm64,
  isStrictExactIdentifier,
  normalizeWithOffsets,
  SEARCH_ANALYZER_VERSION,
  type SearchToken,
} from './search-analyzer.ts';

export type SearchMatchTier = 0 | 1; // 0 = Primary, 1 = Relaxed
export type SearchConceptKind = 'term' | 'cjkSequence' | 'compoundHyphen';

export interface SearchConceptStep {
  readonly canonicalTerm: string;
  readonly canonicalKey: bigint;
  readonly exactFormTerm: string;
  readonly exactFormKey: bigint;
  readonly differsFromExactForm: boolean;
  readonly relativeOffset: number;
  readonly width: number;
  readonly canonicalHash32: number;
  readonly exactFormHash32: number;
  readonly isStopword: boolean;
}

export interface SearchConcept {
  readonly index: number;
  readonly kind: SearchConceptKind;
  readonly steps: readonly SearchConceptStep[];
  readonly shortAsciiPrefix: string | null;
  readonly isStrictIdentifier: boolean;
  readonly isStopword: boolean;
  readonly queryPosition: number;
  readonly queryWidth: number;
  readonly identityKey: string;
}

export interface SearchPhraseConstraint {
  readonly steps: readonly SearchConceptStep[];
  readonly rawText: string;
}

export interface SearchQueryPlan {
  readonly profileVersion: number;
  readonly analyzerVersion: number;
  readonly normalizedText: string;
  readonly concepts: readonly SearchConcept[];
  readonly contentConcepts: readonly SearchConcept[];
  readonly quotedPhrases: readonly SearchPhraseConstraint[];
  readonly orderedQuerySequence: readonly SearchConceptStep[];
  readonly hasStrictIdentifier: boolean;
  readonly isOverlongExactIdentifier: boolean;
  readonly isEmpty: boolean;
}

export const SEARCH_SCORING_PROFILE_VERSION = Limit.SearchFas4Profile;
export const RELAXATION_TRIGGER_PRIMARY_COUNT = 5;
export const MAX_RELAXED_RESULTS = 50;
export const EXACT_FORM_BONUS_FACTOR = 0.15;
export const TITLE_OR_HEADING_PHRASE_BONUS_FACTOR = 0.35;
export const BODY_PHRASE_BONUS_FACTOR = 0.20;
export const TIGHT_PROXIMITY_BONUS_FACTOR = 0.10;

export function allowsRelaxation(plan: SearchQueryPlan): boolean {
  return !plan.isEmpty && !plan.isOverlongExactIdentifier && plan.contentConcepts.length >= 3;
}

export function minRelaxedConcepts(contentConceptCount: number): number {
  if (contentConceptCount <= 2) return contentConceptCount;
  if (contentConceptCount === 3) return 2;
  if (contentConceptCount === 4) return 3;
  return Math.max(3, Math.ceil(contentConceptCount * 0.30));
}

export function minRelaxedIdfRatio(contentConceptCount: number): number {
  if (contentConceptCount <= 3) return 0.60;
  if (contentConceptCount === 4) return 0.50;
  return 0.20;
}

export function inverseDocumentFrequency(totalDocs: number, docFreq: number): number {
  if (totalDocs <= 0) return 0;
  const clamped = Math.max(0, Math.min(totalDocs, docFreq));
  return Math.log(1 + (totalDocs - clamped + 0.5) / (clamped + 0.5));
}

function emptyPlan(normalizedText: string): SearchQueryPlan {
  return {
    profileVersion: SEARCH_SCORING_PROFILE_VERSION,
    analyzerVersion: SEARCH_ANALYZER_VERSION,
    normalizedText,
    concepts: [],
    contentConcepts: [],
    quotedPhrases: [],
    orderedQuerySequence: [],
    hasStrictIdentifier: false,
    isOverlongExactIdentifier: false,
    isEmpty: true,
  };
}

function stripSurroundingQuotes(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === '“' && s[s.length - 1] === '”'))) {
    return s.slice(1, -1).trim();
  }
  return s;
}

function splitQuotedSegments(text: string): { text: string; isQuoted: boolean }[] {
  const result: { text: string; isQuoted: boolean }[] = [];
  let i = 0;
  let plainStart = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === '“') {
      const closeCh = ch === '"' ? '"' : '”';
      const closeIdx = text.indexOf(closeCh, i + 1);
      if (closeIdx > i) {
        if (i > plainStart) result.push({ text: text.slice(plainStart, i), isQuoted: false });
        const inner = text.slice(i + 1, closeIdx).trim();
        if (inner.length > 0) result.push({ text: inner, isQuoted: true });
        i = closeIdx + 1;
        plainStart = i;
        continue;
      }
    }
    i++;
  }
  if (plainStart < text.length) result.push({ text: text.slice(plainStart), isQuoted: false });
  return result;
}

function makeStep(
  canonicalTerm: string,
  exactFormTerm: string,
  differsFromExactForm: boolean,
  relativeOffset: number,
  width: number,
  canonicalHash32: number,
  exactFormHash32: number,
  isStopword: boolean,
): SearchConceptStep {
  return {
    canonicalTerm,
    canonicalKey: hashTerm64(canonicalTerm),
    exactFormTerm,
    exactFormKey: hashTerm64(exactFormTerm),
    differsFromExactForm,
    relativeOffset,
    width,
    canonicalHash32,
    exactFormHash32,
    isStopword,
  };
}

function readPairedForm(tokens: readonly SearchToken[], cursor: { i: number }) {
  const primary = tokens[cursor.i++];
  const exactTerm = primary.term;
  const exactHash32 = primary.hash32;
  if (cursor.i < tokens.length &&
      tokens[cursor.i].kind === 'scriptAlias' &&
      tokens[cursor.i].position === primary.position &&
      tokens[cursor.i].width === primary.width) {
    const alias = tokens[cursor.i++];
    return {
      canonicalTerm: alias.term,
      exactTerm,
      differs: alias.term !== exactTerm,
      canonHash32: alias.hash32,
      exactHash32,
    };
  }
  return {
    canonicalTerm: exactTerm,
    exactTerm,
    differs: false,
    canonHash32: exactHash32,
    exactHash32,
  };
}

export function planSearchQuery(rawQuery: string): SearchQueryPlan {
  if (!rawQuery || !rawQuery.trim()) return emptyPlan('');
  const { normalized: nfkc } = normalizeWithOffsets(rawQuery, 0);
  const trimmedRaw = nfkc.trim();
  if (!trimmedRaw) return emptyPlan('');

  const unquotedWhole = stripSurroundingQuotes(trimmedRaw);
  if (isStrictExactIdentifier(unquotedWhole) && unquotedWhole.length > Limit.SearchQueryChars) {
    return {
      profileVersion: SEARCH_SCORING_PROFILE_VERSION,
      analyzerVersion: SEARCH_ANALYZER_VERSION,
      normalizedText: '',
      concepts: [],
      contentConcepts: [],
      quotedPhrases: [],
      orderedQuerySequence: [],
      hasStrictIdentifier: true,
      isOverlongExactIdentifier: true,
      isEmpty: true,
    };
  }

  let collapsed = '';
  for (let i = 0; i < trimmedRaw.length; i++) {
    const ch = trimmedRaw[i];
    if (/\s/.test(ch)) {
      if (collapsed.length > 0 && collapsed[collapsed.length - 1] !== ' ') collapsed += ' ';
      continue;
    }
    const c = trimmedRaw.charCodeAt(i);
    if (collapsed.length === Limit.SearchQueryChars - 1 && c >= 0xd800 && c <= 0xdbff) break;
    collapsed += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : ch;
    if (collapsed.length >= Limit.SearchQueryChars) break;
  }
  const normalized = collapsed.trimEnd();
  if (!normalized) return emptyPlan('');

  const segments = splitQuotedSegments(normalized);
  const allConcepts: SearchConcept[] = [];
  const quotedPhrases: SearchPhraseConstraint[] = [];
  const orderedSequence: SearchConceptStep[] = [];
  let hasStrictIdentifier = false;
  let globalPos = 0;

  for (const seg of segments) {
    if (!seg.text.trim()) continue;
    const segStartPos = globalPos;
    const analyzed = analyzeText(seg.text, 'query', 0, globalPos);
    globalPos = analyzed.endPosition;
    const tokens = analyzed.tokens;
    if (tokens.length === 0) continue;

    const shortPrefixSet = analyzed.shortAsciiPrefixes.length > 0 ? new Set(analyzed.shortAsciiPrefixes) : null;
    const phraseSteps: SearchConceptStep[] | null = seg.isQuoted ? [] : null;
    const cursor = { i: 0 };

    while (cursor.i < tokens.length) {
      const tok = tokens[cursor.i];
      if (tok.kind === 'scriptAlias') {
        cursor.i++;
        continue;
      }

      const { canonicalTerm, exactTerm, differs, canonHash32, exactHash32 } = readPairedForm(tokens, cursor);

      // 1. Pure-letter hyphenated compound
      if (tok.kind === 'exact' && !isStrictExactIdentifier(tok.term) && tok.term.includes('-') &&
          cursor.i < tokens.length && tokens[cursor.i].kind === 'subword' && tokens[cursor.i].position === tok.position) {
        const steps: SearchConceptStep[] = [
          makeStep(canonicalTerm, exactTerm, differs, 0, tok.width, canonHash32, exactHash32, tok.isStopword),
        ];
        while (cursor.i < tokens.length && tokens[cursor.i].kind === 'subword' && tokens[cursor.i].position === tok.position) {
          const sub = tokens[cursor.i];
          const p = readPairedForm(tokens, cursor);
          steps.push(makeStep(p.canonicalTerm, p.exactTerm, p.differs, 0, sub.width, p.canonHash32, p.exactHash32, sub.isStopword));
        }
        allConcepts.push({
          index: allConcepts.length,
          kind: 'compoundHyphen',
          steps,
          shortAsciiPrefix: null,
          isStrictIdentifier: false,
          isStopword: tok.isStopword,
          queryPosition: tok.position,
          queryWidth: tok.width,
          identityKey: `hyphen:${canonicalTerm}`,
        });
        if (phraseSteps) phraseSteps.push({ ...steps[0], relativeOffset: tok.position - segStartPos });
        if (!tok.isStopword) orderedSequence.push({ ...steps[0], relativeOffset: tok.position });
        continue;
      }

      // 2. Contiguous CJK bigram sequence
      if (tok.kind === 'cjkBigram') {
        const seqStartPos = tok.position;
        const steps: SearchConceptStep[] = [
          makeStep(canonicalTerm, exactTerm, differs, 0, tok.width, canonHash32, exactHash32, tok.isStopword),
        ];
        let lastPos = tok.position;
        while (cursor.i < tokens.length && tokens[cursor.i].kind === 'cjkBigram' && tokens[cursor.i].position === lastPos + 1) {
          const next = tokens[cursor.i];
          const p = readPairedForm(tokens, cursor);
          steps.push(makeStep(p.canonicalTerm, p.exactTerm, p.differs, next.position - seqStartPos, next.width, p.canonHash32, p.exactHash32, next.isStopword));
          lastPos = next.position;
        }
        if (steps.length >= 2) {
          allConcepts.push({
            index: allConcepts.length,
            kind: 'cjkSequence',
            steps,
            shortAsciiPrefix: null,
            isStrictIdentifier: false,
            isStopword: false,
            queryPosition: seqStartPos,
            queryWidth: (lastPos - seqStartPos) + 2,
            identityKey: `cjkseq:${steps.map(s => s.canonicalTerm).join('|')}`,
          });
          if (phraseSteps) {
            for (const st of steps) phraseSteps.push({ ...st, relativeOffset: (seqStartPos + st.relativeOffset) - segStartPos });
          }
          for (const st of steps) orderedSequence.push({ ...st, relativeOffset: seqStartPos + st.relativeOffset });
        } else {
          const st = steps[0];
          allConcepts.push({
            index: allConcepts.length,
            kind: 'term',
            steps: [st],
            shortAsciiPrefix: null,
            isStrictIdentifier: false,
            isStopword: st.isStopword,
            queryPosition: seqStartPos,
            queryWidth: tok.width,
            identityKey: `term:${st.canonicalTerm}`,
          });
          if (phraseSteps) phraseSteps.push({ ...st, relativeOffset: seqStartPos - segStartPos });
          if (!st.isStopword) orderedSequence.push({ ...st, relativeOffset: seqStartPos });
        }
        continue;
      }

      // 3. Regular term
      const isStrict = isStrictExactIdentifier(tok.term);
      if (isStrict) hasStrictIdentifier = true;
      const shortAsciiPrefix = !isStrict && shortPrefixSet && shortPrefixSet.has(tok.term) ? tok.term : null;
      const step = makeStep(canonicalTerm, exactTerm, differs, 0, tok.width, canonHash32, exactHash32, tok.isStopword);
      const conceptKey = `${isStrict ? 'strict' : 'term'}:${canonicalTerm}${shortAsciiPrefix ? ':p' : ''}`;
      allConcepts.push({
        index: allConcepts.length,
        kind: 'term',
        steps: [step],
        shortAsciiPrefix,
        isStrictIdentifier: isStrict,
        isStopword: tok.isStopword,
        queryPosition: tok.position,
        queryWidth: tok.width,
        identityKey: conceptKey,
      });
      if (phraseSteps) phraseSteps.push({ ...step, relativeOffset: tok.position - segStartPos });
      if (!tok.isStopword) orderedSequence.push({ ...step, relativeOffset: tok.position });
    }

    if (phraseSteps && phraseSteps.length >= 2) {
      const baseOffset = phraseSteps[0].relativeOffset;
      quotedPhrases.push({
        steps: phraseSteps.map(s => ({ ...s, relativeOffset: s.relativeOffset - baseOffset })),
        rawText: seg.text,
      });
    }
  }

  if (allConcepts.length === 0) return emptyPlan(normalized);

  const deduped: SearchConcept[] = [];
  const seenIds = new Map<string, number>();
  for (const concept of allConcepts) {
    const existingIdx = seenIds.get(concept.identityKey);
    if (existingIdx !== undefined) {
      if (concept.isStrictIdentifier && !deduped[existingIdx].isStrictIdentifier) {
        deduped[existingIdx] = { ...deduped[existingIdx], isStrictIdentifier: true };
      }
      continue;
    }
    seenIds.set(concept.identityKey, deduped.length);
    deduped.push({ ...concept, index: deduped.length });
  }

  const nonStop = deduped.filter(c => !c.isStopword);
  const contentConcepts = (nonStop.length > 0 ? nonStop : deduped).map((c, idx) => ({ ...c, index: idx }));

  let seqArray: SearchConceptStep[] = [];
  if (orderedSequence.length >= 2) {
    const basePos = orderedSequence[0].relativeOffset;
    seqArray = orderedSequence.map(s => ({ ...s, relativeOffset: s.relativeOffset - basePos }));
  }

  return {
    profileVersion: SEARCH_SCORING_PROFILE_VERSION,
    analyzerVersion: SEARCH_ANALYZER_VERSION,
    normalizedText: normalized,
    concepts: deduped,
    contentConcepts,
    quotedPhrases,
    orderedQuerySequence: seqArray,
    hasStrictIdentifier,
    isOverlongExactIdentifier: false,
    isEmpty: contentConcepts.length === 0,
  };
}

export function isQuerySupportedByLocalFspk(plan: SearchQueryPlan): { supported: boolean; reason?: string } {
  for (const phrase of plan.quotedPhrases) {
    const nonStop = phrase.steps.filter(s => !s.isStopword);
    if (nonStop.length === 0) {
      return { supported: false, reason: 'Stopword-only quoted phrase requires server positional index' };
    }
  }
  return { supported: true };
}
