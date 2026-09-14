import { PUBLIC_SEARCH_ROUTE_POLICY } from '@/public-renderers/generated/publicPageManifest';
import { parsePublicPaginationCursor } from '@/public-renderers/publicRouteIdentity';

export type PublicSearchQuery = Readonly<Record<string, string>>;

export type PublicSearchQueryNormalization = Readonly<{
    query: PublicSearchQuery;
    shouldRedirect: boolean;
    invalidKeyword: boolean;
}>;

function firstValue(value: unknown): string
{
    if (Array.isArray(value))
    {
        return value.length > 0 ? String(value[0] ?? '') : '';
    }
    return typeof value === 'string' ? value : '';
}

export function normalizePublicSearchKeyword(value: unknown): string | null
{
    const normalized = firstValue(value).normalize('NFC').replace(/\s+/gu, ' ').trim();
    if (normalized.length > PUBLIC_SEARCH_ROUTE_POLICY.maxKeywordChars || /[\p{Cc}]/u.test(normalized))
    {
        return null;
    }
    return normalized;
}

export function normalizePublicSearchQuery(input: Readonly<Record<string, unknown>>): PublicSearchQueryNormalization
{
    const allowedKeys = new Set(['q', 'sort', 'page', 'cursor']);
    let shouldRedirect = Object.keys(input).some((key) => !allowedKeys.has(key))
    || Object.values(input).some((value) => Array.isArray(value) && value.length > 1);

    const rawKeyword = firstValue(input.q);
    const keyword = normalizePublicSearchKeyword(rawKeyword);
    if (keyword === null)
    {
        return { query: {}, shouldRedirect: true, invalidKeyword: true };
    }

    const query: Record<string, string> = {};
    if (keyword.length === 0)
    {
        return {
            query,
            shouldRedirect: shouldRedirect || Object.keys(input).length > 0,
            invalidKeyword: false
        };
    }

    query.q = keyword;
    shouldRedirect ||= rawKeyword !== keyword;

    const rawSort = firstValue(input.sort);
    const sort = rawSort.trim().toLowerCase();
    if (sort === PUBLIC_SEARCH_ROUTE_POLICY.latestSort || sort === PUBLIC_SEARCH_ROUTE_POLICY.hotSort)
    {
        query.sort = sort;
        shouldRedirect ||= rawSort !== sort;
    }
    else if (rawSort.length > 0)
    {
        shouldRedirect = true;
    }
    else if ('sort' in input)
    {
        shouldRedirect = true;
    }

    const rawPage = firstValue(input.page).trim();
    if (/^[0-9]+$/u.test(rawPage))
    {
        const page = Number(rawPage);
        if (Number.isSafeInteger(page) && page > 1 && page <= PUBLIC_SEARCH_ROUTE_POLICY.maxPage)
        {
            query.page = String(page);
            shouldRedirect ||= rawPage !== query.page;
        }
        else
        {
            shouldRedirect = true;
        }
    }
    else if (rawPage.length > 0 || 'page' in input)
    {
        shouldRedirect = true;
    }

    if ('cursor' in input)
    {
        const rawCursor = firstValue(input.cursor);
        const cursor = parsePublicPaginationCursor(rawCursor);
        if (cursor)
        {
            query.cursor = cursor;
            shouldRedirect ||= rawCursor !== cursor;
        }
        else
        {
            // Preserve malformed or unexpected cursors so the page fails closed instead
            // of redirecting to a cursor-less request with different semantics.
            query.cursor = rawCursor;
            shouldRedirect = false;
        }
    }

    return { query, shouldRedirect, invalidKeyword: false };
}
