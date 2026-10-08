import { effectScope } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { documentExportCanDownload, documentExportStatusLabel } from '@/components/document-export/documentExportUiPort';
import type { DocumentExportPresentation, DocumentExportUiPort } from '@/components/document-export/documentExportUiPort';
import { useDocumentExport } from '@/composables/useDocumentExport';

const disposals: (() => void)[] = [];
afterEach(() => { disposals.splice(0).forEach((dispose) => dispose()); });

function view(taskId = 'task', status = 3, version = 1): DocumentExportPresentation {
    return {
        taskId, status, version, source: 'draft coordinate/version 12', format: 'pdf',
        provider: 'canonical-pdf', options: 'registered-only', inputDigest: 'fixture-input',
        contentDigest: 'fixture-snapshot', reason: '', warnings: null, diagnostic: false, output: null,
    };
}

function createPort(roster = [view()]) {
    const port: DocumentExportUiPort<DocumentExportPresentation, Readonly<{ sourceId: string; formatId: string }>> = {
        catalog: [], sources: [],
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
        port.delete = vi.fn(() => new Promise((resolve) => { accept = resolve; }));
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
});
