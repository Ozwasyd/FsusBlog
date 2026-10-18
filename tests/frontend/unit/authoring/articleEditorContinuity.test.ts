// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import { ElMarkdownEditor, type MarkdownEditorDispatchResult, type MarkdownEditorTransaction } from '@ozwasyd/element-plus';
import { createMarkdownAnchorMap, MARKDOWN_RENDERER_VERSION, renderMarkdownResultWithRuntime } from '@ozwasyd/element-plus/markdown-runtime';
import {
    ArticleEditorContinuityAdapter, createArticleEditorContinuityAcknowledgement,
    validateArticleEditorContinuityAcknowledgement, validateArticleEditorContinuityContext, validateArticleEditorContinuityReceipt,
    type ArticleEditorContinuityAcknowledgement, type ArticleEditorContinuityReceipt, type ArticleEditorContinuityPort
} from '@/services/authoring/articleEditorContinuity';
import { ArticleAnchorContextAdapter, type ArticleAnchorCaptureOptions } from '@/services/authoring/articleAnchorContext';
import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';
import { ArticleRenderCache, type ArticleRenderProducer } from '@/services/authoring/articleRenderCache';
import { ArticleFsusUiRenderProducer } from '@/services/authoring/articleFsusUiRenderProducer';
import { calculateOpenArticleDocumentDigest as digest } from '@/services/authoring/openArticleDocumentRegistry';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()));
const defaults: ArticleAnchorCaptureOptions = { surface: 'source', tool: 'none', affinity: 'after', viewportOffset: 0, percentage: 0 };
const restore = { origin: 'surface' as const, now: 100, viewportHeight: 500, reducedMotion: true };
function reseal<T extends { contentDigest: string; }>(value: T, changes: object): T
{
    const { contentDigest: _ignored, ...unsigned } = value;
    const changed = { ...unsigned, ...changes };
    return { ...changed, contentDigest: digest(changed) } as T;
}

