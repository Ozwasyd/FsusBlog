// @vitest-environment happy-dom

import {
    ElMarkdownEditor,
    type MarkdownEditorDispatchResult,
    type MarkdownEditorInstance,
    type MarkdownEditorTransaction
} from '@ozwasyd/element-plus';
import { createMarkdownAnchorMap } from '@ozwasyd/element-plus/markdown-runtime';
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import { ArticleAnchorContextAdapter } from '@/services/authoring/articleAnchorContext';
import { ArticleAttachmentContextAdapter, type ArticleAttachmentTransactionPort } from '@/services/authoring/articleAttachmentContext';
import { ArticleDocumentContextAuthority } from '@/services/authoring/articleDocumentContext';
import { bindArticleEditorRuntime } from '@/services/authoring/articleEditorRuntimeBinding';
import { calculateOpenArticleDocumentDigest as digest } from '@/services/authoring/openArticleDocumentRegistry';

const cleanups: (() => void)[] = [];
const sourceBytes = '# Shared body\n\nabcdef';
const captureOptions = {
    surface: 'source' as const,
    tool: 'none' as const,
    affinity: 'after' as const,
    viewportOffset: 0,
    percentage: 0
};

afterEach(() =>
{
    cleanups.splice(0).reverse().forEach(cleanup => cleanup());
});

function openSession(authority: ArticleDocumentContextAuthority, articleId: number)
{
    let source = sourceBytes;
    const lease = authority.acquire({
        articleId,
        siteScope: 'site:session-replacement',
        userScope: 'user:session-replacement',
        content: source
    });
    const owner = lease.adapter;
    const anchors = new ArticleAnchorContextAdapter(owner);
    const attachments = new ArticleAttachmentContextAdapter(owner, 'article-assets', 'article-assets:v1', anchors);
    let runtime: ReturnType<typeof bindArticleEditorRuntime> | null = null;
    const consumed: boolean[] = [];
    const wrapper = mount(ElMarkdownEditor, {
        props: {
            modelValue: source,
            mode: 'source',
            documentIdentity: owner.documentIdentity,
            onTransaction: (result: MarkdownEditorDispatchResult) =>
            {
                if (runtime !== null)
                {
                    consumed.push(runtime.consumeTransaction(result));
                }
            }
        }
    });
    const editor = wrapper.vm as unknown as MarkdownEditorInstance;
    const port: ArticleAttachmentTransactionPort = {
        dispatch: transaction => editor.dispatchTransaction(transaction),
        commitSource: result =>
        {
            if (result.revision > owner.context.sourceRevision)
            {
                owner.updateSource(result.value, result.revision);
            }
            source = result.value;
        },
        binding: () => ({
            document: owner.context,
            map: createMarkdownAnchorMap({ identity: owner.documentIdentity, source })
        })
    };
    runtime = bindArticleEditorRuntime(owner, anchors, attachments, port, () => source, editor, {
        surface: 'source',
        configuration: { allowLatex: true, allowMermaid: true, baseUrl: null },
        identity: { themeDigest: digest({ theme: 'session-replacement' }), locale: 'zh-CN' },
        cachePolicy: { maxEntryBytes: 65536, maxAgeMs: 60000, maxReceipts: 8 }
    });
    const binding = runtime;
    let released = false;
    const release = () =>
    {
        if (released)
        {
            return;
        }
        released = true;
        binding.dispose();
        attachments.dispose();
        wrapper.unmount();
        lease.release();
    };
    cleanups.push(release);
    expect(binding.initialize()).toBe(true);
    const capture = () => binding.continuity.capture(binding.positionBinding(), captureOptions);
    const dispatch = (input: Omit<MarkdownEditorTransaction, 'documentIdentity' | 'expectedRevision'>) =>
    {
        const result = binding.dispatchTransaction(owner.context, {
            ...input,
            documentIdentity: owner.documentIdentity,
            expectedRevision: owner.context.sourceRevision
        });
        expect(result.accepted).toBe(true);
        expect(consumed.at(-1)).toBe(true);
        return result;
    };
    return { owner, binding, editor, wrapper, capture, dispatch, release, source: () => source };
}

