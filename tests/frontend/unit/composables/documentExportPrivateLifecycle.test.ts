import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { decodeDocumentExportJobResponse, decodeDocumentExportRequest } from '@/codecs/binary/documentExportWire.generated';
import { createDocumentExportWireUiPort } from '@/components/document-export/documentExportWireUiPort';
import { useDocumentExport } from '@/composables/useDocumentExport';
import { createDocumentExportBrowserUiPort } from '@/composition/documentExport';
import { BinaryTransportError } from '@/services/binaryTransport';
import { privateRequestRuntime } from '@/services/privateRequestRuntime';

import goldens from '../../../backend/Fixtures/document-export-payload-goldens-v1.json';

const transport = vi.hoisted(() => ({ binary: vi.fn(), raw: vi.fn() }));
vi.mock('@/composition/binaryTransport', async () => ({
    ...(await vi.importActual<typeof import('@/composition/binaryTransport')>('@/composition/binaryTransport')),
    requestBinaryOnly: transport.binary
}));
vi.mock('@/api/binaryApiClient', async () => ({
    ...(await vi.importActual<typeof import('@/api/binaryApiClient')>('@/api/binaryApiClient')),
    binaryRequest: transport.raw
}));
// FrameType, generated codecs and private runtime remain the actual published owners.
function payload(name: string): Uint8Array {
    return Uint8Array.from(goldens.vectors.find(vector => vector.name === name)!.hex.match(/../gu)!, value => Number.parseInt(value, 16));
}
const queued = () => decodeDocumentExportJobResponse(payload('queued-job-response'));
const selection = { sourceId: 'exact-revision-17', formatId: 'self-contained-html', layout: 'document-reading-v1', theme: 'light-v1' };
function options() {
    return {
        catalog: [{ id: 'self-contained-html', label: 'HTML', providerId: 'fsus-html', available: true, reason: '', layouts: ['document-reading-v1'], themes: ['light-v1'], support: [] }],
        sources: [{ id: 'exact-revision-17', label: 'specified revision17', private: true, coordinate: queued().source }],
        prepareRequest: vi.fn(() => decodeDocumentExportRequest(payload('request-revision'))),
        deliverPrivate: vi.fn().mockResolvedValue(undefined)
    };
}
const disposals: (() => void)[] = [];
function port(config = options()) {
    const result = createDocumentExportWireUiPort(config);
    disposals.push(() => result.dispose?.());
    return result;
}
beforeEach(() => {
    privateRequestRuntime.resetForTests();
    transport.binary.mockReset().mockResolvedValue({ offset: 0, limit: 20, hasMore: false, jobs: [queued()] });
    transport.raw.mockReset();
});
afterEach(() => {
    disposals.splice(0).forEach(dispose => dispose());
    privateRequestRuntime.resetForTests();
    vi.restoreAllMocks();
});
it('clears an idle private center and its exact choices immediately on original admin generation revocation', async () => {
    const adapter = port(); const center = useDocumentExport(adapter); disposals.push(center.dispose);
    center.setOpen(true); await center.refresh(); center.select('task-1');
    expect(center.selectedView.value?.status).toBe(1); expect(queued().output).toBeNull();
    const reads = transport.binary.mock.calls.length;
    privateRequestRuntime.advanceForAuthTransition('admin-logout'); await Promise.resolve();
    expect(center.permitted.value).toBe(false); expect(center.views.value).toEqual([]);
    expect(center.selectedView.value).toBeNull(); expect(center.queryFailure.value).toBe('permission-revoked');
    expect(adapter.catalog).toEqual([]); expect(adapter.sources).toEqual([]);
    expect(transport.binary).toHaveBeenCalledTimes(reads);
});
it('refuses a retired port before preparation, capture or any HTTP request', async () => {
    const config = options(); const adapter = port(config);
    privateRequestRuntime.advance('admin');
    expect(() => adapter.prepareRequest(selection)).toThrow();
    expect(() => adapter.captureRequest(decodeDocumentExportRequest(payload('request-revision')))).toThrow();
    await expect(adapter.list(0, 20)).rejects.toThrow();
    await expect(adapter.request(decodeDocumentExportRequest(payload('request-revision')))).rejects.toThrow();
    expect(config.prepareRequest).not.toHaveBeenCalled(); expect(transport.binary).not.toHaveBeenCalled();
});
it('requires a fresh host-authorized port after identity change instead of reviving old choices', async () => {
    const old = port(); const center = useDocumentExport(old); disposals.push(center.dispose);
    center.changeIdentity(); expect(center.permitted.value).toBe(false); expect(old.sources).toEqual([]);
    center.changeIdentity(); expect(center.permitted.value).toBe(false);
    const replacement = port(); expect(replacement.prepareRequest(selection).source).toEqual(queued().source);
    await expect(replacement.list(0, 20)).resolves.toEqual([queued()]);
});
it('captures immutable authorized option and source projections against caller mutation', () => {
    const config = options(); const adapter = port(config);
    config.catalog[0]!.layouts[0] = 'caller-change'; config.catalog[0]!.available = false;
    config.sources[0]!.coordinate.sourceVersion = '99'; config.sources[0]!.label = 'caller-change';
    expect(adapter.prepareRequest(selection).source.sourceVersion).toBe('3');
    expect(adapter.sources[0]!.label).toBe('specified revision17');
    expect(Object.isFrozen(adapter.catalog[0]!.layouts)).toBe(true);
});
it('aborts pending HTTP observation and rejects a late literal queued response', async () => {
    let complete!: (value: unknown) => void;
    transport.binary.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const adapter = port(); const pending = adapter.list(0, 20);
    const signal = transport.binary.mock.calls[0]![0].signal as AbortSignal;
    privateRequestRuntime.advance('admin'); expect(signal.aborted).toBe(true);
    complete({ offset: 0, limit: 20, hasMore: false, jobs: [queued()] });
    await expect(pending).rejects.toThrow('stale_private_response:admin'); expect(adapter.sources).toEqual([]);
});
it('clears and refuses an already retired port when a center subscribes later', async () => {
    const adapter = port(); adapter.dispose?.();
    const center = useDocumentExport(adapter); disposals.push(center.dispose); await Promise.resolve();
    expect(center.permitted.value).toBe(false); expect(center.queryFailure.value).toBe('permission-revoked');
});
it('releases listeners and the view lifetime idempotently without affecting a fresh port', async () => {
    const adapter = port(); const revoked = vi.fn(); const detached = vi.fn();
    adapter.subscribePermissionRevoked!(revoked); adapter.subscribePermissionRevoked!(detached)();
    adapter.dispose?.(); adapter.dispose?.(); await Promise.resolve(); expect(revoked).toHaveBeenCalledOnce(); expect(detached).not.toHaveBeenCalled();
    const replacement = port(); privateRequestRuntime.advance('account');
    expect(replacement.sources).toHaveLength(1); expect(revoked).toHaveBeenCalledOnce();
});
it('also clears captured choices after a uniform HTTP permission denial', async () => {
    transport.binary.mockRejectedValue(new BinaryTransportError({ kind: 'not_found', message: 'private' }));
    const adapter = port(); const center = useDocumentExport(adapter); disposals.push(center.dispose);
    center.setOpen(true); await center.refresh();
    expect(center.permitted.value).toBe(false); expect(adapter.sources).toEqual([]); expect(adapter.catalog).toEqual([]);
});
const headers = () => new Headers({ 'content-length': '3', 'content-type': 'text/html',
    'content-disposition': 'attachment; filename="verified.html"', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'accept-ranges': 'none' });
