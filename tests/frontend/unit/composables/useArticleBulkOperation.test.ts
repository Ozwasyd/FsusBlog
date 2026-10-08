// @vitest-environment happy-dom

import { effectScope } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useArticleBulkOperation } from '@/composables/useArticleBulkOperation';
import type {
    ArticleBulkGateway,
    ArticleBulkItemPage,
    ArticleBulkOperationOption,
    ArticleBulkPlanSummary,
    ArticleBulkResultSummary,
    ArticleBulkSelectionSummary
} from '@/services/authoring/articleBulkPresentation';

const digest = (letter: string): string => `sha256:${letter.repeat(64)}`;
const now = Date.parse('2026-10-08T06:00:00Z');
const selection: ArticleBulkSelectionSummary = { reference: 'selection:one', digest: digest('a'), kind: 'current-page', count: 10_000 };
const operation: ArticleBulkOperationOption = { id: 'tag.add', label: '添加标签', strategy: 'per-item-isolated', registryDigest: digest('b'), available: true, parameters: [] };
const makePlan = (): ArticleBulkPlanSummary => ({
    reference: 'plan:one', digest: digest('c'), registryDigest: digest('b'), operationId: operation.id,
    operationLabel: operation.label, strategy: operation.strategy, selection: { ...selection },
    selectedCount: selection.count, eligibleCount: selection.count, blockedCount: 0, conflictCount: 0,
    executable: true, expiresAtUtc: '2026-10-08T06:30:00Z', proposedChange: '添加所选标签', impactPageReference: 'impact:first'
});
const makeResult = (): ArticleBulkResultSummary => ({
    executionReference: 'attempt:one', planDigest: digest('c'), receiptReference: 'receipt:one', receiptDigest: digest('d'),
    strategy: operation.strategy, state: 'partial', selectedCount: 10_000, eligibleCount: 10_000,
    succeededCount: 9999, failedCount: 1, cancelledCount: 0, blockedCount: 0, notExecutedCount: 0,
    commitOutcome: null, itemPageReference: 'items:first'
});
const scopes: ReturnType<typeof effectScope>[] = [];

function fixture() {
    const gateway: ArticleBulkGateway = {
        createPlan: vi.fn(async () => makePlan()), execute: vi.fn(async () => makeResult()),
        readExecution: vi.fn(async () => makeResult()), readExecutionByIdempotency: vi.fn(async () => makeResult()), cancel: vi.fn(async () => makeResult()),
        readResultPage: vi.fn(async reference => ({
            planDigest: digest('c'), receiptDigest: digest('d'), reference, nextReference: 'items:next',
            items: [{ articleIdentity: 'article:failed', receiptReference: 'item:failed', outcome: 'revision-conflict', reason: '版本已变化', retryEligible: true }]
        })),
        readImpactPage: vi.fn(async reference => ({ planDigest: digest('c'), reference, items: [], nextReference: null })),
        retry: vi.fn(async () => ({ ...makePlan(), reference: 'plan:retry', digest: digest('e'), selectedCount: 1,
            eligibleCount: 1, selection: { reference: 'selection:retry', digest: digest('f'), count: 1, kind: 'explicit' } })),
        downloadReceipt: vi.fn(async () => new Blob(['test protocol export'], { type: 'application/json' }))
    };
    let clock = now;
    const scope = effectScope();
    scopes.push(scope);
    const model = scope.run(() => useArticleBulkOperation(gateway, () => clock))!;
    model.setSelection(selection);
    return { model, gateway, advance: (milliseconds: number) => { clock += milliseconds; } };
}

afterEach(() => {
    scopes.splice(0).forEach(scope => scope.stop());
    vi.useRealTimers();
});

