// @vitest-environment happy-dom
import { effectScope } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useArticleBulkOperation } from '@/composables/useArticleBulkOperation';
import type { ArticleBulkGateway, ArticleBulkOperationOption, ArticleBulkPlanSummary } from '@/services/authoring/articleBulkPresentation';

const plan: ArticleBulkPlanSummary = {
    reference: 'plan:first', digest: 'sha256:first', registryDigest: 'sha256:registry', operationId: 'tag.add', operationLabel: '添加标签',
    strategy: 'per-item-isolated', selection: { reference: 'selection:exact', digest: 'sha256:selection', kind: 'query', count: 100 },
    selectedCount: 100, eligibleCount: 100, blockedCount: 0, conflictCount: 0, executable: true,
    expiresAtUtc: '2026-10-09T20:00:00Z', proposedChange: '添加已确认标签', impactPageReference: 'impact:first'
};
const operation: ArticleBulkOperationOption = { id: plan.operationId, label: plan.operationLabel, strategy: plan.strategy,
    registryDigest: plan.registryDigest, available: true, parameters: [] };
const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()));
function fixture() {
    const gateway: ArticleBulkGateway = {
        createPlan: vi.fn(async () => plan),
        execute: vi.fn(async () => ({ executionReference: 'execution:exact', planDigest: plan.digest, strategy: plan.strategy,
            state: 'executing' as const, selectedCount: 100, eligibleCount: 100, succeededCount: 0, failedCount: 0, cancelledCount: 0, cancelAllowed: true })),
        readExecution: vi.fn(), readExecutionByIdempotency: vi.fn(), cancel: vi.fn(), readResultPage: vi.fn(),
        readImpactPage: vi.fn(), retry: vi.fn(), downloadReceipt: vi.fn()
    };
    const scope = effectScope(); scopes.push(scope);
    const model = scope.run(() => useArticleBulkOperation(gateway, () => Date.parse('2026-10-08T12:00:00Z')))!;
    model.setSelection(plan.selection);
    return { model, gateway };
}

