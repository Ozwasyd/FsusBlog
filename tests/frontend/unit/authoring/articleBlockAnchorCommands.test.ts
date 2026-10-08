// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import {
    ElMarkdownEditor,
    runMarkdownEditorCommand,
    resolveMarkdownEditorLocaleText,
    type MarkdownEditorCommandContext,
    type MarkdownEditorDispatchResult,
    type MarkdownEditorTransaction
} from '@ozwasyd/element-plus';
import { createMarkdownAnchorMap, createMarkdownEditorProjection, stabilizeMarkdownEditorProjection } from '@ozwasyd/element-plus/markdown-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ArticleAnchorContextAdapter } from '@/services/authoring/articleAnchorContext';
import { ArticleAttachmentContextAdapter } from '@/services/authoring/articleAttachmentContext';
import { createArticleBlockAnchorRevealCommand, guardArticleBlockAnchorCoreCommands } from '@/services/authoring/articleBlockAnchorCommands';
import { fsusUiMarkdownCoreCommands } from '@/fsusui/articleBlockAnchors';
import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';
import { bindArticleEditorRuntime, type ArticleEditorRuntimeBinding } from '@/services/authoring/articleEditorRuntimeBinding';
import { calculateOpenArticleDocumentDigest as digest } from '@/services/authoring/openArticleDocumentRegistry';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()));

function fixture(source = 'Paragraph ^intro')
{
    const owner = createArticleDocumentContextAdapter({ articleId: 1, draftId: 'article:1',
        editorSessionId: 'editor:block-test', siteScope: 'site:test', userScope: 'user:test', content: source });
    const anchors = new ArticleAnchorContextAdapter(owner);
    const attachments = new ArticleAttachmentContextAdapter(owner, 'article-assets', 'article-assets:v1', anchors);
    const wrapper = mount(ElMarkdownEditor, { props: { modelValue: source, mode: 'source', documentIdentity: owner.documentIdentity } });
    const editor = wrapper.vm as unknown as { dispatchTransaction(transaction: MarkdownEditorTransaction): MarkdownEditorDispatchResult; openCommandPalette(): void; };
    const binding = bindArticleEditorRuntime(owner, anchors, attachments, {
        dispatch: transaction => editor.dispatchTransaction(transaction),
        commitSource: result => owner.updateSource(result.value),
        binding: () => ({ document: owner.context, map: createMarkdownAnchorMap({ identity: owner.documentIdentity, source }) })
    }, () => source, editor, { surface: 'source', configuration: { allowLatex: false, allowMermaid: false, baseUrl: null },
        identity: { themeDigest: digest({ theme: 'test' }), locale: 'zh-CN' },
        cachePolicy: { maxEntryBytes: 65536, maxAgeMs: 60000, maxReceipts: 16 } });
    const projection = stabilizeMarkdownEditorProjection(createMarkdownEditorProjection(source), owner.documentIdentity);
    const node = projection.nodes.find(item => item.kind === 'anchor') ?? projection.nodes[0]!;
    const controller = new AbortController();
    const dispatch = vi.fn(() => { throw new Error('Command planning must not self-dispatch.'); });
    const context: MarkdownEditorCommandContext = { value: source, projection, documentIdentity: owner.documentIdentity,
        revision: owner.context.sourceRevision, readonly: false, mode: 'source', signal: controller.signal,
        selection: { start: node.rawRange.start, end: node.rawRange.end, direction: 'backward' }, dispatch: { dispatch },
        syntax: { nodeId: node.id, blockIdentity: node.blockIdentity, range: node.rawRange, contentRanges: node.rawContentRanges,
            markerRanges: node.rawMarkerRanges, type: node.kind, status: node.status, diagnosticCode: node.diagnosticCode } };
    cleanups.push(() => { binding.dispose(); attachments.dispose(); wrapper.unmount(); owner.dispose(); });
    const command = createArticleBlockAnchorRevealCommand(binding, { label: '显示锚点源码', reason: reason => `诊断：${reason}` });
    return { owner, binding, context, command, controller, dispatch, editor, wrapper };
}

