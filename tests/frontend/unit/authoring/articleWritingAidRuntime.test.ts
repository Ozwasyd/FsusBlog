// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { ElMarkdownEditor, type MarkdownEditorDispatchResult } from '@ozwasyd/element-plus';
import { createMarkdownAnchorMap } from '@ozwasyd/element-plus/markdown-runtime';
import { afterEach, describe, expect, it } from 'vitest';

import { ArticleAnchorContextAdapter, articleScrollIntentPolicy } from '@/services/authoring/articleAnchorContext';
import { ArticleAttachmentContextAdapter, type ArticleAttachmentTransactionPort } from '@/services/authoring/articleAttachmentContext';
import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';
import { type ArticleEditorContinuityPort } from '@/services/authoring/articleEditorContinuity';
import { bindArticleEditorRuntime, type ArticleEditorRuntimeBinding } from '@/services/authoring/articleEditorRuntimeBinding';
import {
    createArticleWritingAidRuntimeConsumer,
    type ArticleWritingAidRuntimeFacts
} from '@/services/authoring/articleWritingAidRuntime';
import { calculateOpenArticleDocumentDigest as digest } from '@/services/authoring/openArticleDocumentRegistry';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()));

const facts: ArticleWritingAidRuntimeFacts = {
    requested: { focus: true, typewriter: true },
    editablePane: true,
    readonly: false,
    focusAvailable: true,
    typewriterAvailable: true,
    overlayActive: false,
    composing: false,
    selectionDragging: false,
    assistiveNavigation: false,
    explicitNavigationActive: false,
    viewportAvailable: true
};

function open()
{
    let source = '# Heading\n\nabcdef';
    const owner = createArticleDocumentContextAdapter({ articleId: 1, draftId: 'article:1',
        editorSessionId: 'session:writing-aids', siteScope: 'site:test', userScope: 'user:test', content: source });
    const anchors = new ArticleAnchorContextAdapter(owner);
    const attachments = new ArticleAttachmentContextAdapter(owner, 'attachment:test', 'attachment:v1', anchors);
    let binding: ArticleEditorRuntimeBinding | null = null;
    const wrapper = mount(ElMarkdownEditor, { props: {
        modelValue: source, mode: 'source', editorProfile: 'prose', documentIdentity: owner.documentIdentity,
        onTransaction: (result: MarkdownEditorDispatchResult) => binding?.consumeTransaction(result)
    } });
    const editor = wrapper.vm as unknown as ArticleEditorContinuityPort;
    let positionReads = 0;
    const port: ArticleAttachmentTransactionPort = {
        dispatch: transaction => editor.dispatchTransaction(transaction),
        commitSource: result =>
        {
            source = result.value;
            if (result.revision > owner.context.sourceRevision) owner.updateSource(source, result.revision);
        },
        binding: () =>
        {
            positionReads += 1;
            return { document: owner.context, map: createMarkdownAnchorMap({ identity: owner.documentIdentity, source }) };
        }
    };
    binding = bindArticleEditorRuntime(owner, anchors, attachments, port, () => source, editor, {
        surface: 'source', configuration: { allowLatex: true, allowMermaid: true, baseUrl: null },
        identity: { themeDigest: digest({ theme: 'test' }), locale: 'zh-CN' },
        cachePolicy: { maxEntryBytes: 65536, maxAgeMs: 60000, maxReceipts: 16 }
    });
    expect(binding.initialize()).toBe(true);
    const consumer = createArticleWritingAidRuntimeConsumer(binding, owner);
    cleanups.push(() => { binding?.dispose(); attachments.dispose(); wrapper.unmount(); owner.dispose(); });
    return { owner, anchors, binding, consumer, wrapper, editor, positionReads: () => positionReads };
}