describe('current displayed-plan confirmation boundaries', () => {
    it('rejects a stale displayed preview after another plan is bound without executing either candidate', async () => {
        const { model, gateway } = fixture();
        await model.preview(operation, { tagId: 'tag:first' });
        const displayed = { planReference: plan.reference, planDigest: plan.digest };
        vi.mocked(gateway.createPlan).mockResolvedValue({ ...plan, reference: 'plan:second', digest: 'sha256:second' });
        await model.preview(operation, { tagId: 'tag:second' });
        await expect(model.executeConfirmed(displayed)).rejects.toThrow('confirmation-plan-mismatch');
        expect(model.phase.value).toBe('ready'); expect(gateway.execute).not.toHaveBeenCalled();
    });
    it.each(['permission-changed', 'revision-changed', 'parameters-changed'] as const)(
        '%s requires explicit replanning and never automatically refreshes', async reason => {
            const { model, gateway } = fixture(); await model.preview(operation, {});
            model.invalidatePlan(plan.digest, reason);
            await expect(model.executeConfirmed({ planReference: plan.reference, planDigest: plan.digest })).rejects.toThrow('confirmation-required');
            expect(model.phase.value).toBe('stale'); expect(model.errorCode.value).toBe(`article-bulk.${reason}`);
            expect(gateway.execute).not.toHaveBeenCalled(); expect(gateway.createPlan).toHaveBeenCalledTimes(1);
        });
    it('refuses an invalidation for another frozen plan', async () => {
        const { model } = fixture(); await model.preview(operation, {});
        expect(() => model.invalidatePlan('sha256:foreign', 'permission-changed')).toThrow('invalidation-unbound');
        expect(model.phase.value).toBe('ready');
    });
    it('does not pretend that invalidation cancels an admitted command', async () => {
        const { model, gateway } = fixture(); await model.preview(operation, {});
        await model.executeConfirmed({ planReference: plan.reference, planDigest: plan.digest });
        model.invalidatePlan(plan.digest, 'permission-changed');
        expect(model.phase.value).toBe('executing'); expect(model.progress.value?.executionReference).toBe('execution:exact');
        expect(gateway.cancel).not.toHaveBeenCalled(); expect(gateway.execute).toHaveBeenCalledTimes(1);
    });
    it('treats atomic preparation success counts as an untrusted observation rather than partial completion', async () => {
        const { model, gateway } = fixture();
        const atomicPlan = { ...plan, strategy: 'all-or-nothing' as const };
        vi.mocked(gateway.createPlan).mockResolvedValue(atomicPlan);
        vi.mocked(gateway.execute).mockResolvedValue({ executionReference: 'execution:atomic', planDigest: plan.digest,
            strategy: 'all-or-nothing', state: 'executing', selectedCount: 100, eligibleCount: 100, succeededCount: 100,
            failedCount: 0, cancelledCount: 0, cancelAllowed: false });
        await model.preview({ ...operation, strategy: 'all-or-nothing' }, {});
        await model.executeConfirmed({ planReference: plan.reference, planDigest: plan.digest });
        expect(model.phase.value).toBe('recovery-required'); expect(model.progress.value).toBeNull();
        expect(gateway.execute).toHaveBeenCalledTimes(1);
    });
    it('ignores a pending old preview after input changes and requires another explicit preview', async () => {
        const { model, gateway } = fixture();
        let finish!: (value: ArticleBulkPlanSummary) => void;
        vi.mocked(gateway.createPlan).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const pending = model.preview(operation, { tagId: 'old' });
        model.invalidateInputs('parameters-changed'); finish(plan); await pending;
        expect(model.plan.value).toBeNull(); expect(model.phase.value).toBe('stale');
        expect(gateway.createPlan).toHaveBeenCalledTimes(1); expect(gateway.execute).not.toHaveBeenCalled();
    });
    it('limits impact reads to one in-flight cursor request and releases the slot after failure', async () => {
        const { model, gateway } = fixture(); await model.preview(operation, {});
        let fail!: (reason: Error) => void;
        vi.mocked(gateway.readImpactPage).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
        const pending = model.loadImpactPage('impact:first');
        await expect(model.loadImpactPage('impact:second')).rejects.toThrow('impact-page-pending');
        expect(gateway.readImpactPage).toHaveBeenCalledTimes(1);
        fail(new Error('transport unavailable')); await expect(pending).rejects.toThrow('transport unavailable');
        vi.mocked(gateway.readImpactPage).mockResolvedValue({ reference: 'impact:first', planDigest: plan.digest, items: [], nextReference: null });
        await model.loadImpactPage('impact:first'); expect(gateway.readImpactPage).toHaveBeenCalledTimes(2);
    });
    it('keeps only one result page request active without firing a next-page loop', async () => {
        const { model, gateway } = fixture(); await model.preview(operation, {});
        vi.mocked(gateway.execute).mockResolvedValue({ executionReference: 'execution:exact', planDigest: plan.digest,
            receiptReference: 'receipt:exact', receiptDigest: 'sha256:receipt', strategy: plan.strategy, state: 'partial',
            selectedCount: 100, eligibleCount: 100, succeededCount: 99, failedCount: 1, cancelledCount: 0,
            blockedCount: 0, notExecutedCount: 0, commitOutcome: null, itemPageReference: 'items:first' });
        await model.executeConfirmed({ planReference: plan.reference, planDigest: plan.digest });
        let finish!: (value: Awaited<ReturnType<ArticleBulkGateway['readResultPage']>>) => void;
        vi.mocked(gateway.readResultPage).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const pending = model.loadResultPage('items:first');
        await expect(model.loadResultPage('items:second')).rejects.toThrow('result-page-pending');
        finish({ reference: 'items:first', planDigest: plan.digest, receiptDigest: 'sha256:receipt', items: [], nextReference: 'items:second' });
        await pending; expect(gateway.readResultPage).toHaveBeenCalledTimes(1);
        expect(model.resultPage.value?.reference).toBe('items:first'); expect(gateway.execute).toHaveBeenCalledTimes(1);
    });

});
