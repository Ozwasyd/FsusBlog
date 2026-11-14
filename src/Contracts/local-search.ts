import { ApiError, decodeApiError, decodeFrame, ProtocolError } from './aeds.ts';
import { decodeUtf8 } from './binary.ts';
import type { ArticleCard } from './public-articles.ts';
import { FrameType, WireHeaders, WireLayouts as L, WireLimits as Limit, WireRoutes } from './wire.generated.ts';
import lexicon from './search-lexicon.json' with { type: 'json' };

type Term = { offset: number; end: number; idf: number; hasPositions: boolean };
type SearchArticle = ArticleCard & { length: number };
type Taxon = ArticleCard['category'];
type Shard = { documents: Map<number, SearchArticle>; matches: Map<number, number> };
type Result = { items: ArticleCard[]; total: number; nextCursor: null };
type PhraseHits = Map<number, Map<number, bigint>>;
type CorpusPages = { generation: string; pages: Uint8Array[] };
type CorpusCache = { corpus?: CorpusPages };

const utf8 = new TextEncoder();
const none: Taxon = { id: 0, name: '' };
const tf = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 30, 50, 100, 140];
const titleField = 1;
const bodyField = 4;
const phraseBonus = 1.25;
const cjk = /^[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+$/u;
const weights = new Map(Object.entries(lexicon.words).filter(([word]) => cjk.test(word)));
for (const word of lexicon.stopwords) if (!weights.has(word)) weights.set(word, 1);
const maxWord = Math.max(...[...weights.keys()].map(word => word.length));

function requireWire(condition: boolean, field: string): asserts condition {
  if (!condition) throw new ProtocolError(`Invalid local search ${field}`);
}

function align(offset: number): number { return Math.ceil(offset / 8) * 8; }

class Bytes {
  readonly data: Uint8Array;
  readonly view: DataView;
  constructor(data: Uint8Array) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get length() { return this.data.length; }
  u8(at: number) { return this.view.getUint8(at); }
  u16(at: number) { return this.view.getUint16(at, true); }
  u32(at: number) { return this.view.getUint32(at, true); }
  i64(at: number) { return this.view.getBigInt64(at, true); }
  f32(at: number) { return this.view.getFloat32(at, true); }

  sub(start: number, end: number) {
    requireWire(start >= 0 && start <= end && end <= this.length, 'range');
    return this.data.subarray(start, end);
  }

  zero(start: number, end: number) {
    requireWire(this.sub(start, end).every(byte => byte === 0), 'reserved bytes');
  }

  time(at: number) {
    const value = this.i64(at);
    requireWire(value !== 0n && value >= -62135596800000n && value <= 253402300799999n, 'publish timestamp');
    return Number(value);
  }
}

function coordinates(bytes: Bytes, offset: number) {
  const revision = bytes.i64(offset);
  const revisionNo = bytes.u32(offset + 8);
  const publication = bytes.i64(offset + 12);
  const publicationNo = bytes.u32(offset + 20);
  requireWire(revision > 0n && publication > 0n && revisionNo > 0 && revisionNo <= 0x7fffffff &&
    publicationNo > 0 && publicationNo <= 0x7fffffff, 'publication coordinates');
  return { revision, revisionNo, publication, publicationNo };
}

function text(bytes: Bytes, start: number, offset: number, length: number, end: number, limit: number) {
  requireWire(length <= limit && start + offset + length <= end, 'string slice');
  return decodeUtf8(bytes.sub(start + offset, start + offset + length));
}

function murmur(bytes: Uint8Array): number {
  let hash = 0;
  let at = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
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

export function searchTerms(query: string): readonly number[] {
  requireWire(query.length <= Limit.SearchQueryChars, 'query length');
  const normalized = query.normalize('NFKC');
  requireWire(normalized.length <= Limit.SearchQueryChars, 'normalized query length');
  const words = normalized.match(/[a-zA-Z0-9]+|[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+|[\p{Letter}\p{Decimal_Number}]/gu) ?? [];
  const tokens = words.flatMap(word => cjk.test(word) ? segmentCjk(word) : [word.replace(/[A-Z]/g, letter => letter.toLowerCase())]);
  return tokens.map(word => murmur(utf8.encode(word)));
}

function segmentCjk(text: string) {
  if (text.length === 1) return [text];
  const next = new Uint8Array(text.length);
  const scores = new Int32Array(text.length + 1);
  for (let at = text.length - 1; at >= 0; at--) {
    let score = 4 + scores[at + 1];
    let best = 1;
    for (let width = Math.min(maxWord, text.length - at); width >= 1; width--) {
      const weight = weights.get(text.slice(at, at + width));
      if (weight === undefined) continue;
      const candidate = 4 * weight + width + scores[at + width];
      if (candidate < score || (candidate === score && width <= best)) continue;
      score = candidate;
      best = width;
    }
    next[at] = best;
    scores[at] = score;
  }
  const words: string[] = [];
  for (let at = 0; at < text.length; at += next[at]) words.push(text.slice(at, at + next[at]));
  return words;
}

function dictionary(bytes: Bytes, start: number, count: number, strings: number, end: number): Taxon[] {
  const result: Taxon[] = [];
  let previous = 0;
  for (let i = 0; i < count; i++) {
    const at = start + i * L.SearchDictionaryRecordSize;
    const id = bytes.u32(at);
    requireWire(id > previous && id <= 0x7fffffff, 'dictionary identity');
    previous = id;
    bytes.zero(at + 10, at + L.SearchDictionaryRecordSize);
    const name = text(bytes, strings, bytes.u32(at + 4), bytes.u16(at + 8), end, Limit.TaxonomyNameBytes);
    result.push({ id, name });
  }
  return result;
}

function readPostings(
  bytes: Bytes,
  term: Term,
  documents: Map<number, SearchArticle>,
  meanLength: number,
  matches: Map<number, number> | undefined,
  phraseHits: PhraseHits,
  wordMask: bigint,
) {
  let offset = term.offset;
  function vint() {
    let result = 0;
    for (let i = 0; i < 5; i++) {
      requireWire(offset < term.end, 'posting length');
      const next = bytes.u8(offset++);
      requireWire(i < 4 || next < 16, 'varint range');
      result += (next & 127) * (2 ** (i * 7));
      if (next < 128) {
        requireWire(i === 0 || next !== 0, 'varint encoding');
        return result;
      }
    }
    throw new ProtocolError('Invalid local search varint');
  }

  const count = vint();
  requireWire(count > 0 && count <= documents.size, 'posting document count');
  let id = 0;
  let hasPositions = false;
  for (let i = 0; i < count; i++) {
    const delta = vint();
    id += delta;
    const doc = documents.get(id);
    requireWire(delta > 0 && doc !== undefined && offset + 3 < term.end, 'posting document ID');
    const title = tf[bytes.u8(offset++)];
    const meta = tf[bytes.u8(offset++)];
    const body = tf[bytes.u8(offset++)];
    requireWire(title !== undefined && meta !== undefined && body !== undefined && title + meta + body > 0, 'term frequency');
    const positions = vint();
    requireWire((term.hasPositions || positions === 0) && positions <= doc.length * maxWord &&
      positions * 3 <= term.end - offset, 'posting position count');
    hasPositions ||= positions > 0;
    let position = 0;
    let previousField = 0;
    let previousWidth = 0;
    let titlePositions = 0;
    let bodyPositions = 0;
    for (let j = 0; j < positions; j++) {
      const delta = vint();
      const width = vint();
      const field = vint();
      position += delta;
      requireWire(width > 0 && width <= maxWord && position + width <= doc.length &&
        (field === titleField || field === bodyField) &&
        (delta > 0 || field > previousField || field === previousField && width > previousWidth), 'posting position');
      previousField = field;
      previousWidth = width;
      if (field === titleField) titlePositions++;
      else bodyPositions++;
      if (wordMask !== 0n) {
        let docHits = phraseHits.get(id);
        if (!docHits) phraseHits.set(id, docHits = new Map());
        const lane = position * 2 + (field === bodyField ? 1 : 0);
        const coordinate = lane * maxWord + width - 1;
        docHits.set(coordinate, (docHits.get(coordinate) ?? 0n) | wordMask);
      }
    }
    requireWire((titlePositions === 0 || title > 0) && (bodyPositions === 0 || body > 0), 'posting position fields');
    if (matches) {
      const frequency = title * 2.5 + meta * 0.9 + body;
      const score = term.idf * (frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * doc.length / meanLength));
      matches.set(id, (matches.get(id) ?? 0) + score);
    }
  }
  requireWire(offset === term.end && term.hasPositions === hasPositions, 'posting end or position flag');
}

function hasPhrase(hits: Map<number, bigint>, expected: bigint): boolean {
  // Each lane encodes one field and offset. A matching word advances by its stored width.
  const lanes = (maxWord + 1) * 2;
  const endpoints = new Array<number>(lanes).fill(-1);
  const prefixes = new Array<bigint>(lanes).fill(0n);
  for (const [coordinate, words] of [...hits].sort((a, b) => a[0] - b[0])) {
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
export function queryCorpusPage(payload: Uint8Array, terms: readonly number[]): Shard {
  requireWire(terms.length <= Limit.SearchQueryChars, 'term count');
  try {
    return parseCorpusPage(payload, terms, false);
  } catch (error) {
    if (error instanceof RangeError) throw new ProtocolError('Truncated local search corpus');
    throw error;
  }
}

function parseCorpusPage(payload: Uint8Array, terms: readonly number[], admitted: boolean): Shard {
  const p = new Bytes(payload);
  requireWire(p.length >= L.SearchPackagePayloadOffset + L.SearchShardHeaderSize &&
    p.length <= Limit.SearchCorpusPageBytes && p.u32(0) === L.SearchPackageMagic &&
    p.u32(4) === L.SearchArtifactVersion && p.u32(8) === 1, 'package header');
  const entry = L.SearchPackageEntryOffset;
  const start = p.u32(entry + 8);
  requireWire(p.u32(entry) === 0 && p.u32(entry + 4) === 0 && start === L.SearchPackagePayloadOffset &&
    p.u32(entry + 12) === p.length - start, 'core package entry');
  p.zero(entry + 16, start);

  const b = new Bytes(p.sub(start, p.length));
  const termCount = b.u32(16);
  const docCount = b.u32(20);
  const categoryCount = b.u32(24);
  const tagCount = b.u32(28);
  const referenceCount = b.u32(32);
  const termAt = b.u32(36);
  const docAt = b.u32(40);
  const categoryAt = b.u32(44);
  const tagAt = b.u32(48);
  const tagRefAt = b.u32(52);
  const stringAt = b.u32(56);
  const postingAt = b.u32(60);
  const end = postingAt + b.u32(64);
  const average = b.f32(68);
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

  b.zero(termAt + termCount * L.SearchTermRecordSize, docAt);
  b.zero(docAt + docCount * L.SearchDocumentRecordSize, categoryAt);
  b.zero(tagRefAt + referenceCount * 2, stringAt);
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
    const publishedAt = b.time(at + 24);
    requireWire(id > lastId && id <= 0x7fffffff && category !== undefined && length > 0 && views <= 0x7fffffff &&
      b.u32(at + 8) === consumedReferences && references <= Limit.TaxonomyTagCount &&
      consumedReferences + references <= referenceCount, 'document identity or tags');
    lastId = id;
    b.zero(at + 38, at + 40);
    b.zero(at + 46, at + 52);
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
      scheduledPublishAt: null, length, ...coordinates(b, at + 52),
    });
  }
  requireWire(consumedReferences === referenceCount, 'shard tag references');

  const matches = new Map<number, number>();
  const phrase = new Map<number, bigint>();
  const phraseHits: PhraseHits = new Map();
  if (terms.length > 1) {
    for (const [index, hash] of terms.entries())
      phrase.set(hash, (phrase.get(hash) ?? 0n) | (1n << BigInt(index)));
  }
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
        average, hit ? matches : undefined, phraseHits, phrase.get(hash) ?? 0n);
    }
    priorHash = hash;
    consumed += length;
  }
  requireWire(consumed === end, 'shard trailing bytes');
  if (phraseHits.size > 0) {
    const expected = 1n << BigInt(terms.length - 1);
    for (const [id, hits] of phraseHits) {
      if (hasPhrase(hits, expected)) matches.set(id, (matches.get(id) ?? 0) + phraseBonus);
    }
  }
  return { documents, matches };
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
  const b = new Bytes(payload);
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
    const publishedAt = b.time(at + 8);
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
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) {
        await reader.cancel();
        throw new ProtocolError('Local search corpus exceeds its byte limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (chunks.length === 1 && chunks[0].buffer.byteLength === length) return chunks[0];
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function corpusRequest(
  signal: AbortSignal | undefined,
  generation: string | undefined,
  page: number | undefined,
) {
  const query = new URLSearchParams();
  if (page !== undefined) query.set('page', String(page));
  if (generation !== undefined) query.set('generation', generation);
  const response = await fetch(`${WireRoutes.PublicSearchCorpus}?${query}`, {
    method: page === undefined ? 'HEAD' : 'GET',
    cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/octet-stream' }, signal,
  });
  if (!response.ok) {
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
  requireWire(response.status === 200 && response.headers.get('Content-Type')?.split(';')[0] === 'application/octet-stream' &&
    pagesText !== null && /^[1-9][0-9]{0,2}$/.test(pagesText) && pages >= page &&
    pages <= Limit.SearchCorpusMaxPages, 'corpus response headers');
  return { generation: current, pages, bytes: await readBytes(response, Limit.SearchCorpusPageBytes) };
}

/** Search published corpus data. The consumer revalidates the result generation before display. */
export function searchCorpus(query: string, signal?: AbortSignal, page = 1, size = 10) {
  return runCorpusSearch(query, signal, page, size);
}

/** Keep one completely admitted generation in the owning search worker's memory. */
export function createCorpusSearch() {
  const cache: CorpusCache = {};
  let searching = false;
  return async (query: string, signal?: AbortSignal, page = 1, size = 10) => {
    requireWire(!searching, 'concurrent corpus query');
    searching = true;
    try {
      return await runCorpusSearch(query, signal, page, size, cache);
    } catch (error) {
      cache.corpus = undefined;
      throw error;
    } finally {
      searching = false;
    }
  };
}

async function currentCachedCorpus(cache: CorpusCache, signal: AbortSignal | undefined) {
  if (!cache.corpus) return undefined;
  try {
    await verifySearchGeneration(cache.corpus.generation, signal);
    return cache.corpus;
  } catch (error) {
    cache.corpus = undefined;
    if (!(error instanceof ApiError) || error.status !== 409) throw error;
    return undefined;
  }
}

async function runCorpusSearch(query: string, signal: AbortSignal | undefined, page: number, size: number,
  cache?: CorpusCache): Promise<{ frame: Uint8Array<ArrayBuffer>; generation: string | null }> {
  requireWire(Number.isInteger(page) && page > 0 && page <= 10000 &&
    Number.isInteger(size) && size > 0 && size <= 100, 'query page');
  const terms = searchTerms(query);
  signal?.throwIfAborted();
  if (terms.length === 0) return { frame: encodeLocalSearchResult([], 0), generation: null };

  const admitted = cache ? await currentCachedCorpus(cache, signal) : undefined;
  const first = admitted
    ? { generation: admitted.generation, pages: admitted.pages.length, bytes: admitted.pages[0] }
    : await corpusRequest(signal, undefined, 1);
  const pendingPages: Uint8Array[] | undefined = cache && !admitted ? [] : undefined;
  const ids = new Set<number>();
  const matches: { article: SearchArticle; score: number }[] = [];
  let totalBytes = 0;
  for (let i = 1; i <= first.pages; i++) {
    signal?.throwIfAborted();
    let shard: Shard;
    if (admitted) {
      // Buffers are private to this worker and all postings were validated on cold load.
      shard = parseCorpusPage(admitted.pages[i - 1], terms, true);
    } else {
      const loaded = i === 1 ? first : await corpusRequest(signal, first.generation, i);
      totalBytes += loaded.bytes.length;
      requireWire(loaded.pages === first.pages && totalBytes <= Limit.SearchCorpusTotalBytes, 'corpus pages or byte budget');
      shard = queryCorpusPage(loaded.bytes, terms);
      pendingPages?.push(loaded.bytes);
    }
    requireWire(first.pages === 1 || shard.documents.size > 0, 'empty corpus page');
    for (const article of shard.documents.values()) {
      requireWire(!ids.has(article.id), 'duplicate corpus article');
      ids.add(article.id);
      const score = shard.matches.get(article.id);
      if (score !== undefined) matches.push({ article, score });
    }
  }
  matches.sort((a, b) => b.score - a.score || b.article.createdAt - a.article.createdAt || b.article.id - a.article.id);
  const start = (page - 1) * size;
  const encoded = encodeLocalSearchResult(matches.slice(start, start + size).map(hit => hit.article), matches.length);
  signal?.throwIfAborted();
  if (cache && pendingPages) cache.corpus = { generation: first.generation, pages: pendingPages };
  return { frame: encoded, generation: first.generation };
}

/** Final same-origin visibility check before a worker result is made visible. */
export async function verifySearchGeneration(generation: string, signal?: AbortSignal): Promise<void> {
  await corpusRequest(signal, generation, undefined);
  signal?.throwIfAborted();
}
