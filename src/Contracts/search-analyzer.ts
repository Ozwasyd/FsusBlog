import { dataView } from './binary.ts';
import lexicon from './search-lexicon.json' with { type: 'json' };
import scTcMap from './search-sc-tc-map.json' with { type: 'json' };
import { WireLimits as Limit } from './wire.generated.ts';

export type SearchTokenKind = 'exact' | 'cjkBigram' | 'cjkChar' | 'prefix' | 'subword' | 'scriptAlias';
export type SearchAnalysisMode = 'index' | 'query';

export type SearchToken = Readonly<{
  term: string;
  key: bigint;
  hash32: number;
  kind: SearchTokenKind;
  position: number;
  width: number;
  advance: number;
  sourceStart: number;
  sourceEnd: number;
  isStopword: boolean;
}>;

export type AnalyzedQuery = Readonly<{
  normalizedText: string;
  tokens: readonly SearchToken[];
  shortAsciiPrefixes: readonly string[];
  isExactIdentifier: boolean;
  isOverlongExactIdentifier: boolean;
  isOverlongQuery: boolean;
}>;

export const SEARCH_ANALYZER_VERSION = Limit.SearchAnalyzerVersion;
export const BLOCK_POSITION_GAP = 16;
export const MAX_CJK_SEGMENT = 4096;
export const ASCII_MIN_PREFIX_LENGTH = 3;
export const ASCII_MAX_PREFIX_LENGTH = 12;
export const MAX_ASCII_SUBTOKENS = 32;
export const MAX_TOKENS_PER_FIELD = 262_144;

const utf8 = new TextEncoder();
const cjkSingle = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const combiningMark = /\p{M}/u;
const unicodeLetterOrDigit = /[\p{Letter}\p{Decimal_Number}]/u;

const lexiconWeights = new Map<string, number>();
const lexiconStopwords = new Set<string>(lexicon.stopwords);
for (const [word, weight] of Object.entries(lexicon.words)) {
  if ([...word].every(ch => isCjkCode(ch.charCodeAt(0)))) lexiconWeights.set(word, weight);
}
for (const word of lexiconStopwords) {
  if (!lexiconWeights.has(word)) lexiconWeights.set(word, 1);
}
const maxLexiconWord = Math.max(...[...lexiconWeights.keys()].map(w => w.length));

const tradToSimp = new Map<string, string>(Object.entries(scTcMap.traditionalToSimplified));

export function isCjkCode(code: number): boolean {
  return (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7af);
}

const isAsciiLower = (c: number) => c >= 97 && c <= 122;
const isAsciiUpper = (c: number) => c >= 65 && c <= 90;
const isAsciiDigit = (c: number) => c >= 48 && c <= 57;
const isAsciiLetter = (c: number) => isAsciiLower(c) || isAsciiUpper(c);
const isAsciiAlnum = (c: number) => isAsciiLetter(c) || isAsciiDigit(c);

export function toSimplifiedCjk(text: string): string {
  let out: string[] | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const mapped = tradToSimp.get(ch);
    if (mapped !== undefined) {
      if (!out) out = text.slice(0, i).split('');
      out.push(mapped);
    } else if (out) {
      out.push(ch);
    }
  }
  return out ? out.join('') : text;
}

export function hashTerm64(term: string): bigint {
  return hashBytes64(utf8.encode(term));
}

function hashBytes64(bytes: Uint8Array): bigint {
  let h = 14695981039346656037n;
  const prime = 1099511628211n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = (h * prime) & mask;
  }
  return h;
}

export function hashTerm32(term: string): number {
  return hashBytes32(utf8.encode(term));
}

