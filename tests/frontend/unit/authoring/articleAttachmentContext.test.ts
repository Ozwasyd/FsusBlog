// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { ElMarkdownEditor, type MarkdownEditorDispatchResult, type MarkdownEditorTransaction } from '@ozwasyd/element-plus';
import { createMarkdownAnchorMap } from '@ozwasyd/element-plus/markdown-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { ArticleAttachmentContextAdapter, validateArticleAttachmentIntent } from '@/services/authoring/articleAttachmentContext';
import { ArticleAnchorContextAdapter } from '@/services/authoring/articleAnchorContext';
import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(dispose => dispose()));
const file = { name: 'one.png', mimeType: 'image/png', byteLength: 100 };
function open()
{
    const source = 'paragraph';
    const owner = createArticleDocumentContextAdapter({ articleId: 1, draftId: 'article:1', editorSessionId: 'session:attachment', siteScope: 'site:test', userScope: 'user:test', content: source });
    const anchors = new ArticleAnchorContextAdapter(owner);
    const anchor = () => anchors.capture({ document: owner.context, map: createMarkdownAnchorMap({ identity: owner.documentIdentity, source }) }, { start: 0, end: 0, direction: 'none' }, { affinity: 'after', viewportOffset: 0, percentage: 0, surface: 'source', tool: 'none' });
    const adapter = new ArticleAttachmentContextAdapter(owner, 'article-assets', 'version:1');
    cleanup.push(() => adapter.dispose());
    return { source, owner, anchor, adapter };
}

