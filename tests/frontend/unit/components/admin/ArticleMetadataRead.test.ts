// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils';
import { h, nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    decodeArticlePropertyValueReadResponse,
    type ArticlePropertyValueReadResponse
} from '@/codecs/binary/articlePropertyValueReadCodecs';
import ArticleMetadataRead from '@/components/admin/article/ArticleMetadataRead.vue';
import { ArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';

import golden from '../../../../fixtures/protocol/article-property-value-read-wire-golden.json';

const transport = vi.hoisted(() => ({ requestBinaryOnly: vi.fn() }));
vi.mock('@/composition/binaryTransport', () => transport);

// Reuse upstream wire witnesses without claiming authenticated HTTP/DB receipts.
function response(name = 'current-8'): ArticlePropertyValueReadResponse
{
    const entry = golden.cases.find((candidate) => candidate.name === name);
    if (!entry)
    {
        throw new Error(`missing canonical wire fixture: ${name}`);
    }
    return decodeArticlePropertyValueReadResponse(Uint8Array.from(Buffer.from(entry.payloadHex, 'hex')));
}

function documentContext()
{
    return new ArticleDocumentContextAdapter({
        articleId: 7,
        draftId: 'article-7',
        editorSessionId: 'editor-session-7',
        siteScope: 'site:blog.example',
        userScope: 'user:42',
        content: 'body'
    }).context;
}

function pending()
{
    let resolve!: (value: ArticlePropertyValueReadResponse) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<ArticlePropertyValueReadResponse>((accept, refuse) =>
    {
        resolve = accept;
        reject = refuse;
    });
    return { promise, resolve, reject };
}

type ReadSlot = {
    model: ArticlePropertyValueReadResponse | null;
    state: string;
    refresh: () => void;
};
const wrappers: ReturnType<typeof mount>[] = [];
function render(overrides = {})
{
    let observed: ReadSlot | null = null;
    const wrapper = mount(ArticleMetadataRead, {
        props: { context: documentContext(), definitionOwnerUserId: '42', enabled: true, readKey: 'permissions-1', ...overrides },
        slots: {
            default: (value: ReadSlot) =>
            {
                observed = value;
                return h('p', { 'data-state': value.state }, value.state);
            }
        }
    });
    wrappers.push(wrapper);
    return { wrapper, slot: (): ReadSlot =>
    {
        if (!observed)
        {
            throw new Error('read slot did not render');
        }
        return observed;
    } };
}

afterEach(() =>
{
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
    vi.restoreAllMocks();
    transport.requestBinaryOnly.mockReset();
});

describe('ArticleMetadataRead canonical API consumer', () =>
{
    it.each([0, 1, 8, 1000])('passes the unchanged canonical %i-definition wire model through the real API', async (count) =>
    {
        const model = response(`current-${count}`);
        transport.requestBinaryOnly.mockResolvedValueOnce(model);
        const { wrapper, slot } = render();
        await flushPromises();
        expect(transport.requestBinaryOnly).toHaveBeenCalledOnce();
        expect(transport.requestBinaryOnly.mock.calls[0]?.[0]).toEqual({
            binaryUrl: '/api/binary/author/articles/7/properties?ownerUserId=42',
            privateScope: 'admin', frameType: 269, signal: expect.any(AbortSignal),
            requestOptions: { method: 'GET', cache: 'no-store' }
        });
        expect(slot().state).toBe('ready');
        expect(slot().model).toBe(model);
        expect(slot().model?.definitions).toHaveLength(count);
        expect(wrapper.findAll('input, textarea, table, a, button')).toHaveLength(0);
        expect(wrapper.emitted()).toEqual({});
    });

    it('retains all eight typed payloads, exact revision strings, provenance and reconciliation without conversion', async () =>
    {
        const fetch = vi.spyOn(globalThis, 'fetch');
        const storage = vi.spyOn(Storage.prototype, 'setItem');
        const log = vi.spyOn(console, 'error');
        const model = response();
        transport.requestBinaryOnly.mockResolvedValueOnce(model);
        const { slot } = render();
        await flushPromises();
        expect(slot().model).toBe(model);
        expect(slot().model?.current?.snapshot.values.map((entry) => entry.value?.type)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(slot().model?.currentArticleRevisionId).toBe('9007199254740993');
        expect(slot().model?.current?.snapshotId).toBe(model.current?.snapshotId);
        expect(slot().model?.current?.factsetId).toBe(model.current?.factsetId);
        expect(slot().model?.current?.auditReference).toBe(model.current?.auditReference);
        expect(slot().model?.reconciliation).toBe(model.reconciliation);
        expect(fetch).not.toHaveBeenCalled();
        expect(storage).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
    });

    it('does not reload metadata on body source/digest changes', async () =>
    {
        const model = response();
        const context = documentContext();
        transport.requestBinaryOnly.mockResolvedValueOnce(model);
        const { wrapper, slot } = render({ context });
        await flushPromises();
        await wrapper.setProps({ context: { ...context, sourceRevision: 99, contentDigest: 'body-changed', contextDigest: 'body-context-changed' } });
        expect(transport.requestBinaryOnly).toHaveBeenCalledOnce();
        expect(slot().model).toBe(model);
    });

    it.each([
        ['article', { articleId: 8 }],
        ['document', { documentId: 'other-document' }],
        ['epoch', { documentEpoch: 2 }],
        ['session', { editorSessionId: 'other-session' }],
        ['site identity', { siteScope: 'site:other.example' }],
        ['user identity', { userScope: 'user:43' }],
        ['draft identity', { draftId: 'other-draft' }]
    ])('aborts and refuses a late result after %s switch', async (_name, change) =>
    {
        const first = pending();
        const second = pending();
        transport.requestBinaryOnly.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const { wrapper, slot } = render();
        const signal = transport.requestBinaryOnly.mock.calls[0]?.[0].signal as AbortSignal;
        await wrapper.setProps({ context: { ...documentContext(), ...change } });
        expect(signal.aborted).toBe(true);
        first.resolve(response());
        await flushPromises();
        expect(slot().model).toBeNull();
        expect(slot().state).toBe('loading');
        const model = { ...response(), articleId: 'articleId' in change ? change.articleId : 7 };
        if (model.current)
        {
            model.current.snapshot.coordinates.articleId = model.articleId;
        }
        second.resolve(model);
        await flushPromises();
        expect(slot().model).toBe(model);
    });

    it.each([
        ['disabled', { enabled: false }, 'inactive'],
        ['released binding', { context: null }, 'inactive'],
        ['create article', { context: { ...documentContext(), articleId: null } }, 'article-required'],
        ['independent draft', { context: { ...documentContext(), draftRevision: '51' } }, 'draft-unavailable']
    ])('withdraws data and never substitutes article facts for %s', async (_name, changed, state) =>
    {
        transport.requestBinaryOnly.mockResolvedValueOnce(response());
        const { wrapper, slot } = render();
        await flushPromises();
        await wrapper.setProps(changed);
        expect(slot().model).toBeNull();
        expect(slot().state).toBe(state);
        expect(transport.requestBinaryOnly).toHaveBeenCalledOnce();
    });

    it('withdraws old values before permission/schema refresh, cancels the superseded read, and retains the latest server revision', async () =>
    {
        const initial = response();
        const stale = pending();
        const latest = pending();
        transport.requestBinaryOnly.mockResolvedValueOnce(initial).mockReturnValueOnce(stale.promise).mockReturnValueOnce(latest.promise);
        const { wrapper, slot } = render();
        await flushPromises();
        await wrapper.setProps({ readKey: 'permissions-2' });
        expect(slot().model).toBeNull();
        const staleSignal = transport.requestBinaryOnly.mock.calls[1]?.[0].signal as AbortSignal;
        slot().refresh();
        await nextTick();
        expect(staleSignal.aborted).toBe(true);
        const current = { ...response(), propertyRevision: '9007199254740994' };
        if (current.current)
        {
            current.current.snapshot.coordinates.propertyRevision = current.propertyRevision;
        }
        latest.resolve(current);
        await flushPromises();
        stale.resolve(initial);
        await flushPromises();
        expect(slot().model).toBe(current);
        expect(slot().model?.propertyRevision).toBe('9007199254740994');
    });

    it('cancels the previous definition-owner scope without displaying its late facts', async () =>
    {
        const first = pending();
        const second = pending();
        transport.requestBinaryOnly.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const { wrapper, slot } = render();
        const signal = transport.requestBinaryOnly.mock.calls[0]?.[0].signal as AbortSignal;
        await wrapper.setProps({ definitionOwnerUserId: '43' });
        expect(signal.aborted).toBe(true);
        expect(transport.requestBinaryOnly.mock.calls[1]?.[0].binaryUrl).toBe('/api/binary/author/articles/7/properties?ownerUserId=43');
        first.resolve(response());
        await flushPromises();
        expect(slot().model).toBeNull();
        expect(slot().state).toBe('loading');
        second.resolve({ ...response('current-0'), scope: { ...response('current-0').scope, definitionOwnerUserId: '43' } });
        await flushPromises();
        expect(slot().state).toBe('ready');
    });

    it('does not expose exceptions or private values after failure; refresh retries the canonical read', async () =>
    {
        transport.requestBinaryOnly.mockRejectedValueOnce(new Error('private-value-secret')).mockResolvedValueOnce(response());
        const { wrapper, slot } = render();
        await flushPromises();
        expect(slot().state).toBe('unavailable');
        expect(slot().model).toBeNull();
        expect(wrapper.text()).not.toContain('private-value-secret');
        slot().refresh();
        await flushPromises();
        expect(slot().state).toBe('ready');
    });

    it('rejects delivery for a different article without inspecting or changing payloads', async () =>
    {
        transport.requestBinaryOnly.mockResolvedValueOnce({ ...response(), articleId: 8 });
        const { slot } = render();
        await flushPromises();
        expect(slot().state).toBe('unavailable');
        expect(slot().model).toBeNull();
    });

    it('aborts on permission loss and suppresses a late transport rejection', async () =>
    {
        const request = pending();
        transport.requestBinaryOnly.mockReturnValueOnce(request.promise);
        const { wrapper, slot } = render();
        const signal = transport.requestBinaryOnly.mock.calls[0]?.[0].signal as AbortSignal;
        await wrapper.setProps({ enabled: false });
        request.reject(new Error('late-private-error'));
        await flushPromises();
        expect(signal.aborted).toBe(true);
        expect(slot().state).toBe('inactive');
        expect(slot().model).toBeNull();
    });

    it('cancels outstanding reads when the owning inspector unmounts', async () =>
    {
        const request = pending();
        transport.requestBinaryOnly.mockReturnValueOnce(request.promise);
        const { wrapper, slot } = render();
        const signal = transport.requestBinaryOnly.mock.calls[0]?.[0].signal as AbortSignal;
        wrapper.unmount();
        request.resolve(response());
        await flushPromises();
        expect(signal.aborted).toBe(true);
        expect(slot().model).toBeNull();
    });

    it('uses the real API global-owner path and refuses invalid owners before any transport call', async () =>
    {
        transport.requestBinaryOnly.mockResolvedValueOnce({ ...response('current-0'), scope: { ...response('current-0').scope, definitionOwnerUserId: null } });
        const { wrapper, slot } = render({ definitionOwnerUserId: null });
        await flushPromises();
        expect(transport.requestBinaryOnly.mock.calls[0]?.[0].binaryUrl).toBe('/api/binary/author/articles/7/properties');
        await wrapper.setProps({ definitionOwnerUserId: 'user:42' });
        await flushPromises();
        expect(transport.requestBinaryOnly).toHaveBeenCalledOnce();
        expect(slot().state).toBe('unavailable');
        expect(slot().model).toBeNull();
    });
});
