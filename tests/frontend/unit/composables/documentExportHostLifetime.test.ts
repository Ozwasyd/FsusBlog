// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { decodeDocumentExportJobResponse, decodeDocumentExportRequest, encodeDocumentExportJobResponse } from '@/codecs/binary/documentExportWire.generated';
import { decodeDocumentExportSourceChoicesResponse } from '@/codecs/binary/documentExportSourceOptionsWire.generated';
import type { useDocumentExport } from '@/composables/useDocumentExport';
import { FsusUiButton } from '@/fsusui/button';
import { FsusUiClassicSelect } from '@/fsusui/classicSelect';
import { FsusUiExportCheckbox, FsusUiExportRadioGroup } from '@/fsusui/documentExportControls';
import { BinaryRequestError } from '@/api/binaryApiClient';
import { encodeAedsFrame } from '@/api/binaryFrame';
import { BinaryTransportError } from '@/composition/binaryTransport';
import { FrameType } from '@wasm/protocol/frame';
import { privateRequestRuntime } from '@/services/privateRequestRuntime';
import DocumentExportHost, { documentExportHostAuthoritiesKey } from '@/views/admin/article/DocumentExportHost.vue';
import ExportCenter from '@/views/admin/article/ExportCenter.vue';

import sourceGoldens from '../../../backend/Fixtures/document-export-source-options-payload-goldens-v1.json';
import jobGoldens from '../../../backend/Fixtures/document-export-payload-goldens-v1.json';

// Readiness/privacy are controlled unit facts, never production admission evidence.
// Restore the original envelope decoder; control only the outer HTTP boundary.
vi.unmock('@wasm/aeds');
const http = vi.hoisted(() => vi.fn());
vi.mock('@/api/binaryApiClient', async () => ({
    ...await vi.importActual<typeof import('@/api/binaryApiClient')>('@/api/binaryApiClient'),
    binaryRequest: http
}));
const bytes = (name: string) => Uint8Array.from(jobGoldens.vectors.find(vector => vector.name === name)!.hex.match(/../gu)!, value => Number.parseInt(value, 16));
const sourceResponse = () => decodeDocumentExportSourceChoicesResponse(Uint8Array.from(
    sourceGoldens.vectors.find(vector => vector.name === 'exact-version-choices')!.hex.match(/../gu)!, value => Number.parseInt(value, 16)));
const requestFixture = () => decodeDocumentExportRequest(bytes('request-revision'));
const writes = () => http.mock.calls.filter(([url]) => url === '/api/binary/document-export/request');
const submitted = (index: number) => decodeDocumentExportRequest(new Uint8Array(writes()[index]![1].body, 16));
let write: (options: { signal: AbortSignal; }) => Promise<ArrayBuffer>;
const mounted: ReturnType<typeof mount>[] = [];
beforeEach(() =>
{
    privateRequestRuntime.resetForTests();
    write = async () => { throw new BinaryTransportError({ kind: 'network', message: 'controlled unconfirmed response' }); };
    http.mockReset().mockImplementation((url, options) =>
    {
        if (url === '/api/binary/document-export/sources/revisions')
        {
            const payload = sourceGoldens.vectors.find(vector => vector.name === 'exact-version-choices')!.hex;
            return Promise.resolve(encodeAedsFrame(FrameType.DocumentExportSourceChoicesResponse,
                Uint8Array.from(payload.match(/../gu)!, value => Number.parseInt(value, 16))));
        }
        if (url === '/api/binary/document-export/tasks?offset=0&limit=20')
        {
            return Promise.resolve(encodeAedsFrame(FrameType.DocumentExportPageResponse, bytes('empty-page-response')));
        }
        if (url === '/api/binary/document-export/request') { return write(options); }
        throw new Error('unexpected_outer_http_call');
    });
});
afterEach(() =>
{
    mounted.splice(0).forEach(wrapper => wrapper.unmount());
    privateRequestRuntime.resetForTests();
    document.body.innerHTML = '';
});
async function prepareHost()
{
    const fixture = requestFixture();
    const wrapper = mount(DocumentExportHost, {
        props: { articles: [{ id: 42, title: 'Controlled lifetime fixture' }] }, attachTo: document.body,
        global: { provide: { [documentExportHostAuthoritiesKey as symbol]: {
            readCatalog: () => [{ id: fixture.formatId, label: 'Controlled ready unit fixture', providerId: 'controlled-provider',
                available: true, reason: '', layouts: [fixture.layoutProfile], themes: [fixture.themeProfile], support: [] }],
            privateForSource: () => true
        } } }
    });
    mounted.push(wrapper);
    await wrapper.findComponent(FsusUiButton).trigger('click');
    await flushPromises();
    wrapper.findAllComponents(FsusUiClassicSelect)[0]!.vm.$emit('update:modelValue', 42);
    await flushPromises();
    await wrapper.findAllComponents(FsusUiButton).find(button => button.text() === '读取修订')!.trigger('click');
    await flushPromises();
    wrapper.findAllComponents(FsusUiClassicSelect)[1]!.vm.$emit('update:modelValue', sourceResponse().choices[0]!.choiceId);
    await flushPromises();
    await wrapper.findAllComponents(FsusUiButton).find(button => button.text() === '继续导出')!.trigger('click');
    await flushPromises();
    const center = wrapper.findComponent(ExportCenter);
    const state = (center.vm as unknown as { state: ReturnType<typeof useDocumentExport>; }).state;
    const selection = { sourceId: sourceResponse().choices[0]!.choiceId,
        formatId: fixture.formatId, layout: fixture.layoutProfile, theme: fixture.themeProfile };
    return { wrapper, center, state, selection };
}
async function reopen(host: Awaited<ReturnType<typeof prepareHost>>)
{
    host.center.vm.$emit('update:visible', false);
    await flushPromises();
    expect(host.center.props('visible')).toBe(false);
    await host.wrapper.findComponent(FsusUiButton).trigger('click');
    await flushPromises();
    const resumed = host.wrapper.findComponent(ExportCenter);
    expect(resumed.vm.$).toBe(host.center.vm.$);
    expect(resumed.props('port')).toBe(host.center.props('port'));
    expect(resumed.props('visible')).toBe(true);
    expect(http.mock.calls.filter(([url]) => url === '/api/binary/document-export/sources/revisions')).toHaveLength(1);
}

