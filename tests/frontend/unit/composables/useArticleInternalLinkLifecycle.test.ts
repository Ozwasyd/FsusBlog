// @vitest-environment happy-dom

import { ElMarkdownEditor, type MarkdownEditorCommandContext, type MarkdownEditorDispatchResult,
    type MarkdownEditorTransaction, type MarkdownEditorTransactionEvent } from '@ozwasyd/element-plus';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref, shallowRef } from 'vue';

import ArticleInternalLinkPreview from '@/components/admin/article/ArticleInternalLinkPreview.vue';
import { useArticleInternalLinkLifecycle, type ArticleInternalLinkPresentationLoaders } from '@/composables/useArticleInternalLinkLifecycle';
import { createMarkdownAnchorMap } from '@/fsusui/articlePositionMaps';
import { ArticleAnchorContextAdapter, type ArticleAnchorCaptureOptions } from '@/services/authoring/articleAnchorContext';
import { ArticleAttachmentContextAdapter, type ArticleAttachmentTransactionPort } from '@/services/authoring/articleAttachmentContext';
import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';
import { bindArticleEditorRuntime, type ArticleEditorRuntimeBinding } from '@/services/authoring/articleEditorRuntimeBinding';
import { calculateOpenArticleDocumentDigest as digest } from '@/services/authoring/openArticleDocumentRegistry';

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()); vi.restoreAllMocks(); });

const captureOptions: ArticleAnchorCaptureOptions = {
    affinity: 'after', viewportOffset: 0, percentage: 0, surface: 'source', tool: 'none'
};
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => { resolve = yes; });
    return { promise, resolve };
}
function presentationLoaders(overrides: Partial<ArticleInternalLinkPresentationLoaders> = {}): ArticleInternalLinkPresentationLoaders {
    // Only local component presentation fixtures. These do not prove server
    // permission, query, canonical URL or target admission.
    return {
        search: async request => ({ requestKey: request.requestKey, state: 'ready', articles: [], message: null }),
        headings: async request => ({ requestKey: request.requestKey, articleId: request.articleId,
            articleRevision: request.articleRevision, state: 'ready', headings: [], message: null }),
        preview: async () => null,
        ...overrides
    };
}
function harness() {
    let source = '# Heading\n\nChosen body';
    const owner = createArticleDocumentContextAdapter({ articleId: 1, draftId: 'article:1',
        editorSessionId: 'session:internal-link', siteScope: 'site:test', userScope: 'user:test', content: source });
    const anchors = new ArticleAnchorContextAdapter(owner);
    const attachments = new ArticleAttachmentContextAdapter(owner, 'article-assets', 'version:1', anchors);
    let binding: ArticleEditorRuntimeBinding | null = null;
    let context: MarkdownEditorCommandContext | null = null;
    const editor = mount(ElMarkdownEditor, { attachTo: document.body, props: {
        mode: 'source', modelValue: source, documentIdentity: owner.documentIdentity, surfaces: { toolbar: true },
        commands: [{ key: 'internal-link-lifecycle-fixture', label: '链接到文章', group: 'insert',
            run: command => { context = command; return { focus: 'surface' as const }; } }],
        'onUpdate:modelValue': (value: string) => { source = value; },
        onTransaction: (event: MarkdownEditorTransactionEvent) => binding?.consumeTransaction(event)
    } });
    const port = editor.vm as unknown as { dispatchTransaction(transaction: MarkdownEditorTransaction): MarkdownEditorDispatchResult; };
    const transactions: ArticleAttachmentTransactionPort = {
        dispatch: transaction => port.dispatchTransaction(transaction),
        commitSource: result => {
            source = result.value;
            if (result.revision > owner.context.sourceRevision) owner.updateSource(source, result.revision);
        },
        binding: () => ({ document: owner.context, map: createMarkdownAnchorMap({ identity: owner.documentIdentity, source }) })
    };
    binding = bindArticleEditorRuntime(owner, anchors, attachments, transactions, () => source, port, {
        surface: 'source', configuration: { allowLatex: true, allowMermaid: true, baseUrl: null },
        identity: { themeDigest: digest({ theme: 'fixture' }), locale: 'zh-CN' },
        cachePolicy: { maxEntryBytes: 65536, maxAgeMs: 60000, maxReceipts: 16 }
    });
    expect(binding.initialize()).toBe(true);
    const runtime = shallowRef<ArticleEditorRuntimeBinding | null>(binding);
    const enabled = ref(true);
    const loaders = shallowRef<ArticleInternalLinkPresentationLoaders | null>(null);
    const previewTarget = ref<string | null>(null);
    const scope = effectScope();
    const state = scope.run(() => useArticleInternalLinkLifecycle({ owner, runtime, enabled, loaders, previewTarget,
        restoreOptions: () => ({ now: 1, viewportHeight: 600, reducedMotion: true }) }))!;
    cleanups.push(() => { scope.stop(); binding?.dispose(); attachments.dispose(); editor.unmount(); owner.dispose(); });
    const command = async () => {
        const selected = port.dispatchTransaction({ changes: [], history: 'skip', origin: 'programmatic',
            expectedRevision: owner.context.sourceRevision, documentIdentity: owner.documentIdentity,
            selection: { start: 11, end: 17, direction: 'backward' } });
        expect(selected.accepted).toBe(true);
        await flushPromises();
        await editor.get('button[aria-label="链接到文章"]').trigger('click');
        await flushPromises();
        expect(context).not.toBeNull();
        return context!;
    };
    const open = async () => {
        const actual = await command();
        expect(state.openFromCommand(actual, captureOptions)).toBe(true);
        return actual;
    };
    const cancelPicker = () => state.cancel({ sessionKey: state.pickerProps.value.sessionKey,
        scope: 'picker', searchRequestKey: state.pickerProps.value.searchResult?.requestKey ?? null,
        headingRequestKey: state.pickerProps.value.headingResult?.requestKey ?? null });
    const request = (requestKey: string) => ({ sessionKey: state.pickerProps.value.sessionKey, requestKey, query: '' });
    return { owner, anchors, port, binding, runtime, enabled, loaders, previewTarget, scope, state,
        command, open, cancelPicker, request, readSource: () => source };
}