function hashBytes32(bytes: Uint8Array): number {
  let hash = 0;
  let at = 0;
  const view = dataView(bytes);
  const rotate = (value: number, bits: number) => (value << bits) | (value >>> (32 - bits));
  const mix = (value: number) => Math.imul(rotate(Math.imul(value, 0xcc9e2d51), 15), 0x1b873593);
  while (bytes.length - at >= 4) {
    hash ^= mix(view.getUint32(at, true));
    hash = (Math.imul(rotate(hash, 13), 5) + 0xe6546b64) | 0;
    at += 4;
  }
  let tail = 0;
  for (let i = 0; at + i < bytes.length; i++) tail |= bytes[at + i] << (8 * i);
  hash ^= mix(tail) ^ bytes.length;
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

function decodeCodePointLen(s: string, index: number): number {
  const c = s.charCodeAt(index);
  if (c >= 0xd800 && c <= 0xdbff && index + 1 < s.length) {
    const next = s.charCodeAt(index + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return 2;
  }
  return 1;
}

function isIsolatedSurrogate(s: string, index: number, len: number): boolean {
  if (len !== 1) return false;
  const c = s.charCodeAt(index);
  return c >= 0xd800 && c <= 0xdfff;
}

export function normalizeWithOffsets(source: string, baseOffset = 0): { normalized: string; origStart: number[]; origEnd: number[] } {
  if (source.length === 0) return { normalized: '', origStart: [], origEnd: [] };
  let allAscii = true;
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) >= 0x80) { allAscii = false; break; }
  }
  if (allAscii) {
    const origStart = new Array<number>(source.length);
    const origEnd = new Array<number>(source.length);
    for (let i = 0; i < source.length; i++) {
      origStart[i] = baseOffset + i;
      origEnd[i] = baseOffset + i + 1;
    }
    return { normalized: source, origStart, origEnd };
  }

  let normalized = '';
  const origStart: number[] = [];
  const origEnd: number[] = [];
  let idx = 0;
  while (idx < source.length) {
    const clusterStart = idx;
    const firstLen = decodeCodePointLen(source, idx);
    idx += firstLen;
    while (idx < source.length) {
      const nextLen = decodeCodePointLen(source, idx);
      if (isIsolatedSurrogate(source, idx, nextLen)) break;
      const ch = source.slice(idx, idx + nextLen);
      if (!combiningMark.test(ch)) break;
      idx += nextLen;
    }
    const clusterEnd = idx;
    const rawStart = baseOffset + clusterStart;
    const rawEnd = baseOffset + clusterEnd;
    let norm: string;
    if (clusterEnd - clusterStart === 1 && isIsolatedSurrogate(source, clusterStart, 1)) {
      norm = '\uFFFD';
    } else if (clusterEnd - clusterStart === 1 && source.charCodeAt(clusterStart) < 0x80) {
      norm = source[clusterStart];
    } else {
      norm = source.slice(clusterStart, clusterEnd).normalize('NFKC');
    }
    normalized += norm;
    for (let j = 0; j < norm.length; j++) {
      origStart.push(rawStart);
      origEnd.push(rawEnd);
    }
  }
  return { normalized, origStart, origEnd };
}

export function isStrictExactIdentifier(token: string): boolean {
  if (token.length < 2) return false;
  let hasDigit = false;
  let hasHyphen = false;
  let hasStrictSymbol = false;
  let hasAlnum = false;
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    if (isAsciiAlnum(c)) {
      hasAlnum = true;
      if (isAsciiDigit(c)) hasDigit = true;
    } else if (c === 45 /* - */) {
      if (i === 0 || i === token.length - 1 || !isAsciiAlnum(token.charCodeAt(i - 1)) || !isAsciiAlnum(token.charCodeAt(i + 1))) {
        return false;
      }
      hasHyphen = true;
    } else if (c === 95 /* _ */ || c === 46 /* . */ || c === 47 /* / */) {
      if (i === token.length - 1) return false;
      if (c === 46 && i === 0) {
        if (!isAsciiLetter(token.charCodeAt(1))) return false;
      } else if (i === 0 || !isAsciiAlnum(token.charCodeAt(i - 1)) || !isAsciiAlnum(token.charCodeAt(i + 1))) {
        return false;
      }
      hasStrictSymbol = true;
    } else if (c === 35 /* # */ || c === 43 /* + */) {
      if (i === 0) return false;
      hasStrictSymbol = true;
    } else {
      return false;
    }
  }
  return hasAlnum && (hasStrictSymbol || (hasHyphen && hasDigit));
}

function startsTechnicalToken(text: string, index: number): boolean {
  const c = text.charCodeAt(index);
  if (isAsciiAlnum(c)) return true;
  if (c === 46 /* . */ && index + 1 < text.length && isAsciiLetter(text.charCodeAt(index + 1)) &&
      (index === 0 || !isAsciiAlnum(text.charCodeAt(index - 1)))) {
    return true;
  }
  return false;
}

