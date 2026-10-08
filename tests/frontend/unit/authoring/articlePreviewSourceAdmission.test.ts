// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { ElMarkdownEditor, type MarkdownEditorDispatchResult, type MarkdownEditorTransaction } from '@ozwasyd/element-plus';
import { createMarkdownAnchorMap } from '@ozwasyd/element-plus/markdown-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { ArticleDocumentContextAuthority } from '@/services/authoring/articleDocumentContext';
import { ArticleAnchorContextAdapter } from '@/services/authoring/articleAnchorContext';
import { ArticleAttachmentContextAdapter, type ArticleAttachmentLifecycleSnapshot,
    type ArticleAttachmentTransactionPort } from '@/services/authoring/articleAttachmentContext';
import { ArticlePreviewSourceAdmission, type ArticlePreviewSourceInput } from '@/services/authoring/articlePreviewSourceAdmission';
import type { ArticleDraftResponsibilitySource } from '@/view-contracts/articleDraftResponsibility';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(dispose => dispose()));

function open(articleId: number | null = 1)
{
    const authority = new ArticleDocumentContextAuthority();
    let source = 'paragraph';
    let siteAuthor = 'Site author';
    const host = authority.acquire({ articleId, siteScope: 'site:preview', userScope: 'user:preview', content: source });
    const owner = host.adapter;
    let responsibility: ArticleDraftResponsibilitySource | null = { inheritSiteAuthor: true, authors: [], reviewer: null,
        sources: [], updateSummary: null, updateReason: null, effectiveAt: null,
        conclusionImpact: null, responsiblePersonConfirmed: true };
    const anchors = new ArticleAnchorContextAdapter(owner);
    const attachments = new ArticleAttachmentContextAdapter(owner, 'article-assets', 'version:1', anchors);
    let historyOverride: readonly ArticleAttachmentLifecycleSnapshot[] | null = null;
    const read = (): ArticlePreviewSourceInput => ({ context: owner.context, source, responsibility, siteAuthor,
        attachmentLifecycleHistory: historyOverride ?? attachments.lifecycleReceipts });
    const preview = ArticlePreviewSourceAdmission.attach(read, authority);
    cleanups.push(host.release, () => attachments.dispose(), () => preview.dispose());
    return { authority, host, owner, read, preview, attachments,
        setResponsibility(value: ArticleDraftResponsibilitySource | null) { responsibility = value; },
        setSiteAuthor(value: string) { siteAuthor = value; },
        setHistory(value: readonly ArticleAttachmentLifecycleSnapshot[]) { historyOverride = value; },
        edit(value: string) { source = value; owner.updateSource(value); },
        get source() { return source; },
        bindPublicEditor()
        {
            const wrapper = mount(ElMarkdownEditor, { props: { mode: 'source', modelValue: source,
                documentIdentity: owner.documentIdentity } });
            cleanups.push(() => wrapper.unmount());
            const commands = wrapper.vm as unknown as {
                dispatchTransaction(input: MarkdownEditorTransaction): MarkdownEditorDispatchResult;
            };
            const port: ArticleAttachmentTransactionPort = {
                dispatch: input => commands.dispatchTransaction(input),
                commitSource: result => { owner.updateSource(result.value, result.revision); source = result.value; },
                binding: () => ({ document: owner.context, map: createMarkdownAnchorMap({ identity: owner.documentIdentity, source }) })
            };
            const anchor = anchors.capture(port.binding(), { start: 0, end: 0, direction: 'none' },
                { affinity: 'after', viewportOffset: 0, percentage: 0, surface: 'source', tool: 'none' });
            const capture = attachments.capture({ source, origin: 'pick', anchor,
                files: [{ name: 'one.png', mimeType: 'image/png', byteLength: 100 }] });
            if (capture.status !== 'created') throw new Error('capture rejected');
            return { port, handles: attachments.commitCreated(capture, port) };
        }
    };
}

