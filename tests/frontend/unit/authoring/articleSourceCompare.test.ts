// @vitest-environment happy-dom
import { ElDrawer, ElIcon, ElMarkdownEditor } from '@ozwasyd/element-plus';
import { MARKDOWN_RENDERER_VERSION, createMarkdownAnchorMap, renderMarkdownResultWithRuntime } from '@ozwasyd/element-plus/markdown-runtime';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';

import ArticleWriteEditor from '@/components/admin/article/ArticleWriteEditor.vue';
import { ArticleAnchorContextAdapter } from '@/services/authoring/articleAnchorContext';
import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';
import { createArticleEditorContinuityAcknowledgement, validateArticleEditorContinuityReceipt } from '@/services/authoring/articleEditorContinuity';
import { ArticleAttachmentContextAdapter } from '@/services/authoring/articleAttachmentContext';
import { bindArticleEditorRuntime } from '@/services/authoring/articleEditorRuntimeBinding';
import { ArticleSourceCompareSession, isArticleSourceCompareAvailable, validateArticleSourceCompareRequest } from '@/services/authoring/articleSourceCompare';
import { calculateOpenArticleDocumentDigest as digest } from '@/services/authoring/openArticleDocumentRegistry';

import type { MarkdownEditorDispatchResult, MarkdownEditorTransaction } from '@ozwasyd/element-plus';
import type { ArticleEditorRuntimeBinding } from '@/services/authoring/articleEditorRuntimeBinding';
import type { ArticleEditorContinuityPort, ArticleEditorContinuityReceipt } from '@/services/authoring/articleEditorContinuity';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(dispose => dispose()));
const viewport = { inlineSize: 1366, mobile: false };
const restore = { origin: 'tool' as const, now: 100, viewportHeight: 500, reducedMotion: true };