function browserPort() {
    const adapter = createDocumentExportBrowserUiPort(options()); disposals.push(() => adapter.dispose?.()); return adapter;
}
function browserSave() {
    const link = document.createElement('a');
    vi.spyOn(document, 'createElement').mockReturnValue(link);
    vi.spyOn(link, 'click').mockImplementation(() => undefined);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:controlled-private-export');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    return link;
}
it('composes guarded actual response bytes with the original private saver, without a successful job fixture', async () => {
    const link = browserSave(); const bytes = Uint8Array.of(3, 5, 7).buffer;
    transport.raw.mockImplementation(async (_url, request) => { request.onResponseHeaders(headers()); return bytes; });
    await browserPort().download('task-1', new AbortController().signal);
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob;
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array(bytes));
    expect(link.download).toBe('verified.html'); expect(link.click).toHaveBeenCalledOnce();
    expect(link.isConnected).toBe(false); expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    expect(queued().output).toBeNull();
});
it('performs zero body reads and zero browser saves when the original admin authority revokes at response headers', async () => {
    const link = browserSave(); const read = vi.fn(() => new ArrayBuffer(3));
    transport.raw.mockImplementation(async (_url, request) => {
        privateRequestRuntime.advance('admin'); request.onResponseHeaders(headers()); return read();
    });
    const adapter = browserPort(); await expect(adapter.download('task-1', new AbortController().signal)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled(); expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(link.click).not.toHaveBeenCalled(); expect(adapter.sources).toEqual([]);
});
it('removes the private URL and performs zero clicks if admin revocation reaches the original attached-link save boundary', async () => {
    const link = browserSave(); const append = document.body.append.bind(document.body);
    vi.spyOn(document.body, 'append').mockImplementation((...nodes) => { append(...nodes); privateRequestRuntime.advance('admin'); });
    transport.raw.mockImplementation(async (_url, request) => { request.onResponseHeaders(headers()); return new ArrayBuffer(3); });
    const adapter = browserPort(); await expect(adapter.download('task-1', new AbortController().signal)).rejects.toThrow();
    expect(link.click).not.toHaveBeenCalled(); expect(link.isConnected).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce(); expect(adapter.catalog).toEqual([]);
});
it('combines caller cancellation with the private view lifetime before any save', async () => {
    const link = browserSave(); const caller = new AbortController();
    transport.raw.mockImplementation(async (_url, request) => { request.onResponseHeaders(headers()); caller.abort(); return new ArrayBuffer(3); });
    const adapter = browserPort(); await expect(adapter.download('task-1', caller.signal)).rejects.toThrow();
    expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(link.click).not.toHaveBeenCalled();
    expect(adapter.sources).toHaveLength(1);
});

it('lets an original generation notification construct a fresh authorized port after runtime iteration', async () => {
    const adapter = port(); let replacement: ReturnType<typeof port> | undefined;
    adapter.subscribePermissionRevoked!(() => { replacement = port(); });
    privateRequestRuntime.advance('admin'); expect(adapter.catalog).toEqual([]);
    await Promise.resolve(); expect(replacement?.sources).toHaveLength(1);
    await expect(replacement!.list(0, 20)).resolves.toEqual([queued()]);
});

it('honors another listener being detached during the same queued revocation notification', async () => {
    const adapter = port(); const detached = vi.fn(); let unsubscribe = () => undefined;
    adapter.subscribePermissionRevoked!(() => unsubscribe());
    unsubscribe = adapter.subscribePermissionRevoked!(detached);
    adapter.dispose?.(); await Promise.resolve(); expect(detached).not.toHaveBeenCalled();
});
