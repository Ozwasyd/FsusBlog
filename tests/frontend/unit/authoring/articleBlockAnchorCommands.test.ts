// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import {
    ElMarkdownEditor,
    type MarkdownEditorCommandContext,
    type MarkdownEditorDispatchResult,
    type MarkdownEditorTransaction
} from '@ozwasyd/element-plus';
import { createMarkdownAnchorMap, createMarkdownEditorProjection, stabilizeMarkdownEditorProjection } from '@ozwasyd/element-plus/markdown-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ArticleAnchorContextAdapter } from '@/services/authoring/articleAnchorContext';
import { ArticleAttachmentContextAdapter } from '@/services/authoring/articleAttachmentContext';
import { createArticleBlockAnchorRevealCommand } from '@/services/authoring/articleBlockAnchorCommands';
import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';
import { bindArticleEditorRuntime, type ArticleEditorRuntimeBinding } from '@/services/authoring/articleEditorRuntimeBinding';
import { calculateOpenArticleDocumentDigest as digest } from '@/services/authoring/openArticleDocumentRegistry';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()));

function fixture()
{
    const source = 'Paragraph ^intro';
    const owner = createArticleDocumentContextAdapter({ articleId: 1, draftId: 'article:1',
        editorSessionId: 'editor:block-test', siteScope: 'site:test', userScope: 'user:test', content: source });
    const anchors = new ArticleAnchorContextAdapter(owner);
    const attachments = new ArticleAttachmentContextAdapter(owner, 'article-assets', 'article-assets:v1', anchors);
    const wrapper = mount(ElMarkdownEditor, { props: { modelValue: source, mode: 'source', documentIdentity: owner.documentIdentity } });
    const editor = wrapper.vm as unknown as { dispatchTransaction(transaction: MarkdownEditorTransaction): MarkdownEditorDispatchResult; };
    const binding = bindArticleEditorRuntime(owner, anchors, attachments, {
        dispatch: transaction => editor.dispatchTransaction(transaction),
        commitSource: () => { throw new Error('Navigation must never commit source.'); },
        binding: () => ({ document: owner.context, map: createMarkdownAnchorMap({ identity: owner.documentIdentity, source }) })
    }, () => source, editor, { surface: 'source', configuration: { allowLatex: false, allowMermaid: false, baseUrl: null },
        identity: { themeDigest: digest({ theme: 'test' }), locale: 'zh-CN' },
        cachePolicy: { maxEntryBytes: 65536, maxAgeMs: 60000, maxReceipts: 16 } });
    const projection = stabilizeMarkdownEditorProjection(createMarkdownEditorProjection(source), owner.documentIdentity);
    const node = projection.nodes.find(item => item.kind === 'anchor')!;
    const controller = new AbortController();
    const dispatch = vi.fn(() => { throw new Error('Command planning must not self-dispatch.'); });
    const context: MarkdownEditorCommandContext = { value: source, projection, documentIdentity: owner.documentIdentity,
        revision: owner.context.sourceRevision, readonly: false, mode: 'source', signal: controller.signal,
        selection: { start: node.rawRange.start, end: node.rawRange.end, direction: 'backward' }, dispatch: { dispatch },
        syntax: { nodeId: node.id, blockIdentity: node.blockIdentity, range: node.rawRange, contentRanges: node.rawContentRanges,
            markerRanges: node.rawMarkerRanges, type: node.kind, status: node.status, diagnosticCode: node.diagnosticCode } };
    cleanups.push(() => { binding.dispose(); attachments.dispose(); wrapper.unmount(); owner.dispose(); });
    const command = createArticleBlockAnchorRevealCommand(binding, { label: '显示锚点源码', reason: reason => `诊断：${reason}` });
    return { owner, binding, context, command, controller, dispatch };
}

describe('Block command consumer of real shared runtime binding (#2444)', () =>
{
    it('uses the real binding and command authority while preserving the current upstream resolver failure', () =>
    {
        const { owner, binding, context, command, dispatch } = fixture();
        expect(binding.context).toBe(owner.context);
        expect(command.key).toBe('reveal-anchor-source');
        expect(command.presentation).toEqual(['palette', 'selection']);
        expect(command.when?.(context)).toBe(true);
        expect(command.enabled?.(context)).toBe(false);
        expect(command.disabledReason?.(context)).toBe('诊断：source-node-stale');
        expect(() => command.run(context)).toThrow('诊断：source-node-stale');
        expect(dispatch).not.toHaveBeenCalled();
        expect(owner.context.sourceRevision).toBe(0);
    });

    it('does not expose the command without a projected explicit anchor', () =>
    {
        const { context, command } = fixture();
        expect(command.when?.({ ...context, syntax: undefined })).toBe(false);
    });

    it('requires the source surface instead of fabricating a surface/focus acknowledgement', () =>
    {
        const { context, command } = fixture();
        expect(command.disabledReason?.({ ...context, mode: 'live' })).toBe('诊断：source-mode-required');
        expect(() => command.run({ ...context, mode: 'live' })).toThrow('诊断：source-mode-required');
    });

    it('reports read-only admission consistently with the public command execution gate', () =>
    {
        const { context, command } = fixture();
        expect(command.disabledReason?.({ ...context, readonly: true })).toBe('诊断：editor-readonly');
    });

    it('reads binding lifetime rather than retaining a parallel released-session state', () =>
    {
        const { binding, context, command } = fixture();
        binding.dispose();
        expect(command.enabled?.(context)).toBe(false);
        expect(command.disabledReason?.(context)).toBe('诊断：editor-binding-unavailable');
        expect(() => command.run(context)).toThrow('诊断：editor-binding-unavailable');
    });

    it('denies changed raw bytes even when their normalized form could match', () =>
    {
        const { context, command } = fixture();
        expect(command.disabledReason?.({ ...context, value: `${context.value}\r\n` })).toBe('诊断：editor-binding-stale');
    });

    it('rechecks cancellation from the real command signal at execution', () =>
    {
        const { context, command, controller } = fixture();
        controller.abort();
        expect(command.disabledReason?.(context)).toBe('诊断：command-aborted');
        expect(() => command.run(context)).toThrow('诊断：command-aborted');
    });

    it('rechecks revision and same-source article switch through the live binding context', () =>
    {
        const { owner, context, command } = fixture();
        owner.updateSource(context.value, 1);
        expect(command.disabledReason?.(context)).toBe('诊断：document-stale');
        owner.switchDocument({ articleId: 2, draftId: 'article:2', content: context.value });
        expect(command.disabledReason?.(context)).toBe('诊断：document-stale');
    });

    it('rejects a binding whose actual position-map context drifted', () =>
    {
        const { owner, binding, context } = fixture();
        const old = binding.positionBinding();
        owner.updateSource(context.value, 1);
        // This negative control tampers only a copied handle, never the canonical owner.
        const tampered = { ...binding, context: owner.context, positionBinding: () => old } satisfies ArticleEditorRuntimeBinding;
        const command = createArticleBlockAnchorRevealCommand(tampered, { label: '显示源码', reason: reason => reason });
        expect(command.disabledReason?.(context)).toBe('editor-binding-stale');
    });
});
