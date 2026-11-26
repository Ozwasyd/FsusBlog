import { ApiError, decodeApiError, decodeFrame, ProtocolError } from './aeds.ts';
import { ByteView, dataView, decodeUtf8, toHex } from './binary.ts';
import { collectBounded } from './bounded-stream.ts';
import type { ArticleCard } from './public-articles.ts';
import { FrameType, WireHeaders, WireLayouts as L, WireLimits as Limit, WireRoutes } from './wire.generated.ts';
import lexicon from './search-lexicon.json' with { type: 'json' };
import { analyzeQuery, hashTerm32, isStrictExactIdentifier } from './search-analyzer.ts';
import {
  allowsRelaxation,
  BODY_PHRASE_BONUS_FACTOR,
  EXACT_FORM_BONUS_FACTOR,
  inverseDocumentFrequency,
  isQuerySupportedByLocalFspk,
  MAX_RELAXED_RESULTS,
  minRelaxedConcepts,
  minRelaxedIdfRatio,
  planSearchQuery,
  RELAXATION_TRIGGER_PRIMARY_COUNT,
  TIGHT_PROXIMITY_BONUS_FACTOR,
  TITLE_OR_HEADING_PHRASE_BONUS_FACTOR,
  type SearchConcept,
  type SearchConceptStep,
  type SearchMatchTier,
  type SearchQueryPlan,
} from './search-query-plan.ts';

export const LOCAL_SEARCH_PROFILE = 'local-fspk-v4-global-concept-v3';

type Term = { offset: number; end: number; idf: number; hasPositions: boolean };
type SearchArticle = ArticleCard & { length: number; row: number };
type Taxon = ArticleCard['category'];
type Shard = { documents: Map<number, SearchArticle>; matches: Map<number, number> };
type Result = { items: ArticleCard[]; total: number; nextCursor: null };
type PositionSpan = (row: number, start: number, end: number) => void;
type CorpusPages = { generation: string; pages: Uint8Array[] };
type CorpusCache = { corpus?: CorpusPages };
type PreviousCorpusPage = { generation: string; bytes: Uint8Array };

export type PublicSearchSort = 'relevance' | 'latest';
export type PersistedCompactCorpus = Readonly<{ generation: string; pages: readonly Uint8Array[] }>;
export interface CompactSearchStorage {
  load(signal?: AbortSignal): Promise<PersistedCompactCorpus | undefined>;
  save(corpus: PersistedCompactCorpus, signal?: AbortSignal): Promise<void>;
  discard(generation: string, signal?: AbortSignal): Promise<void>;
}
export type AdmittedHit = Readonly<{ row: number; id: number; publishedAt: number; views: number; score: number; tier?: SearchMatchTier }>;
export interface GlobalCorpusStats {
  totalDocs: number;
  totalDocLength: number;
  avgLength: number;
  docFreqs: Map<number, number>;
  shortPrefixDfs: Map<string, number>;
}

export function normalizePublicSearchSort(value: unknown): PublicSearchSort {
  return value === 'latest' ? 'latest' : 'relevance';
}

const utf8 = new TextEncoder();
const none: Taxon = { id: 0, name: '' };
const tf = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 30, 50, 100, 140];
const titleField = 1;
const bodyField = 4;
const phraseBonus = 1.25;
const asciiMinPrefixLength = 3;
const shortPrefixTitleBoost = 0.6;
const shortPrefixMetaBoost = 0.25;
const corpusPatchType = 'application/vnd.fsus.search-patch';
const cjk = /^[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+$/u;
const weights = new Map(Object.entries(lexicon.words).filter(([word]) => cjk.test(word)));
for (const word of lexicon.stopwords) if (!weights.has(word)) weights.set(word, 1);
const maxWord = Math.max(...[...weights.keys()].map(word => word.length));

const failWire = (field: string): never => { throw new ProtocolError(`Invalid local search ${field}`); };
function requireWire(condition: boolean, field: string): asserts condition {
  if (!condition) failWire(field);
}

const openBytes = (data: Uint8Array) => new ByteView(data, failWire);
const align = (offset: number) => Math.ceil(offset / 8) * 8;
const bm25 = (idf: number, frequency: number, docLength: number, average: number) =>
  idf * (frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * docLength / average));

function readShardHeader(b: ByteView) {
  const postingAt = b.u32(60);
  return {
    termCount: b.u32(16), docCount: b.u32(20), categoryCount: b.u32(24), tagCount: b.u32(28),
    referenceCount: b.u32(32), termAt: b.u32(36), docAt: b.u32(40), categoryAt: b.u32(44),
    tagAt: b.u32(48), tagRefAt: b.u32(52), stringAt: b.u32(56), postingAt,
    end: postingAt + b.u32(64), average: b.f32(68),
  };
}

function coordinates(bytes: ByteView, offset: number) {
  const revision = bytes.i64(offset);
  const revisionNo = bytes.u32(offset + 8);
  const publication = bytes.i64(offset + 12);
  const publicationNo = bytes.u32(offset + 20);
  requireWire(revision > 0n && publication > 0n && revisionNo > 0 && revisionNo <= 0x7fffffff &&
    publicationNo > 0 && publicationNo <= 0x7fffffff, 'publication coordinates');
  return { revision, revisionNo, publication, publicationNo };
}

function text(bytes: ByteView, start: number, offset: number, length: number, end: number, limit: number) {
  requireWire(length <= limit && start + offset + length <= end, 'string slice');
  return decodeUtf8(bytes.sub(start + offset, start + offset + length));
}

export function normalizeLocalSearchQuery(query: string): string | undefined {
  if (query.length > Limit.SearchQueryChars) return undefined;
  const normalized = query.normalize('NFKC');
  return normalized.length <= Limit.SearchQueryChars ? normalized : undefined;
}

function requireNormalizedQuery(query: string): string {
  const normalized = normalizeLocalSearchQuery(query);
  requireWire(normalized !== undefined, query.length > Limit.SearchQueryChars ? 'query length' : 'normalized query length');
  return normalized;
}

export function searchTerms(query: string): readonly number[] {
  const normalized = requireNormalizedQuery(query);
  const analyzed = analyzeQuery(normalized);
  if (analyzed.isOverlongExactIdentifier || analyzed.tokens.length === 0) return [];
  // Emit ordered primary hashes first, followed by any distinct script-alias hashes (deduped for phrase order safety).
  // Note: phrase matching in FSPK v4 matches consecutive ordered terms; keep one canonical token per query position
  // when all tokens are primary, or prefer the simplified/canonical alias when traditional tokens occur.
  const hashes: number[] = [];
  for (const token of analyzed.tokens) {
    if (token.kind === 'scriptAlias') continue;
    hashes.push(token.hash32);
  }
  for (const token of analyzed.tokens) {
    if (token.kind === 'scriptAlias' && !hashes.includes(token.hash32)) {
      hashes.push(token.hash32);
    }
  }
  return hashes;
}

export function searchShortAsciiPrefixes(query: string): readonly string[] {
  const normalized = requireNormalizedQuery(query);
  const analyzed = analyzeQuery(normalized);
  if (analyzed.isOverlongExactIdentifier || isStrictExactIdentifier(analyzed.normalizedText)) return [];
  return [...analyzed.shortAsciiPrefixes];
}

const isAsciiLower = (c: number) => c >= 97 && c <= 122;
const isAsciiUpper = (c: number) => c >= 65 && c <= 90;
const isAsciiDigit = (c: number) => c >= 48 && c <= 57;
const isAsciiWord = (c: number) => isAsciiLower(c) || isAsciiUpper(c) || isAsciiDigit(c);
const lowerAscii = (c: number) => isAsciiUpper(c) ? c + 32 : c;

function isSubwordBoundary(value: string, end: number, index: number): boolean {
  const prev = value.charCodeAt(index - 1), curr = value.charCodeAt(index);
  return isAsciiDigit(prev) !== isAsciiDigit(curr) || isAsciiLower(prev) && isAsciiUpper(curr) ||
    isAsciiUpper(prev) && isAsciiUpper(curr) && index + 1 < end && isAsciiLower(value.charCodeAt(index + 1));
}

function startsWithLowerAscii(value: string, at: number, prefix: string): boolean {
  for (let i = 0; i < prefix.length; i++) if (lowerAscii(value.charCodeAt(at + i)) !== prefix.charCodeAt(i)) return false;
  return true;
}

function countAsciiPrefixMatches(value: string, prefix: string): number {
  if (value.length <= prefix.length) return 0;
  let source = value;
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) >= 0x80) { source = value.normalize('NFKC'); break; }
  let count = 0;
  for (let offset = 0; offset < source.length;) {
    if (!isAsciiWord(source.charCodeAt(offset))) { offset++; continue; }
    const start = offset++;
    while (offset < source.length && isAsciiWord(source.charCodeAt(offset))) offset++;
    if (offset - start <= prefix.length) continue;
    if (startsWithLowerAscii(source, start, prefix)) { count++; continue; }
    for (let segmentStart = start, i = start + 1; i <= offset; i++) {
      if (i < offset && !isSubwordBoundary(source, offset, i)) continue;
      if (segmentStart > start && i - segmentStart > prefix.length && startsWithLowerAscii(source, segmentStart, prefix)) {
        count++;
        break;
      }
      segmentStart = i;
    }
  }
  return count;
}