function scanTechnicalToken(text: string, start: number): number {
  let i = start;
  if (text.charCodeAt(i) === 46) i++;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (isAsciiAlnum(c)) {
      i++;
      continue;
    }
    if ((c === 45 || c === 95 || c === 46 || c === 47) && i + 1 < text.length && isAsciiAlnum(text.charCodeAt(i + 1))) {
      i += 2;
      continue;
    }
    break;
  }
  if (i < text.length && (text.charCodeAt(i) === 35 || text.charCodeAt(i) === 43)) {
    const symStart = i;
    while (i < text.length && (text.charCodeAt(i) === 35 || text.charCodeAt(i) === 43) && i - symStart < 3) i++;
    if (i < text.length && isAsciiAlnum(text.charCodeAt(i))) i = symStart;
  }
  return i;
}

function hasTechnicalPunctuation(token: string): boolean {
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    if (c === 45 || c === 95 || c === 46 || c === 47 || c === 35 || c === 43) return true;
  }
  return false;
}

function isSubwordBoundary(token: string, index: number): boolean {
  const prev = token.charCodeAt(index - 1);
  const curr = token.charCodeAt(index);
  return isAsciiDigit(prev) !== isAsciiDigit(curr) ||
    (isAsciiLower(prev) && isAsciiUpper(curr)) ||
    (isAsciiUpper(prev) && isAsciiUpper(curr) && index + 1 < token.length && isAsciiLower(token.charCodeAt(index + 1)));
}

function segmentCjk(simpRun: string): { rel: number; width: number }[] {
  const len = simpRun.length;
  if (len === 1) return [{ rel: 0, width: 1 }];
  const next = new Uint8Array(len);
  const scores = new Int32Array(len + 1);
  for (let at = len - 1; at >= 0; at--) {
    let score = 4 + scores[at + 1];
    let best = 1;
    for (let width = Math.min(maxLexiconWord, len - at); width >= 1; width--) {
      const weight = lexiconWeights.get(simpRun.slice(at, at + width));
      if (weight === undefined) continue;
      const candidate = 4 * weight + width + scores[at + width];
      if (candidate < score || (candidate === score && width <= best)) continue;
      score = candidate;
      best = width;
    }
    next[at] = best;
    scores[at] = score;
  }
  const out: { rel: number; width: number }[] = [];
  for (let at = 0; at < len; at += next[at]) out.push({ rel: at, width: next[at] });
  return out;
}

function lowerAscii(s: string): string {
  return s.replace(/[A-Z]/g, ch => ch.toLowerCase());
}

