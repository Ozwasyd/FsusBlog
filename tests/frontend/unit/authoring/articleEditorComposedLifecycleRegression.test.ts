// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import { ElMarkdownEditor, type MarkdownEditorDispatchResult, type MarkdownEditorTransaction } from '@ozwasyd/element-plus';
import { createMarkdownAnchorMap } from '@ozwasyd/element-plus/markdown-runtime';
import { ArticleDocumentContextAuthority } from '@/services/authoring/articleDocumentContext';
import { ArticleAnchorContextAdapter } from '@/services/authoring/articleAnchorContext';
import { ArticleAttachmentContextAdapter, type ArticleAttachmentPendingHandle, type ArticleAttachmentTransactionPort } from '@/services/authoring/articleAttachmentContext';
import { bindArticleEditorRuntime } from '@/services/authoring/articleEditorRuntimeBinding';
import { createArticleEditorContinuityAcknowledgement, type ArticleEditorContinuityPort } from '@/services/authoring/articleEditorContinuity';
import { calculateOpenArticleDocumentDigest as digest } from '@/services/authoring/openArticleDocumentRegistry';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()));
const capture = { surface: 'source' as const, tool: 'none' as const, affinity: 'after' as const, viewportOffset: 0, percentage: 0 };
const restore = { origin: 'tool' as const, now: 100, viewportHeight: 500, reducedMotion: true };
const file = { name: 'one.png', mimeType: 'image/png', byteLength: 100 };

function open(authority = new ArticleDocumentContextAuthority(), content = 'paragraph', initialize = true)
{
    let source = content;
    const lease = authority.acquire({ articleId: 1, siteScope: 'site:integration', userScope: 'user:integration', content });
    const owner = lease.adapter;
    const anchors = new ArticleAnchorContextAdapter(owner);
    const attachments = new ArticleAttachmentContextAdapter(owner, 'article-assets', 'version:1', anchors);
    const events: MarkdownEditorDispatchResult[] = [];
    let runtime: ReturnType<typeof bindArticleEditorRuntime> | null = null;
    const wrapper = mount(ElMarkdownEditor, { attachTo: document.body, props: { mode: 'source', modelValue: source,
        documentIdentity: owner.documentIdentity, onTransaction: (result: MarkdownEditorDispatchResult) => {
            events.push(result);
            runtime?.consumeTransaction(result);
        } } });
    const editor = wrapper.vm as unknown as ArticleEditorContinuityPort & {
        undo(): MarkdownEditorDispatchResult; redo(): MarkdownEditorDispatchResult;
    };
    const port: ArticleAttachmentTransactionPort = {
        dispatch: transaction => editor.dispatchTransaction(transaction),
        commitSource: result => {
            if (result.revision > owner.context.sourceRevision) owner.updateSource(result.value, result.revision);
            source = result.value;
        },
        binding: () => ({ document: owner.context, map: createMarkdownAnchorMap({ identity: owner.documentIdentity, source }) })
    };
    runtime = bindArticleEditorRuntime(owner, anchors, attachments, port, () => source, editor, {
        surface: 'source', configuration: { allowLatex: true, allowMermaid: true, baseUrl: null },
        identity: { themeDigest: digest({ theme: 'light' }), locale: 'zh-CN' },
        cachePolicy: { maxEntryBytes: 65536, maxAgeMs: 60000, maxReceipts: 16 }
    });
    if (initialize) expect(runtime.initialize()).toBe(true);
    const binding = runtime;
    const insert = (files = [file]) => {
        const anchor = anchors.capture(binding.positionBinding(), { start: 0, end: 0, direction: 'none' }, capture);
        const input = attachments.capture({ source, origin: 'pick', anchor, files });
        expect(input.status).toBe('created');
        return attachments.commitCreated(input, port);
    };
    const resolved = (handle: ArticleAttachmentPendingHandle) => ({ status: 'resolved' as const, ...handle.request,
        payload: { markdownKind: 'image' as const, href: `/assets/${handle.snapshot.intent.candidate.name}`,
            alt: handle.snapshot.intent.candidate.name, mimeType: 'image/png' } });
    const release = () => {
        // Same public ordering as canonical Writer: runtime, attachment binding, component context binding.
        binding.dispose(); attachments.cancelPending('article-attachment-editor-release'); wrapper.unmount(); lease.release();
    };
    cleanups.push(() => { release(); attachments.dispose(); });
    return { authority, lease, owner, anchors, attachments, binding, wrapper, editor, port, insert, resolved,
        events, release, source: () => source,
        dispatch: (transaction: MarkdownEditorTransaction) => editor.dispatchTransaction({ documentIdentity: owner.documentIdentity,
            expectedRevision: owner.context.sourceRevision, ...transaction }) };
}