async function submitFromForm(host: Awaited<ReturnType<typeof prepareHost>>)
{
    const fixture = requestFixture();
    const select = (id: string, value: string) => host.center.findAllComponents(FsusUiClassicSelect)
        .find(component => component.props('id') === id)!.vm.$emit('update:modelValue', value);
    select('document-export-source', host.selection.sourceId);
    host.center.findComponent(FsusUiExportRadioGroup).vm.$emit('update:modelValue', fixture.formatId);
    await flushPromises();
    select('document-export-layout', fixture.layoutProfile);
    select('document-export-theme', fixture.themeProfile);
    await flushPromises();
    host.center.findComponent(FsusUiExportCheckbox).vm.$emit('update:modelValue', true);
    await flushPromises();
    await host.center.find('form').trigger('submit');
    await flushPromises();
}
it('does not replace an uncertain write identity when the actual Host closes and reopens', async () =>
{
    const host = await prepareHost();
    await submitFromForm(host);
    expect(host.state.submission.value.phase).toBe('uncertain');
    expect(host.wrapper.text()).toContain('请求结果待核实');
    expect(writes()).toHaveLength(1);
    const original = submitted(0);
    await reopen(host);
    expect(host.state.submission.value.phase).toBe('uncertain');
    await submitFromForm(host);
    expect(writes()).toHaveLength(1);
    await host.state.retrySubmission();
    expect(writes()).toHaveLength(2);
    expect(writes()[1]![1].body).toEqual(writes()[0]![1].body);
    expect(submitted(1)).toEqual(original);
    expect(new Set(writes().map((_, index) => JSON.stringify([submitted(index).requestId, submitted(index).idempotencyKey]))).size).toBe(1);
    expect(original.source).toEqual(sourceResponse().choices[0]!.coordinate);
    expect(original.source.sourceVersion).toBe('9007199254740993');
    expect(writes()[0]![1]).toMatchObject({ method: 'POST', credentials: 'include', requiresPow: true });
});
it('retains an in-flight write across close/reopen and preserves late uncertainty without another submission', async () =>
{
    let reject!: (error: BinaryTransportError) => void;
    write = () => new Promise((_, fail) => { reject = fail; });
    const host = await prepareHost();
    const pending = host.state.submit(host.selection);
    await flushPromises();
    expect(host.state.submission.value.phase).toBe('pending');
    const signal = writes()[0]![1].signal as AbortSignal;
    await reopen(host);
    expect(signal.aborted).toBe(false);
    reject(new BinaryTransportError({ kind: 'network', message: 'controlled late unconfirmed response' }));
    await pending;
    expect(host.state.submission.value.phase).toBe('uncertain');
    expect(writes()).toHaveLength(1);
});
it('retires a hidden unconfirmed center on original admin revocation without reusing its private choices', async () =>
{
    const host = await prepareHost();
    await host.state.submit(host.selection);
    host.center.vm.$emit('update:visible', false);
    await flushPromises();
    privateRequestRuntime.advance('admin');
    await flushPromises();
    expect(host.wrapper.findComponent(ExportCenter).exists()).toBe(false);
    await host.wrapper.findComponent(FsusUiButton).trigger('click');
    await flushPromises();
    expect(host.wrapper.findComponent(ExportCenter).exists()).toBe(false);
    expect(host.wrapper.findAllComponents(FsusUiClassicSelect)[0]!.props('modelValue')).toBeUndefined();
    expect(writes()).toHaveLength(1);
});
it.each([401, 403, 404])('clears private host choices after actual HTTP %s permission/source denial', async status =>
{
    write = async () => { throw new BinaryRequestError(status, 'private response details', new ArrayBuffer(0)); };
    const host = await prepareHost();
    await host.state.submit(host.selection);
    await flushPromises();
    expect(writes()).toHaveLength(1);
    expect(host.wrapper.findComponent(ExportCenter).exists()).toBe(false);
    expect(host.wrapper.text()).not.toContain('private response details');
    await host.wrapper.findComponent(FsusUiButton).trigger('click');
    await flushPromises();
    expect(host.wrapper.findAllComponents(FsusUiClassicSelect)[0]!.props('modelValue')).toBeUndefined();
    expect(writes()).toHaveLength(1);
});