describe('draft preview source admission through the existing document owner', () =>
{
    it('uses the unified binding tool lease and leaves editor lifecycle ownership with the host', () =>
    {
        const editor = open();
        const starts: string[] = [];
        const runtime = {
            get context() { return editor.owner.context; },
            beginToolTask(tool: 'publish-preview')
            {
                starts.push(tool);
                return editor.owner.beginTask('preview', 'article-write:preview', 'article-editor-tools:v1');
            }
        };
        const admission = ArticlePreviewSourceAdmission.attachRuntime(runtime, editor.read);
        cleanups.push(() => admission.dispose());
        const before = editor.owner.context;
        const request = admission.begin();
        expect(starts).toEqual(['publish-preview']);
        expect(request.context).toBe(before);
        expect(admission.accept(request, 'public-composition-ref').accepted).toBe(true);
        const second = admission.begin();
        admission.dispose();
        expect(second.signal.aborted).toBe(true);
        const hostTask = runtime.beginToolTask('publish-preview');
        expect(hostTask.isCurrent()).toBe(true);
        hostTask.cancel();
    });

    it('rejects a unified binding context mismatch and a task whose owner changed during admission', () =>
    {
        const editor = open();
        const other = open(2);
        expect(() => ArticlePreviewSourceAdmission.attachRuntime({
            get context() { return other.owner.context; },
            beginToolTask: () => other.owner.beginTask('preview', 'article-write:preview')
        }, editor.read)).toThrow('article-preview-source-context-invalid');
        const admission = ArticlePreviewSourceAdmission.attachRuntime({
            get context() { return editor.owner.context; },
            beginToolTask: () =>
            {
                editor.host.switchDocument({ articleId: 2, content: editor.source, reason: 'article-switch' });
                return editor.owner.beginTask('preview', 'article-write:preview');
            }
        }, editor.read);
        cleanups.push(() => admission.dispose());
        expect(() => admission.begin()).toThrow('article-preview-source-task-invalid');
    });

    it.each([null, 1])('retains canonical identity and registers an existing-owner preview task for %s', articleId =>
    {
        const editor = open(articleId);
        const before = editor.owner.context;
        const request = editor.preview.begin();
        expect(request.context).toBe(before);
        expect(editor.authority.context).toBe(before);
        expect(request.responsibility.authors[0]?.name).toBe('Site author');
        expect(Object.isFrozen(request)).toBe(true);
        expect(editor.preview.accept(request, 'composition-ref')).toEqual({ accepted: true, value: 'composition-ref', reason: null });
        expect(editor.preview.accept(request, 'duplicate').accepted).toBe(false);
    });

    it('rejects an absent or different canonical owner before acquiring or switching a document', () =>
    {
        const editor = open();
        const empty = new ArticleDocumentContextAuthority();
        expect(() => ArticlePreviewSourceAdmission.attach(editor.read, empty)).toThrow('article-preview-owner-mismatch');
        expect(empty.context).toBeNull();
        const other = new ArticleDocumentContextAuthority();
        const binding = other.acquire({ articleId: 2, siteScope: 'site:preview', userScope: 'user:preview', content: editor.source });
        cleanups.push(binding.release);
        const before = other.context;
        expect(() => ArticlePreviewSourceAdmission.attach(editor.read, other)).toThrow('article-preview-owner-mismatch');
        expect(other.context).toBe(before);
        expect(() => ArticlePreviewSourceAdmission.attach(() => ({ ...editor.read(), source: 'mismatched' }), editor.authority)).toThrow();
    });

    it('rejects copied request objects without consuming the genuine capability', () =>
    {
        const editor = open();
        const request = editor.preview.begin();
        expect(editor.preview.accept({ ...request }, 'copied').accepted).toBe(false);
        expect(editor.preview.accept(request, 'genuine').accepted).toBe(true);
    });

    it('rejects metadata-only changes without advancing Markdown revision', () =>
    {
        const editor = open();
        const request = editor.preview.begin();
        editor.setResponsibility({ ...editor.read().responsibility!, updateSummary: 'new evidence' });
        expect(editor.owner.context).toBe(request.context);
        expect(editor.preview.accept(request, 'old').reason).toBe('preview-input-changed');
        expect(request.signal.aborted).toBe(true);
        expect(editor.preview.begin().responsibility.update?.summary).toBe('new evidence');
    });

    it('binds site-author and missing responsibility changes even with unchanged source bytes', () =>
    {
        const editor = open();
        const author = editor.preview.begin();
        editor.setSiteAuthor('Current site author');
        expect(editor.preview.accept(author, 'old').accepted).toBe(false);
        const missing = editor.preview.begin();
        editor.setResponsibility(null);
        expect(editor.preview.accept(missing, 'old').accepted).toBe(false);
        expect(editor.preview.begin().responsibility.status).toBe('missing');
    });

    it('cancels replacement requests and rejects an abort-ignoring old producer', async () =>
    {
        const editor = open();
        const old = editor.preview.begin();
        const late = Promise.resolve().then(() => editor.preview.accept(old, 'old-ref'));
        const current = editor.preview.begin();
        expect(old.signal.aborted).toBe(true);
        expect((await late).accepted).toBe(false);
        expect(editor.preview.accept(current, 'current-ref').accepted).toBe(true);
    });

    it.each(['edit', 'switch'] as const)('rejects a late result after %s on the existing host owner', operation =>
    {
        const editor = open();
        const request = editor.preview.begin();
        if (operation === 'edit') editor.edit('updated source');
        else editor.host.switchDocument({ articleId: 2, content: editor.source, reason: 'article-switch' });
        expect(request.signal.aborted).toBe(true);
        expect(editor.preview.accept(request, 'late').accepted).toBe(false);
    });

    it('cancels explicitly, disposes repeatedly and retains the host binding', () =>
    {
        const editor = open();
        const first = editor.preview.begin();
        editor.preview.cancel();
        expect(first.signal.aborted).toBe(true);
        expect(editor.preview.accept(first, 'late').accepted).toBe(false);
        const second = editor.preview.begin();
        editor.preview.dispose();
        editor.preview.dispose();
        expect(second.signal.aborted).toBe(true);
        expect(() => editor.preview.begin()).toThrow('article-preview-source-disposed');
        const hostTask = editor.owner.beginTask('search', 'article-search', 'version:1');
        expect(hostTask.isCurrent()).toBe(true);
        hostTask.cancel();
    });

    it('invalidates on real public pending insertion and lifecycle cancellation with unchanged placeholder bytes', () =>
    {
        const editor = open();
        const beforeInsertion = editor.preview.begin();
        const attached = editor.bindPublicEditor();
        const handle = attached.handles[0];
        if (!handle) throw new Error('pending handle missing');
        expect(handle.snapshot.state).toBe('provider-pending');
        expect(editor.source).toContain('![one.png]()');
        expect(beforeInsertion.signal.aborted).toBe(true);
        expect(editor.preview.accept(beforeInsertion, 'old').accepted).toBe(false);
        const pending = editor.preview.begin();
        const context = editor.owner.context;
        handle.cancel();
        expect(editor.owner.context).toBe(context);
        expect(handle.snapshot.state).toBe('cancelled');
        expect(editor.preview.accept(pending, 'old').accepted).toBe(false);
        const canceled = editor.preview.begin();
        expect(canceled.attachmentLifecycleHistoryDigest).not.toBe(pending.attachmentLifecycleHistoryDigest);
        expect(Object.hasOwn(canceled, 'verifiedAssets')).toBe(false);
    });

    it('rejects malformed/tampered lifecycle history rather than treating receipts as assets', () =>
    {
        const editor = open();
        const attached = editor.bindPublicEditor();
        const request = editor.preview.begin();
        const receipt = attached.handles[0]?.snapshot;
        if (!receipt) throw new Error('receipt missing');
        editor.setHistory([{ ...receipt, state: 'transaction-committed' }]);
        expect(editor.preview.accept(request, 'invalid').reason).toBe('preview-input-invalid');
        expect(() => editor.preview.begin()).toThrow('article-preview-attachment-history-invalid');
        editor.setHistory(Array.from({ length: 65 }, () => receipt));
        expect(() => editor.preview.begin()).toThrow('article-preview-attachment-history-invalid');
    });

    it('fails closed when the current source read throws or differs from the canonical byte digest', () =>
    {
        const editor = open();
        let fail = false;
        const admission = ArticlePreviewSourceAdmission.attach(() => {
            if (fail) throw new Error('read failed');
            return editor.read();
        }, editor.authority);
        cleanups.push(() => admission.dispose());
        const request = admission.begin();
        fail = true;
        expect(admission.accept(request, 'late').reason).toBe('preview-input-invalid');
        expect(request.signal.aborted).toBe(true);
    });
});