async function host(initialSurface: 'live' | 'source' = 'source', initialSource = '\ufeff# Heading\r\n\r\nparagraph  \r\n', productionWrapper = false)
{
    let source = initialSource;
    const owner = createArticleDocumentContextAdapter({ articleId: 1, draftId: 'article:1', editorSessionId: 'session:compare', siteScope: 'site:test', userScope: 'user:test', content: source });
    const anchors = new ArticleAnchorContextAdapter(owner);
    const configuration = { allowLatex: true, allowMermaid: true, baseUrl: null };
    const identity = { rendererVersion: MARKDOWN_RENDERER_VERSION, projectionVersion: MARKDOWN_RENDERER_VERSION, featureConfigurationDigest: digest(configuration), themeDigest: digest({ theme: 'light' }), locale: 'zh-CN' };
    const attachments = new ArticleAttachmentContextAdapter(owner, 'compare-test', 'v1.0', anchors);
    let runtime: ArticleEditorRuntimeBinding | null = null;
    const wrapper = mount(productionWrapper ? ArticleWriteEditor : ElMarkdownEditor, { attachTo: document.body,
        global: { components: { ElDrawer, ElIcon } }, props: {
        modelValue: source, ...(productionWrapper ? {} : { mode: initialSurface }), documentIdentity: owner.documentIdentity,
        'onUpdate:modelValue': async (value: string): Promise<void> => { await wrapper.setProps({ modelValue: value }); },
        ...(productionWrapper ? {
            onEditorFocus: (event: 'focusin' | 'focusout') => runtime?.consumeFocus(event),
            onSelectionChange: (event: Parameters<ArticleEditorRuntimeBinding['consumeSelection']>[0]) => runtime?.consumeSelection(event)
        } : {}),
        onTransaction: (result: MarkdownEditorDispatchResult) => {
            if (!result.accepted) return;
            runtime?.consumeTransaction(result);
        }
    } });
    await nextTick();
    if (productionWrapper && initialSurface === 'live')
    {
        await wrapper.get('[data-authoring-surface="live"]').trigger('click');
    }
    const exposed = wrapper.vm as unknown as { getAuthoringEditorPort(): ArticleEditorContinuityPort | null; };
    const editor = productionWrapper ? exposed.getAuthoringEditorPort()! : wrapper.vm as unknown as ArticleEditorContinuityPort;
    if (productionWrapper)
    {
        expect(editor).not.toBeNull();
        expect(exposed.getAuthoringEditorPort()).toBe(editor);
        expect(wrapper.findAllComponents(ElMarkdownEditor)).toHaveLength(1);
    }
    const binding = () => ({ document: owner.context, map: createMarkdownAnchorMap({ identity: owner.documentIdentity, source }) });
    runtime = bindArticleEditorRuntime(owner, anchors, attachments, {
        dispatch: transaction => editor.dispatchTransaction(transaction),
        commitSource: result => { source = result.value; if (result.revision > owner.context.sourceRevision) owner.updateSource(source, result.revision); },
        binding
    }, () => source, editor, { surface: initialSurface, configuration, identity, cachePolicy: { maxEntryBytes: 2000000, maxAgeMs: 60000, maxReceipts: 8 } });
    const bound = runtime;
    const adapter = bound.continuity;
    const compare = new ArticleSourceCompareSession(owner, bound);
    let surface = initialSurface;
    let tool: 'none' | 'source-compare' = 'none';
    const options = () => ({ surface, tool, affinity: 'after' as const, viewportOffset: 0, percentage: 0 });
    const dispatch = (input: Partial<MarkdownEditorTransaction> = {}) => {
        const result = editor.dispatchTransaction({ changes: [], history: 'skip', origin: 'programmatic', documentIdentity: owner.documentIdentity,
            expectedRevision: owner.context.sourceRevision, selection: { start: 14, end: 18, direction: 'backward' }, ...input });
        expect(result.accepted).toBe(true);
        expect(bound.context).toBe(owner.context);
        return result;
    };
    const focusIn = () => adapter.observeFocus(editor, { document: owner.context, event: 'focusin' });
    const focusOut = () => adapter.observeFocus(editor, { document: owner.context, event: 'focusout' });
    if (!productionWrapper)
    {
        wrapper.element.addEventListener('focusin', focusIn);
        wrapper.element.addEventListener('focusout', focusOut);
    }
    cleanup.push(() => {
        owner.dispose(); compare.dispose(); bound.dispose(); attachments.dispose(); wrapper.unmount();
    });
    expect(bound.initialize()).toBe(true);
    dispatch(); await nextTick(); await nextTick();
    const complete = async (receipt: ArticleEditorContinuityReceipt) => {
        const admitted = adapter.apply(receipt.requestRef);
        expect(admitted.status).toBe('awaiting-ack');
        if (productionWrapper)
        {
            await wrapper.get(`[data-authoring-surface="${admitted.targetSurface}"]`).trigger('click');
        }
        else
        {
            await wrapper.setProps({ mode: admitted.targetSurface });
        }
        await nextTick(); await nextTick();
        // The fixture reads actual mounted state after public dispatch, matching the upstream acknowledgement contract.
        const textarea = wrapper.find('textarea').element as HTMLTextAreaElement;
        const context = adapter.capture(binding(), { ...options(), tool: admitted.targetTool });
        const focused = document.activeElement === textarea;
        const acknowledgement = createArticleEditorContinuityAcknowledgement({ requestRef: admitted.requestRef, document: owner.context,
            instanceRef: adapter.instanceRef, sessionRef: owner.context.editorSessionId, historyRef: context.historyRef, history: context.history,
            selection: { start: textarea.selectionStart, end: textarea.selectionEnd, direction: textarea.selectionDirection },
            surface: admitted.targetSurface, tool: admitted.targetTool, generation: admitted.anchorCommand!.generation,
            focus: focused ? 'editor' : 'outside', focusEvent: focused ? 'focusin' : 'focusout', viewportOffset: textarea.scrollTop });
        const finished = adapter.acknowledge(editor, acknowledgement)!;
        expect(finished.status).toBe('restored');
        expect(validateArticleEditorContinuityReceipt(finished)).toBe(true);
        surface = finished.targetSurface;
        tool = finished.targetTool as typeof tool;
        return finished;
    };
    const open = async () => {
        const opening = compare.open(viewport, identity, binding(), options(), restore);
        tool = 'source-compare';
        if (opening.source !== null) {
            expect(compare.state.sourceReady).toBe(false);
            await complete(opening.source);
        }
        return opening;
    };
    const close = () => compare.close(binding(), options(), restore);
    return { owner, anchors, runtime: bound, compare, wrapper, editor, adapter, identity, binding: bound.positionBinding, options, dispatch, complete, open, close, source: () => source };
}

