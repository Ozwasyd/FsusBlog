/** Display destination only; the shared protocol owner has not published a pin wire decoder. */
export interface ArticlePinDisplayRow {
    readonly pinId: string;
    readonly articleId: number;
    readonly orderReference: string;
    readonly title: string;
    readonly status: 0 | 1 | 2 | 3;
    /** Server display hint, never an authorization or an open acknowledgement. */
    readonly openEligible: boolean;
    /** Optional display facts supplied by the existing document/session owner. */
    readonly dirty?: boolean;
    readonly open?: boolean;
}

export interface ArticlePinDisplayBinding {
    /** Lossless UI reference; wire representation remains owned by shared contracts. */
    readonly collectionRevision: string;
    readonly pageDigest: string;
}

export interface ArticlePinDisplayPage extends ArticlePinDisplayBinding {
    /** Same server order for both consumers; no local ranking or membership cache. */
    readonly items: readonly ArticlePinDisplayRow[];
    readonly startsAtHead: boolean;
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
}

export type ArticlePinPresentation =
    | Readonly<{ state: 'unconnected' | 'loading' | 'unavailable' | 'stale' | 'conflict' | 'failed'; }>
    | Readonly<{ state: 'current'; page: ArticlePinDisplayPage; }>;

export type ArticlePinActionState = 'idle' | 'pending' | 'failed' | 'conflict' | 'stale';

/** Already localized by the original composition; these are UI slots, not locale catalog keys. */
export interface ArticlePinCopy {
    readonly railLabel: string;
    readonly switcherLabel: string;
    readonly orderLabel: string;
    readonly archivedLabel: string;
    readonly dirtyLabel: string;
    readonly openLabel: string;
    readonly pinLabel: string;
    readonly unpinLabel: string;
    readonly reorderLabel: string;
    readonly previousLabel: string;
    readonly nextLabel: string;
    readonly headDropLabel: string;
    readonly nextPageLabel: string;
    readonly refreshLabel: string;
    readonly statusCurrent: string;
    readonly statusEmpty: string;
    readonly statusUnavailable: string;
    readonly statusLoading: string;
    readonly statusPending: string;
    readonly statusFailed: string;
    readonly statusConflict: string;
    readonly statusStale: string;
}

export type ArticlePinToggleIntent = Readonly<ArticlePinDisplayBinding & {
    kind: 'add' | 'remove';
    actionId: 'article-pin-toggle';
    articleId: number;
    pinId: string | null;
}>;

export type ArticlePinMoveIntent = Readonly<ArticlePinDisplayBinding & {
    kind: 'reorder';
    actionId: 'article-pin-reorder';
    articleId: number;
    pinId: string;
    afterArticleId: number | null;
    afterPinId: string | null;
}>;

export type ArticlePinOpenIntent = Readonly<ArticlePinDisplayBinding & {
    kind: 'open';
    actionId: 'article-pin-open';
    articleId: number;
    pinId: string;
}>;

export const ARTICLE_PIN_DISPLAY_LIMIT = 64;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>>
{
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validArticleId(value: unknown): value is number
{
    return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2_147_483_647;
}

function validReference(value: unknown): value is string
{
    if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value !== value.trim())
    {
        return false;
    }
    for (const character of value)
    {
        const code = character.charCodeAt(0);
        if (code < 32 || (code >= 127 && code <= 159))
        {
            return false;
        }
    }
    return true;
}

export function hasArticlePinDisplayBinding(binding: unknown): binding is ArticlePinDisplayBinding
{
    return isRecord(binding) && validReference(binding.collectionRevision)
        && typeof binding.pageDigest === 'string' && /^[a-f0-9]{64}$/u.test(binding.pageDigest);
}

function hasArticlePinDisplayRow(row: unknown): row is ArticlePinDisplayRow
{
    return isRecord(row) && validArticleId(row.articleId) && validReference(row.pinId) && validReference(row.orderReference)
        && typeof row.status === 'number' && [0, 1, 2, 3].includes(row.status) && typeof row.title === 'string'
        && typeof row.openEligible === 'boolean' && (row.dirty === undefined || typeof row.dirty === 'boolean')
        && (row.open === undefined || typeof row.open === 'boolean');
}