export function analyzeText(
  rawText: string,
  mode: SearchAnalysisMode = 'index',
  baseSourceOffset = 0,
  startPosition = 0,
): { tokens: SearchToken[]; sourceLength: number; endPosition: number; shortAsciiPrefixes: string[] } {
  if (!rawText) return { tokens: [], sourceLength: 0, endPosition: startPosition, shortAsciiPrefixes: [] };
  const { normalized: text, origStart, origEnd } = normalizeWithOffsets(rawText, baseSourceOffset);
  const tokens: SearchToken[] = [];
  const shortAsciiPrefixes: string[] = [];
  const indexMode = mode === 'index';
  let position = startPosition;
  let sourceLength = 0;

  const emit = (
    term: string,
    kind: SearchTokenKind,
    pos: number,
    width: number,
    advance: number,
    normStart: number,
    normEnd: number,
  ) => {
    if (!term || tokens.length >= MAX_TOKENS_PER_FIELD) return;
    const bytes = utf8.encode(term);
    tokens.push({
      term,
      key: hashBytes64(bytes),
      hash32: hashBytes32(bytes),
      kind,
      position: pos,
      width,
      advance,
      sourceStart: origStart[normStart],
      sourceEnd: origEnd[normEnd - 1],
      isStopword: lexiconStopwords.has(term),
    });
  };

  for (let i = 0; i < text.length;) {
    if (tokens.length >= MAX_TOKENS_PER_FIELD) break;

    if (startsTechnicalToken(text, i)) {
      const start = i;
      const end = scanTechnicalToken(text, i);
      i = end;
      const rawToken = text.slice(start, end);
      if (rawToken.length > Limit.SearchQueryChars) continue;

      const lower = lowerAscii(rawToken);
      const tokenPos = position;
      position += 1;
      sourceLength += 1;

      const hasPunct = hasTechnicalPunctuation(rawToken);
      const isStrict = isStrictExactIdentifier(rawToken);
      const isPureAlphaHyphen = !isStrict && rawToken.includes('-');

      emit(lower, 'exact', tokenPos, 1, 1, start, end);

      if (indexMode) {
        const seen = new Set<string>([lower]);
        let count = 0;
        const tryEmit = (candidate: string, kind: SearchTokenKind) => {
          if (count >= MAX_ASCII_SUBTOKENS || candidate.length < 2 || seen.has(candidate)) return false;
          seen.add(candidate);
          count++;
          emit(candidate, kind, tokenPos, 1, 0, start, end);
          return true;
        };
        const emitCamelSubwords = (raw: string, low: string) => {
          let segStart = 0;
          for (let j = 1; j <= raw.length; j++) {
            if (j < raw.length && !isSubwordBoundary(raw, j)) continue;
            const segLen = j - segStart;
            if (segLen >= 2 && segLen < raw.length) {
              tryEmit(low.slice(segStart, j), 'subword');
            }
            segStart = j;
          }
        };
        const emitCamelPrefixes = (raw: string, low: string) => {
          let segStart = 0;
          for (let j = 1; j <= raw.length; j++) {
            if (j < raw.length && !isSubwordBoundary(raw, j)) continue;
            const segLen = j - segStart;
            if (segLen >= 2 && segLen < raw.length) {
              const segLow = low.slice(segStart, j);
              const maxP = Math.min(ASCII_MAX_PREFIX_LENGTH, segLen - 1);
              for (let l = ASCII_MIN_PREFIX_LENGTH; l <= maxP; l++) tryEmit(segLow.slice(0, l), 'prefix');
            }
            segStart = j;
          }
        };
        if (!hasPunct) {
          emitCamelSubwords(rawToken, lower);
          const maxP = Math.min(ASCII_MAX_PREFIX_LENGTH, lower.length - 1);
          for (let l = ASCII_MIN_PREFIX_LENGTH; l <= maxP; l++) tryEmit(lower.slice(0, l), 'prefix');
          emitCamelPrefixes(rawToken, lower);
        } else {
          const dotIdx = lower.indexOf('.');
          if (dotIdx > 0 && dotIdx + 2 < lower.length) {
            const dottedSuffix = lower.slice(dotIdx);
            if (!dottedSuffix.slice(1).includes('.')) tryEmit(dottedSuffix, 'subword');
          }
          let segStart = 0;
          for (let j = 0; j <= rawToken.length; j++) {
            if (j < rawToken.length && !'-_./'.includes(rawToken[j])) continue;
            const segLen = j - segStart;
            if (segLen >= 2 && segLen < rawToken.length) {
              const segRaw = rawToken.slice(segStart, j);
              const segLow = lowerAscii(segRaw);
              tryEmit(segLow, 'subword');
              if (!hasTechnicalPunctuation(segRaw)) {
                emitCamelSubwords(segRaw, segLow);
                const maxP = Math.min(ASCII_MAX_PREFIX_LENGTH, segLow.length - 1);
                for (let l = ASCII_MIN_PREFIX_LENGTH; l <= maxP; l++) tryEmit(segLow.slice(0, l), 'prefix');
                emitCamelPrefixes(segRaw, segLow);
              }
            }
            segStart = j + 1;
          }
        }
      } else {
        if (isPureAlphaHyphen) {
          const seen = new Set<string>([lower]);
          let segStart = 0;
          for (let j = 0; j <= rawToken.length; j++) {
            if (j < rawToken.length && rawToken[j] !== '-') continue;
            const segLen = j - segStart;
            if (segLen >= 1 && segLen < rawToken.length) {
              const segLow = lower.slice(segStart, j);
              if (!seen.has(segLow)) {
                seen.add(segLow);
                emit(segLow, 'subword', tokenPos, 1, 0, start + segStart, start + j);
              }
            }
            segStart = j + 1;
          }
        }
        if (!hasPunct && lower.length >= 1 && lower.length < ASCII_MIN_PREFIX_LENGTH && !shortAsciiPrefixes.includes(lower)) {
          shortAsciiPrefixes.push(lower);
        }
      }
      continue;
    }

    if (isCjkCode(text.charCodeAt(i))) {
      const start = i++;
      while (i < text.length && isCjkCode(text.charCodeAt(i))) i++;
      const runLen = i - start;
      const basePos = position;
      sourceLength += emitCjkRun(text, start, i, basePos, indexMode, emit);
      position += runLen;
      continue;
    }

    const cpLen = decodeCodePointLen(text, i);
    const ch = text.slice(i, i + cpLen);
    const cp = ch.codePointAt(0) ?? 0xfffd;
    if (cp >= 0x80 && unicodeLetterOrDigit.test(ch) && !cjkSingle.test(ch)) {
      emit(ch.toLowerCase(), 'exact', position, 1, 1, i, i + cpLen);
      position += 1;
      sourceLength += 1;
    }
    i += cpLen;
  }

  return { tokens, sourceLength, endPosition: position, shortAsciiPrefixes };
}

