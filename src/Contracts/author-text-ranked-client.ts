import { request, siteSessionHeader } from './client.ts';
import {
  decodeAuthorTextFacetedPage, decodeAuthorTextRankedPage, encodeAuthorTextFacetedQuery, encodeAuthorTextRankedQuery,
  encodeAuthorTextQualifiedQuery, decodeAuthorTextSummaryPage, encodeAuthorTextSummaryQuery,
  decodeAuthorTextHeadingPage, encodeAuthorTextHeadingQuery,
  decodeAuthorTextPropertyFacetPage, encodeAuthorTextPropertyFacetQuery,
  type AuthorTextPropertyFacetPage, type AuthorTextPropertyFacetQuery,
  type AuthorTextFacetedPage, type AuthorTextQualifiedQuery,
  type AuthorTextRankedPage, type AuthorTextRankedQuery,
} from './author-text-search.ts';
import { FrameType, WireRoutes } from './wire.generated.ts';

export function authorTextRankedSearch(
  input: AuthorTextRankedQuery, session: string, signal: AbortSignal,
): Promise<AuthorTextRankedPage> {
  return request(WireRoutes.AuthorTextSearch, FrameType.AuthorTextRankedPage, decodeAuthorTextRankedPage, signal, 'POST',
    encodeAuthorTextRankedQuery(input), siteSessionHeader(session));
}

export function authorTextFacetedSearch(
  input: AuthorTextRankedQuery, session: string, signal: AbortSignal,
): Promise<AuthorTextFacetedPage> {
  return request(WireRoutes.AuthorTextSearch, FrameType.AuthorTextFacetedPage, decodeAuthorTextFacetedPage, signal, 'POST',
    encodeAuthorTextFacetedQuery(input), siteSessionHeader(session));
}

export function authorTextQualifiedSearch(
  input: AuthorTextQualifiedQuery, session: string, signal: AbortSignal,
): Promise<AuthorTextFacetedPage> {
  return request(WireRoutes.AuthorTextSearch, FrameType.AuthorTextFacetedPage, decodeAuthorTextFacetedPage, signal, 'POST',
    encodeAuthorTextQualifiedQuery(input), siteSessionHeader(session));
}

export function authorTextSummarySearch(
  input: AuthorTextQualifiedQuery, session: string, signal: AbortSignal,
): Promise<AuthorTextFacetedPage> {
  return request(WireRoutes.AuthorTextSearch, FrameType.AuthorTextSummaryPage, decodeAuthorTextSummaryPage, signal, 'POST',
    encodeAuthorTextSummaryQuery(input), siteSessionHeader(session));
}

export function authorTextHeadingSearch(
  input: AuthorTextQualifiedQuery, session: string, signal: AbortSignal,
): Promise<AuthorTextFacetedPage> {
  return request(WireRoutes.AuthorTextSearch, FrameType.AuthorTextHeadingPage, decodeAuthorTextHeadingPage, signal, 'POST',
    encodeAuthorTextHeadingQuery(input), siteSessionHeader(session));
}

export function authorTextPropertyFacetSearch(
  input: AuthorTextPropertyFacetQuery, session: string, signal: AbortSignal,
): Promise<AuthorTextPropertyFacetPage> {
  return request(WireRoutes.AuthorTextSearch, FrameType.AuthorTextPropertyFacetPage,
    payload => decodeAuthorTextPropertyFacetPage(payload, input.includeHeading), signal, 'POST',
    encodeAuthorTextPropertyFacetQuery(input), siteSessionHeader(session));
}
