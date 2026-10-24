import { effectScope } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { documentExportCanDownload, documentExportStatusLabel, documentExportCompareVersions, documentExportValidatePresentation } from '@/components/document-export/documentExportUiPort';
import type { DocumentExportPresentation, DocumentExportUiPort } from '@/components/document-export/documentExportUiPort';
import { useDocumentExport } from '@/composables/useDocumentExport';

const disposals: (() => void)[] = [];
afterEach(() => { disposals.splice(0).forEach((dispose) => dispose()); vi.useRealTimers(); });

function view(taskId = 'task', status = 3, version: number | string = 1): DocumentExportPresentation {
    return {
        taskId, status, version, source: 'draft coordinate/version 12', format: 'pdf',
        provider: 'canonical-pdf', options: 'registered-only', inputDigest: 'fixture-input',
        contentDigest: 'fixture-snapshot', reason: '', warnings: null, diagnostic: false, output: null,
    };
}

function createPort(roster = [view()]) {
    const port: DocumentExportUiPort<DocumentExportPresentation, Readonly<{ sourceId: string; formatId: string }>> = {
        catalog: [{ id: 'pdf', label: 'PDF', providerId: 'canonical-pdf', available: true, reason: '', layouts: ['reading'], themes: ['light'], support: [] }],
        sources: [{ id: 'exact-draft-12', label: 'draft coordinate/version 12', private: true }],
        prepareRequest: (selection) => Object.freeze({ sourceId: selection.sourceId, formatId: selection.formatId }),
        captureRequest: (request) => Object.freeze({ ...request }),
        request: vi.fn().mockResolvedValue(view()),
        list: vi.fn(async (offset, limit) => roster.slice(offset, offset + limit)),
        status: vi.fn().mockResolvedValue(view()),
        cancel: vi.fn().mockResolvedValue(view('task', 4, 2)),
        retry: vi.fn().mockResolvedValue(view('task', 1, 2)),
        delete: vi.fn().mockResolvedValue(view('task', 10, 2)),
        download: vi.fn().mockResolvedValue(undefined),
        inspect: (snapshot) => snapshot,
        classifyFailure: (error) => error === 'revoked' ? 'permission-revoked' : 'uncertain',
    };
    const scope = effectScope();
    const center = scope.run(() => useDocumentExport(port))!;
    disposals.push(() => { center.dispose(); scope.stop(); });
    return { port, center };
}

async function open(center: ReturnType<typeof createPort>['center']) {
    center.setOpen(true);
    await center.refresh();
}