function dictionary(bytes: ByteView, start: number, count: number, strings: number, end: number): Taxon[] {
  const result: Taxon[] = [];
  let previous = 0;
  for (let i = 0; i < count; i++) {
    const at = start + i * L.SearchDictionaryRecordSize;
    const id = bytes.u32(at);
    requireWire(id > previous && id <= 0x7fffffff, 'dictionary identity');
    previous = id;
    bytes.zero(at + 10, L.SearchDictionaryRecordSize - 10);
    const name = text(bytes, strings, bytes.u32(at + 4), bytes.u16(at + 8), end, Limit.TaxonomyNameBytes);
    result.push({ id, name });
  }
  return result;
}

class PostingReader {
  private readonly bytes: ByteView;
  offset: number;
  readonly end: number;
  constructor(bytes: ByteView, offset: number, end: number) { this.bytes = bytes; this.offset = offset; this.end = end; }

  vint() {
    let result = 0;
    for (let i = 0; i < 5; i++) {
      requireWire(this.offset < this.end, 'posting length');
      const next = this.bytes.u8(this.offset++);
      requireWire(i < 4 || next < 16, 'varint range');
      result += (next & 127) * (2 ** (i * 7));
      if (next < 128) { requireWire(i === 0 || next !== 0, 'varint encoding'); return result; }
    }
    throw new ProtocolError('Invalid local search varint');
  }
}

function readPostings(
  bytes: ByteView,
  term: Term,
  documents: Map<number, SearchArticle>,
  meanLength: number,
  matches: Map<number, number> | undefined,
  recordPositions: PositionSpan | undefined,
) {
  const read = new PostingReader(bytes, term.offset, term.end);
  const count = read.vint();
  requireWire(count > 0 && count <= documents.size, 'posting document count');
  let id = 0;
  let hasPositions = false;
  for (let i = 0; i < count; i++) {
    const delta = read.vint();
    id += delta;
    const doc = documents.get(id);
    requireWire(delta > 0 && doc !== undefined && read.offset + 3 < term.end, 'posting document ID');
    const title = tf[bytes.u8(read.offset++)];
    const meta = tf[bytes.u8(read.offset++)];
    const body = tf[bytes.u8(read.offset++)];
    requireWire(title !== undefined && meta !== undefined && body !== undefined && title + meta + body > 0, 'term frequency');
    const positions = read.vint();
    requireWire((term.hasPositions || positions === 0) && positions <= doc.length * maxWord &&
      positions * 3 <= term.end - read.offset, 'posting position count');
    hasPositions ||= positions > 0;
    let position = 0;
    let previousField = 0;
    let previousWidth = 0;
    let titlePositions = 0;
    let bodyPositions = 0;
    const positionStart = read.offset;
    for (let j = 0; j < positions; j++) {
      const delta = read.vint();
      const width = read.vint();
      const field = read.vint();
      position += delta;
      requireWire(width > 0 && width <= maxWord && position + width <= doc.length &&
        (field === titleField || field === bodyField) &&
        (delta > 0 || field > previousField || field === previousField && width > previousWidth), 'posting position');
      previousField = field;
      previousWidth = width;
      if (field === titleField) titlePositions++;
      else bodyPositions++;
    }
    requireWire((titlePositions === 0 || title > 0) && (bodyPositions === 0 || body > 0), 'posting position fields');
    if (positions > 0) recordPositions?.(doc.row, positionStart, read.offset);
    if (matches) matches.set(id, (matches.get(id) ?? 0) + bm25(term.idf, title * 2.5 + meta * 0.9 + body, doc.length, meanLength));
  }
  requireWire(read.offset === term.end && term.hasPositions === hasPositions, 'posting end or position flag');
}

class PhraseSpans {
  private readonly slots = new Map<number, number>();
  private readonly masks: bigint[] = [];
  private readonly spans: Uint32Array;
  private readonly expected: bigint;

  constructor(terms: readonly number[], docCount: number) {
    for (const [index, hash] of terms.entries()) {
      const slot = this.slots.get(hash) ?? this.masks.length;
      this.slots.set(hash, slot);
      this.masks[slot] = (this.masks[slot] ?? 0n) | (1n << BigInt(index));
    }
    // A validated byte range per document row/query hash is sufficient for the phrase merge.
    this.spans = new Uint32Array(docCount * this.masks.length * 2);
    this.expected = 1n << BigInt(terms.length - 1);
  }

  recorder(hash: number): PositionSpan | undefined {
    const slot = this.slots.get(hash);
    if (slot === undefined) return undefined;
    return (row, start, end) => {
      const at = (row * this.masks.length + slot) * 2;
      this.spans[at] = start;
      this.spans[at + 1] = end;
    };
  }

  hasMatch(bytes: ByteView, row: number): boolean {
    const width = this.masks.length;
    const first = row * width * 2;
    for (let slot = 0; slot < width; slot++) {
      if (this.spans[first + slot * 2 + 1] === 0) return false;
    }
    const positions: PositionStream[] = [];
    for (let slot = 0; slot < width; slot++) {
      const at = first + slot * 2;
      positions.push(new PositionStream(bytes, this.spans[at], this.spans[at + 1], this.masks[slot]));
    }
    return hasPhrase(positions, this.expected);
  }
}

class PositionStream {
  private readonly read: PostingReader;
  private position = 0;
  readonly words: bigint;
  coordinate = 0;

  constructor(bytes: ByteView, start: number, end: number, words: bigint) {
    this.read = new PostingReader(bytes, start, end);
    this.words = words;
    this.advance();
  }

  advance(): boolean {
    if (this.read.offset === this.read.end) return false;
    this.position += this.read.vint();
    const width = this.read.vint();
    const field = this.read.vint();
    const lane = this.position * 2 + (field === bodyField ? 1 : 0);
    this.coordinate = lane * maxWord + width - 1;
    return true;
  }
}

function replacePositionHead(heap: PositionStream[], value: PositionStream) {
  let parent = 0;
  for (let child = 1; child < heap.length; child = parent * 2 + 1) {
    if (child + 1 < heap.length && heap[child + 1].coordinate < heap[child].coordinate) child++;
    if (value.coordinate <= heap[child].coordinate) break;
    heap[parent] = heap[child];
    parent = child;
  }
  heap[parent] = value;
}

function hasPhrase(positions: PositionStream[], expected: bigint): boolean {
  // Each lane encodes one field and offset. A matching word advances by its stored width.
  const lanes = (maxWord + 1) * 2;
  const endpoints = new Array<number>(lanes).fill(-1);
  const prefixes = new Array<bigint>(lanes).fill(0n);
  // One head per matched term. Each individual span is already in coordinate order.
  positions.sort((a, b) => a.coordinate - b.coordinate);
  while (positions.length > 0) {
    const coordinate = positions[0].coordinate;
    let words = 0n;
    do {
      const head = positions[0];
      words |= head.words;
      if (head.advance()) replacePositionHead(positions, head);
      else {
        const last = positions.pop()!;
        if (positions.length > 0) replacePositionHead(positions, last);
      }
    } while (positions[0]?.coordinate === coordinate);
    const lane = Math.floor(coordinate / maxWord);
    const slot = lane % lanes;
    const prefix = endpoints[slot] === lane ? prefixes[slot] : 0n;
    const matched = ((prefix << 1n) | 1n) & words;
    if ((matched & expected) !== 0n) return true;
    if (matched === 0n) continue;
    const width = (coordinate % maxWord) + 1;
    const end = lane + width * 2;
    const next = end % lanes;
    prefixes[next] = (endpoints[next] === end ? prefixes[next] : 0n) | matched;
    endpoints[next] = end;
  }
  return false;
}

/** Parses a complete core shard, including all posting lists even when their terms do not match. */
export function queryCorpusPage(
  payload: Uint8Array,
  terms: readonly number[],
  shortPrefixes: readonly string[] = [],
): Shard {
  requireWire(terms.length <= Limit.SearchQueryChars, 'term count');
  requireWire(shortPrefixes.length <= Limit.SearchQueryChars, 'prefix count');
  // The phrase pass reuses validated byte spans. Isolate potentially shared backing first.
  if (!(payload.buffer instanceof ArrayBuffer)) {
    requireWire(payload.length <= Limit.SearchCorpusPageBytes, 'package header');
    payload = Uint8Array.from(payload);
  }
  try {
    return parseCorpusPage(payload, terms, false, shortPrefixes);
  } catch (error) {
    if (error instanceof RangeError) throw new ProtocolError('Truncated local search corpus');
    throw error;
  }
}

