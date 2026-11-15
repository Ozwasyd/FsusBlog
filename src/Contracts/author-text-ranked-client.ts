import { request, siteSessionHeader } from './client.ts';
import {
  decodeAuthorTextFacetedPage, decodeAuthorTextRankedPage, encodeAuthorTextFacetedQuery, encodeAuthorTextRankedQuery,
  type AuthorTextFacetedPage, type AuthorTextRankedPage, type AuthorTextRankedQuery,
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