function emitCjkRun(
  text: string,
  start: number,
  end: number,
  basePos: number,
  indexMode: boolean,
  emit: (term: string, kind: SearchTokenKind, pos: number, width: number, advance: number, ns: number, ne: number) => void,
): number {
  const runLen = end - start;
  if (runLen === 1) {
    const single = text.slice(start, end);
    emit(single, 'exact', basePos, 1, 1, start, end);
    const simp = toSimplifiedCjk(single);
    if (simp !== single) emit(simp, 'scriptAlias', basePos, 1, 0, start, end);
    return 1;
  }

  const simpRun = toSimplifiedCjk(text.slice(start, end));
  const emitWithAlias = (orig: string, simp: string, kind: SearchTokenKind, pos: number, width: number, adv: number, ns: number, ne: number) => {
    emit(orig, kind, pos, width, adv, ns, ne);
    if (simp !== orig) emit(simp, 'scriptAlias', pos, width, 0, ns, ne);
  };

  if (runLen > MAX_CJK_SEGMENT) {
    for (let rel = 0; rel < runLen; rel++) {
      const abs = start + rel;
      const pos = basePos + rel;
      for (let w = Math.min(maxLexiconWord, runLen - rel); w >= 2; w--) {
        const simpCand = simpRun.slice(rel, rel + w);
        if (lexiconWeights.has(simpCand)) {
          emitWithAlias(text.slice(abs, abs + w), simpCand, 'exact', pos, w, 0, abs, abs + w);
        }
      }
      if (rel + 1 < runLen && !lexiconWeights.has(simpRun.slice(rel, rel + 2))) {
        emitWithAlias(text.slice(abs, abs + 2), simpRun.slice(rel, rel + 2), 'cjkBigram', pos, 2, indexMode ? 0 : 1, abs, abs + 2);
      }
      if (indexMode) {
        emitWithAlias(text.slice(abs, abs + 1), simpRun.slice(rel, rel + 1), 'cjkChar', pos, 1, 1, abs, abs + 1);
      }
    }
    return runLen;
  }

  const segments = segmentCjk(simpRun);
  const emittedBigrams = new Set<number>();
  const emitBigramOnce = (rel: number, adv: number) => {
    if (rel < 0 || rel + 2 > runLen || emittedBigrams.has(rel)) return;
    emittedBigrams.add(rel);
    const abs = start + rel;
    emitWithAlias(text.slice(abs, abs + 2), simpRun.slice(rel, rel + 2), 'cjkBigram', basePos + rel, 2, adv, abs, abs + 2);
  };

  let idx = 0;
  while (idx < segments.length) {
    const { rel, width } = segments[idx];
    if (width >= 2) {
      const abs = start + rel;
      emitWithAlias(text.slice(abs, abs + width), simpRun.slice(rel, rel + width), 'exact', basePos + rel, width, width, abs, abs + width);
      for (let r = 0; r < width; r++) {
        const maxSub = Math.min(width - 1, width - r);
        for (let subW = maxSub; subW >= 2; subW--) {
          const subSimp = simpRun.slice(rel + r, rel + r + subW);
          if (lexiconWeights.has(subSimp)) {
            emitWithAlias(text.slice(abs + r, abs + r + subW), subSimp, 'subword', basePos + rel + r, subW, 0, abs + r, abs + r + subW);
            if (subW === 2) emittedBigrams.add(rel + r);
          }
        }
      }
      if (width === 2) emittedBigrams.add(rel);
      if (indexMode) {
        for (let r = 0; r + 1 < width; r++) emitBigramOnce(rel + r, 0);
        for (let r = 0; r < width; r++) {
          emitWithAlias(text.slice(abs + r, abs + r + 1), simpRun.slice(rel + r, rel + r + 1), 'cjkChar', basePos + rel + r, 1, 0, abs + r, abs + r + 1);
        }
      }
      idx++;
    } else {
      const groupStart = rel;
      while (idx < segments.length && segments[idx].width === 1) idx++;
      const groupEnd = idx < segments.length ? segments[idx].rel : runLen;
      const groupLen = groupEnd - groupStart;
      if (groupLen === 1) {
        const abs = start + groupStart;
        const singleSimp = simpRun.slice(groupStart, groupStart + 1);
        const isLexiconSingle = lexiconWeights.has(singleSimp) || lexiconStopwords.has(singleSimp);
        if (indexMode) {
          emitWithAlias(text.slice(abs, abs + 1), singleSimp, isLexiconSingle ? 'exact' : 'cjkChar', basePos + groupStart, 1, 1, abs, abs + 1);
        } else if (isLexiconSingle) {
          emitWithAlias(text.slice(abs, abs + 1), singleSimp, 'exact', basePos + groupStart, 1, 1, abs, abs + 1);
        } else {
          let bridged = false;
          if (groupStart > 0) { emitBigramOnce(groupStart - 1, 1); bridged = true; }
          if (groupStart + 1 < runLen) { emitBigramOnce(groupStart, bridged ? 0 : 1); bridged = true; }
          if (!bridged) {
            emitWithAlias(text.slice(abs, abs + 1), singleSimp, 'exact', basePos + groupStart, 1, 1, abs, abs + 1);
          }
        }
      } else {
        for (let r = 0; r + 1 < groupLen; r++) emitBigramOnce(groupStart + r, r === 0 ? groupLen : 0);
        if (indexMode) {
          for (let r = 0; r < groupLen; r++) {
            const abs = start + groupStart + r;
            emitWithAlias(text.slice(abs, abs + 1), simpRun.slice(groupStart + r, groupStart + r + 1), 'cjkChar', basePos + groupStart + r, 1, 0, abs, abs + 1);
          }
        }
      }
    }
  }

  if (indexMode) {
    for (let s = 1; s < segments.length; s++) emitBigramOnce(segments[s].rel - 1, 0);
  }
  return runLen;
}