function parseCorpusPage(
  payload: Uint8Array,
  terms: readonly number[],
  admitted: boolean,
  shortPrefixes: readonly string[],
): Shard {
  const p = openBytes(payload);
  requireWire(p.length >= L.SearchPackagePayloadOffset + L.SearchShardHeaderSize &&
    p.length <= Limit.SearchCorpusPageBytes && p.u32(0) === L.SearchPackageMagic &&
    p.u32(4) === L.SearchArtifactVersion && p.u32(8) === 1, 'package header');
  const entry = L.SearchPackageEntryOffset;
  const start = p.u32(entry + 8);
  requireWire(p.u32(entry) === 0 && p.u32(entry + 4) === 0 && start === L.SearchPackagePayloadOffset &&
    p.u32(entry + 12) === p.length - start, 'core package entry');
  p.zero(entry + 16, start - (entry + 16));

  const b = openBytes(p.sub(start, p.length));
  const {
    termCount, docCount, categoryCount, tagCount, referenceCount,
    termAt, docAt, categoryAt, tagAt, tagRefAt, stringAt, postingAt, end, average,
  } = readShardHeader(b);
  requireWire(b.u32(0) === L.SearchShardMagic && b.u32(4) === L.SearchArtifactVersion &&
    b.u32(8) === 0 && b.u32(12) === 1 && docCount <= Limit.SearchIndexPageSize &&
    categoryCount < 65535 && tagCount < 65535 && referenceCount <= docCount * Limit.TaxonomyTagCount &&
    Number.isFinite(average) && average >= 1 && termAt === L.SearchShardHeaderSize &&
    docAt === align(termAt + termCount * L.SearchTermRecordSize) &&
    categoryAt === align(docAt + docCount * L.SearchDocumentRecordSize) &&
    tagAt === align(categoryAt + categoryCount * L.SearchDictionaryRecordSize) &&
    tagRefAt === align(tagAt + tagCount * L.SearchDictionaryRecordSize) &&
    stringAt === align(tagRefAt + referenceCount * 2) && postingAt >= stringAt && postingAt === align(postingAt) &&
    end === b.length, 'shard layout');

  b.zero(termAt + termCount * L.SearchTermRecordSize, docAt - (termAt + termCount * L.SearchTermRecordSize));
  b.zero(docAt + docCount * L.SearchDocumentRecordSize, categoryAt - (docAt + docCount * L.SearchDocumentRecordSize));
  b.zero(tagRefAt + referenceCount * 2, stringAt - (tagRefAt + referenceCount * 2));
  const categories = dictionary(b, categoryAt, categoryCount, stringAt, postingAt);
  const tags = dictionary(b, tagAt, tagCount, stringAt, postingAt);
  const documents = new Map<number, SearchArticle>();
  let lastId = 0;
  let consumedReferences = 0;
  for (let i = 0; i < docCount; i++) {
    const at = docAt + i * L.SearchDocumentRecordSize;
    const id = b.u32(at);
    const categoryIndex = b.u16(at + 4);
    const category = categoryIndex === 65535 ? none : categories[categoryIndex];
    const references = b.u16(at + 6);
    const views = b.u32(at + 12);
    const length = b.u32(at + 20);
    const publishedAt = b.timestamp(at + 24, false);
    requireWire(id > lastId && id <= 0x7fffffff && category !== undefined && length > 0 && views <= 0x7fffffff &&
      b.u32(at + 8) === consumedReferences && references <= Limit.TaxonomyTagCount &&
      consumedReferences + references <= referenceCount, 'document identity or tags');
    lastId = id;
    b.zero(at + 38, 2);
    b.zero(at + 46, 6);
    const title = text(b, stringAt, b.u32(at + 32), b.u16(at + 36), postingAt, Limit.TitleBytes);
    requireWire(title.length > 0 && !title.includes('\0'), 'document title');
    const summary = text(b, stringAt, b.u32(at + 40), b.u16(at + 44), postingAt, 2048);
    const articleTags: Taxon[] = [];
    const seenTags = new Set<number>();
    for (let j = 0; j < references; j++) {
      const tag = tags[b.u16(tagRefAt + consumedReferences++ * 2)];
      requireWire(tag !== undefined && !seenTags.has(tag.id), 'document tag order');
      articleTags.push(tag);
      seenTags.add(tag.id);
    }
    documents.set(id, {
      id, title, summary, views, category, tags: articleTags, createdAt: publishedAt, publishedAt, updatedAt: null,
      scheduledPublishAt: null, length, row: i, ...coordinates(b, at + 52),
    });
  }
  requireWire(consumedReferences === referenceCount, 'shard tag references');

  const matches = new Map<number, number>();
  const phrase = terms.length > 1 ? new PhraseSpans(terms, docCount) : undefined;
  const uniqueTerms = new Set(terms);
  let priorHash = -1;
  let consumed = postingAt;
  for (let i = 0; i < termCount; i++) {
    const at = termAt + i * L.SearchTermRecordSize;
    const hash = b.u32(at);
    const idf = b.f32(at + 4);
    const offset = postingAt + b.u32(at + 8);
    const length = b.u32(at + 12);
    const positionFlag = b.u32(at + 16);
    requireWire(hash > priorHash && Number.isFinite(idf) && idf > 0 && offset === consumed &&
      length > 0 && offset + length <= end && positionFlag <= 1 && b.u32(at + 20) === 0, 'term metadata');
    const hit = uniqueTerms.has(hash);
    if (hit || !admitted) {
      readPostings(b, { offset, end: offset + length, idf, hasPositions: positionFlag === 1 }, documents,
        average, hit ? matches : undefined, positionFlag === 1 ? phrase?.recorder(hash) : undefined);
    }
    priorHash = hash;
    consumed += length;
  }
  requireWire(consumed === end, 'shard trailing bytes');
  if (phrase) {
    for (const [id, doc] of documents) {
      if (phrase.hasMatch(b, doc.row)) matches.set(id, (matches.get(id) ?? 0) + phraseBonus);
    }
  }
  if (shortPrefixes.length > 0 && docCount > 0) {
    const docRows = [...documents.values()];
    scoreShortMetadataPrefixes(b, termAt, termCount, docCount, postingAt, average, shortPrefixes,
      row => docRows[row],
      (row, delta) => {
        const id = docRows[row].id;
        matches.set(id, (matches.get(id) ?? 0) + delta);
      });
  }
  return { documents, matches };
}

function exactDocumentFrequency(b: ByteView, termAt: number, termCount: number, postingAt: number, hash: number): number {
  const at = findTermRecord(b, termAt, termCount, hash);
  if (at < 0) return 0;
  const offset = postingAt + b.u32(at + 8);
  return new PostingReader(b, offset, offset + b.u32(at + 12)).vint();
}

function scoreShortMetadataPrefixes(
  b: ByteView,
  termAt: number,
  termCount: number,
  docCount: number,
  postingAt: number,
  average: number,
  shortPrefixes: readonly string[],
  readDoc: (row: number) => { title: string; summary: string; category: Taxon; tags: readonly Taxon[]; length: number },
  addScore: (row: number, delta: number) => void,
) {
  const frequencies = new Float64Array(docCount);
  for (const prefix of shortPrefixes) {
    if (prefix.length === 0 || prefix.length >= asciiMinPrefixLength) continue;
    frequencies.fill(0);
    let prefixDf = 0;
    for (let row = 0; row < docCount; row++) {
      const doc = readDoc(row);
      const titleHits = countAsciiPrefixMatches(doc.title, prefix);
      let metaHits = countAsciiPrefixMatches(doc.summary, prefix) + countAsciiPrefixMatches(doc.category.name, prefix);
      for (let j = 0; j < doc.tags.length; j++) metaHits += countAsciiPrefixMatches(doc.tags[j].name, prefix);
      const frequency = titleHits * shortPrefixTitleBoost + metaHits * shortPrefixMetaBoost;
      if (frequency > 0) {
        frequencies[row] = frequency;
        prefixDf++;
      }
    }
    if (prefixDf === 0) continue;
    const exactDf = exactDocumentFrequency(b, termAt, termCount, postingAt, hashTerm32(prefix));
    const combinedDf = Math.min(docCount, exactDf + prefixDf);
    const idf = Math.log(1 + (docCount - combinedDf + 0.5) / (combinedDf + 0.5));
    for (let row = 0; row < docCount; row++) {
      if (frequencies[row] !== 0) addScore(row, bm25(idf, frequencies[row], readDoc(row).length, average));
    }
  }
}

function binarySearchU32(b: ByteView, base: number, count: number, stride: number, target: number, low = 0): number {
  let high = count - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const value = b.u32(base + mid * stride);
    if (value === target) return mid;
    if (value < target) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}

const findTermRecord = (b: ByteView, termAt: number, termCount: number, hash: number): number => {
  const index = binarySearchU32(b, termAt, termCount, L.SearchTermRecordSize, hash);
  return index < 0 ? -1 : termAt + index * L.SearchTermRecordSize;
};

const findDocumentRow = (b: ByteView, docAt: number, docCount: number, id: number, lowStart: number): number =>
  binarySearchU32(b, docAt, docCount, L.SearchDocumentRecordSize, id, lowStart);

