import { onScopeDispose, readonly, shallowRef } from 'vue';

import {
    articleBulkSelectionLabel,
    articleBulkStrategyLabel,
    validateArticleBulkResult,
    type ArticleBulkGateway,
    type ArticleBulkImpactPage,
    type ArticleBulkExecutionObservation,
    type ArticleBulkItemPage,
    type ArticleBulkOperationOption,
    type ArticleBulkPlanSummary,
    type ArticleBulkProgress,
    type ArticleBulkResultSummary,
    type ArticleBulkSelectionSummary
} from '@/services/authoring/articleBulkPresentation';

/** Owns UI confirmation of canonical plans; the gateway owns all queries, mutations and receipts. */
export function useArticleBulkOperation(gateway: ArticleBulkGateway, now: () => number = Date.now)
{
    const phase = shallowRef<'idle' | 'previewing' | 'ready' | 'executing' | 'results' | 'stale' | 'recovery-required' | 'error'>('idle');
    const selection = shallowRef<ArticleBulkSelectionSummary | null>(null);
    const plan = shallowRef<ArticleBulkPlanSummary | null>(null);
    const result = shallowRef<ArticleBulkResultSummary | null>(null);
    const resultPage = shallowRef<ArticleBulkItemPage | null>(null);
    const impactPage = shallowRef<ArticleBulkImpactPage | null>(null);
    const progress = shallowRef<ArticleBulkProgress | null>(null);
    const errorCode = shallowRef<string | null>(null);
    let generation = 0;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    let executionKey: string | null = null;

    function clearExpiry(): void
    {
        clearTimeout(expiryTimer);
        expiryTimer = undefined;
    }

    function setSelection(value: ArticleBulkSelectionSummary | null): void
    {
        if (phase.value === 'executing' || phase.value === 'recovery-required')
        {
            throw new Error('article-bulk.selection-locked');
        }
        if (value)
        {
            articleBulkSelectionLabel(value.kind);
            if (!Number.isSafeInteger(value.count) || value.count < 0 || value.count > 10_000 || !value.reference || !value.digest)
            {
                throw new Error('article-bulk.selection-invalid');
            }
        }
        generation++;
        clearExpiry();
        selection.value = value ? Object.freeze({ ...value }) : null;
        plan.value = null;
        result.value = null;
        resultPage.value = null;
        impactPage.value = null;
        progress.value = null;
        executionKey = null;
        errorCode.value = null;
        phase.value = 'idle';
    }

    function bindPlan(value: ArticleBulkPlanSummary, expected: ArticleBulkSelectionSummary): void
    {
        articleBulkStrategyLabel(value.strategy);
        const counts = [value.selectedCount, value.eligibleCount, value.blockedCount, value.conflictCount];
        if (counts.some(count => !Number.isSafeInteger(count) || count < 0 || count > 10_000)
            || value.selectedCount !== expected.count || value.selection.reference !== expected.reference
            || value.selection.digest !== expected.digest || value.selection.kind !== expected.kind || value.selection.count !== expected.count
            || value.eligibleCount + value.blockedCount !== value.selectedCount
            || value.executable && (value.eligibleCount === 0
                || value.strategy === 'all-or-nothing' && value.blockedCount !== 0)
            || !value.reference || !value.digest || !value.impactPageReference
            || !Number.isFinite(Date.parse(value.expiresAtUtc)))
        {
            throw new Error('article-bulk.plan-inexact');
        }
        plan.value = Object.freeze({ ...value, selection: Object.freeze({ ...value.selection }) });
        executionKey = crypto.randomUUID();
        clearExpiry();
        const expiresIn = Date.parse(value.expiresAtUtc) - now();
        phase.value = expiresIn <= 0 ? 'stale' : 'ready';
        if (expiresIn > 0)
        {
            expiryTimer = setTimeout(() =>
            {
                if (phase.value === 'ready')
                {
                    phase.value = 'stale';
                }
            }, Math.min(expiresIn, 2_147_483_647));
        }
    }

    async function preview(operation: ArticleBulkOperationOption, parameters: Readonly<Record<string, string | readonly string[]>>): Promise<void>
    {
        const frozenSelection = selection.value;
        if (!frozenSelection || frozenSelection.count === 0 || !operation.available
            || phase.value === 'executing' || phase.value === 'recovery-required')
        {
            throw new Error('article-bulk.preview-unavailable');
        }
        const currentGeneration = ++generation;
        clearExpiry();
        plan.value = null;
        result.value = null;
        resultPage.value = null;
        impactPage.value = null;
        errorCode.value = null;
        phase.value = 'previewing';
        try
        {
            const value = await gateway.createPlan({
                selectionReference: frozenSelection.reference,
                selectionDigest: frozenSelection.digest,
                operationId: operation.id,
                registryDigest: operation.registryDigest,
                parameters: Object.freeze(Object.fromEntries(Object.entries(parameters).map(([key, value]) =>
                    [key, typeof value === 'string' ? value : Object.freeze([...value])])))
            });
            if (currentGeneration !== generation)
            {
                return;
            }
            if (value.operationId !== operation.id || value.registryDigest !== operation.registryDigest
                || value.strategy !== operation.strategy)
            {
                throw new Error('article-bulk.operation-drift');
            }
            bindPlan(value, frozenSelection);
        }
        catch
        {
            if (currentGeneration !== generation)
            {
                return;
            }
            errorCode.value = 'article-bulk.preview-failed';
            phase.value = 'error';
        }
    }

    async function executeConfirmed(): Promise<void>
    {
        const confirmed = plan.value;
        if (phase.value !== 'ready' || !confirmed?.executable || !executionKey)
        {
            throw new Error('article-bulk.confirmation-required');
        }
        if (Date.parse(confirmed.expiresAtUtc) <= now())
        {
            phase.value = 'stale';
            throw new Error('article-bulk.plan-expired');
        }
        phase.value = 'executing';
        result.value = null;
        resultPage.value = null;
        clearExpiry();
        try
        {
            const value = await gateway.execute({
                planReference: confirmed.reference,
                planDigest: confirmed.digest,
                idempotencyKey: executionKey
            });
            bindObservation(value, confirmed);
        }
        catch
        {
            // A lost HTTP response is not a business failure or permission to issue another command.
            errorCode.value = 'article-bulk.execution-conclusion-unknown';
            phase.value = 'recovery-required';
        }
    }

    function bindObservation(value: ArticleBulkExecutionObservation, confirmed: ArticleBulkPlanSummary): void
    {
        if ('cancelAllowed' in value)
        {
            const counts = [value.selectedCount, value.eligibleCount, value.succeededCount, value.failedCount, value.cancelledCount];
            if (!['executing', 'cancelling'].includes(value.state) || value.planDigest !== confirmed.digest || value.strategy !== confirmed.strategy
                || value.selectedCount !== confirmed.selectedCount || value.eligibleCount !== confirmed.eligibleCount
                || !value.executionReference || counts.some(count => !Number.isSafeInteger(count) || count < 0 || count > 10_000)
                || typeof value.cancelAllowed !== 'boolean'
                || value.succeededCount + value.failedCount + value.cancelledCount > value.eligibleCount
                || value.strategy === 'all-or-nothing' && value.succeededCount > 0 && value.succeededCount !== value.eligibleCount)
            {
                throw new Error('article-bulk.progress-inexact');
            }
            progress.value = Object.freeze({ ...value });
            phase.value = 'executing';
            return;
        }
        validateArticleBulkResult(value, confirmed);
        result.value = Object.freeze({ ...value });
        progress.value = null;
        phase.value = value.state === 'recovery-required' ? 'recovery-required' : 'results';
    }

    async function refreshProgress(): Promise<void>
    {
        const current = progress.value;
        const confirmed = plan.value;
        if (!current || !confirmed)
        {
            throw new Error('article-bulk.progress-unavailable');
        }
        const value = await gateway.readExecution(current.executionReference);
        if (plan.value?.digest !== confirmed.digest || progress.value?.executionReference !== current.executionReference)
        {
            return;
        }
        bindObservation(value, confirmed);
    }

    async function recoverExecution(): Promise<void>
    {
        const confirmed = plan.value;
        if (phase.value !== 'recovery-required' || !confirmed || !executionKey)
        {
            throw new Error('article-bulk.recovery-unavailable');
        }
        try
        {
            const value = await gateway.readExecutionByIdempotency({
                planReference: confirmed.reference, planDigest: confirmed.digest, idempotencyKey: executionKey
            });
            bindObservation(value, confirmed);
            errorCode.value = null;
        }
        catch
        {
            errorCode.value = 'article-bulk.execution-conclusion-unknown';
        }
    }

    async function loadResultPage(reference: string): Promise<void>
    {
        const current = result.value;
        if (!current || !reference)
        {
            throw new Error('article-bulk.results-unavailable');
        }
        const currentGeneration = generation;
        const page = await gateway.readResultPage(reference);
        if (currentGeneration !== generation || result.value?.receiptDigest !== current.receiptDigest)
        {
            return;
        }
        if (page.planDigest !== current.planDigest || page.receiptDigest !== current.receiptDigest
            || page.reference !== reference || page.items.length > 50
            || new Set(page.items.map(item => item.receiptReference)).size !== page.items.length)
        {
            throw new Error('article-bulk.result-page-inexact');
        }
        resultPage.value = Object.freeze({ ...page, items: Object.freeze(page.items.map(item => Object.freeze({ ...item }))) });
    }

    async function loadImpactPage(reference: string): Promise<void>
    {
        const confirmed = plan.value;
        if (!confirmed || !reference)
        {
            throw new Error('article-bulk.impact-unavailable');
        }
        const currentGeneration = generation;
        const page = await gateway.readImpactPage(reference);
        if (currentGeneration !== generation || plan.value?.digest !== confirmed.digest)
        {
            return;
        }
        if (page.planDigest !== confirmed.digest || page.reference !== reference || page.items.length > 50
            || new Set(page.items.map(item => item.articleIdentity)).size !== page.items.length)
        {
            throw new Error('article-bulk.impact-page-inexact');
        }
        impactPage.value = Object.freeze({ ...page, items: Object.freeze(page.items.map(item => Object.freeze({ ...item }))) });
    }

    async function cancel(): Promise<void>
    {
        const current = progress.value;
        const confirmed = plan.value;
        if (!current?.cancelAllowed || !confirmed)
        {
            throw new Error('article-bulk.cancel-reference-required');
        }
        const value = await gateway.cancel(current.executionReference);
        if (plan.value?.digest !== confirmed.digest || progress.value?.executionReference !== current.executionReference)
        {
            return;
        }
        bindObservation(value, confirmed);
        resultPage.value = null;
    }

    async function retryExact(itemReceiptReferences: readonly string[], expectedRevisionPolicyReference: string): Promise<void>
    {
        const current = result.value;
        const previousPlan = plan.value;
        const page = resultPage.value;
        if (phase.value !== 'results' || !current || !previousPlan || !page
            || current.strategy !== 'per-item-isolated' || !expectedRevisionPolicyReference
            || itemReceiptReferences.length === 0 || itemReceiptReferences.length > 50
            || new Set(itemReceiptReferences).size !== itemReceiptReferences.length
            || itemReceiptReferences.some(reference => !page.items.some(item => item.receiptReference === reference
                && item.retryEligible && item.outcome !== 'success')))
        {
            throw new Error('article-bulk.retry-not-eligible');
        }
        const currentGeneration = ++generation;
        const exactReceipts = Object.freeze([...itemReceiptReferences]);
        phase.value = 'previewing';
        errorCode.value = null;
        try
        {
            const value = await gateway.retry({
                executionReference: current.executionReference,
                planDigest: current.planDigest,
                itemReceiptReferences: exactReceipts,
                expectedRevisionPolicyReference
            });
            if (currentGeneration !== generation)
            {
                return;
            }
            if (value.operationId !== previousPlan.operationId || value.strategy !== previousPlan.strategy
                || value.registryDigest !== previousPlan.registryDigest || value.digest === previousPlan.digest
                || value.selectedCount !== exactReceipts.length)
            {
                throw new Error('article-bulk.retry-plan-inexact');
            }
            bindPlan(value, value.selection);
            resultPage.value = null;
            impactPage.value = null;
        }
        catch
        {
            if (currentGeneration !== generation)
            {
                return;
            }
            phase.value = 'results';
            errorCode.value = 'article-bulk.retry-preview-failed';
        }
        // Retain the previous attempt result until the user explicitly confirms the retry plan.
    }

    async function downloadReceipt(): Promise<Blob>
    {
        if (!result.value)
        {
            throw new Error('article-bulk.receipt-unavailable');
        }
        return gateway.downloadReceipt(result.value.receiptReference);
    }

    onScopeDispose(() =>
    {
        generation++;
        clearExpiry();
    });

    return {
        phase: readonly(phase), selection: readonly(selection), plan: readonly(plan),
        result: readonly(result), resultPage: readonly(resultPage), impactPage: readonly(impactPage), progress: readonly(progress), errorCode: readonly(errorCode),
        setSelection, preview, executeConfirmed, loadResultPage, loadImpactPage, cancel, refreshProgress, recoverExecution, retryExact, downloadReceipt
    };
}