describe('Article attachment created-stage public boundary (#2256)', () =>
{
    it.each(['pick', 'paste', 'drop'] as const)('captures %s as the same closed intent and public transaction plan', origin =>
    {
        const editor = open();
        const result = editor.adapter.capture({ source: editor.source, origin, anchor: editor.anchor(), files: [file] });
        expect(result.status).toBe('created');
        if (result.status !== 'created') throw new Error('capture rejected');
        expect(validateArticleAttachmentIntent(result.handles[0]?.intent)).toBe(true);
        expect(result.handles[0]?.intent).toMatchObject({ state: 'created', inputOrigin: origin, order: 0, provider: 'article-assets', providerVersion: 'version:1', candidate: file });
        expect(result.transaction).toMatchObject({ expectedRevision: 0, documentIdentity: editor.owner.documentIdentity, history: 'separate', changes: [{ from: 0, to: 0, insert: '![one.png]()' }] });
        expect(result.handles[0]?.signal.aborted).toBe(false);
        result.handles[0]?.cancel();
        expect(result.handles[0]?.signal.aborted).toBe(true);
    });

    it('uses upstream clipboard file-first priority and leaves non-attachment text with that owner', () =>
    {
        const editor = open();
        const transfer = { files: [{ name: file.name, type: file.mimeType, size: file.byteLength }], items: [{ type: 'text/markdown', text: '# text' }, { type: 'text/html', text: '<b>text</b>' }] };
        expect(editor.adapter.capture({ source: editor.source, origin: 'paste', anchor: editor.anchor(), transfer }).status).toBe('created');
        expect(editor.adapter.capture({ source: editor.source, origin: 'paste', anchor: editor.anchor(), transfer: { ...transfer, files: [] } })).toEqual({ status: 'non-attachment', reason: 'markdown-source' });
    });

    it('keeps multiple file creation order and independent cancellation identities', () =>
    {
        const editor = open();
        const result = editor.adapter.capture({ source: editor.source, origin: 'drop', anchor: editor.anchor(), files: [file, { ...file, name: 'two.png' }] });
        if (result.status !== 'created') throw new Error('capture rejected');
        expect(result.handles.map(handle => handle.intent.order)).toEqual([0, 1]);
        expect(new Set(result.handles.map(handle => handle.intent.task.requestId)).size).toBe(2);
        expect(result.transaction.changes?.[0]?.insert).toBe('![one.png]()\n![two.png]()');
        result.handles[0]?.cancel();
        expect(result.handles[1]?.signal.aborted).toBe(false);
    });

    it.each(['readonly', 'disabled', 'isComposing'] as const)('preserves upstream %s capture gate and duplicate-event suppression', gate =>
    {
        const editor = open();
        const input = { source: editor.source, origin: 'pick' as const, anchor: editor.anchor(), files: [file], eventFingerprint: 'event:one' };
        expect(editor.adapter.capture({ ...input, context: { [gate]: true } }).status).toBe('rejected');
        expect(editor.adapter.capture(input).status).toBe('created');
        expect(editor.adapter.capture(input)).toEqual({ status: 'rejected', reason: 'duplicate-event' });
    });

    it('binds epoch cancellation immediately and rejects old/tampered context with identical bytes', () =>
    {
        const editor = open();
        const anchor = editor.anchor();
        const result = editor.adapter.capture({ source: editor.source, origin: 'pick', anchor, files: [file], eventFingerprint: 'event:one' });
        if (result.status !== 'created') throw new Error('capture rejected');
        const intent = result.handles[0]?.intent;
        expect(validateArticleAttachmentIntent({ ...intent, inputOrigin: 'drop' })).toBe(false);
        expect(validateArticleAttachmentIntent({ ...intent, extra: true })).toBe(false);
        editor.owner.switchDocument({ articleId: 2, draftId: 'article:2', content: editor.source, reason: 'article-switch' });
        expect(result.handles[0]?.signal.aborted).toBe(true);
        expect(editor.adapter.capture({ source: editor.source, origin: 'pick', anchor, files: [file] }).status).toBe('rejected');
        expect(editor.adapter.capture({ source: editor.source, origin: 'pick', anchor: editor.anchor(), files: [file], eventFingerprint: 'event:one' }).status).toBe('created');
    });

    it('executes the real public transaction and documents the pending-stage lifecycle gate', () =>
    {
        const editor = open();
        const result = editor.adapter.capture({ source: editor.source, origin: 'pick', anchor: editor.anchor(), files: [file] });
        if (result.status !== 'created') throw new Error('capture rejected');
        const wrapper = mount(ElMarkdownEditor, { props: { mode: 'source', modelValue: editor.source, documentIdentity: editor.owner.documentIdentity } });
        cleanup.push(() => wrapper.unmount());
        const commands = wrapper.vm as unknown as { dispatchTransaction(input: MarkdownEditorTransaction): MarkdownEditorDispatchResult; };
        const committed = commands.dispatchTransaction(result.transaction);
        expect(committed.accepted).toBe(true);
        expect(committed.positionMap?.map(0, 1)).toBe('![one.png]()'.length);
        expect(committed.value).toBe('![one.png]()paragraph');
        editor.owner.updateSource(committed.value, committed.revision);
        // Created-stage signals cannot masquerade as provider-pending signals after admission.
        expect(result.handles[0]?.signal.aborted).toBe(true);
        expect(result.handles[0]?.signal.reason).toBe('source-revision-changed');
    });

    it('rejects mismatched source, bounds created leases, and disposes all signals', () =>
    {
        const editor = open();
        const input = { source: editor.source, origin: 'pick' as const, anchor: editor.anchor(), files: [file] };
        expect(editor.adapter.capture({ ...input, source: 'other' })).toEqual({ status: 'rejected', reason: 'source-context-invalid' });
        const handles = [];
        for (let index = 0; index < 64; index++)
        {
            const result = editor.adapter.capture(input);
            if (result.status !== 'created') throw new Error('capture rejected');
            handles.push(...result.handles);
        }
        expect(editor.adapter.capture(input)).toEqual({ status: 'rejected', reason: 'created-intent-capacity' });
        editor.adapter.dispose();
        expect(handles.every(handle => handle.signal.aborted)).toBe(true);
        expect(editor.adapter.capture(input).status).toBe('rejected');
    });
});