describe('temporary compare using actual shared owners (#2284 source stage)', () => {
    it.each(['live', 'source'] as const)('consumes the real production wrapper port from %s and rejects disposed admission after the canonical fix', async surface => {
        const h = await host(surface, '\ufeff# Heading\r\n\r\nparagraph  \r\n', true);
        const exposed = h.wrapper.vm as unknown as { getAuthoringEditorPort(): ArticleEditorContinuityPort | null; };
        const instance = h.editor;
        const initial = h.owner.context;
        h.dispatch({ changes: [{ from: 14, to: 14, insert: 'new ' }], history: 'record' });
        await nextTick(); await nextTick();
        const before = h.adapter.capture(h.binding(), h.options());
        const bytes = h.source();
        expect(h.wrapper.emitted('transaction')!.length).toBeGreaterThan(0);
        expect(h.wrapper.emitted('selection-change')!.length).toBeGreaterThan(0);
        const textarea = h.wrapper.get('textarea').element as HTMLTextAreaElement;
        textarea.focus(); await nextTick();
        expect(h.wrapper.emitted('editor-focus')!.some(event => event[0] === 'focusin')).toBe(true);
        await h.open();
        const planned = h.close();
        const restored = await h.complete(planned);
        expect(restored.after!.history).toEqual(before.history);
        expect(restored.after!.anchor.direction).toBe('backward');
        expect(exposed.getAuthoringEditorPort()).toBe(instance);
        expect(h.wrapper.findAllComponents(ElMarkdownEditor)).toHaveLength(1);
        expect(h.owner.context.documentId).toBe(initial.documentId);
        expect(h.owner.context.documentEpoch).toBe(initial.documentEpoch);
        expect(h.source()).toBe(bytes);
        const current = h.owner.context;
        h.owner.dispose();
        expect(h.owner.isCurrentContext(current)).toBe(false);
        expect(() => h.compare.open(viewport, h.identity, h.binding(), h.options(), restore)).toThrow();
        expect(h.compare.state.open).toBe(false);
        expect(h.compare.retainedRender).toBeNull();
    });
    it.each(['live', 'source'] as const)('restores mounted %s context through actual owner acknowledgement independently of renderer availability', async surface => {
        const h = await host(surface);
        const before = h.owner.context;
        const instance = h.wrapper.vm;
        const bytes = h.source();
        await h.open();
        const receipt = h.close();
        expect(receipt.status).toBe('planned');
        expect(receipt.after).toBeNull();
        const restored = await h.complete(receipt);
        expect(restored.after!.history).toEqual(restored.before.history);
        expect(restored.after!.anchor.direction).toBe('backward');
        expect(restored.targetSurface).toBe(surface);
        expect(h.owner.context).toBe(before);
        expect(h.wrapper.vm).toBe(instance);
        expect(h.source()).toBe(bytes);
    });
    it('executes the actual renderer in the mounted-editor environment', async () => {
        const result = await renderMarkdownResultWithRuntime({ source: '# Runtime probe', mode: 'editor' });
        expect(result.ok, JSON.stringify(result)).toBe(true);
    });
    it.each(['live', 'source'] as const)('opens/closes from %s without another editor, epoch or content model', async surface => {
        const h = await host(surface);
        const instance = h.wrapper.vm;
        const context = h.owner.context;
        const bytes = h.source();
        await h.open();
        expect(h.compare.state.sourceReady).toBe(true);
        expect(validateArticleSourceCompareRequest(h.compare.state.request)).toBe(true);
        expect(h.compare.state.request?.originalSurface).toBe(surface);
        expect(await h.compare.refresh(h.binding(), h.options()), JSON.stringify(h.runtime.renderState)).toBe('eligible');
        const content = h.compare.state.render!.content!;
        expect(content.context.contextDigest).toBe(h.owner.context.contextDigest);
        expect(h.compare.retainedRender?.render.rawSource).toBe(bytes);
        expect(h.compare.retainedRender).toBe(h.runtime.retainedRender);
        const planned = h.close();
        expect(planned.status).toBe('planned');
        expect(h.compare.state.open).toBe(false);
        const restored = await h.complete(planned);
        expect(restored.targetSurface).toBe(surface);
        expect(restored.after!.history).toEqual(restored.before.history);
        expect(restored.after!.anchor.direction).toBe('backward');
        expect(h.wrapper.vm).toBe(instance);
        expect(h.owner.context).toBe(context);
        expect(h.source()).toBe(bytes);
    });

    it('leaves no compare tasks or renderer overhead while closed', async () => {
        const h = await host();
        expect(h.compare.state.render).toBeNull();
        expect(h.runtime.renderState.content).toBeNull();
        expect(h.compare.retainedRender).toBeNull();
        expect(h.owner.activeTaskRefs).toHaveLength(0);
    });

    it('uses the canonical runtime policy to refuse an oversized source without rendering', async () => {
        const h = await host('source', 'a'.repeat(82000));
        await h.open();
        expect(await h.compare.refresh(h.binding(), h.options())).toBe('invalid');
        expect(h.runtime.renderState.reason).toBe('render-source-byte-limit');
        expect(h.runtime.renderState.content).toBeNull();
        expect(h.compare.retainedRender).toBeNull();
        expect(h.owner.activeTaskRefs).toHaveLength(1);
        expect(h.compare.signal!.aborted).toBe(false);
        await h.complete(h.close());
    });

    it('withdraws content and synchronization admission when the actual runtime grants a different tool task', async () => {
        const h = await host();
        await h.open();
        h.compare.setSynchronization(true);
        const signal = h.compare.signal!;
        const previewLease = h.runtime.beginToolTask('publish-preview');
        expect(signal.aborted).toBe(true);
        expect(h.compare.state.sourceReady).toBe(false);
        expect(h.compare.state.render).toBeNull();
        expect(h.compare.retainedRender).toBeNull();
        expect(await h.compare.refresh(h.binding(), h.options())).toBe('invalid');
        await h.complete(h.close());
        expect(previewLease.signal.aborted).toBe(false);
        h.runtime.cancelToolTask();
    });

    it('rejects an editor runtime belonging to another article owner', async () => {
        const h = await host();
        const other = createArticleDocumentContextAdapter({ articleId: 2, draftId: 'article:2', editorSessionId: 'session:other', siteScope: 'site:test', userScope: 'user:test', content: h.source() });
        expect(() => new ArticleSourceCompareSession(other, h.runtime)).toThrow('article-source-compare-runtime-context-invalid');
        other.dispose();
    });

    it.each([375, 768, 1366 / 1.5, 1440 / 2])('refuses %s CSS px without forcing panes or invoking hooks', async inlineSize => {
        const h = await host();
        expect(() => h.compare.open({ inlineSize, mobile: false }, h.identity, h.binding(), h.options(), restore)).toThrow('article-source-compare-open-invalid');
        expect(h.adapter.receipts).toHaveLength(0);
        expect(h.owner.activeTaskRefs).toHaveLength(0);
    });

    it('hides mobile even with ample width and closes on reduced available viewport', async () => {
        expect(isArticleSourceCompareAvailable({ inlineSize: 1440, mobile: true })).toBe(false);
        const h = await host();
        await h.open();
        const result = h.compare.adaptViewport({ inlineSize: 768, mobile: false }, h.binding(), h.options(), restore)!;
        expect(result.action).toBe('source-compare-close');
        expect(h.compare.state.open).toBe(false);
        await h.complete(result);
    });

    it('keeps the original same-document last-valid cache stale and rejects old sync', async () => {
        const h = await host();
        await h.open();
        expect(await h.compare.refresh(h.binding(), h.options()), JSON.stringify(h.runtime.renderState)).toBe('eligible');
        const retained = h.compare.state.render!.content!.result.resultRef;
        h.dispatch({ changes: [{ from: 14, to: 14, insert: 'new ' }], history: 'record' });
        await nextTick();
        expect(h.compare.state.render!.stale).toBe(true);
        expect(h.compare.state.render!.content!.result.resultRef).toBe(retained);
        h.compare.setSynchronization(true);
        const saved = h.anchors.capture(h.binding(), { start: 14, end: 14, direction: 'none' }, h.options());
        expect(h.compare.synchronize({ document: h.owner.context, pane: 'source', generation: null, now: 200 }, saved, h.binding(), { height: 500, reducedMotion: true })).toBeNull();
        expect(await h.compare.refresh(h.binding(), h.options())).toBe('eligible');
        expect(h.compare.state.render!.stale).toBe(false);
    });

    it('delegates sync on/off, generation feedback rejection, manual priority and reduced motion to the existing anchor owner', async () => {
        const h = await host(); await h.open(); await h.compare.refresh(h.binding(), h.options());
        const saved = h.anchors.capture(h.binding(), { start: 14, end: 14, direction: 'none' }, h.options());
        const event = { document: h.owner.context, pane: 'source' as const, generation: null, now: 200 };
        const sync = () => h.compare.synchronize(event, saved, h.binding(), { height: 500, reducedMotion: true });
        expect(sync()).toBeNull();
        h.compare.setSynchronization(true);
        const first = sync()!;
        expect(first.target).toBe('renderer'); expect(first.command.behavior).toBe('instant');
        expect(h.compare.synchronize({ ...event, generation: first.command.generation, now: 220 }, saved, h.binding(), { height: 500, reducedMotion: true })).toBeNull();
        h.anchors.manual('touch', 'source', 230);
        expect(h.compare.synchronize({ ...event, now: 240 }, saved, h.binding(), { height: 500, reducedMotion: true })).toBeNull();
        expect(h.anchors.resume('navigation', 250)).toBe(true);
        h.compare.setSynchronization(false);
        expect(h.compare.state.synchronization).toBe(false);
    });

    it('cancels comparison admission on close, rapid edit and equal-source article switch', async () => {
        const h = await host(); await h.open();
        const pending = h.compare.refresh(h.binding(), h.options());
        const signal = h.compare.signal!;
        const planned = h.close();
        expect(signal.aborted).toBe(true);
        expect(await pending).toBe('stale');
        await h.complete(planned);
        await h.open();
        h.owner.switchDocument({ articleId: 2, draftId: 'article:2', content: h.source() });
        expect(h.compare.state.open).toBe(false);
        expect(h.compare.state.render).toBeNull();
    });

    it('rejects request integrity tamper and never accepts tool state in preference', async () => {
        const h = await host(); await h.open();
        const request = h.compare.state.request!;
        expect(validateArticleSourceCompareRequest({ ...request, originalSurface: 'split' })).toBe(false);
        expect(validateArticleSourceCompareRequest({ ...request, anchorDigest: 'f'.repeat(64) })).toBe(false);
        expect(validateArticleSourceCompareRequest({ ...request, publishPreviewOpen: true })).toBe(false);
        expect(Object.hasOwn(request, 'source')).toBe(false);
    });
});
