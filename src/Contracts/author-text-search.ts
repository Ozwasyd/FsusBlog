import { encodeFrame } from './aeds.ts';
import { PodReader, PodWriter, ProtocolError } from './binary.ts';
import { request, siteSessionHeader } from './client.ts';
import { FrameType, WireLimits, WireRoutes } from './wire.generated.ts';

export type AuthorTextSearchRow = Readonly<{
  id: number;
  revision: bigint;
  title: string;
  field: 'title' | 'body';
  snippet: string;
  highlightStart: number;
  highlightEnd: number;
  sourceStart: number;
  sourceEnd: number;
  sourceByteStart: number;
  sourceByteEnd: number;
  sourceDigest: Uint8Array;
}>;

export type AuthorTextSearchPage = Readonly<{ ready: boolean; more: boolean; rows: readonly AuthorTextSearchRow[] }>;

const utf8 = new TextEncoder();

export function encodeAuthorTextSearchQuery(query: string): Uint8Array<ArrayBuffer> {
  if (query.length > WireLimits.AuthorTextSearchQueryChars) throw new ProtocolError('Author text search query exceeds its text limit');
  const writer = new PodWriter();
  writer.text(query, WireLimits.AuthorTextSearchQueryBytes);
  return encodeFrame(FrameType.AuthorTextSearchQuery, writer.finish());
}

export function authorTextSearch(query: string, session: string, signal: AbortSignal): Promise<AuthorTextSearchPage> {
  return request(WireRoutes.AuthorTextSearch, FrameType.AuthorTextSearchPage, decodeAuthorTextSearchPage, signal, 'POST',
    encodeAuthorTextSearchQuery(query), siteSessionHeader(session));
}

export function decodeAuthorTextSearchPage(payload: Uint8Array): AuthorTextSearchPage {
  const reader = new PodReader(payload);
  const ready = reader.bool();
  const more = reader.bool();
  const count = reader.i32();
  if (count < 0 || count > WireLimits.AuthorTextSearchRows || (!ready && (more || count !== 0)) ||
      (more && count !== WireLimits.AuthorTextSearchRows)) throw new ProtocolError('Invalid author text search page');

  const rows: AuthorTextSearchRow[] = [];
  for (let i = 0; i < count; i++) {
    const id = reader.i32();
    const revision = reader.i64();
    const title = reader.text(WireLimits.TitleBytes);
    const field = reader.i32();
    const snippet = reader.text(WireLimits.AuthorTextSearchSnippetBytes);
    const highlightStart = reader.i32(), highlightEnd = reader.i32();
    const sourceStart = reader.i32(), sourceEnd = reader.i32();
    const sourceByteStart = reader.i32(), sourceByteEnd = reader.i32();
    const sourceDigest = reader.fixedBytes(WireLimits.AuthorTextSearchSourceDigestBytes);
    const sourceLimit = field === 1 ? WireLimits.TitleBytes : WireLimits.BodyBytes;
    if (id <= 0 || revision <= 0n || (i > 0 && id >= rows[i - 1].id) || (field !== 1 && field !== 2) ||
        highlightStart < 0 || highlightEnd <= highlightStart || highlightEnd > snippet.length ||
        !isRuneBoundary(snippet, highlightStart) || !isRuneBoundary(snippet, highlightEnd) ||
        sourceStart < 0 || sourceEnd <= sourceStart || sourceEnd > sourceLimit ||
        sourceByteStart < sourceStart || sourceByteEnd <= sourceByteStart || sourceByteEnd > sourceLimit ||
        sourceEnd - sourceStart !== highlightEnd - highlightStart ||
        sourceByteEnd - sourceByteStart !== utf8.encode(snippet.slice(highlightStart, highlightEnd)).length)
      throw new ProtocolError('Invalid author text search row');
    rows.push({ id, revision, title, field: field === 1 ? 'title' : 'body', snippet, highlightStart, highlightEnd,
      sourceStart, sourceEnd, sourceByteStart, sourceByteEnd, sourceDigest });
  }
  reader.finish();
  return { ready, more, rows };
}

function isRuneBoundary(text: string, offset: number): boolean {
  if (offset === text.length) return true;
  const value = text.charCodeAt(offset);
  return value < 0xdc00 || value > 0xdfff;
}
