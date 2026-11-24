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

function authorTextPost<Input, Output>(
  expected: FrameType,
  encode: (input: Input) => Uint8Array<ArrayBuffer>,
  decode: (payload: Uint8Array, input: Input) => Output,
) {
  return (input: Input, session: string, signal: AbortSignal): Promise<Output> =>
    sessionPost(WireRoutes.AuthorTextSearch, expected, payload => decode(payload, input), signal, encode(input), session);
}

export const authorTextRankedSearch = authorTextPost<AuthorTextRankedQuery, AuthorTextRankedPage>(
  FrameType.AuthorTextRankedPage, encodeAuthorTextRankedQuery, decodeAuthorTextRankedPage);
export const authorTextFacetedSearch = authorTextPost<AuthorTextRankedQuery, AuthorTextFacetedPage>(
  FrameType.AuthorTextFacetedPage, encodeAuthorTextFacetedQuery, decodeAuthorTextFacetedPage);
export const authorTextQualifiedSearch = authorTextPost<AuthorTextQualifiedQuery, AuthorTextFacetedPage>(
  FrameType.AuthorTextFacetedPage, encodeAuthorTextQualifiedQuery, decodeAuthorTextFacetedPage);
export const authorTextSummarySearch = authorTextPost<AuthorTextQualifiedQuery, AuthorTextFacetedPage>(
  FrameType.AuthorTextSummaryPage, encodeAuthorTextSummaryQuery, decodeAuthorTextSummaryPage);
export const authorTextHeadingSearch = authorTextPost<AuthorTextQualifiedQuery, AuthorTextFacetedPage>(
  FrameType.AuthorTextHeadingPage, encodeAuthorTextHeadingQuery, decodeAuthorTextHeadingPage);
export const authorTextPropertyFacetSearch = authorTextPost<AuthorTextPropertyFacetQuery, AuthorTextPropertyFacetPage>(
  FrameType.AuthorTextPropertyFacetPage, encodeAuthorTextPropertyFacetQuery,
  (payload, input) => decodeAuthorTextPropertyFacetPage(payload, input.includeHeading));
export const authorTextPropertySortSearch = authorTextPost<AuthorTextPropertySortQuery, AuthorTextPropertySortPage>(
  FrameType.AuthorTextPropertySortPage, encodeAuthorTextPropertySortQuery,
  (payload, input) => decodeAuthorTextPropertySortPage(payload, input.includeHeading, input.facet !== null));
export const authorTextPropertyTextSearch = authorTextPost<AuthorTextPropertyTextQuery, AuthorTextFacetedPage>(
  FrameType.AuthorTextPropertyTextPage, encodeAuthorTextPropertyTextQuery, decodeAuthorTextPropertyTextPage);
export const authorTextPropertyTextQualifiedSearch = authorTextPost<AuthorTextPropertyTextQualifiedQuery, AuthorTextPropertySortPage>(
  FrameType.AuthorTextPropertyTextQualifiedPage, encodeAuthorTextPropertyTextQualifiedQuery,
  (payload, input) => decodeAuthorTextPropertyTextQualifiedPage(payload, input.facet !== null));
export const authorTextPropertyTextMixedSearch = authorTextPost<AuthorTextPropertyTextMixedQuery, AuthorTextPropertySortPage>(
  FrameType.AuthorTextPropertyTextMixedPage, encodeAuthorTextPropertyTextMixedQuery,
  (payload, input) => decodeAuthorTextPropertyTextMixedPage(payload, input.includeHeading, input.facet !== null));