describe('composed canonical editor lifecycle integration regressions', () =>
{
    it('denies new semantic binding reads after the canonical owner is disposed', () => {
        const f = open();
        const handle = f.insert()[0]!;
        f.owner.dispose();
        expect(handle.signal.aborted).toBe(true);
        expect(f.binding.consumeTransaction(f.events.at(-1)!)).toBe(false);
        // A surviving runtime handle must not expose an apparently current map after owner teardown.
        expect(() => f.anchors.capture(f.binding.positionBinding(), { start: 0, end: 0, direction: 'none' }, capture)).toThrow();
    });

    it('keeps real attachment successors in tool capture across completion, close and undo/redo', async () => {
        const f = open();
        const handles = f.insert([file, { ...file, name: 'two.png' }]);
        const second = handles[1]!;
        f.binding.consumeFocus('focusin');
        const task = f.binding.beginToolTask('source-compare');
        f.binding.continuity.setTaskOwners({ search: null, outline: null, attachments: f.binding.attachmentTaskLeases, diagnostic: null });
        const opened = f.binding.continuity.toolLifecycle('source-compare-open', f.binding.positionBinding(), capture, restore);
        expect(opened.before.stateRefs.attachments).toHaveLength(2);
        const marker = f.events.length;
        expect(f.attachments.complete(handles[0]!, f.resolved(handles[0]!), f.port).state).toBe('transaction-committed');
        expect(second.signal.aborted).toBe(false);
        expect(task.isCurrent()).toBe(false);
        f.binding.continuity.setTaskOwners({ search: null, outline: null, attachments: f.binding.attachmentTaskLeases, diagnostic: null });
        const closed = f.binding.continuity.toolLifecycle('source-compare-close', f.binding.positionBinding(), capture,
            { ...restore, transactions: f.events.slice(marker) });
        expect(closed.status).toBe('planned');
        const applied = f.binding.continuity.apply(closed.requestRef);
        expect(applied.status).toBe('awaiting-ack');
        await nextTick(); await nextTick();
        f.binding.consumeFocus('focusin');
        const observed = f.binding.continuity.capture(f.binding.positionBinding(), capture);
        const textarea = f.wrapper.find('textarea').element as HTMLTextAreaElement;
        const ack = createArticleEditorContinuityAcknowledgement({ requestRef: closed.requestRef, document: f.owner.context,
            instanceRef: f.binding.continuity.instanceRef, sessionRef: f.owner.context.editorSessionId,
            historyRef: observed.historyRef, history: observed.history,
            selection: { start: textarea.selectionStart, end: textarea.selectionEnd, direction: textarea.selectionDirection },
            surface: 'source', tool: 'none', generation: applied.anchorCommand!.generation,
            focus: 'editor', focusEvent: 'focusin', viewportOffset: textarea.scrollTop });
        const completed = f.binding.continuity.acknowledge(f.editor, ack);
        expect(completed?.status).toBe('restored');
        expect(completed?.after?.stateRefs.attachments).toHaveLength(1);
        expect(f.editor.undo().accepted).toBe(true);
        expect(f.source()).toContain('![one.png]()');
        expect(f.editor.redo().accepted).toBe(true);
        expect(f.source()).toContain('/assets/one.png');
        expect(f.wrapper.vm).toBe(f.editor);
    });

    it('rejects late completion and old events after release/reopen with identical bytes and retained epoch', async () => {
        const f = open(); const handle = f.insert()[0]!;
        let deliver!: () => void;
        const late = new Promise<void>(resolve => { deliver = resolve; }).then(() =>
            f.attachments.complete(handle, f.resolved(handle), f.port));
        const source = f.source(); const context = f.owner.context; const oldEvent = f.events.at(-1)!;
        f.release();
        // Real API gap: fresh public editor starts at revision zero while this authority retains revision > 0.
        // Reopening cannot grant a ready continuity observation; test late-result safety independently.
        const reopened = open(f.authority, source, false);
        expect(reopened.owner.context.documentEpoch).toBe(context.documentEpoch);
        expect(reopened.binding.continuity.instanceRef).not.toBe(f.binding.continuity.instanceRef);
        deliver(); await expect(late).rejects.toThrow();
        expect(handle.signal.aborted).toBe(true);
        expect(f.binding.consumeTransaction(oldEvent)).toBe(false);
        expect(reopened.source()).toBe(source);
        expect(reopened.binding.attachmentTaskLeases).toHaveLength(0);
    });

    it('isolates a same-byte article switch from late attachment and tool responses', async () => {
        const f = open(); const handle = f.insert()[0]!;
        const task = f.binding.beginToolTask('publish-preview');
        f.binding.continuity.toolLifecycle('publish-preview-open', f.binding.positionBinding(), capture, restore);
        const oldContext = f.owner.context; const oldEvent = f.events.at(-1)!;
        const result = { tool: 'publish-preview', taskRef: task.taskRef, contextDigest: oldContext.contextDigest,
            resultRef: 'result:integration', resultDigest: digest({ rendered: true }) };
        expect(f.binding.continuity.inspectToolResult(task, result)).toBe('eligible');
        f.lease.switchDocument({ articleId: 2, content: f.source(), reason: 'article-switch' });
        await f.wrapper.setProps({ documentIdentity: f.owner.documentIdentity, modelValue: f.source() });
        expect(f.binding.initialize()).toBe(true);
        expect(f.binding.consumeTransaction(oldEvent)).toBe(false);
        expect(f.binding.continuity.inspectToolResult(task, result)).toBe('stale');
        expect(() => f.attachments.complete(handle, f.resolved(handle), f.port)).toThrow();
        expect(f.binding.continuity.capture(f.binding.positionBinding(), capture).stateRefs.attachments).toHaveLength(0);
        expect(f.source()).toBe(oldEvent.value);
    });

    it('cancels one provider during an open tool without removing its sibling from restoration', () => {
        const f = open(); const handles = f.insert([file, { ...file, name: 'two.png' }]);
        f.binding.continuity.toolLifecycle('publish-preview-open', f.binding.positionBinding(), capture, restore);
        const marker = f.events.length;
        handles[0]!.cancel();
        expect(() => f.attachments.complete(handles[0]!, f.resolved(handles[0]!), f.port)).toThrow();
        expect(f.binding.attachmentTaskLeases).toHaveLength(1);
        expect(f.attachments.complete(handles[1]!, f.resolved(handles[1]!), f.port).state).toBe('transaction-committed');
        expect(f.source()).toContain('![one.png]()');
        expect(f.source()).toContain('/assets/two.png');
        const closed = f.binding.continuity.toolLifecycle('publish-preview-close', f.binding.positionBinding(), capture,
            { ...restore, transactions: f.events.slice(marker) });
        expect(closed.status).toBe('planned');
        expect(f.binding.continuity.apply(closed.requestRef).status).toBe('awaiting-ack');
        expect(f.binding.attachmentTaskLeases).toHaveLength(0);
    });

    it('invalidates a tool restoration when real undo removes its pending attachment and redo cannot revive the response', () => {
        const f = open(); const handle = f.insert()[0]!;
        f.binding.continuity.toolLifecycle('source-compare-open', f.binding.positionBinding(), capture, restore);
        const closed = f.binding.continuity.toolLifecycle('source-compare-close', f.binding.positionBinding(), capture, restore);
        expect(f.binding.continuity.apply(closed.requestRef).status).toBe('awaiting-ack');
        expect(f.editor.undo().accepted).toBe(true);
        expect(f.source()).toBe('paragraph');
        expect(handle.snapshot.state).toBe('removed');
        expect(() => f.binding.continuity.apply(closed.requestRef)).toThrow('continuity-plan-not-current');
        expect(f.editor.redo().accepted).toBe(true);
        const source = f.source();
        expect(() => f.attachments.complete(handle, f.resolved(handle), f.port)).toThrow();
        expect(f.source()).toBe(source);
        expect(f.binding.continuity.capture(f.binding.positionBinding(), capture).history.canUndo).toBe(true);
        expect(f.binding.attachmentTaskLeases).toHaveLength(0);
    });
});
