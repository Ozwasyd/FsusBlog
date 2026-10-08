// @vitest-environment happy-dom

import { ElDrawer, ElIcon, type MarkdownEditorDispatchResult, type MarkdownEditorTransaction, type MarkdownEditorTransactionEvent } from '@ozwasyd/element-plus';
import { flushPromises, mount } from '@vue/test-utils';
import { renderToString } from 'vue/server-renderer';
import { createSSRApp, defineComponent, h, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as selectionNetwork from '@/api/binaryApiClient';
import { encodeAedsFrame } from '@/api/binaryFrame';
import { decodeAuthorArticleSelectionRevalidationRequest, encodeAuthorArticleSelectionRevalidationResponse, type AuthorArticleSelectionRevalidationRequest } from '@/codecs/binary/authorArticleSelectionWire.generated';
import { revalidateArticleSearchSelection } from '@/services/authoring/articleSearchSelection';
import { privateRequestRuntime } from '@/services/privateRequestRuntime';
import { FrameType } from '@wasm/protocol/frame';

import ArticleSearchRevealStatus from '@/components/admin/article/ArticleSearchRevealStatus.vue';
import ArticleWriteEditor from '@/components/admin/article/ArticleWriteEditor.vue';
import { useAdminArticleWrite } from '@/composables/useAdminArticleWrite';
import { type ArticleEditorContinuityPort } from '@/services/authoring/articleEditorContinuity';
import { calculateOpenArticleDocumentDigest } from '@/services/authoring/openArticleDocumentRegistry';

// Only bootstrap/network dependencies are replaced. Search, document ownership,
// production bindEditor, wrapper events, public editor and semantic maps are real.
// Exercise the original envelope decoder and generated payload codec; native Wasm/HTTP are separate gates.
vi.mock('@wasm/aeds', async original => await original<typeof import('@wasm/aeds')>());

const boot = vi.hoisted(() => ({ principalId: '', push: vi.fn() }));
vi.mock('vue-router', () => ({
    useRoute: () => ({ params: {}, query: {} }),
    useRouter: () => ({ push: boot.push })
}));
vi.mock('@/store/admin', () => ({
    useAdminStore: () => ({
        setPageTitle: vi.fn(), adminPrincipal: { id: boot.principalId, username: 'search-consumer' }
    })
}));
vi.mock('@/api/article', () => ({
    ArticlePublishStatus: { Draft: 0, Published: 1, Scheduled: 2, Private: 3 },
    createArticle: vi.fn(), updateArticle: vi.fn(), getAdminArticleById: vi.fn()
}));
vi.mock('@/api/authoring', () => ({
    saveServerDraft: vi.fn().mockResolvedValue({ clientRevision: 'search:test', serverRevision: 1,
        savedAt: 0, updatedAt: '2026-10-08T00:00:00Z' }),
    getServerDraft: vi.fn().mockResolvedValue(null), discardServerDraft: vi.fn(),
    checkArticlePrepublish: vi.fn(), generateAiAssist: vi.fn(), createArticlePreviewSourceIdentity: vi.fn(),
    cleanupOrphanAssets: vi.fn(), listAssetLibrary: vi.fn().mockResolvedValue([]),
    listArticleRevisions: vi.fn().mockResolvedValue([]), getArticleRevision: vi.fn(),
    rollbackArticleRevision: vi.fn(), reindexArticleAssets: vi.fn(), previewArticleDraft: vi.fn()
}));
vi.mock('@/api/category', () => ({ getCategories: vi.fn().mockResolvedValue([]), createCategory: vi.fn() }));
vi.mock('@/api/tag', () => ({ getTags: vi.fn().mockResolvedValue([]), createTag: vi.fn() }));
vi.mock('@/api/system', () => ({
    getAdminSiteConfig: vi.fn().mockResolvedValue({ siteName: 'Search test', baseUrl: 'https://search.test',
        enableArticleRights: false, rights: {} }),
    getAdminSiteComplianceConfig: vi.fn().mockResolvedValue({})
}));

const cleanups: (() => void)[] = [];
let sequence = 0;
beforeEach(() => { boot.principalId = `search-writer-${++sequence}`; privateRequestRuntime.resetForTests(); });
afterEach(() =>
{
    cleanups.splice(0).reverse().forEach(cleanup => cleanup());
    vi.restoreAllMocks();
});
const labels = {
    label: 'Source reveal',
    statusLabels: { ready: 'Command available', paused: 'Paused', rejected: 'Unavailable', unavailable: 'Unavailable' },
    precisionLabels: { exact: 'Exact source range', rebased: 'Mapped after edits', partial: 'Partial source range',
        'semantic-neighbor': 'Nearby semantic position', percentage: 'Approximate percentage' }
};
const restoreOptions = { origin: 'search' as const, now: 100, viewportHeight: 500, reducedMotion: true };

async function openWriter()
{
    let authoring!: ReturnType<typeof useAdminArticleWrite>;
    const host = mount(defineComponent({
        setup()
        {
            authoring = useAdminArticleWrite();
            return {};
        },
        template: '<div />'
    }));
    cleanups.push(() => host.unmount());
    await vi.waitFor(async () =>
    {
        await flushPromises();
        expect(authoring.pageLoading.value).toBe(false);
    }, { timeout: 3000 });

    type Bound = ReturnType<typeof authoring.authoringEditorRuntime.bindEditor>;
    let bound: Bound | null = null;
    const consumed: boolean[] = [];
    const editor = mount(ArticleWriteEditor, { global: { components: { ElDrawer, ElIcon } }, props: {
        modelValue: authoring.articleForm.content, documentIdentity: authoring.authoringDocumentIdentity.value,
        'onUpdate:modelValue': (value: string) => { authoring.articleForm.content = value; },
        onTransaction: (event: MarkdownEditorTransactionEvent) =>
        {
            if (bound) consumed.push(bound.binding.consumeTransaction(event));
        },
        onEditorFocus: (event: 'focusin' | 'focusout') => bound?.binding.consumeFocus(event)
    } });
    const exposed = editor.vm as unknown as { getAuthoringEditorPort(): ArticleEditorContinuityPort | null; };
    const port = exposed.getAuthoringEditorPort();
    expect(port).not.toBeNull();
    expect(exposed.getAuthoringEditorPort()).toBe(port);
    bound = authoring.authoringEditorRuntime.bindEditor(port!, {
        surface: 'source', configuration: { allowLatex: true, allowMermaid: true, baseUrl: null },
        identity: { themeDigest: calculateOpenArticleDocumentDigest({ theme: 'search-test' }), locale: 'zh-CN' },
        cachePolicy: { maxEntryBytes: 65536, maxAgeMs: 60000, maxReceipts: 16 }
    });
    const session = bound;
    cleanups.push(() => { session.release(); editor.unmount(); });
    expect(session.binding.initialize()).toBe(true);
    const dispatch = (changes: MarkdownEditorTransaction['changes']) =>
    {
        const result = port!.dispatchTransaction({ changes, history: 'separate', origin: 'programmatic',
            documentIdentity: authoring.authoringDocumentIdentity.value,
            expectedRevision: session.binding.context.sourceRevision });
        expect({ accepted: result.accepted, reason: result.reason }).toEqual({ accepted: true, reason: undefined });
        expect(consumed.at(-1)).toBe(true);
        expect(session.binding.context.sourceRevision).toBe(result.revision);
        return result;
    };
    dispatch([{ from: 0, to: 0, insert: 'abcdef PRIVATE_SEARCH_DRAFT_2319' }]);
    await nextTick();
    const saved = session.binding.anchors.capture(session.binding.positionBinding(), {
        start: 1, end: 5, direction: 'forward'
    }, { affinity: 'after', viewportOffset: 0, percentage: 0.2, surface: 'source', tool: 'none' });
    const restore = (transactions?: readonly MarkdownEditorDispatchResult[]) =>
        session.binding.anchors.restore(saved, session.binding.positionBinding(), { ...restoreOptions, transactions });
    const status = mount(ArticleSearchRevealStatus, { props: { ...labels, search: session.search } });
    cleanups.push(() => status.unmount());
    const begin = () =>
    {
        const lease = session.search.beginTask('search:writer-consumer', 'search:test-v1');
        expect(session.search.currentTask).toBe(lease);
        expect(lease.envelope.kind).toBe('search');
        expect(lease.envelope.context.contextDigest).toBe(session.binding.context.contextDigest);
        expect(lease.isCurrent()).toBe(true);
        return lease;
    };
    const ready = async () =>
    {
        const lease = begin();
        const command = restore();
        expect(session.search.projectCommand(command, lease)).toMatchObject({ status: 'ready', precision: 'exact' });
        await nextTick();
        expect(status.text()).toContain('Exact source range');
        expect(status.html()).not.toContain(command.contentDigest);
        expect(status.html()).not.toContain('PRIVATE_SEARCH_DRAFT_2319');
        return { lease, command };
    };
    const expectCleared = async () =>
    {
        await nextTick();
        expect(session.search.currentTask).toBeNull();
        expect(session.search.presentation).toBeNull();
        expect(status.text()).toBe('Source reveal: Unavailable');
        expect(status.html()).not.toContain('Exact source range');
        expect(status.findAll('button, a, input')).toHaveLength(0);
    };
    return { authoring, host, session, dispatch, restore, begin, ready, status, expectCleared };
}

describe('search reveal consumes the production Writer search lifecycle', () =>
{
    it('shows a real bound.search command without navigation or history acknowledgement', async () =>
    {
        const state = await openWriter();
        expect(state.status.text()).toBe('Source reveal: Unavailable');
        const context = state.session.binding.context;
        const { lease, command } = await state.ready();
        expect(state.session.search.presentation?.commandDigest).toBe(command.contentDigest);
        expect(state.session.binding.context).toBe(context);
        expect(lease.envelope.status).toBe('running');
        expect(boot.push).not.toHaveBeenCalled();
    });

    it.each(['close', 'abort', 'release', 'unmount'] as const)(
        'clears live text and precision after actual %s', async action =>
        {
            const state = await openWriter();
            const { lease, command } = await state.ready();
            if (action === 'close') state.session.search.cancel();
            else if (action === 'abort') lease.cancel('PRIVATE_QUERY_CANCELED_2319');
            else if (action === 'release') state.session.release();
            else state.host.unmount();
            expect(lease.signal.aborted).toBe(true);
            await state.expectCleared();
            expect(state.status.html()).not.toContain('PRIVATE_QUERY_CANCELED_2319');
            expect(() => state.session.search.projectCommand(command, lease)).toThrow();
        }
    );

    it('replacement aborts the old lease, clears precision and refuses late old work', async () =>
    {
        const state = await openWriter();
        const old = await state.ready();
        const next = state.begin();
        expect(old.lease.signal.aborted).toBe(true);
        await nextTick();
        expect(state.status.text()).toBe('Source reveal: Unavailable');
        expect(() => state.session.search.projectCommand(old.command, old.lease)).toThrow('article-editor-search-task-stale');
        expect(state.session.search.currentTask).toBe(next);
        expect(state.session.search.projectCommand(state.restore(), next)?.status).toBe('ready');
        await nextTick();
        expect(state.status.text()).toContain('Exact source range');
    });

    it('a completed lease cannot retain current availability or accept a late command', async () =>
    {
        const state = await openWriter();
        const { lease, command } = await state.ready();
        lease.complete(state.session.binding.context.sourceRevision);
        expect(lease.isCurrent()).toBe(false);
        expect(state.session.search.refresh()).toMatchObject({ status: 'rejected', reason: 'search-reveal-lease-stale' });
        await nextTick();
        expect(state.status.text()).toBe('Source reveal: Unavailable');
        expect(state.status.html()).not.toContain('search-reveal-lease-stale');
        expect(() => state.session.search.projectCommand(command, lease)).toThrow('article-editor-search-task-stale');
    });

    it.each([
        ['rebased', [{ from: 0, to: 0, insert: 'X' }]],
        ['partial', [{ from: 2, to: 4, insert: '' }]],
        ['semantic-neighbor', [{ from: 1, to: 5, insert: '' }]],
        ['percentage', []]
    ] as const)('clears the old lease on native revision change and consumes original %s composition', async (precision, changes) =>
    {
        const state = await openWriter();
        const old = await state.ready();
        const transaction = state.dispatch(precision === 'percentage'
            ? [{ from: 0, to: state.authoring.articleForm.content.length, insert: '' }]
            : [...changes]);
        if (precision === 'percentage')
        {
            expect(transaction.value).toBe('');
            expect(state.session.binding.positionBinding().map.source).toBe('');
            expect(state.session.binding.positionBinding().map.syntax).toHaveLength(0);
        }
        expect(old.lease.signal.aborted).toBe(true);
        await state.expectCleared();
        const lease = state.begin();
        const command = state.restore([transaction]);
        expect(command.kind).toBe(precision);
        expect(state.session.search.projectCommand(command, lease)).toMatchObject({
            status: 'ready', precision, exact: false, commandDigest: command.contentDigest
        });
        await nextTick();
        expect(state.status.text()).toContain(labels.precisionLabels[precision]);
        expect(() => state.session.search.projectCommand(old.command, old.lease)).toThrow('article-editor-search-task-stale');
    });

    it('search cancellation preserves an independently owned compare task', async () =>
    {
        const state = await openWriter();
        const compare = state.session.binding.beginToolTask('source-compare');
        const { lease } = await state.ready();
        state.session.search.cancel();
        await state.expectCleared();
        expect(lease.signal.aborted).toBe(true);
        expect(compare.signal.aborted).toBe(false);
        expect(compare.isCurrent()).toBe(true);
    });

    it('withholds unadmitted snippet evidence through the actual owned runtime', async () =>
    {
        const state = await openWriter();
        const { lease } = await state.ready();
        const evidence = { recordType: 'AuthorSearchSourceSnippetEvidence', RawText: 'PRIVATE_SNIPPET_2319',
            DocumentEpoch: 'PRIVATE_SERVER_EPOCH_2319' };
        expect(state.session.search.projectCommand(evidence, lease)).toMatchObject({
            status: 'rejected', precision: null, reason: 'search-reveal-command-invalid'
        });
        await nextTick();
        expect(state.status.text()).toBe('Source reveal: Unavailable');
        for (const secret of ['PRIVATE_SNIPPET_2319', 'PRIVATE_SERVER_EPOCH_2319', 'search-reveal-command-invalid'])
        {
            expect(state.status.html()).not.toContain(secret);
        }
        expect(lease.isCurrent()).toBe(true);
    });

    it('reads the actual runtime snapshot in SSR without retaining a subscription or serializing private context', async () =>
    {
        const state = await openWriter();
        const { lease, command } = await state.ready();
        const context = state.session.binding.context;
        const subscribe = vi.spyOn(state.session.search, 'subscribe');
        const html = await renderToString(createSSRApp({
            render: () => h(ArticleSearchRevealStatus, { ...labels, search: state.session.search })
        }));
        expect(subscribe).not.toHaveBeenCalled();
        expect(html).toContain('Exact source range');
        for (const secret of ['PRIVATE_SEARCH_DRAFT_2319', command.contentDigest, context.contextDigest,
            context.contentDigest, context.documentId, context.siteScope, context.userScope])
        {
            expect(html).not.toContain(secret);
        }
        expect(lease.isCurrent()).toBe(true);
    });

    it('unsubscribes the component while preserving the original search task', async () =>
    {
        const state = await openWriter();
        const { lease } = await state.ready();
        const original = state.session.search.subscribe.bind(state.session.search);
        let unsubscriptions = 0;
        // Instrument the actual unsubscribe; no owner state, lease or projection is replaced.
        vi.spyOn(state.session.search, 'subscribe').mockImplementation(listener =>
        {
            const unsubscribe = original(listener);
            return () => { unsubscriptions++; unsubscribe(); };
        });
        const view = mount(ArticleSearchRevealStatus, { props: { ...labels, search: state.session.search } });
        expect(view.text()).toContain('Exact source range');
        view.unmount();
        expect(unsubscriptions).toBe(1);
        expect(lease.isCurrent()).toBe(true);
        expect(state.session.search.currentTask).toBe(lease);
        state.session.search.refresh();
        expect(unsubscriptions).toBe(1);
    });

    it('withholds availability when both runtime and snapshot inputs are supplied', async () =>
    {
        const state = await openWriter();
        const { lease, command } = await state.ready();
        await state.status.setProps({ presentation: state.session.search.presentation });
        expect(state.status.text()).toBe('Source reveal: Unavailable');
        expect(state.status.html()).not.toContain(command.contentDigest);
        expect(state.status.html()).not.toContain('Exact source range');
        await state.status.setProps({ presentation: undefined });
        expect(state.status.text()).toContain('Exact source range');
        expect(lease.isCurrent()).toBe(true);
    });

    it.each([true, false])('does not turn a Current=%s selected-ID observation into a reveal command', async current =>
    {
        const state = await openWriter();
        const { lease } = await state.ready();
        // Untrusted original C# record-shaped samples from d36532bc, not decoded
        // responses or server revalidation receipts. This port supplies no range.
        const observation = {
            Current: current,
            Owner: { AdminPrincipalId: 7, SiteScope: 'PRIVATE_SELECTION_SCOPE_2319' },
            ArticleId: 1, ServerRevision: 10, RequestId: '019a6211-6f00-7000-8000-000000002319',
            PermissionToken: current ? 'b'.repeat(64) : null
        };
        expect(state.session.search.projectCommand(observation, lease)).toMatchObject({
            status: 'rejected', precision: null, reason: 'search-reveal-command-invalid'
        });
        await nextTick();
        expect(state.status.text()).toBe('Source reveal: Unavailable');
        for (const secret of [observation.Owner.SiteScope, observation.RequestId, 'b'.repeat(64),
            'search-reveal-command-invalid', 'Exact source range'])
        {
            expect(state.status.html()).not.toContain(secret);
        }
        expect(lease.isCurrent()).toBe(true);
        expect(state.session.search.currentTask).toBe(lease);
        expect(boot.push).not.toHaveBeenCalled();
    });
});

// Synthetic selected-ID wire vectors, not authenticated server/query receipts.
const selectionRequest = (): AuthorArticleSelectionRevalidationRequest => ({
    schemaVersion: 1, articleId: 27, serverRevision: '9223372036854775807',
    requestId: '018f1ce7-093a-7a01-bbcc-123456789abc', permissionToken: 'a'.repeat(64)
});
const selectionReply = (request = selectionRequest(), current = true,
    changes: Partial<Parameters<typeof encodeAuthorArticleSelectionRevalidationResponse>[0]> = {}) =>
    encodeAedsFrame(FrameType.AuthorArticleSelectionRevalidateResponse,
        encodeAuthorArticleSelectionRevalidationResponse({ ...request, current,
            owner: { adminPrincipalId: '9223372036854775807', siteScope: 'PRIVATE_SELECTION_SCOPE_2319' },
            permissionToken: current ? request.permissionToken : null, ...changes }));

function pendingSelectionNetwork()
{
    const pending: { options: NonNullable<Parameters<typeof selectionNetwork.binaryRequest>[1]>; complete: (bytes: ArrayBuffer) => void; }[] = [];
    const original = selectionNetwork.binaryRequest;
    vi.spyOn(selectionNetwork, 'binaryRequest').mockImplementation((url, options) =>
    {
        if (url !== '/api/binary/author/articles/revalidate-selection')
        {
            return original(url, options);
        }
        expect(options).toBeDefined();
        return new Promise<ArrayBuffer>(resolve => pending.push({ options: options!, complete: resolve }));
    });
    return pending;
}

describe('selected-ID transport is consumed under the original Writer search lease', () =>
{
    it('withholds old precision while pending and returns only the actual wire observation and retained lease', async () =>
    {
        const state = await openWriter();
        const { lease: oldLease } = await state.ready();
        const compare = state.session.binding.beginToolTask('source-compare', 'compare:selection-control');
        const network = pendingSelectionNetwork();
        const pending = revalidateArticleSearchSelection(selectionRequest(), state.session.search);
        const lease = state.session.search.currentTask!;
        await nextTick();
        expect(oldLease.signal.aborted).toBe(true);
        expect(lease.isCurrent()).toBe(true);
        expect(state.status.text()).toBe('Source reveal: Unavailable');
        expect(network).toHaveLength(1);
        expect(network[0]!.options).toMatchObject({ method: 'POST', requiresPow: true });
        const bytes = new Uint8Array(network[0]!.options.body as ArrayBuffer);
        expect(bytes).toHaveLength(116);
        expect(new DataView(bytes.buffer).getUint16(8, true)).toBe(276);
        expect(decodeAuthorArticleSelectionRevalidationRequest(bytes.subarray(16))).toEqual(selectionRequest());
        network[0]!.complete(selectionReply());
        const result = await pending;
        expect(result!.lease).toBe(lease);
        expect(result!.selection.serverRevision).toBe('9223372036854775807');
        expect(result!.selection.owner.adminPrincipalId).toBe('9223372036854775807');
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result!.selection)).toBe(true);
        expect(state.session.search.presentation).toBeNull();
        expect(state.status.text()).toBe('Source reveal: Unavailable');
        expect(compare.isCurrent()).toBe(true);
        expect(state.session.search.projectCommand(result!.selection, lease)).toMatchObject({ status: 'rejected', precision: null });
        expect(boot.push).not.toHaveBeenCalled();
    });

    it('clears availability and the selected lease on a genuine Current=false wire observation', async () =>
    {
        const state = await openWriter();
        await state.ready();
        const compare = state.session.binding.beginToolTask('source-compare', 'compare:denial-control');
        const network = pendingSelectionNetwork();
        const pending = revalidateArticleSearchSelection(selectionRequest(), state.session.search);
        const lease = state.session.search.currentTask!;
        network[0]!.complete(selectionReply(selectionRequest(), false));
        expect(await pending).toBeNull();
        expect(lease.signal.aborted).toBe(true);
        await state.expectCleared();
        expect(compare.isCurrent()).toBe(true);
        expect(boot.push).not.toHaveBeenCalled();
    });

    it.each(['cancel', 'native-edit', 'release', 'complete', 'admin-logout', 'admin-identity-change'])
    ('refuses a late reply after actual %s and clears only the retained search lease', async transition =>
    {
        const state = await openWriter();
        await state.ready();
        const network = pendingSelectionNetwork();
        const pending = revalidateArticleSearchSelection(selectionRequest(), state.session.search);
        const lease = state.session.search.currentTask!;
        if (transition === 'cancel') state.session.search.cancel();
        if (transition === 'native-edit') state.dispatch([{ from: 0, to: 0, insert: 'prefix ' }]);
        if (transition === 'release') state.session.release();
        if (transition === 'complete') lease.complete(state.session.binding.context.sourceRevision);
        if (transition === 'admin-logout') privateRequestRuntime.advanceForAuthTransition('admin-logout');
        if (transition === 'admin-identity-change') privateRequestRuntime.advance('admin');
        if (transition !== 'complete') expect(network[0]!.options.signal!.aborted).toBe(true);
        network[0]!.complete(selectionReply());
        expect(await pending).toBeNull();
        await state.expectCleared();
        expect(boot.push).not.toHaveBeenCalled();
    });

    it.each([true, false])('an obsolete Current=%s reply cannot cancel or project a newer selection', async current =>
    {
        const state = await openWriter();
        const network = pendingSelectionNetwork();
        const old = revalidateArticleSearchSelection(selectionRequest(), state.session.search);
        const oldLease = state.session.search.currentTask!;
        const freshRequest = { ...selectionRequest(), requestId: '11111111-1111-1111-1111-111111111111' };
        const fresh = revalidateArticleSearchSelection(freshRequest, state.session.search);
        const freshLease = state.session.search.currentTask!;
        expect(oldLease.signal.aborted).toBe(true);
        network[0]!.complete(selectionReply(selectionRequest(), current));
        expect(await old).toBeNull();
        expect(state.session.search.currentTask).toBe(freshLease);
        expect(freshLease.isCurrent()).toBe(true);
        network[1]!.complete(selectionReply(freshRequest));
        const result = await fresh;
        expect(result!.lease).toBe(freshLease);
        expect(result!.selection.requestId).toBe(freshRequest.requestId);
        expect(state.session.search.presentation).toBeNull();
        expect(boot.push).not.toHaveBeenCalled();
    });

    it.each(['article', 'revision', 'request', 'token', 'trailing'])
    ('preserves original protocol rejection for %s and hides old precision and private diagnostics', async fault =>
    {
        const state = await openWriter();
        await state.ready();
        const network = pendingSelectionNetwork();
        const pending = revalidateArticleSearchSelection(selectionRequest(), state.session.search);
        const changes: Partial<Parameters<typeof encodeAuthorArticleSelectionRevalidationResponse>[0]> = {};
        if (fault === 'article') changes.articleId = 28;
        if (fault === 'revision') changes.serverRevision = '1';
        if (fault === 'request') changes.requestId = '11111111-1111-1111-1111-111111111111';
        if (fault === 'token') changes.permissionToken = 'b'.repeat(64);
        let frame = selectionReply(selectionRequest(), true, changes);
        if (fault === 'trailing')
        {
            const payload = new Uint8Array(frame).subarray(16);
            frame = encodeAedsFrame(FrameType.AuthorArticleSelectionRevalidateResponse, Uint8Array.from([...payload, 0]));
        }
        network[0]!.complete(frame);
        await expect(pending).rejects.toThrow('author_article_selection_response_invalid');
        await state.expectCleared();
        for (const secret of ['PRIVATE_SELECTION_SCOPE_2319', selectionRequest().permissionToken,
            'author_article_selection_response_invalid', 'Exact source range'])
        {
            expect(state.status.html()).not.toContain(secret);
        }
        expect(boot.push).not.toHaveBeenCalled();
    });

    it('consumes original request freezing without converting Int64 into document revision authority', async () =>
    {
        const state = await openWriter();
        const network = pendingSelectionNetwork();
        const request = selectionRequest();
        const context = state.session.binding.context;
        const pending = revalidateArticleSearchSelection(request, state.session.search);
        request.serverRevision = '1';
        request.permissionToken = 'b'.repeat(64);
        network[0]!.complete(selectionReply());
        const result = await pending;
        expect(result!.selection.serverRevision).toBe('9223372036854775807');
        expect(state.session.binding.context).toBe(context);
        expect(result!.lease.envelope.context).toEqual(context);
        expect(state.session.search.presentation).toBeNull();
        expect(boot.push).not.toHaveBeenCalled();
    });

    it('retains a transport failure while clearing only its own search lease and private display', async () =>
    {
        const state = await openWriter();
        await state.ready();
        const compare = state.session.binding.beginToolTask('source-compare', 'compare:transport-failure');
        const failure = new Error('PRIVATE_SELECTION_TRANSPORT_FAILURE_2319');
        vi.spyOn(selectionNetwork, 'binaryRequest').mockRejectedValueOnce(failure);
        await expect(revalidateArticleSearchSelection(selectionRequest(), state.session.search)).rejects.toBe(failure);
        await state.expectCleared();
        expect(state.status.html()).not.toContain(failure.message);
        expect(compare.isCurrent()).toBe(true);
        expect(boot.push).not.toHaveBeenCalled();
    });

    it('does not send an invalid original wire request or retain old precision after its rejection', async () =>
    {
        const state = await openWriter();
        await state.ready();
        const network = pendingSelectionNetwork();
        await expect(revalidateArticleSearchSelection({ ...selectionRequest(), serverRevision: '9223372036854775808' },
            state.session.search)).rejects.toThrow('author_article_selection_payload_invalid');
        expect(network).toHaveLength(0);
        await state.expectCleared();
        expect(boot.push).not.toHaveBeenCalled();
    });
});