describe('one canonical export receipt view', () => {
    it('does not offer retry for a blocked job because the canonical service admits only failed retry', async () => {
        const { center, port } = createPort([view('task', 8)]);
        await open(center);
        center.select('task');
        expect(center.actionAllowed('retry', center.selectedView.value!)).toBe(false);
        await center.act('retry', 'task');
        expect(port.retry).not.toHaveBeenCalled();
    });

    it('coalesces uncertainty reconciliation and keeps new delivery pending', async () => {
        const result = { ...view('task', 6), output: { filename: 'export.pdf', bytes: 4, mediaType: 'application/pdf', expiresAt: '2099-01-01', deleted: false } };
        const { center, port } = createPort([result]);
        let finishStatus!: (snapshot: DocumentExportPresentation) => void;
        let finishDelivery!: () => void;
        port.status = vi.fn(() => new Promise<DocumentExportPresentation>((resolve) => { finishStatus = resolve; }));
        port.download = vi.fn().mockRejectedValueOnce('lost-response').mockImplementationOnce(() => new Promise<void>((resolve) => { finishDelivery = resolve; }));
        await open(center);
        center.select('task');
        await center.act('download', 'task');
        const first = center.reconcile();
        await center.reconcile();
        expect(port.status).toHaveBeenCalledTimes(1);
        expect(center.busy.value).toBe(true);
        await center.act('download', 'task');
        expect(port.download).toHaveBeenCalledTimes(1);
        finishStatus(result);
        await first;
        const delivery = center.act('download', 'task');
        await Promise.resolve();
        expect(center.actionState.value.phase).toBe('pending');
        expect(center.busy.value).toBe(true);
        finishDelivery();
        await delivery;
    });

    it('clears uncertain action identity and ignores reconciliation across identities', async () => {
        const { center, port } = createPort();
        let finishStatus!: (snapshot: DocumentExportPresentation) => void;
        port.cancel = vi.fn().mockRejectedValue('lost-response');
        port.status = vi.fn(() => new Promise<DocumentExportPresentation>((resolve) => { finishStatus = resolve; }));
        await open(center);
        center.select('task');
        await center.act('cancel', 'task');
        const reconciliation = center.reconcile();
        await center.retryAction();
        expect(port.cancel).toHaveBeenCalledTimes(1);
        center.setOpen(false);
        center.changeIdentity();
        await center.reconcile();
        expect(port.status).toHaveBeenCalledTimes(1);
        expect(center.actionName.value).toBe('');
        finishStatus(view('private-old-task', 4, 2));
        await reconciliation;
        expect(center.views.value).toEqual([]);
        expect(center.selectedView.value).toBeNull();
        expect(center.busy.value).toBe(false);
    });

    it('rejects option/source tampering before preparing or submitting any job', async () => {
        const { center, port } = createPort();
        const prepare = vi.spyOn(port, 'prepareRequest');
        await center.submit({ sourceId: 'latest', formatId: 'pdf', layout: 'reading', theme: 'light' });
        await center.submit({ sourceId: 'exact-draft-12', formatId: 'pdf', layout: 'arbitrary-template', theme: 'light' });
        await center.submit({ sourceId: 'exact-draft-12', formatId: 'unknown-format', layout: 'reading', theme: 'light' });
        expect(prepare).not.toHaveBeenCalled();
        expect(port.request).not.toHaveBeenCalled();
        expect(center.submission.value.phase).toBe('rejected');
    });

    it('retains one captured admission identity while an uncertain write is reconciled', async () => {
        const { center, port } = createPort();
        const prepare = vi.spyOn(port, 'prepareRequest');
        port.request = vi.fn().mockRejectedValueOnce('response-lost').mockResolvedValueOnce(view());
        const selection = { sourceId: 'exact-draft-12', formatId: 'pdf', layout: 'reading', theme: 'light' };
        await center.submit(selection);
        selection.sourceId = 'edited-source';
        await center.submit(selection);
        expect(prepare).toHaveBeenCalledTimes(1);
        await center.retrySubmission();
        const calls = vi.mocked(port.request).mock.calls;
        expect(calls).toHaveLength(2);
        expect(calls[1]?.[0]).toBe(calls[0]?.[0]);
        expect(calls[1]?.[0]).toEqual({ sourceId: 'exact-draft-12', formatId: 'pdf' });
    });
    it.each([0, 1, 100, 1000])('bounds the %i task list and reopens without cancelling', async (count) => {
        const { port, center } = createPort(Array.from({ length: count }, (_, index) => view(`task-${index}`)));
        await open(center);
        expect(center.views.value).toHaveLength(Math.min(count, 20));
        expect(port.list).toHaveBeenLastCalledWith(0, 20);
        center.setOpen(false);
        center.setOpen(true);
        await center.refresh();
        expect(port.cancel).not.toHaveBeenCalled();
        if (count >= 100) {
            await center.refresh(20);
            expect(center.views.value[0]?.taskId).toBe('task-20');
        }
    });

    it('uses actual cancelling receipts and rejects older status snapshots', async () => {
        const { center, port } = createPort();
        await open(center);
        center.select('task');
        await center.act('cancel', 'task');
        expect(center.selectedView.value?.status).toBe(4);
        expect(center.selectedView.value?.version).toBe(2);
        await center.act('status', 'task');
        expect(port.status).toHaveBeenCalled();
        expect(center.selectedView.value?.status).toBe(4);
        expect(center.views.value[0]?.status).toBe(4);
    });

    it('retains results until actual deletion and exposes cleanup failure', async () => {
        const result = { ...view('task', 6), output: { filename: 'export.pdf', bytes: 4, mediaType: 'application/pdf', expiresAt: '2099-01-01', deleted: false } };
        const { center, port } = createPort([result]);
        let accept!: (value: DocumentExportPresentation) => void;
        port.delete = vi.fn(() => new Promise<DocumentExportPresentation>((resolve) => { accept = resolve; }));
        await open(center);
        center.select('task');
        const deletion = center.act('delete', 'task');
        await Promise.resolve();
        expect(center.selectedView.value?.output).toEqual(result.output);
        accept({ ...result, status: 10, version: 2, reason: 'cleanup-failed', output: { ...result.output, deleted: true } });
        await deletion;
        expect(center.selectedView.value?.status).toBe(10);
        expect(center.selectedView.value?.output?.deleted).toBe(true);
        expect(center.actionAllowed('download', center.selectedView.value!)).toBe(false);
    });

    it('clears private snapshots and invalidates pending reads after permission revocation', async () => {
        const { center, port } = createPort();
        await open(center);
        center.select('task');
        port.cancel = vi.fn().mockRejectedValue('revoked');
        await center.act('cancel', 'task');
        expect(center.permitted.value).toBe(false);
        expect(center.views.value).toEqual([]);
        expect(center.selectedView.value).toBeNull();
        await center.refresh();
        expect(center.queryFailure.value).toBe('permission-revoked');
    });

    it('rejects oversize pages without allowing result actions', async () => {
        const { center, port } = createPort();
        port.list = vi.fn().mockResolvedValue(Array.from({ length: 1000 }, (_, index) => view(`${index}`)));
        await open(center);
        expect(center.views.value).toEqual([]);
        expect(center.queryFailure.value).toBe('uncertain');
    });

    it('cancels pending byte delivery on identity change without claiming job cancellation', async () => {
        const result = { ...view('task', 6), output: { filename: 'export.pdf', bytes: 4, mediaType: 'application/pdf', expiresAt: '2099-01-01', deleted: false } };
        const { center, port } = createPort([result]);
        let signal!: AbortSignal;
        port.download = vi.fn(async (_id, deliverySignal) => { signal = deliverySignal; });
        await open(center);
        center.select('task');
        await center.act('download', 'task');
        center.changeIdentity();
        expect(signal.aborted).toBe(true);
        expect(port.cancel).not.toHaveBeenCalled();
        expect(center.selectedView.value).toBeNull();
    });

    it.each([1, 2, 3, 4, 5, 7, 8, 9, 10, 999])('never downloads status %i', (status) => {
        const result = { ...view('task', status), output: { filename: 'export.pdf', bytes: 4, mediaType: 'application/pdf', expiresAt: '2099-01-01', deleted: false } };
        expect(documentExportCanDownload(result, Date.now())).toBe(false);
        expect(documentExportCanDownload({ ...result, status: 6, diagnostic: true }, Date.now())).toBe(false);
        expect(documentExportCanDownload({ ...result, status: 6, output: { ...result.output, expiresAt: '2001-01-01' } }, Date.now())).toBe(false);
        expect(documentExportStatusLabel(status)).toBeTruthy();
    });
    it('visits all 1000 receipts with a constant twenty-item window', async () => {
        const { center, port } = createPort(Array.from({ length: 1000 }, (_, index) => view(`task-${index}`, 7)));
        await open(center);
        const seen = new Set<string>();
        for (let offset = 0; offset < 1000; offset += 20) {
            await center.refresh(offset);
            expect(center.views.value).toHaveLength(20);
            center.views.value.forEach((item) => seen.add(item.taskId));
            center.select(`task-${offset}`);
            expect(center.selectedView.value?.taskId).toBe(`task-${offset}`);
        }
        expect(seen.size).toBe(1000);
        await center.refresh(1000);
        expect(center.views.value).toEqual([]);
        expect(center.selectedView.value).toBeNull();
        expect(vi.mocked(port.list).mock.calls.every(([, limit]) => limit === 20)).toBe(true);
        expect(port.request).not.toHaveBeenCalled();
    });

    it('ignores old private list responses across close/reopen and user/site changes', async () => {
        const { center, port } = createPort();
        let finishOld!: (page: readonly DocumentExportPresentation[]) => void;
        port.list = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
            .mockResolvedValue([view('new-context', 7)]);
        center.setOpen(true);
        center.setOpen(false);
        center.changeIdentity();
        center.setOpen(true);
        await Promise.resolve();
        expect(center.views.value[0]?.taskId).toBe('new-context');
        finishOld([view('private-old-context')]);
        await Promise.resolve();
        expect(center.views.value.map((item) => item.taskId)).toEqual(['new-context']);
        expect(center.queryFailure.value).toBe('');
        expect(port.cancel).not.toHaveBeenCalled();
    });

    it('does not let an old denial revoke a newly reopened identity', async () => {
        const { center, port } = createPort();
        let denyOld!: (reason: unknown) => void;
        port.list = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { denyOld = reject; }))
            .mockResolvedValue([view('new-context', 7)]);
        center.setOpen(true);
        center.changeIdentity();
        await Promise.resolve();
        denyOld('revoked');
        await Promise.resolve();
        expect(center.permitted.value).toBe(true);
        expect(center.views.value[0]?.taskId).toBe('new-context');
    });

    it('discards a late admission receipt after identity changes', async () => {
        const { center, port } = createPort();
        let finish!: (snapshot: DocumentExportPresentation) => void;
        port.request = vi.fn(() => new Promise<DocumentExportPresentation>((resolve) => { finish = resolve; }));
        const request = center.submit({ sourceId: 'exact-draft-12', formatId: 'pdf', layout: 'reading', theme: 'light' });
        await Promise.resolve();
        center.changeIdentity();
        finish(view('private-old-admission'));
        await request;
        expect(center.submission.value.phase).toBe('idle');
        expect(center.selectedView.value).toBeNull();
        expect(center.views.value).toEqual([]);
    });

    it('keeps a newer authority receipt when late admission returns and queries the first page', async () => {
        const { center, port } = createPort([view('task', 7, 3)]);
        let finish!: (snapshot: DocumentExportPresentation) => void;
        port.request = vi.fn(() => new Promise<DocumentExportPresentation>((resolve) => { finish = resolve; }));
        await open(center);
        const request = center.submit({ sourceId: 'exact-draft-12', formatId: 'pdf', layout: 'reading', theme: 'light' });
        await Promise.resolve();
        finish(view('task', 1, 1));
        await request;
        expect(center.selectedView.value?.version).toBe(3);
        expect(center.selectedView.value?.status).toBe(7);
        expect(port.list).toHaveBeenLastCalledWith(0, 20);
    });

    it('invalidates a pending cancellation on identity change without claiming cancellation', async () => {
        const { center, port } = createPort();
        let finish!: (snapshot: DocumentExportPresentation) => void;
        port.cancel = vi.fn(() => new Promise<DocumentExportPresentation>((resolve) => { finish = resolve; }));
        await open(center);
        center.select('task');
        const cancellation = center.act('cancel', 'task');
        await Promise.resolve();
        expect(center.selectedView.value?.status).toBe(3);
        center.changeIdentity();
        finish(view('private-old-cancel', 5, 2));
        await cancellation;
        expect(center.selectedView.value).toBeNull();
        expect(center.actionState.value.phase).toBe('idle');
    });

    it('stops polling while closed and queries again when reopened without cancelling', async () => {
        vi.useFakeTimers();
        const { center, port } = createPort();
        await open(center);
        const observed = vi.mocked(port.list).mock.calls.length;
        center.setOpen(false);
        await vi.advanceTimersByTimeAsync(10000);
        expect(port.list).toHaveBeenCalledTimes(observed);
        center.setOpen(true);
        await Promise.resolve();
        expect(port.list).toHaveBeenCalledTimes(observed + 1);
        expect(port.cancel).not.toHaveBeenCalled();
    });

    it('queries the authority at output expiry without manufacturing an expired receipt', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-08T10:00:00Z'));
        const result = { ...view('task', 6), output: { filename: null, bytes: 4, mediaType: 'application/pdf', expiresAt: '2026-10-08T10:00:01Z', deleted: false } };
        const { center, port } = createPort([result]);
        await open(center);
        center.select('task');
        expect(center.actionAllowed('download', center.selectedView.value!)).toBe(true);
        const observed = vi.mocked(port.list).mock.calls.length;
        await vi.advanceTimersByTimeAsync(1000);
        expect(port.list).toHaveBeenCalledTimes(observed + 1);
        expect(center.selectedView.value?.status).toBe(6);
        expect(center.actionAllowed('download', center.selectedView.value!)).toBe(false);
        expect(port.download).not.toHaveBeenCalled();
    });

    it.each([null, { filename: null, bytes: 0, mediaType: 'application/pdf', expiresAt: '2001-01-01', deleted: true }])('lets the authority retry cleanup without download authorization', async (output) => {
        const receipt = { ...view('task', 10, 2), output, reason: 'cleanup-required' };
        const { center, port } = createPort([receipt]);
        port.delete = vi.fn().mockResolvedValue({ ...receipt, version: 3 });
        await open(center);
        center.select('task');
        expect(center.actionAllowed('download', center.selectedView.value!)).toBe(false);
        expect(center.actionAllowed('delete', center.selectedView.value!)).toBe(true);
        await center.act('delete', 'task');
        expect(port.delete).toHaveBeenCalledWith('task');
        expect(center.selectedView.value?.status).toBe(10);
        expect(port.download).not.toHaveBeenCalled();
    });

    it('does not send invalid pagination coordinates to the authority', async () => {
        const { center, port } = createPort();
        await open(center);
        const observed = vi.mocked(port.list).mock.calls.length;
        for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
            await center.refresh(offset);
        }
        expect(port.list).toHaveBeenCalledTimes(observed);
        expect(center.offset.value).toBe(0);
    });

    it('ignores the old observation when the same identity closes and reopens', async () => {
        const { center, port } = createPort();
        let finishOld!: (page: readonly DocumentExportPresentation[]) => void;
        port.list = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
            .mockResolvedValue([view('reopened-observation', 7)]);
        center.setOpen(true);
        center.setOpen(false);
        center.setOpen(true);
        await Promise.resolve();
        finishOld([view('old-observation')]);
        await Promise.resolve();
        expect(center.views.value.map((item) => item.taskId)).toEqual(['reopened-observation']);
        expect(port.cancel).not.toHaveBeenCalled();
    });

    it('returns to the first authority page after admission from a later page', async () => {
        const roster = Array.from({ length: 40 }, (_, index) => view(`old-${index}`, 7));
        const { center, port } = createPort(roster);
        await open(center);
        await center.refresh(20);
        expect(center.offset.value).toBe(20);
        const admitted = view('admitted', 1);
        port.request = vi.fn().mockImplementation(async () => { roster.unshift(admitted); return admitted; });
        await center.submit({ sourceId: 'exact-draft-12', formatId: 'pdf', layout: 'reading', theme: 'light' });
        await Promise.resolve();
        expect(port.list).toHaveBeenLastCalledWith(0, 20);
        expect(center.offset.value).toBe(0);
        expect(center.selectedView.value?.taskId).toBe('admitted');
        expect(center.views.value).toHaveLength(20);
    });

});