function hasArticlePinDisplayPage(page: unknown): page is ArticlePinDisplayPage
{
    if (!isRecord(page) || !hasArticlePinDisplayBinding(page) || !Array.isArray(page.items)
        || page.items.length > ARTICLE_PIN_DISPLAY_LIMIT || typeof page.startsAtHead !== 'boolean' || typeof page.hasMore !== 'boolean'
        || (page.nextCursor !== null && typeof page.nextCursor !== 'string')
        || page.hasMore !== (page.nextCursor !== null)
        || (page.nextCursor !== null && (page.nextCursor.length === 0 || page.nextCursor.length > 2048)))
    {
        return false;
    }
    const pinIds = new Set<string>();
    const articleIds = new Set<number>();
    for (const row of page.items)
    {
        if (!hasArticlePinDisplayRow(row) || pinIds.has(row.pinId) || articleIds.has(row.articleId))
        {
            return false;
        }
        pinIds.add(row.pinId);
        articleIds.add(row.articleId);
    }
    return true;
}

/** Shape/budget checks protect rendering only. They verify no receipt, permission or currentness. */
export function readArticlePinDisplayPage(presentation: unknown,
    action: ArticlePinActionState = 'idle'): ArticlePinDisplayPage | null
{
    try
    {
        if (!isRecord(presentation) || presentation.state !== 'current' || action === 'conflict' || action === 'stale')
        {
            return null;
        }
        const page = presentation.page;
        return hasArticlePinDisplayPage(page) ? page : null;
    }
    catch
    {
        // Malformed or throwing display input cannot leave partial title/count content behind.
        return null;
    }
}

/** Closed UI intent only. The future authenticated transport must perform the real CAS command. */
export function createArticlePinToggleIntent(binding: ArticlePinDisplayBinding, articleId: number,
    membership: 'pinned' | 'unpinned' | 'unknown', pinId: string | null): ArticlePinToggleIntent | null
{
    if (!hasArticlePinDisplayBinding(binding) || !validArticleId(articleId) || (membership !== 'pinned' && membership !== 'unpinned')
        || (membership === 'pinned' && (pinId === null || !validReference(pinId)))
        || (membership === 'unpinned' && pinId !== null))
    {
        return null;
    }
    return Object.freeze({ kind: membership === 'pinned' ? 'remove' : 'add', actionId: 'article-pin-toggle',
        articleId, pinId, collectionRevision: binding.collectionRevision, pageDigest: binding.pageDigest });
}

/** Menu, keyboard and drag use this same after-anchor intent; the authoritative list is untouched. */
export function createArticlePinMoveIntent(page: ArticlePinDisplayPage, pinId: string,
    afterPinId: string | null): ArticlePinMoveIntent | null
{
    if (!hasArticlePinDisplayPage(page))
    {
        return null;
    }
    const row = page.items.find(item => item.pinId === pinId);
    const anchor = afterPinId === null ? null : page.items.find(item => item.pinId === afterPinId);
    if (!row || row.pinId === afterPinId || (afterPinId !== null && !anchor) || (afterPinId === null && !page.startsAtHead))
    {
        return null;
    }
    return Object.freeze({ kind: 'reorder', actionId: 'article-pin-reorder', articleId: row.articleId, pinId: row.pinId,
        afterArticleId: anchor?.articleId ?? null, afterPinId: anchor?.pinId ?? null,
        collectionRevision: page.collectionRevision, pageDigest: page.pageDigest });
}

export function articlePinAdjacentAnchor(page: ArticlePinDisplayPage, pinId: string,
    direction: 'previous' | 'next'): string | null | undefined
{
    if (!hasArticlePinDisplayPage(page) || (direction !== 'previous' && direction !== 'next'))
    {
        return undefined;
    }
    const index = page.items.findIndex(row => row.pinId === pinId);
    if (index < 0)
    {
        return undefined;
    }
    if (direction === 'next')
    {
        return page.items[index + 1]?.pinId;
    }
    // An off-page predecessor is unknown; never infer it from a local page boundary.
    return index > 1 ? page.items[index - 2]?.pinId : index === 1 && page.startsAtHead ? null : undefined;
}
