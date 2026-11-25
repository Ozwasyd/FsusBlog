import { ProtocolError } from './aeds.ts';
import type { ArticleCard } from './public-articles.ts';
import {
  decodePublicSearchResult,
  PublicSearchMatchTier,
  PublicSearchSnippetField,
  PublicSearchTotalRelation,
  type PublicSearchHighlight,
  type PublicSearchHit,
  type PublicSearchResult,
} from './wire.generated.ts';

export type PublicSearchTotalRelationKind = 'exact' | 'lowerBound';
export type PublicSearchMatchTierKind = 'primary' | 'relaxed';
export type PublicSearchSnippetFieldKind = 'none' | 'title' | 'heading' | 'summary' | 'taxonomy' | 'code' | 'body';
export type PublicSearchHighlightRange = Readonly<{ start: number; end: number }>;

export type PublicSearchResultItem = ArticleCard & Readonly<{
  matchTier: PublicSearchMatchTierKind;
  snippetField: PublicSearchSnippetFieldKind;
  snippet: string;
  highlights: readonly PublicSearchHighlightRange[];
}>;

export type PublicSearchV2Page = Readonly<{
  generation: string;
  profileVersion: number;
  analyzerVersion: number;
  total: number;
  totalRelation: PublicSearchTotalRelationKind;
  primaryCount: number;
  relaxedCount: number;
  hasMore: boolean;
  nextCursor: string | null;
  items: readonly PublicSearchResultItem[];
}>;

export type SnippetSegment = Readonly<{ text: string; highlight: boolean }>;

const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const generationPattern = /^(0|[1-9][0-9]{0,18})$/;

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

function mapRelation(value: PublicSearchTotalRelation): PublicSearchTotalRelationKind {
  switch (value) {
    case PublicSearchTotalRelation.Exact: return 'exact';
    case PublicSearchTotalRelation.LowerBound: return 'lowerBound';
    default: throw new ProtocolError('Invalid public search total relation');
  }
}

function mapTier(value: PublicSearchMatchTier): PublicSearchMatchTierKind {
  switch (value) {
    case PublicSearchMatchTier.Primary: return 'primary';
    case PublicSearchMatchTier.Relaxed: return 'relaxed';
    default: throw new ProtocolError('Invalid public search match tier');
  }
}

function mapSnippetField(value: PublicSearchSnippetField): PublicSearchSnippetFieldKind {
  switch (value) {
    case PublicSearchSnippetField.None: return 'none';
    case PublicSearchSnippetField.Title: return 'title';
    case PublicSearchSnippetField.Heading: return 'heading';
    case PublicSearchSnippetField.Summary: return 'summary';
    case PublicSearchSnippetField.Taxonomy: return 'taxonomy';
    case PublicSearchSnippetField.Code: return 'code';
    case PublicSearchSnippetField.Body: return 'body';
    default: throw new ProtocolError('Invalid public search snippet field');
  }
}

function validateHighlights(snippet: string, raw: readonly PublicSearchHighlight[]): readonly PublicSearchHighlightRange[] {
  let prevEnd = 0;
  const result: PublicSearchHighlightRange[] = [];
  for (const h of raw) {
    if (!Number.isInteger(h.start) || !Number.isInteger(h.end) ||
        h.start < prevEnd || h.end <= h.start || h.end > snippet.length) {
      throw new ProtocolError('Invalid or overlapping public search highlight range');
    }
    if (isLowSurrogate(snippet.charCodeAt(h.start)) || isHighSurrogate(snippet.charCodeAt(h.end - 1))) {
      throw new ProtocolError('Public search highlight range splits a UTF-16 surrogate pair');
    }
    prevEnd = h.end;
    result.push({ start: h.start, end: h.end });
  }
  return result;
}