/** Fast binary-search scoring over an already-admitted FSPK v4 page without decoding non-matching strings. */
export function scoreAdmittedCorpusPage(
  payload: Uint8Array,
  terms: readonly number[],
  shortPrefixes: readonly string[] = [],
): AdmittedHit[] {
  requireWire(terms.length <= Limit.SearchQueryChars, 'term count');
  requireWire(shortPrefixes.length <= Limit.SearchQueryChars, 'prefix count');
  if (terms.length === 0 && shortPrefixes.length === 0) return [];
  const b = openBytes(payload.subarray(L.SearchPackagePayloadOffset));
  const { termCount, docCount, termAt, docAt, postingAt, average } = readShardHeader(b);
  if (docCount === 0 || (termCount === 0 && shortPrefixes.length === 0)) return [];
  const scores = new Float64Array(docCount);
  const matchedRows: number[] = [];
  const phrase = terms.length > 1 ? new PhraseSpans(terms, docCount) : undefined;
  const uniqueTerms = [...new Set(terms)].sort((a, b) => a - b);

  for (const hash of uniqueTerms) {
    const at = findTermRecord(b, termAt, termCount, hash);
    if (at < 0) continue;
    const idf = b.f32(at + 4);
    const offset = postingAt + b.u32(at + 8);
    const length = b.u32(at + 12);
    const recordPositions = b.u32(at + 16) === 1 ? phrase?.recorder(hash) : undefined;
    const read = new PostingReader(b, offset, offset + length);
    const count = read.vint();
    let id = 0;
    let rowHint = 0;
    for (let i = 0; i < count; i++) {
      id += read.vint();
      const row = findDocumentRow(b, docAt, docCount, id, rowHint);
      requireWire(row >= 0, 'posting document ID');
      rowHint = row + 1;
      const title = tf[b.u8(read.offset++)];
      const meta = tf[b.u8(read.offset++)];
      const body = tf[b.u8(read.offset++)];
      const positions = read.vint();
      const positionStart = read.offset;
      for (let j = 0; j < positions; j++) {
        read.vint();
        read.vint();
        read.vint();
      }
      if (positions > 0) recordPositions?.(row, positionStart, read.offset);
      const docLength = b.u32(docAt + row * L.SearchDocumentRecordSize + 20);
      if (scores[row] === 0) matchedRows.push(row);
      scores[row] += bm25(idf, title * 2.5 + meta * 0.9 + body, docLength, average);
    }
  }

  if (phrase) {
    for (const row of matchedRows) {
      if (phrase.hasMatch(b, row)) scores[row] += phraseBonus;
    }
  }

  if (shortPrefixes.length > 0) {
    const allRows = Array.from({ length: docCount }, (_, i) => i);
    const cards = decodeCorpusDocuments(payload, allRows);
    scoreShortMetadataPrefixes(b, termAt, termCount, docCount, postingAt, average, shortPrefixes,
      row => ({ ...cards[row], length: b.u32(docAt + row * L.SearchDocumentRecordSize + 20) }),
      (row, delta) => {
        if (scores[row] === 0) matchedRows.push(row);
        scores[row] += delta;
      });
  }

  return matchedRows.map(row => {
    const at = docAt + row * L.SearchDocumentRecordSize;
    return { row, id: b.u32(at), views: b.u32(at + 12), publishedAt: b.timestamp(at + 24, false), score: scores[row] };
  });
}

/** Decode only the requested document rows from an already-admitted FSPK v4 page. */
export function decodeCorpusDocuments(payload: Uint8Array, rows: readonly number[]): ArticleCard[] {
  if (rows.length === 0) return [];
  const b = openBytes(payload.subarray(L.SearchPackagePayloadOffset));
  const { docCount, categoryCount, tagCount, docAt, categoryAt, tagAt, tagRefAt, stringAt, postingAt } = readShardHeader(b);
  const readTaxon = (tableAt: number, index: number, cache: Map<number, Taxon>): Taxon => {
    let entry = cache.get(index);
    if (!entry) {
      const at = tableAt + index * L.SearchDictionaryRecordSize;
      entry = { id: b.u32(at), name: text(b, stringAt, b.u32(at + 4), b.u16(at + 8), postingAt, Limit.TaxonomyNameBytes) };
      cache.set(index, entry);
    }
    return entry;
  };
  const decodedCategories = new Map<number, Taxon>();
  const decodedTags = new Map<number, Taxon>();
  return rows.map(row => {
    requireWire(Number.isInteger(row) && row >= 0 && row < docCount, 'document row');
    const at = docAt + row * L.SearchDocumentRecordSize;
    const categoryIndex = b.u16(at + 4);
    let category: Taxon = none;
    if (categoryIndex !== 65535) {
      requireWire(categoryIndex < categoryCount, 'category index');
      category = readTaxon(categoryAt, categoryIndex, decodedCategories);
    }
    const references = b.u16(at + 6);
    const tagOffset = b.u32(at + 8);
    const publishedAt = b.timestamp(at + 24, false);
    const articleTags = Array.from({ length: references }, (_, j) => {
      const tagIndex = b.u16(tagRefAt + (tagOffset + j) * 2);
      requireWire(tagIndex < tagCount, 'tag index');
      return readTaxon(tagAt, tagIndex, decodedTags);
    });
    return {
      id: b.u32(at),
      title: text(b, stringAt, b.u32(at + 32), b.u16(at + 36), postingAt, Limit.TitleBytes),
      summary: text(b, stringAt, b.u32(at + 40), b.u16(at + 44), postingAt, 2048),
      views: b.u32(at + 12), category, tags: articleTags, createdAt: publishedAt, publishedAt,
      updatedAt: null, scheduledPublishAt: null, ...coordinates(b, at + 52),
    };
  });
}

/** Encode the pinned raw browser search-worker result contract, separate from FAS4 HTTP. */
export function encodeLocalSearchResult(articles: readonly ArticleCard[], total: number): Uint8Array<ArrayBuffer> {
  const fields = articles.map(article => ({
    title: utf8.encode(article.title),
    summary: utf8.encode(article.summary),
    category: utf8.encode(article.category.name),
    tags: article.tags.map(tag => utf8.encode(tag.name)),
  }));
  const count = articles.length;
  const tagCount = fields.reduce((n, article) => n + article.tags.length, 0);
  const textSize = fields.reduce((n, article) => n + article.title.length + article.summary.length +
    article.category.length + article.tags.reduce((sum, tag) => sum + tag.length, 0), 0);
  const tagAt = L.SearchResultHeaderSize + count * L.SearchResultRecordSize;
  const blobAt = tagAt + tagCount * L.SearchResultTagRecordSize;
  const bytes = new Uint8Array(blobAt + textSize);
  const v = new DataView(bytes.buffer);
  const i32 = (offset: number, value: number) => v.setUint32(offset, value, true);
  const i64 = (offset: number, value: bigint) => v.setBigInt64(offset, value, true);
  let textAt = blobAt;
  let tagIndex = 0;
  const writeText = (at: number, value: Uint8Array) => {
    i32(at, textAt - blobAt);
    i32(at + 4, value.length);
    bytes.set(value, textAt);
    textAt += value.length;
  };
  [L.SearchResultMagic, L.SearchArtifactVersion, total, count, tagAt, blobAt].forEach((value, i) => i32(i * 4, value));
  for (let i = 0; i < count; i++) {
    const a = articles[i];
    const f = fields[i];
    const at = L.SearchResultHeaderSize + i * L.SearchResultRecordSize;
    i32(at, a.id);
    i32(at + 4, a.views);
    i64(at + 8, BigInt(a.publishedAt ?? a.createdAt));
    i32(at + 16, a.category.id);
    writeText(at + 20, f.category);
    writeText(at + 28, f.title);
    writeText(at + 36, f.summary);
    i32(at + 44, tagIndex);
    i32(at + 48, a.tags.length);
    i64(at + 52, a.revision);
    i32(at + 60, a.revisionNo);
    i64(at + 64, a.publication);
    i32(at + 72, a.publicationNo);
    for (let j = 0; j < a.tags.length; j++) {
      const tagAtOffset = tagAt + tagIndex++ * L.SearchResultTagRecordSize;
      i32(tagAtOffset, a.tags[j].id);
      writeText(tagAtOffset + 4, f.tags[j]);
    }
  }
  return bytes;
}

export function decodeLocalSearchResult(payload: Uint8Array): Result {
  try {
    return parseLocalSearchResult(payload);
  } catch (error) {
    if (error instanceof RangeError) throw new ProtocolError('Truncated local search result');
    throw error;
  }
}

function parseLocalSearchResult(payload: Uint8Array): Result {
  const b = openBytes(payload);
  const total = b.u32(8);
  const count = b.u32(12);
  const tags = b.u32(16);
  const blob = b.u32(20);
  requireWire(b.u32(0) === L.SearchResultMagic && b.u32(4) === L.SearchArtifactVersion &&
    count <= Math.min(total, 100) && tags === L.SearchResultHeaderSize + count * L.SearchResultRecordSize &&
    blob >= tags && blob <= b.length && (blob - tags) % L.SearchResultTagRecordSize === 0, 'result layout');
  const items: ArticleCard[] = [];
  const ids = new Set<number>();
  let tagIndex = 0;
  let textOffset = 0;
  function readText(at: number, limit: number) {
    const start = b.u32(at);
    const length = b.u32(at + 4);
    requireWire(start === textOffset, 'result string order');
    textOffset += length;
    return text(b, blob, start, length, b.length, limit);
  }
  for (let i = 0; i < count; i++) {
    const at = L.SearchResultHeaderSize + i * L.SearchResultRecordSize;
    const id = b.u32(at);
    const publishedAt = b.timestamp(at + 8, false);
    const name = readText(at + 20, Limit.TaxonomyNameBytes);
    const title = readText(at + 28, Limit.TitleBytes);
    const summary = readText(at + 36, 2048);
    const refs = b.u32(at + 48);
    requireWire(id > 0 && id <= 0x7fffffff && !ids.has(id) && title.length > 0 && !title.includes('\0') &&
      b.u32(at + 44) === tagIndex && refs <= Limit.TaxonomyTagCount &&
      tags + (tagIndex + refs) * L.SearchResultTagRecordSize <= blob, 'result identity or tags');
    ids.add(id);
    const articleTags: Taxon[] = [];
    for (let j = 0; j < refs; j++) {
      const tagAt = tags + tagIndex++ * L.SearchResultTagRecordSize;
      articleTags.push({ id: b.u32(tagAt), name: readText(tagAt + 4, Limit.TaxonomyNameBytes) });
    }
    items.push({
      id, views: b.u32(at + 4), publishedAt, createdAt: publishedAt, updatedAt: null, scheduledPublishAt: null,
      category: { id: b.u32(at + 16), name }, title, summary, tags: articleTags, ...coordinates(b, at + 52),
    });
  }
  requireWire(tags + tagIndex * L.SearchResultTagRecordSize === blob && blob + textOffset === b.length, 'result trailing bytes');
  return { items, total, nextCursor: null };
}