describe('frozen article bulk UI protocol', () => {
    it('executes the exact confirmed plan reference without IDs, parameters or a second query', async () => {
        const { model, gateway } = fixture();
        await model.preview(operation, { tagId: 'tag:stable' });
        await model.executeConfirmed();
        expect(gateway.createPlan).toHaveBeenCalledTimes(1);
        expect(gateway.execute).toHaveBeenCalledTimes(1);
        expect(vi.mocked(gateway.execute).mock.calls[0]![0]).toEqual({
            planReference: 'plan:one', planDigest: digest('c'), idempotencyKey: expect.any(String)
        });
        expect(model.phase.value).toBe('results');
        expect(model.result.value?.state).toBe('partial');
        await expect(model.executeConfirmed()).rejects.toThrow('confirmation-required');
        expect(gateway.execute).toHaveBeenCalledTimes(1);
    });

    it('freezes parameter arrays before awaited transport consumption', async () => {
        const { model, gateway } = fixture();
        const values = ['check:one'];
        await model.preview(operation, { checkIds: values });
        values.push('check:unconfirmed');
        expect(vi.mocked(gateway.createPlan).mock.calls[0]![0].parameters.checkIds).toEqual(['check:one']);
    });

    it('discarded preview responses cannot replace a changed exact selection', async () => {
        const { model, gateway } = fixture();
        let resolve!: (value: ArticleBulkPlanSummary) => void;
        vi.mocked(gateway.createPlan).mockImplementation(() => new Promise(done => { resolve = done; }));
        const preview = model.preview(operation, {});
        model.setSelection({ ...selection, reference: 'selection:two', digest: digest('e'), count: 1 });
        resolve(makePlan());
        await preview;
        expect(model.plan.value).toBeNull();
        expect(model.selection.value?.count).toBe(1);
        expect(gateway.execute).not.toHaveBeenCalled();
    });

    it('expiry requires a new preview and never silently refreshes', async () => {
        const { model, gateway, advance } = fixture();
        await model.preview(operation, {});
        advance(31 * 60_000);
        await expect(model.executeConfirmed()).rejects.toThrow('plan-expired');
        expect(model.phase.value).toBe('stale');
        expect(gateway.execute).not.toHaveBeenCalled();
        expect(gateway.createPlan).toHaveBeenCalledTimes(1);
    });

    it('unknown HTTP outcomes block resubmission and do not expose private exception text', async () => {
        const { model, gateway } = fixture();
        vi.mocked(gateway.execute).mockRejectedValue(new Error('private title and property value'));
        await model.preview(operation, {});
        await model.executeConfirmed();
        expect(model.phase.value).toBe('recovery-required');
        expect(model.errorCode.value).toBe('article-bulk.execution-conclusion-unknown');
        await expect(model.executeConfirmed()).rejects.toThrow();
        expect(() => model.setSelection(selection)).toThrow('selection-locked');
        expect(gateway.execute).toHaveBeenCalledTimes(1);
    });

    it('recovers a lost response with a read-only idempotency lookup, never a second execution', async () => {
        const { model, gateway } = fixture();
        vi.mocked(gateway.execute).mockRejectedValue(new Error('connection lost'));
        await model.preview(operation, {});
        await model.executeConfirmed();
        vi.mocked(gateway.readExecutionByIdempotency).mockRejectedValueOnce(new Error('still unavailable'));
        await model.recoverExecution();
        expect(model.phase.value).toBe('recovery-required');
        await model.recoverExecution();
        expect(gateway.readExecutionByIdempotency).toHaveBeenCalledWith(vi.mocked(gateway.execute).mock.calls[0]![0]);
        expect(model.phase.value).toBe('results');
        expect(gateway.execute).toHaveBeenCalledTimes(1);
    });

    it('rejects strategy drift, atomic partial and summary-only success', async () => {
        const { model, gateway } = fixture();
        vi.mocked(gateway.createPlan).mockResolvedValue({ ...makePlan(), strategy: 'all-or-nothing' });
        await model.preview(operation, {});
        expect(model.phase.value).toBe('error');
        expect(gateway.execute).not.toHaveBeenCalled();
        vi.mocked(gateway.createPlan).mockResolvedValue(makePlan());
        await model.preview(operation, {});
        vi.mocked(gateway.execute).mockResolvedValue({ ...makeResult(), state: 'completed' });
        await model.executeConfirmed();
        expect(model.phase.value).toBe('recovery-required');
    });

    it('loads one bounded results page, rejects oversized data and retries exact failed receipt only', async () => {
        const { model, gateway } = fixture();
        await model.preview(operation, {});
        await model.executeConfirmed();
        await model.loadResultPage('items:first');
        expect(gateway.readResultPage).toHaveBeenCalledTimes(1);
        const original = model.result.value!.receiptDigest;
        await model.retryExact(['item:failed'], 'revision-policy:explicit');
        expect(gateway.retry).toHaveBeenCalledWith({ executionReference: 'attempt:one', planDigest: digest('c'),
            itemReceiptReferences: ['item:failed'], expectedRevisionPolicyReference: 'revision-policy:explicit' });
        expect(model.phase.value).toBe('ready');
        expect(model.result.value!.receiptDigest).toBe(original);
        expect(gateway.execute).toHaveBeenCalledTimes(1);
    });

    it('failed retry preview preserves the original receipts and permits another preview', async () => {
        const { model, gateway } = fixture();
        await model.preview(operation, {});
        await model.executeConfirmed();
        await model.loadResultPage('items:first');
        vi.mocked(gateway.retry).mockRejectedValueOnce(new Error('private article data'));
        await model.retryExact(['item:failed'], 'revision-policy:explicit');
        expect(model.phase.value).toBe('results');
        expect(model.errorCode.value).toBe('article-bulk.retry-preview-failed');
        expect(model.result.value?.receiptDigest).toBe(digest('d'));
        await model.retryExact(['item:failed'], 'revision-policy:explicit');
        expect(model.phase.value).toBe('ready');
        expect(gateway.execute).toHaveBeenCalledTimes(1);
    });

    it('freezes exact retry receipts and ignores a late retry plan after the selection changes', async () => {
        const { model, gateway } = fixture();
        await model.preview(operation, {});
        await model.executeConfirmed();
        await model.loadResultPage('items:first');
        let resolve!: (value: ArticleBulkPlanSummary) => void;
        vi.mocked(gateway.retry).mockImplementation(() => new Promise(done => { resolve = done; }));
        const references = ['item:failed'];
        const retry = model.retryExact(references, 'revision-policy:explicit');
        references.push('item:unconfirmed');
        expect(vi.mocked(gateway.retry).mock.calls[0]![0].itemReceiptReferences).toEqual(['item:failed']);
        model.setSelection({ ...selection, count: 1, reference: 'selection:changed' });
        resolve(makePlan());
        await retry;
        expect(model.phase.value).toBe('idle');
        expect(model.plan.value).toBeNull();
    });

    it('rejects retry successes and missing explicit revision policy', async () => {
        const { model, gateway } = fixture();
        await model.preview(operation, {});
        await model.executeConfirmed();
        await model.loadResultPage('items:first');
        await expect(model.retryExact(['item:success'], 'revision-policy:explicit')).rejects.toThrow('retry-not-eligible');
        await expect(model.retryExact(['item:failed'], '')).rejects.toThrow('retry-not-eligible');
        expect(gateway.retry).not.toHaveBeenCalled();
    });

    it('refuses an unbounded page and receipt/plan tamper before rendering', async () => {
        const { model, gateway } = fixture();
        await model.preview(operation, {});
        await model.executeConfirmed();
        const items: ArticleBulkItemPage['items'] = Array.from({ length: 51 }, (_, index) => ({
            articleIdentity: `article:${index}`, receiptReference: `item:${index}`, outcome: 'success', reason: '成功', retryEligible: false
        }));
        vi.mocked(gateway.readResultPage).mockResolvedValue({ planDigest: digest('c'), receiptDigest: digest('d'), reference: 'items:first', nextReference: null, items });
        await expect(model.loadResultPage('items:first')).rejects.toThrow('result-page-inexact');
        expect(model.resultPage.value).toBeNull();
    });

    it('cancels through the canonical execution reference and reads terminal progress', async () => {
        const { model, gateway } = fixture();
        vi.mocked(gateway.execute).mockResolvedValue({ executionReference: 'attempt:one', planDigest: digest('c'), strategy: operation.strategy,
            state: 'executing', selectedCount: 10_000, eligibleCount: 10_000, succeededCount: 5, failedCount: 0, cancelledCount: 0, cancelAllowed: true });
        await model.preview(operation, {});
        await model.executeConfirmed();
        expect(model.phase.value).toBe('executing');
        await model.cancel();
        expect(gateway.cancel).toHaveBeenCalledWith('attempt:one');
        expect(model.phase.value).toBe('results');
        expect(gateway.execute).toHaveBeenCalledTimes(1);
    });
});