describe('ordinary real editor session replacement and constructor ownership', () =>
{
    it('replaces the released native editor for a new article at revision zero and cancels only original tasks', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const original = openSession(authority, 51);
        const before = original.capture();
        original.dispatch({
            changes: [],
            history: 'skip',
            origin: 'programmatic',
            selection: { start: 15, end: 19, direction: 'backward' }
        });
        const stable = original.capture();
        expect(stable.instanceRef).toBe(before.instanceRef);
        expect(stable.sessionRef).toBe(before.sessionRef);
        expect(stable.historyRef).toBe(before.historyRef);
        expect(stable.document.documentId).toBe(before.document.documentId);
        expect(stable.anchor.direction).toBe('backward');
        const originalTask = original.owner.beginTask('search', 'search:replacement', 'search:v1');
        const originalTool = original.binding.beginToolTask('source-compare');
        original.release();
        expect(originalTask.signal.aborted).toBe(true);
        expect(originalTask.envelope.abortReason).toBe('component-unmounted');
        expect(originalTool.signal.aborted).toBe(true);

        // This is a new article/document session, not a fabricated restoration
        // of a retained advanced owner into an editor that starts at revision 0.
        const replacement = openSession(authority, 52);
        const current = replacement.capture();
        expect(replacement.owner.context.sourceRevision).toBe(0);
        expect(replacement.source()).toBe(original.source());
        expect(replacement.wrapper.vm).not.toBe(original.editor);
        expect(current.instanceRef).not.toBe(stable.instanceRef);
        expect(current.sessionRef).toBe(stable.sessionRef);
        expect(current.historyRef).not.toBe(stable.historyRef);
        expect(current.document.documentId).not.toBe(stable.document.documentId);
        const replacementTask = replacement.owner.beginTask('search', 'search:replacement', 'search:v1');
        expect(originalTask.accept('original late result').accepted).toBe(false);
        originalTask.cancel('task-canceled');
        original.release();
        expect(replacementTask.signal.aborted).toBe(false);
        expect(replacementTask.isCurrent()).toBe(true);
        expect(replacementTask.accept('replacement result')).toMatchObject({ accepted: true, value: 'replacement result' });
        replacement.dispatch({
            changes: [{ from: sourceBytes.length, to: sourceBytes.length, insert: '\nReplacement' }],
            history: 'separate',
            origin: 'programmatic'
        });
        expect(replacement.source()).toBe(`${sourceBytes}\nReplacement`);
        expect(original.source()).toBe(sourceBytes);
    });

    it('keeps constructor-owned document/task controllers independent for simultaneous same-byte article sessions', () =>
    {
        const left = openSession(new ArticleDocumentContextAuthority(), 71);
        const right = openSession(new ArticleDocumentContextAuthority(), 71);
        const leftContext = left.owner.context;
        const rightContext = right.owner.context;
        expect(left.source()).toBe(right.source());
        expect(leftContext.documentId).not.toBe(rightContext.documentId);
        expect(leftContext.editorSessionId).not.toBe(rightContext.editorSessionId);
        const leftTask = left.owner.beginTask('outline', 'outline:independent', 'outline:v1');
        const rightTask = right.owner.beginTask('outline', 'outline:independent', 'outline:v1');
        expect(leftTask.signal).not.toBe(rightTask.signal);
        expect(leftTask.envelope.context.contextDigest).toBe(leftContext.contextDigest);
        expect(rightTask.envelope.context.contextDigest).toBe(rightContext.contextDigest);
        const rightRefs = right.capture();
        left.owner.dispose();
        left.release();
        expect(leftTask.signal.aborted).toBe(true);
        expect(rightTask.signal.aborted).toBe(false);
        expect(rightTask.isCurrent()).toBe(true);
        expect(right.owner.context.contextDigest).toBe(rightContext.contextDigest);
        expect(rightTask.accept('surviving outline')).toMatchObject({ accepted: true, value: 'surviving outline' });
        right.dispatch({
            changes: [{ from: 15, to: 15, insert: 'X' }],
            history: 'separate',
            origin: 'programmatic'
        });
        expect(right.source()).toBe('# Shared body\n\nXabcdef');
        expect(left.source()).toBe(sourceBytes);
        const rightAfter = right.capture();
        expect(rightAfter.instanceRef).toBe(rightRefs.instanceRef);
        expect(rightAfter.sessionRef).toBe(rightRefs.sessionRef);
        expect(rightAfter.document.documentId).toBe(rightRefs.document.documentId);
        expect(right.editor.undo().accepted).toBe(true);
        expect(right.source()).toBe(sourceBytes);
        expect(right.editor.redo().accepted).toBe(true);
        expect(right.source()).toBe('# Shared body\n\nXabcdef');
    });
});
