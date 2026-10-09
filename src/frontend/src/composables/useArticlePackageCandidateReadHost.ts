import { computed, getCurrentScope, onScopeDispose, ref } from 'vue';

import type { ArticlePackageCandidateAuthenticatedRead, ArticlePackageCandidateReadContext, ArticlePackageCandidateReadIntent, ArticlePackageCandidateReadResponse } from '@/api/types/articlePackageCandidateRead';
import { useArticlePackageCandidateReview } from '@/composables/useArticlePackageCandidateReview';

/**
 * Inactive typed-read connection to the supplied controller. Stores only this UI sequence's
 * caller input and context echo, never a second server plan/store or execution capability.
 * Actual authenticated AEDS I/O and socket cancellation must be supplied and qualified by
 * the transport owner; passing AbortSignal alone does not prove production cancellation.
 */
export function useArticlePackageCandidateReadHost(read: ArticlePackageCandidateAuthenticatedRead)
{
    let version: object = {};
    let intent: ArticlePackageCandidateReadIntent | null = null;
    let observed: ArticlePackageCandidateReadContext | null = null;
    let initial: AbortController | null = null;
    let disposed = false;
    const initialState = ref<'ready' | 'loading' | 'error'>('ready');

    function sameContext(value: ArticlePackageCandidateReadContext, expected: ArticlePackageCandidateReadContext): boolean
    {
        return value.identity === expected.identity && value.lifecycleVersion === expected.lifecycleVersion
            && value.generation === expected.generation && value.mappingRevision === expected.mappingRevision
            && value.scopeRevision === expected.scopeRevision;
    }

    function validResponse(response: ArticlePackageCandidateReadResponse, id: string, index: number, size: number): boolean
    {
        return response?.requestId === id && !!response.context
            && typeof response.context.identity === 'string' && response.context.identity.length > 0 && response.context.identity.length <= 160
            && response.context.lifecycleVersion === 1
            && Number.isInteger(response.context.generation) && response.context.generation >= 1 && response.context.generation <= 16
            && Number.isInteger(response.context.mappingRevision) && response.context.mappingRevision >= 1 && response.context.mappingRevision <= 1024
            && Number.isInteger(response.context.scopeRevision) && response.context.scopeRevision >= 1
            && response.context.scopeRevision <= response.context.mappingRevision
            && response.review?.pageIndex === index && response.review.pageSize === size
            && typeof response.review.planDigest === 'string' && /^[a-f0-9]{64}$/.test(response.review.planDigest)
            && response.review.executeDisabled === true
            && response.review.executionReasonCode === 'article_package_import_authority_unavailable';
    }

    const controller = useArticlePackageCandidateReview(async (request, signal) =>
    {
        const current = intent;
        const expected = observed;
        const captured = version;
        if (!current || !expected || disposed)
        {
            throw new Error('article_package_candidate_review_context_unavailable');
        }
        const response = await read(Object.freeze({ ...current, requestId: request.requestId,
            pageIndex: request.pageIndex, pageSize: request.pageSize,
            expectedPlanDigest: request.planDigest, expectedContext: expected }), signal);
        if (signal.aborted || captured !== version || !validResponse(response, request.requestId, request.pageIndex, request.pageSize)
            || !sameContext(response.context, expected) || response.review.planDigest !== request.planDigest)
        {
            throw new Error('article_package_candidate_review_plan_stale');
        }
        return response.review;
    });

    async function seed(value: ArticlePackageCandidateReadIntent, requestId: string): Promise<boolean>
    {
        if (disposed)
        {
            return false;
        }
        const captured = {};
        version = captured;
        initial?.abort();
        initial = null;
        intent = null;
        observed = null;
        initialState.value = 'ready';
        await controller.setReview(null);
        if (disposed || captured !== version)
        {
            return false;
        }
        if (!requestId.trim() || requestId.length > 128 || !Number.isSafeInteger(value.pageSize) || value.pageSize < 1 || value.pageSize > 50)
        {
            initialState.value = 'error';
            return false;
        }
        const owned = Object.freeze({ archiveBytes: value.archiveBytes, requestedMode: value.requestedMode,
            callerPolicyDigest: value.callerPolicyDigest, callerPermissionContextDigest: value.callerPermissionContextDigest,
            createdAtUtc: value.createdAtUtc, expiresAtUtc: value.expiresAtUtc, pageSize: value.pageSize,
            requestedTargets: value.requestedTargets ? Object.freeze(value.requestedTargets.map(target => Object.freeze({
                portableArticle: target.portableArticle, requestedTargetArticleId: target.requestedTargetArticleId,
                expectedTargetRevision: target.expectedTargetRevision }))) : null });
        const operation = new AbortController();
        initial = operation;
        initialState.value = 'loading';
        let finishAbort!: () => void;
        const aborted = new Promise<undefined>(resolve =>
        {
            finishAbort = () => resolve(undefined);
            operation.signal.addEventListener('abort', finishAbort, { once: true });
        });
        try
        {
            const response = await Promise.race([read(Object.freeze({ ...owned, requestId, pageIndex: 0,
                expectedPlanDigest: null, expectedContext: null }), operation.signal), aborted]);
            if (operation.signal.aborted || captured !== version || disposed)
            {
                return false;
            }
            if (!response || !validResponse(response, requestId, 0, owned.pageSize))
            {
                throw new Error('article_package_candidate_review_read_invalid');
            }
            intent = owned;
            observed = Object.freeze({ identity: response.context.identity, lifecycleVersion: response.context.lifecycleVersion,
                generation: response.context.generation, mappingRevision: response.context.mappingRevision, scopeRevision: response.context.scopeRevision });
            await controller.setReview(response.review);
            return !disposed && captured === version;
        }
        catch
        {
            if (captured === version && !operation.signal.aborted && !disposed)
            {
                intent = null;
                observed = null;
                initialState.value = 'error';
            }
            return false;
        }
        finally
        {
            operation.signal.removeEventListener('abort', finishAbort);
            if (initial === operation)
            {
                initial = null;
                if (initialState.value === 'loading')
                {
                    initialState.value = 'ready';
                }
            }
        }
    }

    async function clear(): Promise<void>
    {
        version = {};
        initial?.abort();
        initial = null;
        intent = null;
        observed = null;
        initialState.value = 'ready';
        await controller.setReview(null);
    }

    function dispose(): void
    {
        disposed = true;
        version = {};
        initial?.abort();
        initial = null;
        intent = null;
        observed = null;
        controller.dispose();
        initialState.value = 'ready';
    }

    if (getCurrentScope())
    {
        onScopeDispose(dispose);
    }
    return {
        review: controller.review,
        state: computed(() => initialState.value === 'ready' ? controller.state.value : initialState.value),
        pageCompletion: controller.pageCompletion,
        pendingRequest: controller.pendingRequest,
        requestPage: controller.requestPage,
        cancel: controller.cancel,
        seed,
        clear,
        dispose
    };
}