async function readBytes(response: Response, limit: number): Promise<Uint8Array> {
  requireWire(response.body !== null, 'response body');
  return collectBounded(response.body, limit, 'Local search corpus exceeds its byte limit');
}

const digestTag = (digest: Uint8Array) => `"${toHex(digest)}"`;

async function pageTag(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return digestTag(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

async function applyCorpusPatch(
  patch: Uint8Array, base: PreviousCorpusPage, baseTag: string, targetTag: string, generation: string, page: number,
): Promise<Uint8Array> {
  const headerSize = L.SearchCorpusPatchHeaderSize;
  const header = dataView(patch);
  requireWire(patch.length >= headerSize && header.getUint32(0, true) === L.SearchCorpusPatchMagic &&
    header.getUint32(4, true) === L.SearchCorpusPatchVersion && header.getBigInt64(8, true).toString() === base.generation &&
    header.getBigInt64(16, true).toString() === generation && header.getUint32(24, true) === page &&
    header.getUint32(28, true) === base.bytes.length && digestTag(patch.subarray(44, 76)) === baseTag &&
    digestTag(patch.subarray(76, 108)) === targetTag, 'patch binding');
  const length = header.getUint32(32, true);
  const prefix = header.getUint32(36, true);
  const suffix = header.getUint32(40, true);
  requireWire(length <= Limit.SearchCorpusPatchPageBytes && patch.length <= length / 2 &&
    prefix + suffix <= base.bytes.length && prefix + suffix <= length &&
    patch.length === headerSize + length - prefix - suffix, 'patch spans');

  const bytes = new Uint8Array(length);
  bytes.set(base.bytes.subarray(0, prefix));
  bytes.set(patch.subarray(headerSize), prefix);
  bytes.set(base.bytes.subarray(base.bytes.length - suffix), length - suffix);
  requireWire(await pageTag(bytes) === targetTag, 'patch target digest');
  return bytes;
}

async function corpusRequest(
  signal: AbortSignal | undefined,
  generation: string | undefined,
  page: number | undefined,
  previous?: PreviousCorpusPage,
): Promise<{ generation: string; pages: number; bytes: Uint8Array }> {
  const query = new URLSearchParams();
  if (page !== undefined) query.set('page', String(page));
  if (generation !== undefined) query.set('generation', generation);
  const headers = new Headers({ Accept: 'application/octet-stream' });
  let validator: string | undefined;
  if (page !== undefined && previous?.bytes.buffer instanceof ArrayBuffer && globalThis.crypto?.subtle) {
    const bytes = new Uint8Array(previous.bytes.buffer, previous.bytes.byteOffset, previous.bytes.byteLength);
    validator = await pageTag(bytes);
    headers.set('If-None-Match', validator);
  }
  const patchBase = validator !== undefined && page !== undefined && page > 1 && generation !== undefined &&
    previous && previous.generation !== generation && previous.bytes.length <= Limit.SearchCorpusPatchPageBytes ? previous : undefined;
  if (patchBase) {
    query.set('baseGeneration', patchBase.generation);
    headers.set('Accept', `${corpusPatchType}, application/octet-stream`);
  }
  signal?.throwIfAborted();
  const response = await fetch(`${WireRoutes.PublicSearchCorpus}?${query}`, {
    method: page === undefined ? 'HEAD' : 'GET',
    cache: 'no-store', credentials: 'omit', headers, signal,
  });
  const unchanged = response.status === 304;
  if (!response.ok && !unchanged) {
    if (page !== undefined && response.headers.get('Content-Type')?.split(';')[0] === 'application/octet-stream') {
      const frame = decodeFrame(await readBytes(response, 4096), FrameType.ApiError);
      throw decodeApiError(frame.payload, response.status);
    }
    throw new ApiError('Search corpus is unavailable', response.status);
  }
  const current = response.headers.get(WireHeaders.SearchIndexGeneration);
  requireWire(current !== null && /^(0|[1-9][0-9]{0,18})$/.test(current) &&
    (generation === undefined || current === generation), 'publication generation');
  if (page === undefined) {
    requireWire(response.status === 204, 'generation response');
    return { generation: current, pages: 0, bytes: new Uint8Array() };
  }
  const pagesText = response.headers.get(WireHeaders.SearchIndexPages);
  const pages = Number(pagesText);
  requireWire(pagesText !== null && /^[1-9][0-9]{0,2}$/.test(pagesText) && pages >= page &&
    pages <= Limit.SearchCorpusMaxPages, 'corpus response headers');
  if (unchanged) {
    requireWire(previous !== undefined && validator !== undefined && response.headers.get('ETag') === validator,
      'corpus page validator');
    // Chromium exposes an empty stream for an HTTP 304.
    if (response.body !== null) await readBytes(response, 0);
    return { generation: current, pages, bytes: previous.bytes };
  }
  const contentType = response.headers.get('Content-Type')?.split(';')[0];
  if (contentType === corpusPatchType) {
    requireWire(patchBase !== undefined && validator !== undefined, 'unsolicited patch');
    try {
      requireWire(response.status === 200 && response.headers.get('ETag') === null, 'patch representation');
      const targetDigest = response.headers.get(WireHeaders.SearchCorpusTargetDigest);
      requireWire(targetDigest !== null && /^[0-9a-f]{64}$/.test(targetDigest), 'patch target header');
      const patch = await readBytes(response, Limit.SearchCorpusPatchBytes);
      const bytes = await applyCorpusPatch(patch, patchBase, validator, `"${targetDigest}"`, current, page);
      signal?.throwIfAborted();
      return { generation: current, pages, bytes };
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof ProtocolError)) throw error;
      // Retry only the same pinned page, without the previous validator or the patch offer.
      return corpusRequest(signal, current, page);
    }
  }
  requireWire(response.status === 200 && contentType === 'application/octet-stream', 'corpus response type');
  return { generation: current, pages, bytes: await readBytes(response, Limit.SearchCorpusPageBytes) };
}

export type CorpusSearch = ((
  query: string,
  signal?: AbortSignal,
  page?: number,
  size?: number,
  sort?: PublicSearchSort,
) => Promise<{ frame: Uint8Array<ArrayBuffer>; generation: string | null }>) & {
  invalidate(generation: string, signal?: AbortSignal): Promise<void>;
};

/** Search published corpus data. The consumer revalidates the result generation before display. */
export function searchCorpus(query: string, signal?: AbortSignal, page = 1, size = 10, sort: PublicSearchSort = 'relevance') {
  return runCorpusSearch(query, signal, page, size, sort);
}

/** Keep one completely admitted generation in the owning search worker's memory and optional persistent storage. */
export function createCorpusSearch(options?: { storage?: CompactSearchStorage }): CorpusSearch {
  const storage = options?.storage;
  const cache: CorpusCache = {};
  let searching = false;
  const search = (async (query: string, signal?: AbortSignal, page = 1, size = 10, sort: PublicSearchSort = 'relevance') => {
    requireWire(!searching, 'concurrent corpus query');
    searching = true;
    try {
      return await runCorpusSearch(query, signal, page, size, sort, cache, storage);
    } catch (error) {
      cache.corpus = undefined;
      throw error;
    } finally {
      searching = false;
    }
  }) as CorpusSearch;
  search.invalidate = async (generation: string, signal?: AbortSignal) => {
    if (cache.corpus?.generation === generation) cache.corpus = undefined;
    await storage?.discard(generation, signal).catch(() => {});
  };
  return search;
}

function compareHits(
  a: { score: number; publishedAt: number; id: number; tier?: SearchMatchTier },
  b: { score: number; publishedAt: number; id: number; tier?: SearchMatchTier },
  sort: PublicSearchSort,
): number {
  const tierDiff = (a.tier ?? 0) - (b.tier ?? 0);
  if (tierDiff !== 0) return tierDiff;
  return sort === 'latest'
    ? b.publishedAt - a.publishedAt || b.score - a.score || b.id - a.id
    : b.score - a.score || b.publishedAt - a.publishedAt || b.id - a.id;
}