async function open()
{
    let source = '# Heading\n\nabcdef';
    let fail = false;
    let delay: Promise<void> | null = null;
    const owner = createArticleDocumentContextAdapter({ articleId: 1, draftId: 'article:1', editorSessionId: 'session:continuity',
        siteScope: 'site:test', userScope: 'user:test', content: source });
    const anchors = new ArticleAnchorContextAdapter(owner);
    const configuration = { allowLatex: true, allowMermaid: true, baseUrl: null };
    const producer = new ArticleFsusUiRenderProducer(() => {
        if (fail) throw new Error('isolated-reader-failure');
        return source;
    }, configuration, 65536);
    const controlled: ArticleRenderProducer = {
        render: async request => { if (delay) await delay; return producer.render(request); },
        verify: (request, result) => producer.verify(request, result), release: ref => producer.release(ref)
    };
    const cache = new ArticleRenderCache(owner, { rendererVersion: MARKDOWN_RENDERER_VERSION, projectionVersion: MARKDOWN_RENDERER_VERSION,
        featureConfigurationDigest: digest(configuration), themeDigest: digest({ theme: 'light' }), locale: 'zh-CN' }, controlled,
    { maxEntryBytes: 65536, maxAgeMs: 60000, maxReceipts: 16 });
    let consumeTransaction: ((result: MarkdownEditorDispatchResult) => void) | null = null;
    const wrapper = mount(ElMarkdownEditor, { attachTo: document.body,
        props: { modelValue: source, mode: 'source', documentIdentity: owner.documentIdentity,
            onTransaction: (result: MarkdownEditorDispatchResult) => consumeTransaction?.(result) } });
    const editor = wrapper.vm as unknown as ArticleEditorContinuityPort & { undo(): MarkdownEditorDispatchResult; redo(): MarkdownEditorDispatchResult; };
    const adapter = new ArticleEditorContinuityAdapter(owner, anchors, cache, editor, 'source');
    consumeTransaction = result => {
        if (!result.accepted) return;
        source = result.value;
        if (result.revision > owner.context.sourceRevision) owner.updateSource(source, result.revision);
        // FsusUI emits transaction before update:modelValue; the existing document owner commits first.
        expect(adapter.observeTransaction(editor, result)).toBe(true);
    };
    let currentSurface: 'source' | 'live' = 'source';
    let currentTool: 'none' | 'publish-preview' | 'source-compare' = 'none';
    const options = () => ({ ...defaults, surface: currentSurface, tool: currentTool });
    const focusIn = () => adapter.observeFocus(editor, { document: owner.context, event: 'focusin' });
    const focusOut = () => adapter.observeFocus(editor, { document: owner.context, event: 'focusout' });
    wrapper.element.addEventListener('focusin', focusIn); wrapper.element.addEventListener('focusout', focusOut);
    cleanups.push(() => {
        wrapper.element.removeEventListener('focusin', focusIn); wrapper.element.removeEventListener('focusout', focusOut);
        adapter.dispose(); wrapper.unmount(); cache.dispose(); owner.dispose();
    });
    const binding = () => ({ document: owner.context, map: createMarkdownAnchorMap({ identity: owner.documentIdentity, source }) });
    const accept = (result: MarkdownEditorDispatchResult) => {
        expect(result.accepted, JSON.stringify(result)).toBe(true);
        source = result.value;
        if (result.revision > owner.context.sourceRevision) owner.updateSource(source, result.revision);
        expect(adapter.observeTransaction(editor, result)).toBe(true);
        return result;
    };
    const dispatch = (input: Partial<MarkdownEditorTransaction> = {}) => accept(editor.dispatchTransaction({
        changes: [], history: 'skip', origin: 'programmatic', documentIdentity: owner.documentIdentity,
        expectedRevision: owner.context.sourceRevision, selection: { start: 12, end: 16, direction: 'backward' }, ...input
    }));
    const ack = (receipt: ArticleEditorContinuityReceipt, changes: Partial<ArticleEditorContinuityAcknowledgement> = {}) => {
        const context = adapter.capture(binding(), options());
        const textarea = wrapper.find('textarea').element as HTMLTextAreaElement;
        const isFocused = document.activeElement === textarea;
        return createArticleEditorContinuityAcknowledgement({ requestRef: receipt.requestRef, document: owner.context,
            instanceRef: adapter.instanceRef, sessionRef: owner.context.editorSessionId, historyRef: context.historyRef, history: context.history,
            selection: { start: textarea.selectionStart, end: textarea.selectionEnd, direction: textarea.selectionDirection },
            surface: receipt.targetSurface, tool: receipt.targetTool, generation: receipt.anchorCommand!.generation,
            focus: isFocused ? 'editor' : 'outside', focusEvent: isFocused ? 'focusin' : 'focusout', viewportOffset: textarea.scrollTop, ...changes });
    };
    const complete = async (receipt: ArticleEditorContinuityReceipt) => {
        const admitted = adapter.apply(receipt.requestRef);
        expect(admitted.status).toBe('awaiting-ack'); expect(admitted.after).toBeNull();
        await nextTick(); await nextTick();
        const completed = adapter.acknowledge(editor, ack(admitted))!;
        expect(completed.status, JSON.stringify(completed)).toBe('restored'); expect(validateArticleEditorContinuityReceipt(completed)).toBe(true);
        currentSurface = receipt.targetSurface; currentTool = receipt.targetTool;
        return completed;
    };
    const lifecycle = (tool: 'publish-preview' | 'source-compare', action: 'open' | 'close', transactions?: readonly MarkdownEditorDispatchResult[]) => {
        const receipt = adapter.toolLifecycle(`${tool}-${action}`, binding(), options(), { ...restore, transactions });
        currentTool = action === 'open' ? tool : 'none';
        return receipt;
    };
    expect(() => adapter.capture(binding(), options())).toThrow('continuity-observation-required');
    dispatch(); await nextTick(); await nextTick();
    return { owner, anchors, producer, cache, wrapper, editor, adapter, binding, dispatch, accept, options, ack, complete, lifecycle,
        source: () => source, fail: (value: boolean) => { fail = value; }, delay: (gate: Promise<void> | null) => { delay = gate; } };
}