it('retains the replay identity through confirmation and allocates a new identity only for the next explicit Host submission', async () =>
{
    write = async () =>
    {
        if (writes().length !== 2)
        {
            throw new BinaryRequestError(503, 'controlled unconfirmed write', new ArrayBuffer(0));
        }
        // Controlled outer HTTP response: original queued-job golden, with only
        // the actual replayed request correlation/source/options echoed through
        // the original Shared codec. No output or native completion is asserted.
        const replay = submitted(1);
        const queued = decodeDocumentExportJobResponse(bytes('queued-job-response'));
        expect(queued.status).toBe(1);
        expect(queued.output).toBeNull();
        return encodeAedsFrame(FrameType.DocumentExportJobResponse, encodeDocumentExportJobResponse({
            ...queued, requestId: replay.requestId, source: replay.source,
            formatId: replay.formatId, layoutProfile: replay.layoutProfile,
            themeProfile: replay.themeProfile, locale: replay.locale
        }));
    };
    const host = await prepareHost();
    await submitFromForm(host);
    expect(host.state.submission.value.phase).toBe('uncertain');
    expect(writes()).toHaveLength(1);
    const original = submitted(0);
    await reopen(host);
    await submitFromForm(host);
    expect(writes()).toHaveLength(1);
    await host.center.findAllComponents(FsusUiButton).find(button => button.text() === '核实原请求')!.trigger('click');
    await flushPromises();
    expect(writes()).toHaveLength(2);
    expect(writes()[1]![1].body).toEqual(writes()[0]![1].body);
    expect(submitted(1)).toEqual(original);
    expect(host.state.submission.value).toMatchObject({
        phase: 'confirmed', result: { requestId: original.requestId, source: original.source, status: 1, output: null }
    });
    await flushPromises();
    expect(writes()).toHaveLength(2); // Confirmation never automatically starts a new intent.
    await reopen(host);
    expect(writes()).toHaveLength(2);
    await submitFromForm(host);
    expect(writes()).toHaveLength(3);
    const next = submitted(2);
    expect(next.requestId).not.toBe(original.requestId);
    expect(next.idempotencyKey).not.toBe(original.idempotencyKey);
    expect({ ...next, requestId: original.requestId, idempotencyKey: original.idempotencyKey }).toEqual(original);
    expect(submitted(0)).toEqual(original);
    expect(submitted(1)).toEqual(original);
    expect(host.state.submission.value.phase).toBe('uncertain');
    expect(writes()[2]![1]).toMatchObject({ method: 'POST', credentials: 'include', requiresPow: true });
});