function mapHit(hit: PublicSearchHit): PublicSearchResultItem {
  if (hit.id <= 0 || hit.revision <= 0n || hit.revisionNo <= 0 ||
      hit.publication <= 0n || hit.publicationNo <= 0 || hit.views < 0 ||
      hit.categoryId < 0 || (hit.categoryId === 0) !== (hit.categoryName.length === 0) ||
      hit.title.length === 0) {
    throw new ProtocolError('Invalid public search hit metadata');
  }
  const seenTags = new Set<number>();
  const tags = hit.tags.map(tag => {
    if (tag.id <= 0 || tag.name.length === 0 || seenTags.has(tag.id)) {
      throw new ProtocolError('Invalid public search hit tags');
    }
    seenTags.add(tag.id);
    return { id: tag.id, name: tag.name };
  });
  const snippetField = mapSnippetField(hit.snippetField);
  if (snippetField === 'none' && (hit.snippet.length > 0 || hit.highlights.length > 0)) {
    throw new ProtocolError('Public search hit with snippetField=none must not carry snippet data');
  }
  const highlights = snippetField === 'none' ? [] : validateHighlights(hit.snippet, hit.highlights);

  return {
    id: hit.id,
    title: hit.title,
    summary: hit.summary,
    views: hit.views,
    createdAt: Number(hit.createdAtUnixMs),
    updatedAt: null,
    publishedAt: Number(hit.publishedAtUnixMs),
    scheduledPublishAt: null,
    revision: hit.revision,
    revisionNo: hit.revisionNo,
    publication: hit.publication,
    publicationNo: hit.publicationNo,
    category: { id: hit.categoryId, name: hit.categoryName },
    tags,
    matchTier: mapTier(hit.matchTier),
    snippetField,
    snippet: hit.snippet,
    highlights,
  };
}

export function validatePublicSearchResult(raw: PublicSearchResult, headerGeneration?: string | null): PublicSearchV2Page {
  if (raw.generation < 0n || raw.profileVersion <= 0 || raw.analyzerVersion <= 0 ||
      raw.totalCount < 0 || raw.primaryCount < 0 || raw.relaxedCount < 0) {
    throw new ProtocolError('Invalid public search result header');
  }
  const generation = raw.generation.toString();
  if (!generationPattern.test(generation)) {
    throw new ProtocolError('Invalid public search generation');
  }
  if (headerGeneration !== undefined && headerGeneration !== null) {
    if (!generationPattern.test(headerGeneration) || headerGeneration !== generation) {
      throw new ProtocolError('Public search generation header disagrees with payload');
    }
  }
  if (raw.hasMore !== (raw.nextCursor.length > 0)) {
    throw new ProtocolError('Public search nextCursor disagrees with hasMore');
  }
  if (raw.nextCursor.length > 0 && !base64UrlPattern.test(raw.nextCursor)) {
    throw new ProtocolError('Invalid public search cursor encoding');
  }
  const totalRelation = mapRelation(raw.totalRelation);
  if (raw.totalCount < raw.items.length) {
    throw new ProtocolError('Public search totalCount is smaller than page length');
  }
  if (totalRelation === 'exact') {
    if (raw.primaryCount + raw.relaxedCount !== raw.totalCount) {
      throw new ProtocolError('Exact public search counts do not sum to totalCount');
    }
  } else if (raw.primaryCount + raw.relaxedCount > raw.totalCount) {
    throw new ProtocolError('Public search tier counts exceed lower-bound total');
  }

  return {
    generation,
    profileVersion: raw.profileVersion,
    analyzerVersion: raw.analyzerVersion,
    total: raw.totalCount,
    totalRelation,
    primaryCount: raw.primaryCount,
    relaxedCount: raw.relaxedCount,
    hasMore: raw.hasMore,
    nextCursor: raw.hasMore ? raw.nextCursor : null,
    items: raw.items.map(mapHit),
  };
}

export function decodePublicSearchV2(payload: Uint8Array, headerGeneration?: string | null): PublicSearchV2Page {
  return validatePublicSearchResult(decodePublicSearchResult(payload), headerGeneration);
}

/**
 * Splits plain text into safe non-HTML segments using validated UTF-16 highlight ranges.
 * Never interprets HTML or emits raw markup; consumers must render text nodes only.
 */
export function sliceSnippetHighlights(
  text: string,
  highlights: readonly PublicSearchHighlightRange[],
): readonly SnippetSegment[] {
  if (!text) return [];
  if (!highlights.length) return [{ text, highlight: false }];
  const segments: SnippetSegment[] = [];
  let cursor = 0;
  for (const range of highlights) {
    const start = Math.max(cursor, Math.min(range.start, text.length));
    const end = Math.max(start, Math.min(range.end, text.length));
    if (start > cursor) segments.push({ text: text.slice(cursor, start), highlight: false });
    if (end > start) segments.push({ text: text.slice(start, end), highlight: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), highlight: false });
  return segments;
}
