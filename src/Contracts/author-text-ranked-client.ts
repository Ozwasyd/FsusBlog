import { sessionPost } from './internal/http.ts';
import {
  decodeAuthorTextFacetedPage, decodeAuthorTextRankedPage, encodeAuthorTextFacetedQuery, encodeAuthorTextRankedQuery,
  encodeAuthorTextQualifiedQuery, decodeAuthorTextSummaryPage, encodeAuthorTextSummaryQuery,
  decodeAuthorTextHeadingPage, encodeAuthorTextHeadingQuery,
  decodeAuthorTextPropertyFacetPage, encodeAuthorTextPropertyFacetQuery,
  decodeAuthorTextPropertySortPage, encodeAuthorTextPropertySortQuery,
  decodeAuthorTextPropertyTextPage, encodeAuthorTextPropertyTextQuery, type AuthorTextPropertyTextQuery,
  decodeAuthorTextPropertyTextQualifiedPage, encodeAuthorTextPropertyTextQualifiedQuery, type AuthorTextPropertyTextQualifiedQuery,
  decodeAuthorTextPropertyTextMixedPage, encodeAuthorTextPropertyTextMixedQuery, type AuthorTextPropertyTextMixedQuery,
  type AuthorTextPropertySortPage, type AuthorTextPropertySortQuery,
  type AuthorTextPropertyFacetPage, type AuthorTextPropertyFacetQuery,
  type AuthorTextFacetedPage, type AuthorTextQualifiedQuery,
  type AuthorTextRankedPage, type AuthorTextRankedQuery,
} from './author-text-search.ts';
import { FrameType, WireRoutes } from './wire.generated.ts';

export function authorTextRankedSearch(
  input: AuthorTextRankedQuery, session: string, signal: AbortSignal,
): Promise<AuthorTextRankedPage> {
  return sessionPost(WireRoutes.AuthorTextSearch, FrameType.AuthorTextRankedPage, decodeAuthorTextRankedPage, signal,
    encodeAuthorTextRankedQuery(input), session);
}

export function authorTextFacetedSearch(
  input: AuthorTextRankedQuery, session: string, signal: AbortSignal,
): Promise<AuthorTextFacetedPage> {
  return sessionPost(WireRoutes.AuthorTextSearch, FrameType.AuthorTextFacetedPage, decodeAuthorTextFacetedPage, signal,
    encodeAuthorTextFacetedQuery(input), session);
}

export function authorTextQualifiedSearch(
  input: AuthorTextQualifiedQuery, session: string, signal: AbortSignal,
): Promise<AuthorTextFacetedPage> {
  return sessionPost(WireRoutes.AuthorTextSearch, FrameType.AuthorTextFacetedPage, decodeAuthorTextFacetedPage, signal,
    encodeAuthorTextQualifiedQuery(input), session);
}

export function authorTextSummarySearch(
  input: AuthorTextQualifiedQuery, session: string, signal: AbortSignal,
): Promise<AuthorTextFacetedPage> {
  return sessionPost(WireRoutes.AuthorTextSearch, FrameType.AuthorTextSummaryPage, decodeAuthorTextSummaryPage, signal,
    encodeAuthorTextSummaryQuery(input), session);
}

export function authorTextHeadingSearch(
  input: AuthorTextQualifiedQuery, session: string, signal: AbortSignal,
): Promise<AuthorTextFacetedPage> {
  return sessionPost(WireRoutes.AuthorTextSearch, FrameType.AuthorTextHeadingPage, decodeAuthorTextHeadingPage, signal,
    encodeAuthorTextHeadingQuery(input), session);
}

export function authorTextPropertyFacetSearch(
  input: AuthorTextPropertyFacetQuery, session: string, signal: AbortSignal,
): Promise<AuthorTextPropertyFacetPage> {
  return sessionPost(WireRoutes.AuthorTextSearch, FrameType.AuthorTextPropertyFacetPage,
    payload => decodeAuthorTextPropertyFacetPage(payload, input.includeHeading), signal,
    encodeAuthorTextPropertyFacetQuery(input), session);
}

export function authorTextPropertySortSearch(
  input: AuthorTextPropertySortQuery, session: string, signal: AbortSignal,
): Promise<AuthorTextPropertySortPage> {
  return sessionPost(WireRoutes.AuthorTextSearch, FrameType.AuthorTextPropertySortPage,
    payload => decodeAuthorTextPropertySortPage(payload, input.includeHeading, input.facet !== null), signal,
    encodeAuthorTextPropertySortQuery(input), session);
}

export function authorTextPropertyTextSearch(
  input: AuthorTextPropertyTextQuery, session: string, signal: AbortSignal,
): Promise<AuthorTextFacetedPage> {
  return sessionPost(WireRoutes.AuthorTextSearch, FrameType.AuthorTextPropertyTextPage, decodeAuthorTextPropertyTextPage,
    signal, encodeAuthorTextPropertyTextQuery(input), session);
}

export function authorTextPropertyTextQualifiedSearch(
  input: AuthorTextPropertyTextQualifiedQuery, session: string, signal: AbortSignal,
): Promise<AuthorTextPropertySortPage> {
  return sessionPost(WireRoutes.AuthorTextSearch, FrameType.AuthorTextPropertyTextQualifiedPage,
    payload => decodeAuthorTextPropertyTextQualifiedPage(payload, input.facet !== null), signal,
    encodeAuthorTextPropertyTextQualifiedQuery(input), session);
}

export function authorTextPropertyTextMixedSearch(
  input: AuthorTextPropertyTextMixedQuery, session: string, signal: AbortSignal,
): Promise<AuthorTextPropertySortPage> {
  return sessionPost(WireRoutes.AuthorTextSearch, FrameType.AuthorTextPropertyTextMixedPage,
    payload => decodeAuthorTextPropertyTextMixedPage(payload, input.includeHeading, input.facet !== null), signal,
    encodeAuthorTextPropertyTextMixedQuery(input), session);
}