export function analyzeQuery(rawQuery: string): AnalyzedQuery {
  if (!rawQuery || !rawQuery.trim()) {
    return {
      normalizedText: '',
      tokens: [],
      shortAsciiPrefixes: [],
      isExactIdentifier: false,
      isOverlongExactIdentifier: false,
      isOverlongQuery: false,
    };
  }
  const { normalized: nfkc } = normalizeWithOffsets(rawQuery, 0);
  const trimmedRaw = nfkc.trim();
  const isExact = isStrictExactIdentifier(trimmedRaw);
  if (isExact && trimmedRaw.length > Limit.SearchQueryChars) {
    return {
      normalizedText: '',
      tokens: [],
      shortAsciiPrefixes: [],
      isExactIdentifier: true,
      isOverlongExactIdentifier: true,
      isOverlongQuery: true,
    };
  }
  const overlong = rawQuery.length > Limit.SearchQueryChars || trimmedRaw.length > Limit.SearchQueryChars;

  let collapsed = '';
  for (let i = 0; i < trimmedRaw.length; i++) {
    const ch = trimmedRaw[i];
    if (/\s/.test(ch)) {
      if (collapsed.length > 0 && collapsed[collapsed.length - 1] !== ' ') collapsed += ' ';
      continue;
    }
    const c = trimmedRaw.charCodeAt(i);
    if (collapsed.length === Limit.SearchQueryChars - 1 && c >= 0xd800 && c <= 0xdbff) break;
    collapsed += isAsciiUpper(c) ? String.fromCharCode(c + 32) : ch;
    if (collapsed.length >= Limit.SearchQueryChars) break;
  }
  const normalizedText = collapsed.trimEnd();
  if (!normalizedText) {
    return {
      normalizedText: '',
      tokens: [],
      shortAsciiPrefixes: [],
      isExactIdentifier: isExact,
      isOverlongExactIdentifier: false,
      isOverlongQuery: overlong,
    };
  }
  const { tokens, shortAsciiPrefixes } = analyzeText(normalizedText, 'query', 0, 0);
  return {
    normalizedText,
    tokens,
    shortAsciiPrefixes,
    isExactIdentifier: isExact,
    isOverlongExactIdentifier: false,
    isOverlongQuery: overlong,
  };
}
