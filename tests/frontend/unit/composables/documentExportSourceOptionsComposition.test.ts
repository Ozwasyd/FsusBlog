import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { decodeDocumentExportRequest } from '@/codecs/binary/documentExportWire.generated';
import { decodeDocumentExportSourceCaptureRequest, decodeDocumentExportSourceChoicesResponse } from '@/codecs/binary/documentExportSourceOptionsWire.generated';
import { createDocumentExportBrowserUiPortFromRevisionChoices, createDocumentExportBrowserUiPortFromSourceCapture } from '@/composition/documentExportSourceOptions';
import { BinaryTransportError } from '@/services/binaryTransport';
import { privateRequestRuntime } from '@/services/privateRequestRuntime';

import goldens from '../../../backend/Fixtures/document-export-source-options-payload-goldens-v1.json';
import jobGoldens from '../../../backend/Fixtures/document-export-payload-goldens-v1.json';
const transport = vi.hoisted(() => vi.fn());
vi.mock('@/composition/binaryTransport', async () => ({
    requestBinaryOnly: transport,
    BinaryTransportError: (await vi.importActual<typeof import('@/services/binaryTransport')>('@/services/binaryTransport')).BinaryTransportError
}));
function payload(name: string, catalog = goldens): Uint8Array {
    return Uint8Array.from(catalog.vectors.find(vector => vector.name === name)!.hex.match(/../gu)!, value => Number.parseInt(value, 16));
}
const request = () => decodeDocumentExportSourceCaptureRequest(payload('capture-revision'));
const reply = () => decodeDocumentExportSourceChoicesResponse(payload('exact-version-choices'));
function host() {
    const original = decodeDocumentExportRequest(payload('request-revision', jobGoldens));
    return { catalog: [{ id: original.formatId, label: 'actual host format fixture', providerId: 'actual host provider fixture', available: true, reason: '', layouts: [original.layoutProfile], themes: [original.themeProfile], support: [] }],
        privateForSource: vi.fn(() => true),
        prepareRequest: vi.fn((_selection, choice) => ({ ...original, source: choice.coordinate })) };
}
const disposals: (() => void)[] = [];
beforeEach(() => { privateRequestRuntime.resetForTests(); transport.mockReset().mockResolvedValue(reply()); });
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); privateRequestRuntime.resetForTests(); });
it.each(['capture', 'revisions'] as const)('connects the actual %s call and explicit host projections to the existing browser port', async operation => {
    const actualHost = host();
    const port = operation === 'capture' ? await createDocumentExportBrowserUiPortFromSourceCapture(request(), actualHost)
        : await createDocumentExportBrowserUiPortFromRevisionChoices({ articleId: 42 }, actualHost);
    disposals.push(() => port.dispose?.());
    expect(transport.mock.calls[0]![0].binaryUrl).toBe(`/api/binary/document-export/sources/${operation}`);
    const choice = reply().choices[0]!;
    expect(port.sources).toEqual([{ id: choice.choiceId, label: choice.label, private: true, coordinate: choice.coordinate }]);
    expect(port.catalog).toEqual(actualHost.catalog);
    const original = decodeDocumentExportRequest(payload('request-revision', jobGoldens));
    const selection = { sourceId: choice.choiceId, formatId: original.formatId, layout: original.layoutProfile, theme: original.themeProfile };
    const prepared = port.prepareRequest(selection);
    expect(actualHost.prepareRequest).toHaveBeenCalledWith(selection, choice);
    expect(prepared.source.sourceVersion).toBe('9007199254740993'); expect(prepared.locale).toBe(original.locale);
    expect(transport).toHaveBeenCalledOnce(); // No job admission/download/create is made by composition.
    privateRequestRuntime.advance('admin'); expect(port.sources).toEqual([]); expect(port.catalog).toEqual([]);
});
it('does not publish a port or call host policy after uniform permission denial', async () => {
    const denial = new BinaryTransportError({ kind: 'not_found', message: 'private' }); transport.mockRejectedValue(denial); const actualHost = host();
    await expect(createDocumentExportBrowserUiPortFromSourceCapture(request(), actualHost)).rejects.toBe(denial);
    expect(actualHost.privateForSource).not.toHaveBeenCalled(); expect(actualHost.prepareRequest).not.toHaveBeenCalled();
});
it('does not publish late private choices after original admin revocation during capture', async () => {
    let resolve!: (value: unknown) => void; transport.mockImplementation(() => new Promise(complete => { resolve = complete; }));
    const actualHost = host(); const pending = createDocumentExportBrowserUiPortFromSourceCapture(request(), actualHost);
    privateRequestRuntime.advance('admin'); resolve(reply());
    await expect(pending).rejects.toThrow('stale_private_response:admin'); expect(actualHost.privateForSource).not.toHaveBeenCalled();
});
it('keeps the acquisition generation guard across a synchronous host callback', async () => {
    const actualHost = host(); actualHost.privateForSource.mockImplementation(() => { privateRequestRuntime.advance('admin'); return true; });
    await expect(createDocumentExportBrowserUiPortFromSourceCapture(request(), actualHost)).rejects.toThrow('stale_private_response:admin');
    expect(actualHost.prepareRequest).not.toHaveBeenCalled(); expect(transport).toHaveBeenCalledOnce();
});
it.each(['admin', 'caller'] as const)('stops before the next private choice callback after synchronous %s revocation', async authority => {
    const original = request(); original.sources.push({ ...original.sources[0]!, revisionId: '18' });
    const first = reply().choices[0]!;
    const second = { ...first, choiceId: 'b'.repeat(64), coordinate: { ...first.coordinate, revisionId: '18', sourceVersion: '9007199254740994' } };
    transport.mockResolvedValue({ choices: [first, second] });
    const caller = new AbortController(); const actualHost = host();
    actualHost.privateForSource.mockImplementation(() => {
        if (authority === 'admin') privateRequestRuntime.advance('admin');
        else caller.abort();
        return true;
    });
    await expect(createDocumentExportBrowserUiPortFromSourceCapture(original, actualHost, caller.signal)).rejects.toThrow();
    expect(actualHost.privateForSource).toHaveBeenCalledOnce();
    expect(actualHost.privateForSource).toHaveBeenCalledWith(first);
    expect(actualHost.prepareRequest).not.toHaveBeenCalled();
});
it('refuses prior and late caller cancellation without publishing a usable UI port', async () => {
    const caller = new AbortController(); caller.abort();
    await expect(createDocumentExportBrowserUiPortFromSourceCapture(request(), host(), caller.signal)).rejects.toThrow(); expect(transport).not.toHaveBeenCalled();
    const current = new AbortController(); transport.mockImplementation(async () => { current.abort(); return reply(); });
    const actualHost = host(); await expect(createDocumentExportBrowserUiPortFromRevisionChoices({ articleId: 42 }, actualHost, current.signal)).rejects.toThrow();
    expect(actualHost.privateForSource).not.toHaveBeenCalled();
});
it('requires an actual boolean privacy projection rather than filling a response field', async () => {
    const actualHost = host(); actualHost.privateForSource.mockReturnValue(undefined as unknown as boolean);
    await expect(createDocumentExportBrowserUiPortFromSourceCapture(request(), actualHost)).rejects.toThrow('document_export_source_privacy_unavailable');
    expect(actualHost.prepareRequest).not.toHaveBeenCalled();
});
it('preserves unavailable host formats and actual empty choices without guessed availability or sources', async () => {
    const actualHost = host(); actualHost.catalog[0]!.available = false; actualHost.catalog[0]!.reason = 'actual host refusal';
    transport.mockResolvedValue({ choices: [] });
    const port = await createDocumentExportBrowserUiPortFromRevisionChoices({ articleId: 42 }, actualHost); disposals.push(() => port.dispose?.());
    expect(port.sources).toEqual([]); expect(port.catalog[0]).toMatchObject({ available: false, reason: 'actual host refusal' }); expect(actualHost.privateForSource).not.toHaveBeenCalled();
});
it('retains original admission mismatch refusal for a host that changes the selected bound source', async () => {
    const actualHost = host(); const original = decodeDocumentExportRequest(payload('request-revision', jobGoldens)); actualHost.prepareRequest.mockReturnValue(original);
    const port = await createDocumentExportBrowserUiPortFromSourceCapture(request(), actualHost); disposals.push(() => port.dispose?.());
    expect(() => port.prepareRequest({ sourceId: reply().choices[0]!.choiceId, formatId: original.formatId, layout: original.layoutProfile, theme: original.themeProfile })).toThrow('document_export_selection_mismatch');
    expect(transport).toHaveBeenCalledOnce();
});