describe('ArticleEditorContinuityAdapter actual public editor (#2250 data stage)', () =>
{
    // Source control only: UNRUN under current runtime/test/list/native holds.
    it('holds the same actual render terminal after a prompt canceled continuity receipt', async () => {
        const f = await open();
        let release!: () => void;
        f.delay(new Promise<void>(resolve => { release = resolve; }));
        const operation = f.adapter.startRefresh(f.binding(), f.options(), restore);
        expect(f.cache.pendingRefreshWork).toContain(operation.renderWork);
        expect(f.adapter.pendingRefreshWork[0]).toBe(operation.renderWork);
        expect(operation.terminal).toBe(operation.renderWork.terminal);
        let terminalObserved = false;
        void operation.terminal.then(() => { terminalObserved = true; }, () => { terminalObserved = true; });
        f.adapter.cancelRefresh();
        const receipt = await operation.receipt;
        expect(receipt.renderReceipt?.status).toBe('canceled');
        expect(terminalObserved).toBe(false);
        expect(f.owner.pendingTaskRefs).toContain(operation.renderWork.taskRef);
        expect(f.adapter.pendingRefreshWork).toContain(operation.renderWork);
        release();
        // Drain this actual operation only; its outcome is not native restoration evidence.
        await operation.terminal;
        expect(terminalObserved).toBe(true);
    });

    it('captures current public selection/history and consumes existing map/render owners', async () => {
        const f = await open(); const context = f.adapter.capture(f.binding(), f.options());
        expect(validateArticleEditorContinuityContext(context)).toBe(true);
        expect(context).toMatchObject({ focus: 'editor', anchor: { range: { start: 12, end: 16 }, direction: 'backward' }, render: { fallback: 'source' } });
        expect(context.render).toEqual(f.cache.state); expect(Object.isFrozen(context.anchor.range)).toBe(true);
    });
    it('keeps mounted instance, opaque epoch, direction and real undo/redo through source/live/source', async () => {
        const f = await open();
        f.dispatch({ changes: [{ from: 12, to: 12, insert: 'X' }], history: 'separate', selection: { start: 13, end: 17, direction: 'backward' } });
        await nextTick(); await nextTick();
        const before = f.adapter.capture(f.binding(), f.options()); const instance = f.wrapper.vm; const epoch = f.owner.context.documentEpoch;
        const plan = f.adapter.transitionSurface('live', f.binding(), f.options(), restore);
        await f.wrapper.setProps({ mode: 'live', modelValue: f.source() });
        expect((await f.complete(plan)).after!.historyRef).toBe(before.historyRef);
        const back = f.adapter.transitionSurface('source', f.binding(), f.options(), { ...restore, now: 200 });
        await f.wrapper.setProps({ mode: 'source' }); await f.complete(back);
        const undone = f.accept(f.editor.undo()); expect(undone.value).toBe('# Heading\n\nabcdef'); expect(undone.history.canRedo).toBe(true);
        expect(f.accept(f.editor.redo()).value).toContain('aXbcdef');
        expect(f.wrapper.vm).toBe(instance); expect(f.owner.context.documentEpoch).toBe(epoch);
    });
    it.each(['publish-preview', 'source-compare'] as const)('runs the exact %s open/close hooks with owner task refs', async tool => {
        const f = await open(); const search = f.owner.beginTask('search', 'search:owner'); const outline = f.owner.beginTask('outline', 'outline:owner');
        const attachment = f.owner.beginTask('attachment', 'attachment:owner'); const diagnostic = f.owner.beginTask('feature', 'diagnostic:owner');
        f.adapter.setTaskOwners({ search, outline, attachments: [attachment], diagnostic });
        const opened = f.lifecycle(tool, 'open'); expect(opened.status).toBe('captured'); expect(validateArticleEditorContinuityReceipt(opened)).toBe(true);
        expect(opened.before.stateRefs.search?.taskRef).toBe(search.taskRef);
        expect(() => f.lifecycle(tool, 'open')).toThrow('continuity-tool-already-active');
        const closed = await f.complete(f.lifecycle(tool, 'close'));
        expect(closed.after!.stateRefs).toEqual(opened.before.stateRefs); expect(closed.after!.anchor.direction).toBe('backward');
        expect(() => f.lifecycle(tool, 'close')).toThrow('continuity-tool-not-active');
    });
    it('requires real registered lease identity, omits canceled tasks, rejects wrong kind and duplicates', async () => {
        const f = await open(); const search = f.owner.beginTask('search', 'search:owner');
        const fake = { envelope: search.envelope, taskRef: search.taskRef, isCurrent: () => true } as typeof search;
        f.adapter.setTaskOwners({ search: fake, outline: null, attachments: [], diagnostic: null });
        expect(f.adapter.capture(f.binding(), f.options()).stateRefs.search).toBeNull();
        f.adapter.setTaskOwners({ search, outline: null, attachments: [], diagnostic: null }); search.cancel();
        expect(f.adapter.capture(f.binding(), f.options()).stateRefs.search).toBeNull();
        expect(() => f.adapter.setTaskOwners({ search: f.owner.beginTask('outline', 'outline:owner'), outline: null, attachments: [], diagnostic: null })).toThrow('continuity-task-owner-invalid');
        const attachment = f.owner.beginTask('attachment', 'attachment:owner');
        expect(() => f.adapter.setTaskOwners({ search: null, outline: null, attachments: [attachment, attachment], diagnostic: null })).toThrow('continuity-task-input-invalid');
    });
    it('retains editor context and exposes formal fatal/loading state when this DOM host lacks Wasm', async () => {
        const f = await open();
        const actualRender = await renderMarkdownResultWithRuntime({ source: f.source(), mode: 'editor' });
        expect(actualRender).toMatchObject({ ok: false, error: { category: 'runtime', code: 'infra', message: 'markdown_wasm_runtime_unavailable' } });
        const capture = { ...f.options(), viewportOffset: (f.wrapper.find('textarea').element as HTMLTextAreaElement).scrollTop };
        const before = f.adapter.capture(f.binding(), capture);
        const failed = await f.adapter.refresh(f.binding(), capture, restore);
        expect(failed.renderReceipt?.status).toBe('failed');
        expect(f.adapter.renderState).toMatchObject({ content: null, fallback: 'source', refreshState: 'failed' });
        const completed = await f.complete(failed);
        expect(completed.after!.historyRef).toBe(before.historyRef);
        expect(completed.after!.anchor.range).toEqual(before.anchor.range);
        let release!: () => void; f.delay(new Promise<void>(resolve => { release = resolve; }));
        const running = f.adapter.refresh(f.binding(), capture, { ...restore, now: 200 });
        await expect(f.adapter.refresh(f.binding(), f.options(), restore)).rejects.toThrow('continuity-transition-pending');
        f.adapter.cancelRefresh(); const canceled = await running;
        expect(canceled.renderReceipt?.status).toBe('canceled'); await f.complete(canceled);
        release(); f.delay(null);
    });
    it('marks old tool results stale after edit/close/epoch without claiming producer verification', async () => {
        const f = await open(); f.lifecycle('publish-preview', 'open'); const lease = f.owner.beginTask('preview', 'preview:owner');
        const result = { tool: 'publish-preview', taskRef: lease.taskRef, contextDigest: f.owner.context.contextDigest, resultRef: 'result:1', resultDigest: digest({ result: 1 }) };
        expect(f.adapter.inspectToolResult(lease, result)).toBe('eligible'); expect(lease.envelope.status).toBe('running');
        expect(f.adapter.inspectToolResult(lease, { ...result, extra: true })).toBe('invalid');
        f.dispatch({ changes: [{ from: 17, to: 17, insert: '!' }], history: 'separate' });
        expect(f.adapter.inspectToolResult(lease, result)).toBe('stale');
        f.owner.switchDocument({ articleId: 2, draftId: 'article:2', content: f.source() });
        expect(f.adapter.inspectToolResult(lease, result)).toBe('stale'); expect(f.cache.state.content).toBeNull();
    });
    it('stays pending with missing focus/viewport ack and rejects repeated acknowledgement', async () => {
        const f = await open(); const plan = f.adapter.transitionSurface('live', f.binding(), f.options(), restore);
        const admitted = f.adapter.apply(plan.requestRef); await nextTick(); await nextTick();
        const pending = f.adapter.acknowledge(f.editor, f.ack(admitted, { focus: 'unobserved', focusEvent: 'unobserved', viewportOffset: null }))!;
        expect(pending).toMatchObject({ status: 'awaiting-ack', after: null, focusAcknowledged: false, viewportAcknowledged: false });
        expect(validateArticleEditorContinuityReceipt(pending)).toBe(true);
        const ack = f.ack(admitted); expect(f.adapter.acknowledge(f.editor, ack)?.status).toBe('restored'); expect(f.adapter.acknowledge(f.editor, ack)).toBeNull();
    });
    it.each(['instance', 'request', 'session', 'history', 'direction', 'surface', 'tool', 'generation', 'doc', 'revision', 'extra', 'digest'] as const)('rejects %s acknowledgement mismatch', async kind => {
        const f = await open(); const plan = f.adapter.transitionSurface('live', f.binding(), f.options(), restore);
        const admitted = f.adapter.apply(plan.requestRef); await nextTick(); await nextTick(); const ack = f.ack(admitted);
        const changes: Record<string, object> = {
            instance: { instanceRef: 'editor:foreign' }, request: { requestRef: 'continuity:foreign' }, session: { sessionRef: 'session:foreign' },
            history: { history: { ...ack.history, retainedUnits: ack.history.retainedUnits + 1 } }, direction: { selection: { ...ack.selection, direction: 'forward' } },
            surface: { surface: 'source' }, tool: { tool: 'source-compare' }, generation: { generation: ack.generation + 1 },
            doc: { document: { ...ack.document, articleId: 2 } }, revision: { document: { ...ack.document, sourceRevision: 2 } }, extra: { success: true }
        };
        const bad = kind === 'digest' ? { ...ack, contentDigest: 'f'.repeat(64) } : reseal(ack, changes[kind]);
        expect(f.adapter.acknowledge(f.editor, bad)).toBeNull(); expect(f.adapter.receipts.at(-1)?.status).toBe('awaiting-ack');
    });
    it.each(['wheel', 'touch', 'selection'] as const)('delegates %s manual priority to anchor authority', async kind => {
        const f = await open(); const plan = f.adapter.transitionSurface('live', f.binding(), f.options(), restore); f.anchors.manual(kind, 'source', 101);
        expect(f.adapter.apply(plan.requestRef).status).toBe('paused'); expect(() => f.adapter.apply(plan.requestRef)).toThrow('continuity-plan-not-current');
    });
    it('isolates same-byte document epochs and rejects old public events', async () => {
        const f = await open(); const before = f.owner.context; const result = f.dispatch();
        const plan = f.adapter.transitionSurface('live', f.binding(), f.options(), restore);
        f.owner.switchDocument({ articleId: 2, draftId: 'article:2', content: f.source() });
        expect(() => f.adapter.apply(plan.requestRef)).toThrow('continuity-plan-not-current'); expect(f.adapter.observeTransaction(f.editor, result)).toBe(false);
        expect(f.adapter.observeSelection(f.editor, { document: before, revision: before.sourceRevision, selection: result.selection })).toBe(false);
        expect(f.adapter.observeFocus(f.editor, { document: before, event: 'focusin' })).toBe(false);
        expect(() => f.adapter.capture(f.binding(), f.options())).toThrow('continuity-observation-required');
    });
    it('rebases a tool bookmark through real public edits and preserves the current real history', async () => {
        const f = await open(); const opened = f.lifecycle('source-compare', 'open');
        const transaction = f.dispatch({ changes: [{ from: 0, to: 0, insert: 'X' }], history: 'separate' });
        await nextTick(); await nextTick();
        const closed = f.lifecycle('source-compare', 'close', [transaction]);
        expect(closed.anchorCommand).toMatchObject({ kind: 'rebased', range: { start: 13, end: 17 }, direction: 'backward' });
        const completed = await f.complete(closed);
        expect(completed.after!.history.undoDepth).toBe(1);
        expect(completed.before.history.undoDepth).toBe(opened.before.history.undoDepth);
        expect(f.accept(f.editor.undo()).value).toBe('# Heading\n\nabcdef');
    });
    it('rejects claimed focus when the owned host observed a real blur', async () => {
        const f = await open(); const plan = f.adapter.transitionSurface('live', f.binding(), f.options(), restore);
        const admitted = f.adapter.apply(plan.requestRef); await nextTick(); await nextTick();
        const textarea = f.wrapper.find('textarea').element as HTMLTextAreaElement;
        textarea.blur();
        expect(f.adapter.acknowledge(f.editor, f.ack(admitted, { focus: 'editor', focusEvent: 'focusin' }))).toBeNull();
        textarea.focus();
        expect(f.adapter.acknowledge(f.editor, f.ack(admitted))?.status).toBe('restored');
    });
    it('rejects acknowledgement after manual input overrides an admitted restore', async () => {
        const f = await open(); const plan = f.adapter.transitionSurface('live', f.binding(), f.options(), restore);
        const admitted = f.adapter.apply(plan.requestRef); await nextTick(); await nextTick();
        const ack = f.ack(admitted); f.anchors.manual('wheel', 'source', 101);
        expect(f.adapter.acknowledge(f.editor, ack)).toBeNull();
        expect(f.adapter.receipts.at(-1)?.status).toBe('awaiting-ack');
        const canceled = f.adapter.cancelRestoration(admitted.requestRef)!;
        expect(canceled.status).toBe('rejected'); expect(validateArticleEditorContinuityReceipt(canceled)).toBe(true);
        expect(f.adapter.cancelRestoration(admitted.requestRef)).toBeNull();
        expect(f.adapter.acknowledge(f.editor, ack)).toBeNull();
        f.anchors.resume('navigation', 102);
        expect(f.adapter.transitionSurface('live', f.binding(), f.options(), { ...restore, now: 103 }).status).toBe('planned');
    });
    it('rejects a closed tool result and disposed observations without disposing borrowed owners', async () => {
        const f = await open(); f.lifecycle('publish-preview', 'open'); const lease = f.owner.beginTask('preview', 'preview:owner');
        const input = { tool: 'publish-preview', taskRef: lease.taskRef, contextDigest: f.owner.context.contextDigest, resultRef: 'result:1', resultDigest: digest({ result: 1 }) };
        await f.complete(f.lifecycle('publish-preview', 'close'));
        expect(f.adapter.inspectToolResult(lease, input)).toBe('stale');
        const result = f.dispatch(); f.adapter.dispose();
        expect(f.adapter.observeTransaction(f.editor, result)).toBe(false);
        expect(f.adapter.observeFocus(f.editor, { document: f.owner.context, event: 'focusin' })).toBe(false);
        expect(f.adapter.receipts).toHaveLength(0);
        expect(lease.isCurrent()).toBe(true);
    });
    it('rejects a late refresh after disposal without recreating a pending restore or disposing the cache owner', async () => {
        const f = await open(); let release!: () => void;
        f.delay(new Promise<void>(resolve => { release = resolve; }));
        const running = f.adapter.refresh(f.binding(), f.options(), restore);
        f.adapter.dispose(); release();
        const receipt = await running;
        expect(receipt.status).toBe('rejected'); expect(validateArticleEditorContinuityReceipt(receipt)).toBe(true);
        expect(f.adapter.receipts).toHaveLength(0);
        expect(() => f.adapter.apply(receipt.requestRef)).toThrow('continuity-plan-not-current');
        expect(f.owner.isCurrentContext(f.owner.context)).toBe(true);
    });
    it('rejects resealed context/receipt/ack tampering including success without acknowledgements', async () => {
        const f = await open(); const context = f.adapter.capture(f.binding(), f.options());
        expect(validateArticleEditorContinuityContext(reseal(context, { historyRef: 'history:invented' }))).toBe(false);
        expect(validateArticleEditorContinuityContext(reseal(context, { surface: 'split' }))).toBe(false);
        const plan = f.adapter.transitionSurface('live', f.binding(), f.options(), restore); expect(validateArticleEditorContinuityReceipt(plan)).toBe(true);
        expect(validateArticleEditorContinuityReceipt(reseal(plan, { status: 'restored', after: context, focusAcknowledged: true, viewportAcknowledged: true }))).toBe(false);
        const completed = await f.complete(plan);
        expect(validateArticleEditorContinuityReceipt(reseal(completed, { acknowledgement: null }))).toBe(false);
        expect(validateArticleEditorContinuityAcknowledgement(reseal(completed.acknowledgement!, { surface: 'preview' }))).toBe(false);
    });
    it('rejects unsupported modes/tools, false owner instances and out-of-bounds selection', async () => {
        const f = await open(); const result = f.dispatch();
        expect(f.adapter.observeTransaction({ dispatchTransaction: f.editor.dispatchTransaction }, result)).toBe(false);
        expect(f.adapter.observeSelection(f.editor, { document: f.owner.context, revision: result.revision, selection: { start: 0, end: 999, direction: 'none' } })).toBe(false);
        expect(() => f.adapter.transitionSurface('split' as 'source', f.binding(), f.options(), restore)).toThrow('continuity-surface-invalid');
        expect(() => f.adapter.toolLifecycle('preview-open' as 'publish-preview-open', f.binding(), f.options(), restore)).toThrow('continuity-tool-event-invalid');
        expect(() => createArticleEditorContinuityAcknowledgement({ success: true } as never)).toThrow('continuity-ack-input-invalid');
    });
});
