import { revalidateAuthorArticleSelection } from '@/api/authorArticleSelection';
import type { AuthorArticleSelectionRevalidationRequest, AuthorArticleSelectionRevalidationResponse } from '@/codecs/binary/authorArticleSelectionWire.generated';

import type { ArticleDocumentTaskLease } from './articleDocumentContext';
import type { ArticleEditorSearchRuntime } from './articleEditorSearchRuntime';

/** One selected-ID observation and its original Writer lease; this admits no query package or reveal command. */
export async function revalidateArticleSearchSelection(
    request: AuthorArticleSelectionRevalidationRequest, search: ArticleEditorSearchRuntime
): Promise<Readonly<{ lease: ArticleDocumentTaskLease; selection: AuthorArticleSelectionRevalidationResponse; }> | null>
{
    // The real owner clears the previous command and owns cancellation and supersession.
    const lease = search.beginTask('author-search-selection');
    try
    {
        const selection = await revalidateAuthorArticleSelection(request, lease.signal);
        if (search.currentTask !== lease || !lease.isCurrent() || lease.signal.aborted)
        {
            if (search.currentTask === lease)
            {
                search.cancel();
            }
            return null;
        }
        if (!selection.current)
        {
            search.cancel();
            return null;
        }
        return Object.freeze({ lease, selection });
    }
    catch (error)
    {
        const stale = search.currentTask !== lease || !lease.isCurrent() || lease.signal.aborted;
        if (search.currentTask === lease)
        {
            search.cancel();
        }
        if (stale || (error instanceof Error && error.name === 'AbortError'))
        {
            return null;
        }
        throw error;
    }
}
