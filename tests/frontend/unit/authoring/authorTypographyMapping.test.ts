// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { ElMarkdownEditor } from '@ozwasyd/element-plus';
import { createMarkdownAnchorMap } from '@ozwasyd/element-plus/markdown-runtime';
import { afterEach, describe, expect, it } from 'vitest';

import { ArticleAnchorContextAdapter } from '@/services/authoring/articleAnchorContext';
import { ArticleAttachmentContextAdapter } from '@/services/authoring/articleAttachmentContext';
import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';
import { validateArticleEditorContinuityContext } from '@/services/authoring/articleEditorContinuity';
import { bindArticleEditorRuntime } from '@/services/authoring/articleEditorRuntimeBinding';
import { captureAuthorTypographyContinuity, readAuthorTypographyMappingAvailability } from '@/services/authoring/authorTypographyMapping';
import { calculateOpenArticleDocumentDigest } from '@/services/authoring/openArticleDocumentRegistry';

import type { MarkdownEditorDispatchResult, MarkdownEditorTransaction } from '@ozwasyd/element-plus';
import type { ArticleEditorContinuityPort } from '@/services/authoring/articleEditorContinuity';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()));

function openRuntime(surface: 'live' | 'source')
{
    let source = '# Heading\n\nCJK 中文 العربية emoji 👩🏽‍💻 é';
    const owner = createArticleDocumentContextAdapter({
        articleId: 1, draftId: 'article:1', editorSessionId: 'session:typography',
        siteScope: 'site:test', userScope: 'user:test', content: source
    });
    const anchors = new ArticleAnchorContextAdapter(owner);
    const attachments = new ArticleAttachmentContextAdapter(owner, 'article-assets', 'version:1', anchors);
    let consumeTransaction: ((result: MarkdownEditorDispatchResult) => boolean) | null = null;
    const wrapper = mount(ElMarkdownEditor, {
        props: {
            modelValue: source, mode: surface, documentIdentity: owner.documentIdentity,
            onTransaction: (result: MarkdownEditorDispatchResult) => consumeTransaction?.(result)
        }
    });
    const editor = wrapper.vm as unknown as ArticleEditorContinuityPort;
    const binding = bindArticleEditorRuntime(owner, anchors, attachments, {
        dispatch: (transaction: MarkdownEditorTransaction) => editor.dispatchTransaction(transaction),
        commitSource: result =>
        {
            source = result.value;
            if (result.revision > owner.context.sourceRevision)
            {
                owner.updateSource(source, result.revision);
            }
        },
        binding: () => ({ document: owner.context, map: createMarkdownAnchorMap({ identity: owner.documentIdentity, source }) })
    }, () => source, editor, {
        surface,
        configuration: { allowLatex: false, allowMermaid: false, baseUrl: null },
        identity: { locale: 'zh-CN', themeDigest: calculateOpenArticleDocumentDigest({ theme: 'light' }) },
        cachePolicy: { maxEntryBytes: 65536, maxAgeMs: 60000, maxReceipts: 16 }
    });
    consumeTransaction = result => binding.consumeTransaction(result);
    const options = { affinity: 'after' as const, viewportOffset: 12, percentage: 0.25, surface, tool: 'none' as const };
    cleanups.push(() =>
    {
        binding.dispose();
        attachments.dispose();
        wrapper.unmount();
        owner.dispose();
    });
    return { binding, owner, editor, wrapper, options, source: () => source };
}

describe('author typography public mapping boundary', () =>
{
    it('refuses the real aliased public editor contract without manufacturing CSS or defaults', () =>
    {
        const availability = readAuthorTypographyMappingAvailability();
        expect(availability).toEqual({
            status: 'blocked',
            reason: 'public-typography-contract-unavailable',
            publicEditorDefaultProfile: ElMarkdownEditor.props.editorProfile.default
        });
        expect(Object.isFrozen(availability)).toBe(true);
        expect(ElMarkdownEditor.props.editorProfile.validator('markdown')).toBe(true);
        expect(ElMarkdownEditor.props.editorProfile.validator('prose')).toBe(true);
        for (const value of ['reading-serif', 'cjk-sans', 'system-sans', '18px', 'standard'])
        {
            expect(ElMarkdownEditor.props.editorProfile.validator(value)).toBe(false);
        }
    });

    it('cannot apply preferences or mutate a live editor through the capability observation', () =>
    {
        expect(Object.keys(readAuthorTypographyMappingAvailability()).sort()).toEqual([
            'publicEditorDefaultProfile', 'reason', 'status'
        ]);
        expect(readAuthorTypographyMappingAvailability()).not.toHaveProperty('apply');
        expect(readAuthorTypographyMappingAvailability()).not.toHaveProperty('profile');
    });

    it.each(['live', 'source'] as const)('captures %s through the real runtime binding without transactions or remount', surface =>
    {
        const runtime = openRuntime(surface);
        expect(runtime.binding.initialize()).toBe(true);
        const selected = runtime.editor.dispatchTransaction({
            changes: [], history: 'skip', origin: 'programmatic',
            documentIdentity: runtime.owner.documentIdentity, expectedRevision: runtime.owner.context.sourceRevision,
            selection: { start: 12, end: 18, direction: 'backward' }
        });
        expect(selected.accepted).toBe(true);
        const before = runtime.binding.continuity.capture(runtime.binding.positionBinding(), runtime.options);
        const source = runtime.source();
        const context = runtime.owner.context;
        const editor = runtime.wrapper.vm;
        const transactions = runtime.wrapper.emitted('transaction')?.length;
        runtime.binding.anchors.manual('wheel', 'source', 100);
        const captured = captureAuthorTypographyContinuity(runtime.binding, runtime.options);
        expect(validateArticleEditorContinuityContext(captured)).toBe(true);
        expect(captured.anchor.intent.state).toBe('manual');
        expect(captured.anchor.direction).toBe('backward');
        expect(captured.anchor.viewportOffset).toBe(12);
        expect(captured.historyRef).toBe(before.historyRef);
        expect(captured.instanceRef).toBe(before.instanceRef);
        expect(captured.document).toEqual(context);
        expect(runtime.owner.context).toBe(context);
        expect(runtime.source()).toBe(source);
        expect(runtime.wrapper.vm).toBe(editor);
        expect(runtime.wrapper.emitted('transaction')?.length).toBe(transactions);
        expect(Object.isFrozen(captured)).toBe(true);
        expect(readAuthorTypographyMappingAvailability().status).toBe('blocked');
    });

    it('retains canonical refusal for unobserved, mismatched, stale and disposed bindings', () =>
    {
        const runtime = openRuntime('source');
        expect(() => captureAuthorTypographyContinuity(runtime.binding, runtime.options)).toThrow('continuity-observation-required');
        expect(runtime.binding.initialize()).toBe(true);
        expect(() => captureAuthorTypographyContinuity(runtime.binding, { ...runtime.options, surface: 'live' })).toThrow('continuity-observation-required');
        runtime.owner.switchDocument({ articleId: 2, draftId: 'article:2', content: runtime.source(), reason: 'article-switch' });
        expect(() => captureAuthorTypographyContinuity(runtime.binding, runtime.options)).toThrow('continuity-observation-required');
        runtime.binding.dispose();
        expect(() => captureAuthorTypographyContinuity(runtime.binding, runtime.options)).toThrow('article-editor-runtime-binding-disposed');
    });
});