export function planLocalSearchQuery(query: string): SearchQueryPlan {
  // Overlong strict exact identifiers (> 128 up to 256 HTTP bound) return empty cleanly rather than failing
  if (query.length <= 256) {
    const trimmedNfkc = query.normalize('NFKC').trim();
    const unquoted = trimmedNfkc.length >= 2 &&
      ((trimmedNfkc[0] === '"' && trimmedNfkc[trimmedNfkc.length - 1] === '"') ||
       (trimmedNfkc[0] === '“' && trimmedNfkc[trimmedNfkc.length - 1] === '”'))
      ? trimmedNfkc.slice(1, -1).trim()
      : trimmedNfkc;
    if (isStrictExactIdentifier(unquoted) && unquoted.length > Limit.SearchQueryChars) {
      return planSearchQuery(query);
    }
  }
  const normalized = requireNormalizedQuery(query);
  const plan = planSearchQuery(normalized);
  const support = isQuerySupportedByLocalFspk(plan);
  if (!support.supported) {
    throw new ProtocolError(`Unsupported local search query profile: ${support.reason}`);
  }
  return plan;
}

function collectPlanHashes(plan: SearchQueryPlan): { hashes: number[]; shortPrefixes: string[] } {
  const hashSet = new Set<number>();
  const prefixSet = new Set<string>();
  for (const phrase of plan.quotedPhrases) {
    for (const st of phrase.steps) {
      if (!st.isStopword) hashSet.add(st.canonicalHash32);
    }
  }
  for (const c of plan.contentConcepts) {
    for (const st of c.steps) {
      hashSet.add(st.canonicalHash32);
      if (st.differsFromExactForm) hashSet.add(st.exactFormHash32);
    }
    if (c.shortAsciiPrefix) prefixSet.add(c.shortAsciiPrefix);
  }
  for (const st of plan.orderedQuerySequence) {
    if (!st.isStopword) hashSet.add(st.canonicalHash32);
  }
  return { hashes: [...hashSet].sort((a, b) => a - b), shortPrefixes: [...prefixSet] };
}

/** Pass 1 helper: accumulate exact corpus-wide document count, document lengths, and global DFs across pages. */
export function accumulateGlobalCorpusStats(
  payload: Uint8Array,
  plan: SearchQueryPlan,
  stats: GlobalCorpusStats,
): void {
  const b = openBytes(payload.subarray(L.SearchPackagePayloadOffset));
  const { termCount, docCount, termAt, docAt, postingAt } = readShardHeader(b);
  if (docCount === 0) return;
  stats.totalDocs += docCount;
  for (let row = 0; row < docCount; row++) {
    stats.totalDocLength += b.u32(docAt + row * L.SearchDocumentRecordSize + 20);
  }
  const { hashes, shortPrefixes } = collectPlanHashes(plan);
  for (const hash of hashes) {
    const df = exactDocumentFrequency(b, termAt, termCount, postingAt, hash);
    if (df > 0) stats.docFreqs.set(hash, (stats.docFreqs.get(hash) ?? 0) + df);
  }
  if (shortPrefixes.length > 0) {
    const rows = Array.from({ length: docCount }, (_, i) => i);
    const cards = decodeCorpusDocuments(payload, rows);
    for (const prefix of shortPrefixes) {
      let count = 0;
      for (let row = 0; row < docCount; row++) {
        const doc = cards[row];
        let hits = countAsciiPrefixMatches(doc.title, prefix) +
          countAsciiPrefixMatches(doc.summary, prefix) +
          countAsciiPrefixMatches(doc.category.name, prefix);
        for (let j = 0; j < doc.tags.length; j++) hits += countAsciiPrefixMatches(doc.tags[j].name, prefix);
        if (hits > 0) count++;
      }
      if (count > 0) stats.shortPrefixDfs.set(prefix, (stats.shortPrefixDfs.get(prefix) ?? 0) + count);
    }
  }
}

export function createGlobalCorpusStats(): GlobalCorpusStats {
  return { totalDocs: 0, totalDocLength: 0, avgLength: 1, docFreqs: new Map(), shortPrefixDfs: new Map() };
}

export function finalizeGlobalCorpusStats(stats: GlobalCorpusStats): GlobalCorpusStats {
  stats.avgLength = stats.totalDocs > 0 ? Math.max(1, stats.totalDocLength / stats.totalDocs) : 1;
  return stats;
}

type LocalRowPosting = {
  title: number;
  meta: number;
  body: number;
  posStart: number;
  posEnd: number;
};

type DecodedPos = { field: number; pos: number };

function decodeRowPositions(b: ByteView, start: number, end: number): DecodedPos[] {
  if (end <= start) return [];
  const read = new PostingReader(b, start, end);
  const out: DecodedPos[] = [];
  let pos = 0;
  while (read.offset < read.end) {
    pos += read.vint();
    read.vint(); // width
    const field = read.vint();
    out.push({ field, pos });
  }
  return out;
}

function hasFieldAndPos(list: readonly DecodedPos[], field: number, targetPos: number): boolean {
  for (let i = 0; i < list.length; i++) {
    if (list[i].field === field && list[i].pos === targetPos) return true;
  }
  return false;
}

function localMatchesExactSequence(
  b: ByteView,
  steps: readonly SearchConceptStep[],
  row: number,
  postingsByHash: Map<number, Map<number, LocalRowPosting>>,
  posCache: Map<string, DecodedPos[]>,
): { matched: boolean; inTitle: boolean } {
  const active = steps.filter(s => !s.isStopword);
  if (active.length === 0) return { matched: false, inTitle: false };
  const lists: DecodedPos[][] = [];
  for (const st of active) {
    const p = postingsByHash.get(st.canonicalHash32)?.get(row);
    if (!p || p.posEnd <= p.posStart) return { matched: false, inTitle: false };
    const cacheKey = `${row}:${st.canonicalHash32}`;
    let decoded = posCache.get(cacheKey);
    if (!decoded) {
      decoded = decodeRowPositions(b, p.posStart, p.posEnd);
      posCache.set(cacheKey, decoded);
    }
    if (decoded.length === 0) return { matched: false, inTitle: false };
    lists.push(decoded);
  }
  const baseList = lists[0];
  const baseOffset = active[0].relativeOffset;
  let found = false;
  let inTitle = false;
  for (let i = 0; i < baseList.length; i++) {
    const { field, pos: pos0 } = baseList[i];
    let ok = true;
    for (let s = 1; s < active.length; s++) {
      const target = pos0 + (active[s].relativeOffset - baseOffset);
      if (!hasFieldAndPos(lists[s], field, target)) { ok = false; break; }
    }
    if (ok) {
      found = true;
      if (field === titleField) { inTitle = true; return { matched: true, inTitle: true }; }
    }
  }
  return { matched: found, inTitle };
}

function localMatchesTightProximity(
  b: ByteView,
  steps: readonly SearchConceptStep[],
  row: number,
  postingsByHash: Map<number, Map<number, LocalRowPosting>>,
  posCache: Map<string, DecodedPos[]>,
  maxSpan: number,
): boolean {
  const active = steps.filter(s => !s.isStopword);
  if (active.length < 2) return false;
  const lists: DecodedPos[][] = [];
  for (const st of active) {
    const p = postingsByHash.get(st.canonicalHash32)?.get(row);
    if (!p || p.posEnd <= p.posStart) return false;
    const cacheKey = `${row}:${st.canonicalHash32}`;
    let decoded = posCache.get(cacheKey);
    if (!decoded) {
      decoded = decodeRowPositions(b, p.posStart, p.posEnd);
      posCache.set(cacheKey, decoded);
    }
    if (decoded.length === 0) return false;
    lists.push(decoded);
  }
  for (const field of [titleField, bodyField]) {
    const baseList = lists[0];
    for (let i = 0; i < baseList.length; i++) {
      if (baseList[i].field !== field) continue;
      const anchor = baseList[i].pos;
      let minP = anchor;
      let maxP = anchor;
      let ok = true;
      for (let s = 1; s < lists.length; s++) {
        let bestDist = Infinity;
        let closest = 0;
        const listS = lists[s];
        for (let k = 0; k < listS.length; k++) {
          if (listS[k].field !== field) continue;
          const d = Math.abs(listS[k].pos - anchor);
          if (d < bestDist) { bestDist = d; closest = listS[k].pos; }
        }
        if (bestDist === Infinity) { ok = false; break; }
        if (closest < minP) minP = closest;
        if (closest > maxP) maxP = closest;
        if (maxP - minP > maxSpan) { ok = false; break; }
      }
      if (ok) return true;
    }
  }
  return false;
}

function computeLocalConceptIdf(concept: SearchConcept, stats: GlobalCorpusStats): number {
  const n = stats.totalDocs;
  if (concept.kind === 'cjkSequence') {
    let maxIdf = 0;
    for (const st of concept.steps) {
      const idf = inverseDocumentFrequency(n, stats.docFreqs.get(st.canonicalHash32) ?? 0);
      if (idf > maxIdf) maxIdf = idf;
    }
    return maxIdf;
  }
  if (concept.kind === 'compoundHyphen') {
    const exactDf = stats.docFreqs.get(concept.steps[0].canonicalHash32) ?? 0;
    let minSub = n;
    let allSub = concept.steps.length > 1;
    for (let i = 1; i < concept.steps.length; i++) {
      const d = stats.docFreqs.get(concept.steps[i].canonicalHash32) ?? 0;
      if (d === 0) allSub = false;
      if (d < minSub) minSub = d;
    }
    return inverseDocumentFrequency(n, Math.min(n, Math.max(exactDf, allSub ? minSub : 0)));
  }
  return inverseDocumentFrequency(n, stats.docFreqs.get(concept.steps[0].canonicalHash32) ?? 0);
}