describe('writing aids consume the real unified binding (#2287)', () =>
{
    it('uses the existing mounted public editor and preserves actual selection/history/source', async () =>
    {
        const f = open();
        const transaction = { changes: [{ from: 12, to: 12, insert: 'X' }], history: 'separate' as const,
            origin: 'command' as const, documentIdentity: f.owner.documentIdentity,
            expectedRevision: f.owner.context.sourceRevision, selection: { start: 13, end: 16, direction: 'backward' as const } };
        const before = f.editor.dispatchTransaction(transaction);
        expect(before.accepted).toBe(true);
        const context = f.owner.context;
        const instance = f.wrapper.vm;
        const view = f.consumer.read(facts);
        expect(view.status).toBe('bound');
        await f.wrapper.setProps(view.policy.editorProps);
        const after = f.editor.dispatchTransaction({ changes: [], history: 'skip', origin: 'programmatic',
            documentIdentity: f.owner.documentIdentity, expectedRevision: f.owner.context.sourceRevision });
        expect(after.accepted).toBe(true);
        expect(after.value).toBe(before.value);
        expect(after.history).toEqual(before.history);
        expect(after.selection).toEqual(before.selection);
        expect(f.owner.context).toBe(context);
        expect(f.wrapper.vm).toBe(instance);
        expect(view.policy.focus.effective).toBe(true);
        expect(view.policy.typewriter.effective).toBe(true);
    });

    it.each(['wheel', 'trackpad', 'touch', 'drag', 'selection'] as const)(
        'reads actual %s intent and delegates input resume', kind =>
        {
            const f = open();
            f.anchors.manual(kind, 'source', 100);
            const generation = f.anchors.userIntent.generation;
            const blocked = f.consumer.read(facts);
            expect(blocked.policy.typewriter.blockedReason).toBe('manual-scroll');
            expect(blocked.policy.focus.effective).toBe(true);
            expect(f.anchors.userIntent.generation).toBe(generation);
            expect(f.consumer.resumeTypewriter(facts, 'input', 101)).toBe(true);
            expect(f.anchors.userIntent.resume).toBe('input');
            expect(f.consumer.read(facts).policy.typewriter.effective).toBe(true);
            expect(facts.requested).toEqual({ focus: true, typewriter: true });
        }
    );

    it('uses the original idle deadline and navigation generation without introducing a timer', () =>
    {
        const f = open();
        f.anchors.manual('touch', 'renderer', 100);
        expect(f.consumer.resumeTypewriter(facts, 'idle', 100 + articleScrollIntentPolicy.idleResumeMs - 1)).toBe(false);
        expect(f.consumer.resumeTypewriter(facts, 'idle', 100 + articleScrollIntentPolicy.idleResumeMs)).toBe(true);
        f.anchors.manual('wheel', 'source', 1500);
        expect(f.consumer.resumeTypewriter({ ...facts, explicitNavigationActive: true }, 'navigation', 1501)).toBe(true);
        expect(f.anchors.userIntent.resume).toBe('navigation');
    });

    it.each([
        ['composing', true], ['selectionDragging', true], ['assistiveNavigation', true],
        ['overlayActive', true], ['readonly', true], ['editablePane', false],
        ['typewriterAvailable', false], ['viewportAvailable', false]
    ] as const)('does not resume during %s', (key, value) =>
    {
        const f = open();
        f.anchors.manual('wheel', 'source', 100);
        const before = f.anchors.userIntent;
        expect(f.consumer.resumeTypewriter({ ...facts, [key]: value }, 'input', 101)).toBe(false);
        expect(f.anchors.userIntent).toBe(before);
    });

    it('does not resume the global anchor owner for Focus-only requests', () =>
    {
        const f = open();
        f.anchors.manual('wheel', 'source', 100);
        expect(f.consumer.resumeTypewriter({ ...facts, requested: { focus: true, typewriter: false } }, 'input', 101)).toBe(false);
        expect(f.anchors.userIntent.state).toBe('manual');
    });

    it('gives pending explicit navigation priority over input and idle resume', () =>
    {
        const f = open();
        f.anchors.manual('wheel', 'source', 100);
        const input = { ...facts, explicitNavigationActive: true };
        const before = f.anchors.userIntent;
        expect(f.consumer.resumeTypewriter(input, 'input', 101)).toBe(false);
        expect(f.consumer.resumeTypewriter(input, 'idle', 2000)).toBe(false);
        expect(f.anchors.userIntent).toBe(before);
    });

    it('fails closed after real binding disposal and preserves requested preferences', () =>
    {
        const f = open();
        f.binding.dispose();
        const view = f.consumer.read(facts);
        expect(view.status).toBe('unavailable');
        expect(view.reason).toBe('editor-binding-unavailable');
        expect(view.policy.editorProps.writingAids).toBeUndefined();
        expect(view.policy.typewriter.requested).toBe(true);
        expect(f.consumer.resumeTypewriter(facts, 'input', 100)).toBe(false);
    });

    it('does not read binding maps or intent when disabled or preferences are unavailable', () =>
    {
        const f = open();
        const before = f.positionReads();
        expect(f.consumer.read({ ...facts, requested: { focus: false, typewriter: false } }).status).toBe('disabled');
        expect(f.consumer.read({ ...facts, requested: null }).reason).toBe('preference-unavailable');
        expect(f.positionReads()).toBe(before);
    });

    it('rejects a different real document owner even when article content bytes match', () =>
    {
        const f = open();
        const other = createArticleDocumentContextAdapter({ articleId: 2, draftId: 'article:2',
            editorSessionId: 'session:other', siteScope: 'site:test', userScope: 'user:test', content: '# Heading\n\nabcdef' });
        cleanups.push(() => { other.dispose(); });
        expect(other.context.contentDigest).toBe(f.owner.context.contentDigest);
        const consumer = createArticleWritingAidRuntimeConsumer(f.binding, other);
        expect(consumer.read(facts).reason).toBe('editor-binding-stale');
        expect(consumer.resumeTypewriter(facts, 'input', 100)).toBe(false);
    });
});