describe('internal link lifecycle with the original document owner and public native editor', () => {
    it('captures an actual command selection and restores it on picker cancel and closed without changing the body', async () => {
        const test = harness();
        const actual = await test.open();
        expect(test.state.pickerProps.value.modelValue).toBe(true);
        test.cancelPicker();
        expect(test.state.pickerProps.value.modelValue).toBe(false);
        expect(test.state.closed()).toBe(true);
        expect(test.anchors.receipts.at(-1)).toMatchObject({ kind: 'exact',
            range: { start: actual.selection.start, end: actual.selection.end }, direction: actual.selection.direction });
        expect(test.readSource()).toBe('# Heading\n\nChosen body');
        expect(test.owner.context.sourceRevision).toBe(0);
        expect(test.state.closed()).toBe(false);
    });

    it('rejects a stale original command context before opening or borrowing a task', async () => {
        const test = harness();
        const actual = await test.command();
        expect(test.state.openFromCommand({ ...actual, revision: actual.revision + 1 }, captureOptions)).toBe(false);
        expect(test.state.pickerProps.value.modelValue).toBe(false);
        expect(test.owner.activeTaskRefs).toEqual([]);
    });

    it('keeps missing query and canonical target contracts unavailable and never executes an opaque select action', async () => {
        const test = harness();
        await test.open();
        const request = test.request('search:1');
        expect(await test.state.requestSearch(request)).toBe(false);
        expect(test.state.pickerProps.value.searchResult).toMatchObject({ state: 'error', articles: [] });
        expect(test.state.pickerProps.value.selectionUnavailableText).not.toBeNull();
        const action = vi.fn();
        expect(test.state.select({ sessionKey: request.sessionKey, searchRequestKey: request.requestKey, action } as
            Parameters<typeof test.state.select>[0])).toBe(false);
        expect(action).not.toHaveBeenCalled();
        expect(test.state.closed()).toBe(true);
        expect(test.readSource()).toBe('# Heading\n\nChosen body');
    });

    it('cancels superseded original search leases and ignores a late response without clearing the newer request', async () => {
        const test = harness();
        const first = deferred<Awaited<ReturnType<ArticleInternalLinkPresentationLoaders['search']>>>();
        let oldSignal!: AbortSignal;
        test.loaders.value = presentationLoaders({ search: (request, signal) => {
            if (request.requestKey === 'search:old') { oldSignal = signal; return first.promise; }
            return Promise.resolve({ requestKey: request.requestKey, state: 'ready', articles: [], message: null });
        } });
        await test.open();
        const old = test.state.requestSearch(test.request('search:old'));
        expect(await test.state.requestSearch(test.request('search:new'))).toBe(true);
        expect(oldSignal.aborted).toBe(true);
        first.resolve({ requestKey: 'search:old', state: 'ready', articles: [], message: null });
        expect(await old).toBe(false);
        expect(test.state.pickerProps.value.searchResult?.requestKey).toBe('search:new');
        expect(test.owner.activeTaskRefs).toHaveLength(1);
    });

    it('revokes an actual document epoch synchronously and refuses late results or selection restoration into the next article', async () => {
        const test = harness();
        const pending = deferred<Awaited<ReturnType<ArticleInternalLinkPresentationLoaders['search']>>>();
        let signal!: AbortSignal;
        test.loaders.value = presentationLoaders({ search: (_request, input) => { signal = input; return pending.promise; } });
        await test.open();
        const result = test.state.requestSearch(test.request('search:old'));
        test.owner.switchDocument({ articleId: 2, draftId: 'article:2', content: test.readSource(), reason: 'article-switch' });
        expect(signal.aborted).toBe(true);
        expect(test.state.pickerProps.value.modelValue).toBe(false);
        pending.resolve({ requestKey: 'search:old', state: 'ready', articles: [], message: null });
        expect(await result).toBe(false);
        expect(test.state.closed()).toBe(false);
        expect(test.anchors.receipts).toEqual([]);
    });

    it('restores a backward selection through the real public transaction map after asynchronous source editing', async () => {
        const test = harness();
        const actual = await test.open();
        const result = test.port.dispatchTransaction({ changes: [{ from: 0, to: 0, insert: 'New\n' }], history: 'separate',
            documentIdentity: test.owner.documentIdentity, expectedRevision: test.owner.context.sourceRevision });
        expect(result.accepted).toBe(true);
        expect(test.state.observeTransaction(result)).toBe(true);
        test.cancelPicker();
        expect(test.state.closed()).toBe(true);
        expect(test.anchors.receipts.at(-1)).toMatchObject({ kind: 'rebased', rebase: ['mapped'],
            range: { start: actual.selection.start + 4, end: actual.selection.end + 4 }, direction: actual.selection.direction });
        expect(test.readSource()).toBe('New\n# Heading\n\nChosen body');
        expect(test.owner.context.sourceRevision).toBe(1);
    });

    it('refuses selection restoration when the host omits the native transaction chain', async () => {
        const test = harness();
        await test.open();
        const result = test.port.dispatchTransaction({ changes: [{ from: 0, to: 0, insert: 'New\n' }], history: 'separate',
            documentIdentity: test.owner.documentIdentity, expectedRevision: 0 });
        expect(result.accepted).toBe(true);
        test.cancelPicker();
        expect(test.state.closed()).toBe(false);
        expect(test.anchors.receipts.at(-1)?.reason).toBe('source-revision-unmapped');
        expect(test.readSource()).toBe(result.value);
    });

    it('passes the actual preview request signal and handles its open notification without executing the canonical action twice', async () => {
        const test = harness();
        const action = vi.fn();
        test.previewTarget.value = 'fixture:owner-coordinate';
        test.loaders.value = presentationLoaders({ preview: async () => ({ title: 'Fixture title', excerpt: null,
            statusText: null, sectionText: null, openInNewTab: action }) });
        await test.open();
        const wrapper = mount(ArticleInternalLinkPreview, { attachTo: document.body, props: {
            ...test.state.previewProps.value, onOpen: test.state.previewOpened
        } });
        cleanups.push(() => wrapper.unmount());
        expect(await test.state.requestPreview({ targetKey: test.previewTarget.value!, trigger: 'action' })).toBe(true);
        await wrapper.setProps(test.state.previewProps.value);
        await flushPromises();
        const request = test.state.previewProps.value.request!;
        const button = document.querySelector<HTMLButtonElement>('[data-internal-link-preview-open]');
        expect(button).not.toBeNull();
        button!.click();
        await flushPromises();
        expect(action).toHaveBeenCalledTimes(1);
        expect(request.signal.aborted).toBe(true);
        expect(test.state.previewProps.value.presentation).toBeNull();
        expect(test.state.pickerProps.value.modelValue).toBe(true);
        expect(test.readSource()).toBe('# Heading\n\nChosen body');
    });

    it('restores the original selection on standalone preview dismissal', async () => {
        const test = harness();
        test.previewTarget.value = 'fixture:owner-coordinate';
        test.loaders.value = presentationLoaders();
        const actual = await test.command();
        expect(await test.state.openPreviewFromCommand(actual, captureOptions,
            { targetKey: test.previewTarget.value, trigger: 'focus' })).toBe(true);
        const request = test.state.previewProps.value.request!;
        expect(test.state.dismissPreview({ request })).toBe(true);
        expect(request.signal.aborted).toBe(true);
        expect(test.anchors.receipts.at(-1)?.direction).toBe(actual.selection.direction);
        expect(test.readSource()).toBe('# Heading\n\nChosen body');
    });

    it('withdraws preview content on owner target changes and rejects an ignored-abort late response', async () => {
        const test = harness();
        const pending = deferred<Awaited<ReturnType<ArticleInternalLinkPresentationLoaders['preview']>>>();
        test.previewTarget.value = 'fixture:old-coordinate';
        test.loaders.value = presentationLoaders({ preview: () => pending.promise });
        await test.open();
        const result = test.state.requestPreview({ targetKey: test.previewTarget.value, trigger: 'hover' });
        const request = test.state.previewProps.value.request!;
        test.previewTarget.value = null;
        expect(request.signal.aborted).toBe(true);
        pending.resolve({ title: 'Late private fixture', excerpt: null, statusText: null, sectionText: null, openInNewTab: null });
        expect(await result).toBe(false);
        expect(test.state.previewProps.value).toEqual({ targetKey: null, request: null, presentation: null });
    });

    it('responds to the original task registry superseding its request without canceling the other owner task', async () => {
        const test = harness();
        const pending = deferred<Awaited<ReturnType<ArticleInternalLinkPresentationLoaders['search']>>>();
        test.loaders.value = presentationLoaders({ search: () => pending.promise });
        await test.open();
        const result = test.state.requestSearch(test.request('search:old'));
        const other = test.owner.beginTask('feature', 'internal-link:search', 'internal-link-lifecycle:v1');
        pending.resolve({ requestKey: 'search:old', state: 'ready', articles: [], message: null });
        expect(await result).toBe(false);
        expect(test.state.pickerProps.value.searchResult).toBeNull();
        expect(other.isCurrent()).toBe(true);
        other.cancel();
    });

    it('cancels original pending leases and unsubscribes on scope disposal', async () => {
        const test = harness();
        const pending = deferred<Awaited<ReturnType<ArticleInternalLinkPresentationLoaders['search']>>>();
        let signal!: AbortSignal;
        test.loaders.value = presentationLoaders({ search: (_request, input) => { signal = input; return pending.promise; } });
        await test.open();
        const result = test.state.requestSearch(test.request('search:old'));
        test.scope.stop();
        expect(signal.aborted).toBe(true);
        pending.resolve({ requestKey: 'search:old', state: 'ready', articles: [], message: null });
        expect(await result).toBe(false);
        expect(test.state.closed()).toBe(false);
        expect(test.owner.activeTaskRefs).toEqual([]);
    });
});