describe('Block command consumer of real shared runtime binding (#2444)', () =>
{
    it('reveals the real owner identity through a public command plan and actual editor dispatch', async () =>
    {
        const { owner, binding, context, command, dispatch, editor } = fixture();
        expect(binding.context).toBe(owner.context);
        expect(command.key).toBe('reveal-anchor-source');
        expect(command.presentation).toEqual(['palette', 'selection']);
        expect(context.projection!.resolve(context.syntax!.nodeId).status).toBe('current');
        expect(command.when?.(context)).toBe(true);
        expect(command.enabled?.(context)).toBe(true);
        expect(command.disabledReason?.(context)).toBeUndefined();
        const before = editor.dispatchTransaction({ changes: [], history: 'skip', origin: 'programmatic',
            documentIdentity: owner.documentIdentity, expectedRevision: owner.context.sourceRevision });
        expect(before.accepted).toBe(true);
        expect(binding.consumeTransaction(before)).toBe(true);
        const plan = await runMarkdownEditorCommand(command, context);
        expect(plan).toMatchObject({ focus: 'editor', transaction: { changes: [], history: 'skip', origin: 'command',
            documentIdentity: owner.documentIdentity, expectedRevision: 0,
            selection: { ...context.syntax!.range, direction: 'backward' } } });
        expect(dispatch).not.toHaveBeenCalled();
        const result = editor.dispatchTransaction(plan!.transaction!);
        expect(result).toMatchObject({ accepted: true, beforeRevision: 0, revision: 0, value: context.value,
            documentIdentity: owner.documentIdentity, selection: { ...context.syntax!.range, direction: 'backward' } });
        expect(result.history).toEqual(before.history);
        expect(binding.consumeTransaction(result)).toBe(true);
        expect(owner.context.sourceRevision).toBe(0);
        expect(owner.context).toBe(binding.context);
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


const guardCopy = { reason: (reason: string) => `诊断：${reason}` };

function collapsedContext(context: MarkdownEditorCommandContext): MarkdownEditorCommandContext
{
    return { ...context, selection: { start: context.syntax!.range.end, end: context.syntax!.range.end, direction: 'none' } };
}

describe('Same-key canonical block mutation command guard (#2444/#2445/#2449)', () =>
{
    it('decorates only the existing two core commands and preserves every other identity and presentation', () =>
    {
        const { binding } = fixture();
        const guarded = guardArticleBlockAnchorCoreCommands(fsusUiMarkdownCoreCommands, binding, guardCopy);
        expect(guarded.map(command => command.key)).toEqual(fsusUiMarkdownCoreCommands.map(command => command.key));
        expect(new Set(guarded.map(command => command.key)).size).toBe(guarded.length);
        for (const core of fsusUiMarkdownCoreCommands)
        {
            const decorated = guarded.find(command => command.key === core.key)!;
            if (core.key === 'anchor-insert' || core.key === 'anchor-properties')
            {
                expect(decorated.when).toBe(core.when);
                expect(decorated.presentation).toBe(core.presentation);
            }
            else
            {
                expect(decorated).toBe(core);
            }
        }
    });

    it('requires current impact before the canonical existing-anchor property surface can execute', async () =>
    {
        const { binding, context, dispatch, owner } = fixture();
        const core = fsusUiMarkdownCoreCommands.find(command => command.key === 'anchor-properties')!;
        expect(await core.run(context)).toEqual({ focus: 'surface', surface: 'anchor-properties' });
        const guarded = guardArticleBlockAnchorCoreCommands(fsusUiMarkdownCoreCommands, binding, guardCopy)
            .find(command => command.key === core.key)!;
        expect(guarded.when?.(context)).toBe(true);
        expect(guarded.enabled?.(context)).toBe(false);
        expect(guarded.disabledReason?.(context)).toBe('诊断：current-impact-required');
        expect(await runMarkdownEditorCommand(guarded, context)).toBeUndefined();
        expect(() => guarded.run(context)).toThrow('诊断：current-impact-required');
        expect(dispatch).not.toHaveBeenCalled();
        expect(owner.context.sourceRevision).toBe(0);
    });

    it('keeps unsupported insertion positions closed instead of guessing an offset or duplicating the form', () =>
    {
        const { binding, context, dispatch } = fixture('# Heading');
        const current = collapsedContext(context);
        const guarded = guardArticleBlockAnchorCoreCommands(fsusUiMarkdownCoreCommands, binding, guardCopy)
            .find(command => command.key === 'anchor-insert')!;
        expect(guarded.when?.(current)).toBe(true);
        expect(guarded.disabledReason?.(current)).toBe('诊断：anchor-create-position-required');
        expect(() => guarded.run(current)).toThrow('诊断：anchor-create-position-required');
        expect(dispatch).not.toHaveBeenCalled();
    });

    it.each(['full', 'content'] as const)('keeps the actual paragraph %s endpoint closed until mounted runtime admission', async endpoint =>
    {
        const { binding, context, dispatch, owner } = fixture('First.\r\n\r\nSecond.');
        const resolved = context.projection!.resolve(context.syntax!.nodeId);
        expect(resolved.status).toBe('current');
        const node = resolved.node!;
        const offset = endpoint === 'full' ? node.rawRange.end : node.rawContentRanges.at(-1)!.end;
        const current = { ...context, selection: { start: offset, end: offset, direction: 'none' as const } };
        const core = fsusUiMarkdownCoreCommands.find(command => command.key === 'anchor-insert')!;
        const guarded = guardArticleBlockAnchorCoreCommands(fsusUiMarkdownCoreCommands, binding, guardCopy)
            .find(command => command.key === core.key)!;
        expect(guarded.when?.(current)).toBe(true);
        expect(core.enabled?.(current)).not.toBe(false);
        expect(await core.run(current)).toEqual({ focus: 'surface', surface: 'anchor-properties' });
        expect(guarded.enabled?.(current)).toBe(false);
        expect(guarded.disabledReason?.(current)).toBe('诊断：anchor-runtime-admission-required');
        expect(await runMarkdownEditorCommand(guarded, current)).toBeUndefined();
        expect(() => guarded.run(current)).toThrow('诊断：anchor-runtime-admission-required');
        expect(dispatch).not.toHaveBeenCalled();
        expect(owner.context.sourceRevision).toBe(0);
    });

    it.each(['caret', 'selection', 'tampered-content'] as const)('denies unsupported paragraph %s from current public node facts', variant =>
    {
        const { binding, context, dispatch } = fixture('Paragraph');
        const current = { ...context, selection: { start: 0, end: variant === 'selection' ? 3 : 0, direction: 'none' as const },
            syntax: variant === 'tampered-content' ? { ...context.syntax!, contentRanges: [{ start: 0, end: 0 }] } : context.syntax };
        const guarded = guardArticleBlockAnchorCoreCommands(fsusUiMarkdownCoreCommands, binding, guardCopy)
            .find(command => command.key === 'anchor-insert')!;
        expect(guarded.enabled?.(current)).toBe(false);
        expect(guarded.disabledReason?.(current)).toBe('诊断：anchor-create-position-required');
        expect(() => guarded.run(current)).toThrow('诊断：anchor-create-position-required');
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('denies a second marker on the actual current anchor without inventing another paragraph owner', () =>
    {
        const { binding, context, dispatch } = fixture('First. ^intro\n\nSecond.');
        expect(context.syntax!.type).toBe('anchor');
        expect(context.projection!.nodes.filter(node => node.kind === 'paragraph').map(node => node.rawRange))
            .toEqual([{ start: 15, end: 22 }]);
        const current = collapsedContext(context);
        const guarded = guardArticleBlockAnchorCoreCommands(fsusUiMarkdownCoreCommands, binding, guardCopy)
            .find(command => command.key === 'anchor-insert')!;
        expect(guarded.enabled?.(current)).toBe(false);
        expect(guarded.disabledReason?.(current)).toBe('诊断：anchor-already-present');
        expect(() => guarded.run(current)).toThrow('诊断：anchor-already-present');
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('rechecks cancellation, readonly, source mode and real binding disposal without retaining another lifecycle', () =>
    {
        const { binding, context, controller } = fixture();
        const guarded = guardArticleBlockAnchorCoreCommands(fsusUiMarkdownCoreCommands, binding, guardCopy)
            .find(command => command.key === 'anchor-properties')!;
        expect(guarded.disabledReason?.({ ...context, readonly: true })).toBe('诊断：editor-readonly');
        expect(guarded.disabledReason?.({ ...context, mode: 'live' })).toBe('诊断：source-mode-required');
        controller.abort();
        expect(guarded.disabledReason?.(context)).toBe('诊断：command-aborted');
        binding.dispose();
        expect(guarded.disabledReason?.(context)).toBe('诊断：editor-binding-unavailable');
    });

    it('rechecks the source revision at direct invocation even though the rendered command was already disabled', () =>
    {
        const { binding, context, owner } = fixture();
        const guarded = guardArticleBlockAnchorCoreCommands(fsusUiMarkdownCoreCommands, binding, guardCopy)
            .find(command => command.key === 'anchor-properties')!;
        owner.updateSource(context.value, 1);
        expect(guarded.disabledReason?.(context)).toBe('诊断：document-stale');
        expect(() => guarded.run(context)).toThrow('诊断：document-stale');
    });

    it('renders the guard reason through the actual public palette with the existing command key', async () =>
    {
        const { binding, wrapper, editor, context } = fixture();
        editor.dispatchTransaction({ changes: [], history: 'skip', origin: 'programmatic',
            documentIdentity: context.documentIdentity, expectedRevision: 0, selection: context.selection });
        await flushPromises();
        await wrapper.setProps({ commands: guardArticleBlockAnchorCoreCommands(fsusUiMarkdownCoreCommands, binding, guardCopy),
            surfaces: { commandPalette: true } });
        editor.openCommandPalette();
        await flushPromises();
        const label = resolveMarkdownEditorLocaleText().contextual.editAnchor;
        const option = [...document.body.querySelectorAll('[role="option"]')].find(item => item.textContent?.includes(label));
        expect(option, document.body.textContent ?? '').toBeDefined();
        expect((option as HTMLButtonElement).disabled).toBe(true);
        const reason = [...wrapper.element.querySelectorAll('[id]')].find(item => item.id === option!.getAttribute('aria-describedby'));
        expect(reason!.textContent).toContain('诊断：current-impact-required');
    });
});
