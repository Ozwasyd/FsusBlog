import { ArticlePublishStatus } from '@/contracts/binaryApi';
import type { ArticleDetailResponse } from '@/contracts/binaryApi';

/** Display scopes only. The shared query owner interprets these navigation intents. */
export type ArticleLibraryGroup = 'recent' | 'draft' | 'published' | 'scheduled' | 'archived';

/** Metadata projected from an admitted source; construction does not establish permission. */
export type ArticleLibraryEntry = Readonly<Pick<ArticleDetailResponse, 'id' | 'title' | 'updatedAt'> & {
    status: Exclude<ArticlePublishStatus, typeof ArticlePublishStatus.Deleted>;
}>;

/** One bounded display page, never a query response, cache, or authorization assertion. */
export type ArticleLibraryPresentation =
    | Readonly<{ state: 'unconnected' | 'loading' | 'error' | 'unavailable'; group: ArticleLibraryGroup; }>
    | Readonly<{
        state: 'ready';
        group: ArticleLibraryGroup;
        entries: readonly ArticleLibraryEntry[];
        hasPrevious: boolean;
        hasNext: boolean;
    }>;

export const articleLibraryGroups: readonly Readonly<{ key: ArticleLibraryGroup; label: string; }>[] = [
    { key: 'recent', label: '最近编辑' },
    { key: 'draft', label: '草稿' },
    { key: 'published', label: '已发布' },
    { key: 'scheduled', label: '定时' },
    { key: 'archived', label: '已归档' }
];

const groupStatuses = {
    draft: ArticlePublishStatus.Draft,
    published: ArticlePublishStatus.Published,
    scheduled: ArticlePublishStatus.Scheduled,
    archived: ArticlePublishStatus.Archived
} as const;

/** Reject oversized or inconsistent pages rather than truncating or inventing results. */
export function isArticleLibraryPageValid(page: ArticleLibraryPresentation): boolean
{
    if (!articleLibraryGroups.some((group) => group.key === page.group)) return false;
    if (page.state !== 'ready') return true;
    if (page.entries.length > 50) return false;
    const ids = new Set<number>();
    for (const entry of page.entries)
    {
        if (!Number.isSafeInteger(entry.id) || entry.id <= 0 || ids.has(entry.id)
            || typeof entry.title !== 'string'
            || !Object.values(groupStatuses).includes(entry.status)
            || (page.group !== 'recent' && entry.status !== groupStatuses[page.group]))
        {
            return false;
        }
        ids.add(entry.id);
    }
    return true;
}

/** Lifecycle copy uses the existing article status contract, without interpreting permissions. */
export function articleLibraryStatusLabel(status: ArticleLibraryEntry['status']): string
{
    return articleLibraryGroups.find((group) => group.key !== 'recent' && groupStatuses[group.key] === status)?.label ?? '';
}