/**
 * Pass 2 helper: score one already-admitted FSPK v4 page using global corpus-wide statistics,
 * concept-aware matching, exact CJK bigram / quoted-phrase positions, and bounded relaxation.
 */
export function scoreAdmittedCorpusPageGlobal(
  payload: Uint8Array,
  plan: SearchQueryPlan,
  stats: GlobalCorpusStats,
): AdmittedHit[] {
  if (plan.isEmpty || plan.isOverlongExactIdentifier || stats.totalDocs === 0) return [];
  const b = openBytes(payload.subarray(L.SearchPackagePayloadOffset));
  const { termCount, docCount, termAt, docAt, postingAt } = readShardHeader(b);
  if (docCount === 0) return [];

  // Early reject if any quoted phrase term is globally absent
  for (const phrase of plan.quotedPhrases) {
    for (const st of phrase.steps) {
      if (!st.isStopword && (stats.docFreqs.get(st.canonicalHash32) ?? 0) === 0) return [];
    }
  }

  const concepts = plan.contentConcepts;
  const canRelax = allowsRelaxation(plan);
  const minRelax = minRelaxedConcepts(concepts.length);
  const minRatio = minRelaxedIdfRatio(concepts.length);
  const conceptIdfs = new Float64Array(concepts.length);
  const shortPrefixIdfs = new Float64Array(concepts.length);
  let totalQueryIdf = 0;

  for (let c = 0; c < concepts.length; c++) {
    const concept = concepts[c];
    const idf = computeLocalConceptIdf(concept, stats);
    conceptIdfs[c] = idf;
    totalQueryIdf += idf;
    if (concept.shortAsciiPrefix) {
      const pDf = stats.shortPrefixDfs.get(concept.shortAsciiPrefix) ?? 0;
      if (pDf > 0) {
        const exDf = stats.docFreqs.get(concept.steps[0].canonicalHash32) ?? 0;
        shortPrefixIdfs[c] = inverseDocumentFrequency(stats.totalDocs, Math.min(stats.totalDocs, exDf + pDf));
      }
    }
  }

  const { hashes, shortPrefixes } = collectPlanHashes(plan);
  const postingsByHash = new Map<number, Map<number, LocalRowPosting>>();
  const candidateRows = new Set<number>();

  for (const hash of hashes) {
    const at = findTermRecord(b, termAt, termCount, hash);
    if (at < 0) continue;
    const offset = postingAt + b.u32(at + 8);
    const length = b.u32(at + 12);
    const read = new PostingReader(b, offset, offset + length);
    const count = read.vint();
    const rowMap = new Map<number, LocalRowPosting>();
    let id = 0;
    let rowHint = 0;
    for (let i = 0; i < count; i++) {
      id += read.vint();
      const row = findDocumentRow(b, docAt, docCount, id, rowHint);
      requireWire(row >= 0, 'posting document ID');
      rowHint = row + 1;
      const title = tf[b.u8(read.offset++)];
      const meta = tf[b.u8(read.offset++)];
      const body = tf[b.u8(read.offset++)];
      const positions = read.vint();
      const posStart = read.offset;
      for (let j = 0; j < positions; j++) {
        read.vint();
        read.vint();
        read.vint();
      }
      rowMap.set(row, { title, meta, body, posStart, posEnd: read.offset });
      candidateRows.add(row);
    }
    postingsByHash.set(hash, rowMap);
  }

  const shortPrefixWeightsByPrefix = new Map<string, Float64Array>();
  if (shortPrefixes.length > 0) {
    const allRows = Array.from({ length: docCount }, (_, i) => i);
    const cards = decodeCorpusDocuments(payload, allRows);
    for (const prefix of shortPrefixes) {
      const weights = new Float64Array(docCount);
      for (let row = 0; row < docCount; row++) {
        const doc = cards[row];
        const tHits = countAsciiPrefixMatches(doc.title, prefix);
        let mHits = countAsciiPrefixMatches(doc.summary, prefix) + countAsciiPrefixMatches(doc.category.name, prefix);
        for (let j = 0; j < doc.tags.length; j++) mHits += countAsciiPrefixMatches(doc.tags[j].name, prefix);
        const w = tHits * (4.5 * 0.5) + mHits * (2.2 * 0.25);
        if (w > 0) {
          weights[row] = w;
          candidateRows.add(row);
        }
      }
      shortPrefixWeightsByPrefix.set(prefix, weights);
    }
  }

  if (candidateRows.size === 0) return [];
  const posCache = new Map<string, DecodedPos[]>();
  const hits: AdmittedHit[] = [];
  const avgLen = stats.avgLength;

  for (const row of candidateRows) {
    let phraseOk = true;
    for (const phrase of plan.quotedPhrases) {
      if (!localMatchesExactSequence(b, phrase.steps, row, postingsByHash, posCache).matched) {
        phraseOk = false;
        break;
      }
    }
    if (!phraseOk) continue;

    const docLength = b.u32(docAt + row * L.SearchDocumentRecordSize + 20);
    let matchedCount = 0;
    let matchedIdfSum = 0;
    let strictOk = true;
    let score = 0;

    for (let c = 0; c < concepts.length; c++) {
      const concept = concepts[c];
      let matched = false;
      let weightedTf = 0;
      let exactFormHit = false;
      let usedShortPrefixOnly = false;

      if (concept.kind === 'cjkSequence') {
        if (localMatchesExactSequence(b, concept.steps, row, postingsByHash, posCache).matched) {
          matched = true;
          let minT = Infinity;
          let minM = Infinity;
          let minB = Infinity;
          let allExact = true;
          for (const st of concept.steps) {
            const p = postingsByHash.get(st.canonicalHash32)?.get(row);
            if (!p) { minT = minM = minB = 0; break; }
            if (p.title < minT) minT = p.title;
            if (p.meta < minM) minM = p.meta;
            if (p.body < minB) minB = p.body;
            if (!postingsByHash.get(st.exactFormHash32)?.has(row)) allExact = false;
          }
          weightedTf = (minT === Infinity ? 0 : minT) * 4.5 + (minM === Infinity ? 0 : minM) * 2.2 + (minB === Infinity ? 0 : minB);
          exactFormHit = allExact;
        }
      } else if (concept.kind === 'compoundHyphen') {
        const exP = postingsByHash.get(concept.steps[0].canonicalHash32)?.get(row);
        let allSub = concept.steps.length > 1;
        let minT = Infinity;
        let minM = Infinity;
        let minB = Infinity;
        for (let i = 1; i < concept.steps.length; i++) {
          const sp = postingsByHash.get(concept.steps[i].canonicalHash32)?.get(row);
          if (!sp) { allSub = false; break; }
          if (sp.title < minT) minT = sp.title;
          if (sp.meta < minM) minM = sp.meta;
          if (sp.body < minB) minB = sp.body;
        }
        if (exP || allSub) {
          matched = true;
          const exW = exP ? exP.title * 4.5 + exP.meta * 2.2 + exP.body : 0;
          const subW = allSub ? minT * 4.5 + minM * 2.2 + minB : 0;
          weightedTf = Math.max(exW, subW);
          exactFormHit = exP !== undefined;
        }
      } else {
        const st = concept.steps[0];
        const p = postingsByHash.get(st.canonicalHash32)?.get(row);
        if (p) {
          matched = true;
          weightedTf = p.title * 4.5 + p.meta * 2.2 + p.body;
          exactFormHit = !st.differsFromExactForm || (postingsByHash.get(st.exactFormHash32)?.has(row) ?? false);
        } else if (concept.shortAsciiPrefix) {
          const w = shortPrefixWeightsByPrefix.get(concept.shortAsciiPrefix)?.[row] ?? 0;
          if (w > 0) {
            matched = true;
            weightedTf = w;
            usedShortPrefixOnly = true;
          }
        }
      }

      if (!matched) {
        if (concept.isStrictIdentifier) { strictOk = false; break; }
        continue;
      }
      matchedCount++;
      matchedIdfSum += conceptIdfs[c];
      const activeIdf = usedShortPrefixOnly ? shortPrefixIdfs[c] : conceptIdfs[c];
      score += bm25(activeIdf, weightedTf, docLength, avgLen);
      if (exactFormHit) score += EXACT_FORM_BONUS_FACTOR * activeIdf;
    }

    if (!strictOk || matchedCount === 0) continue;

    const isPrimary = matchedCount === concepts.length;
    const isRelaxed = !isPrimary && canRelax &&
      matchedCount >= minRelax &&
      totalQueryIdf > 0 &&
      (matchedIdfSum / totalQueryIdf) >= minRatio;
    if (!isPrimary && !isRelaxed) continue;

    if (plan.quotedPhrases.length > 0 || (isPrimary && plan.orderedQuerySequence.length >= 2)) {
      const seq = plan.quotedPhrases.length > 0 ? plan.quotedPhrases[0].steps : plan.orderedQuerySequence;
      const exactSeq = localMatchesExactSequence(b, seq, row, postingsByHash, posCache);
      if (exactSeq.matched) {
        score += (exactSeq.inTitle ? TITLE_OR_HEADING_PHRASE_BONUS_FACTOR : BODY_PHRASE_BONUS_FACTOR) * matchedIdfSum;
      } else if (isPrimary && concepts.length >= 2 &&
          localMatchesTightProximity(b, plan.orderedQuerySequence, row, postingsByHash, posCache, 2 * concepts.length + 4)) {
        score += TIGHT_PROXIMITY_BONUS_FACTOR * matchedIdfSum;
      }
    }

    const at = docAt + row * L.SearchDocumentRecordSize;
    hits.push({
      row,
      id: b.u32(at),
      views: b.u32(at + 12),
      publishedAt: b.timestamp(at + 24, false),
      score,
      tier: isPrimary ? 0 : 1,
    });
  }

  return hits;
}