describe('lossless presentation scalars', () => {
    it.each([
        ['9007199254740993', '9007199254740992', 1],
        ['10', '9', 1],
        ['9223372036854775807', '9223372036854775806', 1],
        [42, '42', 0], ['1', 2, -1],
    ])('compares %s to %s without rounding', (left, right, expected) => {
        expect(documentExportCompareVersions(left, right)).toBe(expected);
    });
    it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '01', '+1', ' 1', '1e2', '1\n', '1\r', '1\u2028', '9223372036854775808'])('refuses invalid version %s', (version) => {
        expect(() => documentExportCompareVersions(version, 1)).toThrow('document_export_presentation_int64');
    });
    it('retains the newer exact version across stale pages and status replies', async () => {
        const newer = view('task', 4, '9007199254740993');
        const older = view('task', 3, '9007199254740992');
        const { center, port } = createPort([newer]);
        await open(center);
        center.select('task');
        port.list = vi.fn().mockResolvedValue([older]);
        await center.refresh();
        port.status = vi.fn().mockResolvedValue(older);
        await center.act('status', 'task');
        expect(center.selectedView.value).toBe(newer);
        expect(center.views.value).toEqual([newer]);
    });
    it('refuses an unsafe page atomically without adopting any new receipt', async () => {
        const existing = view();
        const { center, port } = createPort([existing]);
        await open(center);
        center.select('task');
        port.list = vi.fn().mockResolvedValue([view('other'), view('task', 4, Number.MAX_SAFE_INTEGER + 1)]);
        await center.refresh();
        expect(center.views.value).toEqual([existing]);
        expect(center.selectedView.value).toBe(existing);
        expect(center.queryFailure.value).toBe('uncertain');
        expect(port.request).not.toHaveBeenCalled();
    });
    it('preserves exact output byte text and rejects unsafe numeric output sizes', () => {
        const receipt = { ...view('task', 10), output: { filename: null, bytes: '9223372036854775807', mediaType: 'application/pdf', expiresAt: '2001-01-01', deleted: true } };
        expect(() => documentExportValidatePresentation(receipt)).not.toThrow();
        expect(receipt.output.bytes).toBe('9223372036854775807');
        expect(() => documentExportValidatePresentation({ ...receipt, output: { ...receipt.output, bytes: Number.MAX_SAFE_INTEGER + 1 } })).toThrow('document_export_presentation_int64');
        expect(() => documentExportValidatePresentation({ ...receipt, output: { ...receipt.output, bytes: -1 } })).toThrow('document_export_presentation_int64');
    });
});
