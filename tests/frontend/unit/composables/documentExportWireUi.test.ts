import { effectScope } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';

import { decodeDocumentExportJobResponse, decodeDocumentExportRequest } from '@/codecs/binary/documentExportWire.generated';
import { createDocumentExportWireUiPort, inspectDocumentExportWire } from '@/components/document-export/documentExportWireUiPort';
import { useDocumentExport } from '@/composables/useDocumentExport';
import { BinaryTransportError } from '@/composition/binaryTransport';

import goldens from '../../../backend/Fixtures/document-export-payload-goldens-v1.json';

vi.mock('@/api/documentExport', async () => ({
    ...(await vi.importActual<typeof import('@/api/documentExport')>('@/api/documentExport')),
    listDocumentExports: vi.fn(async () => ({ offset: 0, limit: 20, hasMore: false, jobs: [job()] }))
}));
function payload(name: string): Uint8Array {
    const hex = goldens.vectors.find(vector => vector.name === name)!.hex;
    return Uint8Array.from(hex.match(/../gu)!, value => Number.parseInt(value, 16));
}
function job() { return decodeDocumentExportJobResponse(payload('queued-job-response')); }
const disposals: (() => void)[] = [];
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); });
function options() {
    return {
        catalog: [{ id: 'self-contained-html', label: 'HTML', providerId: 'fsus-html', available: true, reason: '', layouts: ['document-reading-v1'], themes: ['light-v1'], support: [] }],
        sources: [{ id: 'exact-revision-17', label: 'specified revision17', private: true, coordinate: job().source }],
        prepareRequest: vi.fn(() => decodeDocumentExportRequest(payload('request-revision'))),
        deliverPrivate: vi.fn().mockResolvedValue(undefined)
    };
}
it('projects only actual canonical facts without inventing warnings, filename or output', () => {
    const snapshot = job(); const view = inspectDocumentExportWire(snapshot);
    expect(view).toMatchObject({ taskId: snapshot.taskId, version: '1', status: 1, contentDigest: snapshot.taskDigest, warnings: null, output: null });
    expect(view.source).toContain('修订 17');
    expect(view.source).toContain('version 3');
});
it('uses the generated queued snapshot directly in the existing ephemeral center', async () => {
    const port = createDocumentExportWireUiPort(options()); const scope = effectScope();
    const center = scope.run(() => useDocumentExport(port))!;
    disposals.push(() => { center.dispose(); scope.stop(); });
    center.setOpen(true); await center.refresh(); center.select('task-1');
    expect(center.selectedView.value?.status).toBe(1);
    expect(center.selectedView.value?.contentDigest).toBe(job().taskDigest);
    expect(center.actionAllowed('download', center.selectedView.value!)).toBe(false);
});
it('requires authorized source and exact available catalog options before original admission preparation', () => {
    const config = options(); const port = createDocumentExportWireUiPort(config);
    const selection = { sourceId: 'exact-revision-17', formatId: 'self-contained-html', layout: 'document-reading-v1', theme: 'light-v1' };
    expect(port.prepareRequest(selection)).toEqual(decodeDocumentExportRequest(payload('request-revision')));
    expect(() => port.prepareRequest({ ...selection, sourceId: 'unknown' })).toThrow();
    expect(() => port.prepareRequest({ ...selection, layout: 'arbitrary-css' })).toThrow();
    expect(() => port.prepareRequest({ ...selection, formatId: 'pdf' })).toThrow();
    expect(config.prepareRequest).toHaveBeenCalledTimes(1);
});
it('rejects an original admission adapter that silently changes the selected format', () => {
    const config = options(); config.prepareRequest.mockReturnValue({ ...decodeDocumentExportRequest(payload('request-revision')), formatId: 'pdf' });
    const port = createDocumentExportWireUiPort(config);
    expect(() => port.prepareRequest({ sourceId: 'exact-revision-17', formatId: 'self-contained-html', layout: 'document-reading-v1', theme: 'light-v1' })).toThrow();
});
it('rejects an original admission adapter that changes the frozen source coordinate', () => {
    const config = options(); const original = decodeDocumentExportRequest(payload('request-revision'));
    config.prepareRequest.mockReturnValue({ ...original, source: { ...original.source, sourceVersion: '4' } });
    const port = createDocumentExportWireUiPort(config);
    expect(() => port.prepareRequest({ sourceId: 'exact-revision-17', formatId: 'self-contained-html', layout: 'document-reading-v1', theme: 'light-v1' })).toThrow();
});
it('announces preparation refusal through the real center with zero admission calls', async () => {
    const config = options(); config.prepareRequest.mockImplementation(() => { throw new RangeError('private invalid selection'); });
    const port = createDocumentExportWireUiPort(config); port.request = vi.fn(); const scope = effectScope();
    const center = scope.run(() => useDocumentExport(port))!;
    disposals.push(() => { center.dispose(); scope.stop(); });
    await expect(center.submit({ sourceId: 'exact-revision-17', formatId: 'self-contained-html', layout: 'document-reading-v1', theme: 'light-v1' })).resolves.toBeUndefined();
    expect(center.submission.value.phase).toBe('rejected'); expect(port.request).not.toHaveBeenCalled();
});
it('announces capture refusal through the real center with zero admission calls', async () => {
    const port = createDocumentExportWireUiPort(options()); port.captureRequest = () => { throw new RangeError('invalid capture'); };
    port.request = vi.fn(); const scope = effectScope(); const center = scope.run(() => useDocumentExport(port))!;
    disposals.push(() => { center.dispose(); scope.stop(); });
    await center.submit({ sourceId: 'exact-revision-17', formatId: 'self-contained-html', layout: 'document-reading-v1', theme: 'light-v1' });
    expect(center.submission.value.phase).toBe('rejected'); expect(port.request).not.toHaveBeenCalled();
});
it('clears private snapshots when original preparation reports permission revocation', async () => {
    const config = options(); config.prepareRequest.mockImplementation(() => { throw new BinaryTransportError({ kind: 'not_found', message: 'private' }); });
    const port = createDocumentExportWireUiPort(config); port.request = vi.fn(); const scope = effectScope();
    const center = scope.run(() => useDocumentExport(port))!;
    disposals.push(() => { center.dispose(); scope.stop(); });
    center.setOpen(true); await center.refresh(); center.select('task-1');
    expect(center.views.value).toHaveLength(1);
    await center.submit({ sourceId: 'exact-revision-17', formatId: 'self-contained-html', layout: 'document-reading-v1', theme: 'light-v1' });
    expect(center.permitted.value).toBe(false); expect(center.views.value).toHaveLength(0);
    expect(center.selectedView.value).toBeNull(); expect(port.request).not.toHaveBeenCalled();
});
it('preserves exact longmax version and non-success cleanup bytes without creating download authority', () => {
    const snapshot = job(); snapshot.version = '9223372036854775807'; snapshot.status = 10;
    snapshot.output = { outputId: 'controlled-output', mediaType: 'application/pdf', extension: '.pdf', outputDigest: snapshot.inputDigest, resultReceiptDigest: snapshot.taskDigest,
        length: '9223372036854775807', createdAtUnixMs: '0', expiresAtUnixMs: '1000', deletedAtUnixMs: '1' };
    const view = inspectDocumentExportWire(snapshot);
    expect(view.version).toBe('9223372036854775807'); expect(view.output?.bytes).toBe('9223372036854775807');
    expect(view.output?.filename).toBeNull(); expect(view.output?.deleted).toBe(true); expect(view.status).toBe(10);
});