export function selectGlobalTieredHits<T extends { score: number; publishedAt: number; id: number; tier?: SearchMatchTier }>(
  allHits: T[],
  plan: SearchQueryPlan,
  sort: PublicSearchSort,
): T[] {
  const primary: T[] = [];
  const relaxed: T[] = [];
  for (const h of allHits) {
    if ((h.tier ?? 0) === 0) primary.push(h);
    else relaxed.push(h);
  }
  primary.sort((a, b) => compareHits(a, b, sort));
  if (allowsRelaxation(plan) && primary.length < RELAXATION_TRIGGER_PRIMARY_COUNT && relaxed.length > 0) {
    relaxed.sort((a, b) => compareHits(a, b, sort));
    const capped = relaxed.length > MAX_RELAXED_RESULTS ? relaxed.slice(0, MAX_RELAXED_RESULTS) : relaxed;
    return primary.concat(capped);
  }
  return primary;
}

export function scoreAdmittedCorpusGlobal(
  pages: readonly Uint8Array[],
  plan: SearchQueryPlan,
  page: number,
  size: number,
  sort: PublicSearchSort,
  signal?: AbortSignal,
): Uint8Array<ArrayBuffer> {
  if (plan.isEmpty || plan.isOverlongExactIdentifier || pages.length === 0) {
    return encodeLocalSearchResult([], 0);
  }
  const stats = createGlobalCorpusStats();
  for (let i = 0; i < pages.length; i++) {
    signal?.throwIfAborted();
    accumulateGlobalCorpusStats(pages[i], plan, stats);
  }
  finalizeGlobalCorpusStats(stats);

  const rawHits: (AdmittedHit & { pageIndex: number })[] = [];
  for (let i = 0; i < pages.length; i++) {
    signal?.throwIfAborted();
    for (const hit of scoreAdmittedCorpusPageGlobal(pages[i], plan, stats)) {
      rawHits.push({ ...hit, pageIndex: i });
    }
  }
  const ordered = selectGlobalTieredHits(rawHits, plan, sort);
  const start = (page - 1) * size;
  const selected = ordered.slice(start, start + size);
  const items = new Array<ArticleCard>(selected.length);
  const byPage = new Map<number, { row: number; resultIndex: number }[]>();
  for (let i = 0; i < selected.length; i++) {
    const entry = selected[i];
    const group = byPage.get(entry.pageIndex) ?? [];
    group.push({ row: entry.row, resultIndex: i });
    byPage.set(entry.pageIndex, group);
  }
  for (const [pageIndex, group] of byPage) {
    const decoded = decodeCorpusDocuments(pages[pageIndex], group.map(entry => entry.row));
    for (let i = 0; i < group.length; i++) items[group[i].resultIndex] = decoded[i];
  }
  return encodeLocalSearchResult(items, ordered.length);
}

async function currentCachedCorpus(
  cache: CorpusCache,
  storage: CompactSearchStorage | undefined,
  signal: AbortSignal | undefined,
): Promise<{ admitted?: CorpusPages; persisted?: CorpusPages; previous?: CorpusPages }> {
  let prior = cache.corpus;
  let fromStorage = false;
  if (!prior && storage) {
    try {
      const loaded = await storage.load(signal);
      if (loaded && loaded.pages.length > 0 && loaded.pages.length <= Limit.SearchCorpusMaxPages) {
        prior = { generation: loaded.generation, pages: [...loaded.pages] };
        fromStorage = true;
      }
    } catch (error) {
      signal?.throwIfAborted();
    }
  }
  if (!prior) return {};
  try {
    await verifySearchGeneration(prior.generation, signal);
    return fromStorage ? { persisted: prior } : { admitted: prior };
  } catch (error) {
    cache.corpus = undefined;
    if (error instanceof ApiError && error.status === 409) return { previous: prior };
    if (fromStorage && (error instanceof ProtocolError || error instanceof ApiError && (error.status === 404 || error.status === 503))) {
      await storage?.discard(prior.generation).catch(() => {});
    }
    throw error;
  }
}

async function runCorpusSearch(
  query: string,
  signal: AbortSignal | undefined,
  page: number,
  size: number,
  sort: PublicSearchSort = 'relevance',
  cache?: CorpusCache,
  storage?: CompactSearchStorage,
): Promise<{ frame: Uint8Array<ArrayBuffer>; generation: string | null }> {
  requireWire(Number.isInteger(page) && page > 0 && page <= 10000 &&
    Number.isInteger(size) && size > 0 && size <= 100, 'query page');
  const plan = planLocalSearchQuery(query);
  signal?.throwIfAborted();
  if (plan.isEmpty || plan.isOverlongExactIdentifier) return { frame: encodeLocalSearchResult([], 0), generation: null };

  const cached = cache ? await currentCachedCorpus(cache, storage, signal) : {};
  if (cached.admitted) {
    const encoded = scoreAdmittedCorpusGlobal(cached.admitted.pages, plan, page, size, sort, signal);
    signal?.throwIfAborted();
    return { frame: encoded, generation: cached.admitted.generation };
  }

  const admitAndScorePages = async (
    pageCount: number,
    readPage: (index: number) => Promise<Uint8Array> | Uint8Array,
    onLoaded?: (bytes: Uint8Array, totalBytes: number) => void,
  ): Promise<Uint8Array<ArrayBuffer>> => {
    const ids = new Set<number>();
    const admittedPages: Uint8Array[] = [];
    let totalBytes = 0;
    for (let i = 0; i < pageCount; i++) {
      signal?.throwIfAborted();
      const bytes = await readPage(i);
      totalBytes += bytes.length;
      requireWire(totalBytes <= Limit.SearchCorpusTotalBytes, 'corpus pages or byte budget');
      onLoaded?.(bytes, totalBytes);
      // Full canonical wire validation on admission before scoring with global statistics
      const shard = queryCorpusPage(bytes, [], []);
      requireWire(pageCount === 1 || shard.documents.size > 0, 'empty corpus page');
      for (const article of shard.documents.values()) {
        requireWire(!ids.has(article.id), 'duplicate corpus article');
        ids.add(article.id);
      }
      admittedPages.push(bytes);
    }
    const encoded = scoreAdmittedCorpusGlobal(admittedPages, plan, page, size, sort, signal);
    signal?.throwIfAborted();
    return encoded;
  };

  if (cached.persisted) {
    try {
      const { pages, generation } = cached.persisted;
      const frame = await admitAndScorePages(pages.length, i => pages[i]);
      if (cache) cache.corpus = cached.persisted;
      return { frame, generation };
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof ProtocolError)) throw error;
      await storage?.discard(cached.persisted.generation).catch(() => {});
    }
  }

  // Reused or reconstructed pages still pass the canonical parser and generation checks.
  // Retire unmatched buffers as we go under the same aggregate budget between requests.
  const previous = cached.previous;
  const reusable: (Uint8Array | undefined)[] | undefined = previous?.pages;
  let unusedBytes = reusable?.reduce((sum, bytes) => sum + (bytes?.length ?? 0), 0) ?? 0;
  function takePrevious(pageNumber: number): PreviousCorpusPage | undefined {
    const old = reusable?.[pageNumber - 1];
    if (old && reusable && previous) {
      reusable[pageNumber - 1] = undefined;
      unusedBytes -= old.length;
      return { generation: previous.generation, bytes: old };
    }
  }
  try {
    const first = await corpusRequest(signal, undefined, 1, takePrevious(1));
    const pendingPages: Uint8Array[] | undefined = cache ? [] : undefined;
    const frame = await admitAndScorePages(first.pages, async i => {
      const loaded = i === 0 ? first : await corpusRequest(signal, first.generation, i + 1, takePrevious(i + 1));
      requireWire(loaded.pages === first.pages, 'corpus pages or byte budget');
      return loaded.bytes;
    }, (bytes, totalBytes) => {
      if (reusable && totalBytes + unusedBytes > Limit.SearchCorpusTotalBytes) { reusable.fill(undefined); unusedBytes = 0; }
      pendingPages?.push(bytes);
    });
    if (cache && pendingPages) {
      cache.corpus = { generation: first.generation, pages: pendingPages };
      await storage?.save({ generation: first.generation, pages: pendingPages }, signal).catch(() => {});
    }
    return { frame, generation: first.generation };
  } catch (error) {
    if (previous) await storage?.discard(previous.generation).catch(() => {});
    throw error;
  }
}

/** Final same-origin visibility check before a worker result is made visible. */
export async function verifySearchGeneration(generation: string, signal?: AbortSignal): Promise<void> {
  await corpusRequest(signal, generation, undefined);
  signal?.throwIfAborted();
}
