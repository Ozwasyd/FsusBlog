import { computed, getCurrentScope, nextTick, onScopeDispose, ref, shallowRef } from 'vue';

import type { ArticlePackageCandidateReview, ArticlePackageCandidateReviewPageCompletion, ArticlePackageCandidateReviewPageRequest } from '@/api/types/articlePackageCandidateReview';

/**
 * Required read port, not a default/unavailable transport implementation.
 * The authenticated route/frame owner supplies a decoded, bounded original projection
 * and forwards this signal to its actual I/O. requestId is UI correlation, not authority.
 * No package route, frame, schema, plan store or execution capability is defined here.
 */
export type ArticlePackageCandidateReviewReadPort = (
    request: ArticlePackageCandidateReviewPageRequest,
    signal: AbortSignal
) => Promise<ArticlePackageCandidateReview>;

interface ActivePageRead
{
    readonly request: ArticlePackageCandidateReviewPageRequest;
    readonly controller: AbortController;
}

/**
 * One read-only page host. Bind review/state/pageCompletion to the frozen component,
 * and requestPage to its request-page event. Seed a decoded page with await setReview.
 * cancel owns the AbortController; optional request identity rejects delayed cancels.
 * setReview clears completion and presents an empty review for a Vue tick before
 * seeding any context, including same-candidate recovery after an identified error.
 * Production I/O cancellation depends on the injected port honoring AbortSignal.
 */
export function useArticlePackageCandidateReview(read: ArticlePackageCandidateReviewReadPort)
{
    const review = shallowRef<ArticlePackageCandidateReview | null>(null);
    const state = ref<'ready' | 'loading' | 'error'>('ready');
    const pageCompletion = shallowRef<ArticlePackageCandidateReviewPageCompletion | null>(null);
    const active = shallowRef<ActivePageRead | null>(null);
    let context: object = {};
    let changingContext = false;
    let disposed = false;
    let lastRequestId: string | null = null;

    function matches(request: ArticlePackageCandidateReviewPageRequest, other: ArticlePackageCandidateReviewPageRequest): boolean
    {
        return request.requestId === other.requestId && request.planDigest === other.planDigest
            && request.pageIndex === other.pageIndex && request.pageSize === other.pageSize;
    }

    function cancel(request?: ArticlePackageCandidateReviewPageRequest): void
    {
        const current = active.value;
        if (!current || (request && !matches(current.request, request)))
        {
            return;
        }
        active.value = null;
        state.value = 'ready';
        pageCompletion.value = { request: current.request, status: 'cancelled' };
        current.controller.abort();
    }

    async function setReview(value: ArticlePackageCandidateReview | null): Promise<void>
    {
        if (disposed)
        {
            return;
        }
        const version = {};
        context = version;
        changingContext = true;
        const previous = active.value;
        active.value = null;
        pageCompletion.value = null;
        review.value = null;
        state.value = 'ready';
        previous?.controller.abort();
        await nextTick();
        if (!disposed && context === version)
        {
            review.value = value;
            changingContext = false;
        }
    }

    async function requestPage(input: ArticlePackageCandidateReviewPageRequest): Promise<void>
    {
        const current = review.value;
        if (disposed || changingContext || active.value || !current || !input.requestId || input.requestId.length > 128
            || input.requestId === lastRequestId || input.planDigest !== current.planDigest
            || input.pageSize !== current.pageSize || !Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 50
            || !Number.isSafeInteger(input.pageIndex) || input.pageIndex < 0 || input.pageIndex >= Math.ceil(current.totalTargets / input.pageSize))
        {
            return;
        }
        const request = Object.freeze({ requestId: input.requestId, planDigest: input.planDigest, pageIndex: input.pageIndex, pageSize: input.pageSize });
        const operation: ActivePageRead = { request, controller: new AbortController() };
        active.value = operation;
        lastRequestId = request.requestId;
        pageCompletion.value = null;
        state.value = 'loading';
        const signal = operation.controller.signal;
        let finishAbort!: () => void;
        const aborted = new Promise<undefined>(resolve =>
        {
            finishAbort = () => resolve(undefined);
            signal.addEventListener('abort', finishAbort, { once: true });
        });
        try
        {
            const response = await Promise.race([read(request, signal), aborted]);
            if (active.value !== operation || signal.aborted)
            {
                return;
            }
            if (response?.planDigest !== request.planDigest || response.pageIndex !== request.pageIndex
                || response.pageSize !== request.pageSize || response.executeDisabled !== true
                || response.executionReasonCode !== 'article_package_import_authority_unavailable')
            {
                state.value = 'error';
                pageCompletion.value = { request, status: 'error' };
            }
            else
            {
                review.value = response;
                state.value = 'ready';
                pageCompletion.value = { request, status: 'ready', review: response };
            }
        }
        catch
        {
            if (active.value === operation && !signal.aborted)
            {
                state.value = 'error';
                pageCompletion.value = { request, status: 'error' };
            }
        }
        finally
        {
            signal.removeEventListener('abort', finishAbort);
            if (active.value === operation)
            {
                active.value = null;
            }
        }
    }

    function dispose(): void
    {
        disposed = true;
        context = {};
        changingContext = false;
        const previous = active.value;
        active.value = null;
        pageCompletion.value = null;
        review.value = null;
        state.value = 'ready';
        previous?.controller.abort();
    }

    if (getCurrentScope())
    {
        onScopeDispose(dispose);
    }
    return {
        review: computed(() => review.value),
        state: computed(() => state.value),
        pageCompletion: computed(() => pageCompletion.value),
        pendingRequest: computed(() => active.value?.request ?? null),
        setReview,
        requestPage,
        cancel,
        dispose
    };
}
