// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import {
    ElMarkdownEditor,
    resolveMarkdownEditorLocaleText,
    type MarkdownEditorCommand,
    type MarkdownEditorCommandContext,
    type MarkdownEditorDispatchResult,
    type MarkdownEditorTransaction,
    type MarkdownEditorTransactionEvent
} from '@ozwasyd/element-plus';
import { createMarkdownAnchorMap, createMarkdownEditorProjection, stabilizeMarkdownEditorProjection } from '@ozwasyd/element-plus/markdown-runtime';
import { afterEach, describe, expect, it } from 'vitest';

import { ArticleAnchorContextAdapter } from '@/services/authoring/articleAnchorContext';
import { ArticleAttachmentContextAdapter } from '@/services/authoring/articleAttachmentContext';
import { fsusUiMarkdownCoreCommands } from '@/fsusui/articleBlockAnchors';
import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';
import { bindArticleEditorRuntime, type ArticleEditorRuntimeBinding } from '@/services/authoring/articleEditorRuntimeBinding';
import { calculateOpenArticleDocumentDigest as digest } from '@/services/authoring/openArticleDocumentRegistry';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()));

// This probe bypasses the closed Blog insert gate to inspect the actual upstream form contract.
// Preserve its expected-denial regression unchanged across upstream source offers.
function nativeInsertFixture(source: string, commands: readonly MarkdownEditorCommand[] = fsusUiMarkdownCoreCommands)
{
    let value = source;
    let binding: ArticleEditorRuntimeBinding | null = null;
    let synchronize: (value: string) => void = () => undefined;
    const observations: { event: MarkdownEditorTransactionEvent; consumed: boolean; }[] = [];
    const owner = createArticleDocumentContextAdapter({ articleId: 1, draftId: 'article:1',
        editorSessionId: 'editor:native-insert', siteScope: 'site:test', userScope: 'user:test', content: source });
    const anchors = new ArticleAnchorContextAdapter(owner);
    const attachments = new ArticleAttachmentContextAdapter(owner, 'article-assets', 'article-assets:v1', anchors);
    const wrapper = mount(ElMarkdownEditor, { attachTo: document.body, props: { modelValue: source, mode: 'source',
        documentIdentity: owner.documentIdentity, surfaces: { commandPalette: true },
        onTransaction: (event: MarkdownEditorTransactionEvent) => observations.push({ event, consumed: binding?.consumeTransaction(event) ?? false }) } });
    const editor = wrapper.vm as unknown as { dispatchTransaction(transaction: MarkdownEditorTransaction): MarkdownEditorDispatchResult;
        openCommandPalette(): void; undo(): void; redo(): void; };
    synchronize = value => { void wrapper.setProps({ modelValue: value }); };
    binding = bindArticleEditorRuntime(owner, anchors, attachments, {
        dispatch: transaction => editor.dispatchTransaction(transaction),
        commitSource: result =>
        {
            value = result.value;
            owner.updateSource(value, result.revision > owner.context.sourceRevision ? result.revision : undefined);
            synchronize(value);
        },
        binding: () => ({ document: owner.context, map: createMarkdownAnchorMap({ identity: owner.documentIdentity, source: value }) })
    }, () => value, editor, { surface: 'source', configuration: { allowLatex: false, allowMermaid: false, baseUrl: null },
        identity: { themeDigest: digest({ theme: 'test' }), locale: 'zh-CN' },
        cachePolicy: { maxEntryBytes: 65536, maxAgeMs: 60000, maxReceipts: 16 } });
    const actualBinding = binding;
    cleanups.push(() => { actualBinding.dispose(); attachments.dispose(); wrapper.unmount(); owner.dispose(); });
    const begin = async () =>
    {
        await wrapper.setProps({ commands });
        const projection = stabilizeMarkdownEditorProjection(createMarkdownEditorProjection(value), owner.documentIdentity);
        const paragraph = projection.nodes.find(node => node.kind === 'paragraph')!;
        editor.dispatchTransaction({ changes: [], history: 'skip', origin: 'programmatic',
            documentIdentity: owner.documentIdentity, expectedRevision: owner.context.sourceRevision,
            selection: { start: paragraph.rawRange.end, end: paragraph.rawRange.end, direction: 'none' } });
        await flushPromises();
        editor.openCommandPalette();
        await flushPromises();
        const label = resolveMarkdownEditorLocaleText().contextual.insertAnchor;
        const option = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(item => item.textContent?.includes(label));
        expect(option).toBeDefined();
        expect(option!.disabled).toBe(false);
        option!.click();
        await flushPromises();
    };
    return { owner, binding: actualBinding, wrapper, editor, observations, begin, readSource: () => value,
        open: async () =>
        {
            await begin();
            return wrapper.get('form[role="dialog"]');
        } };
}

function pendingNativeCommands(concurrent = false)
{
    const attempts: { context: MarkdownEditorCommandContext; resolve(): void; reject(error: Error): void; }[] = [];
    const commands = fsusUiMarkdownCoreCommands.map(command => command.key === 'anchor-insert' ? {
        ...command,
        concurrent,
        shortcut: concurrent ? 'mod+q' : command.shortcut,
        run: async (context: MarkdownEditorCommandContext) =>
        {
            // Delay the existing public command only; intent/target handling stays in FsusUI.
            await new Promise<void>((resolve, reject) => attempts.push({ context, resolve, reject }));
            return command.run(context);
        }
    } : command);
    return { commands, attempts };
}

describe('Unqualified native anchor form contract through actual FsusUI and original Blog binding (#2444)', () =>
{
    it.each(['existing-anchor', 'same-paragraph'] as const)('refuses pending creation retargeted to %s before the native form opens', async target =>
    {
        const source = 'First.\n\nOther ^existing';
        const pending = pendingNativeCommands();
        const { owner, editor, wrapper, observations, readSource, begin } = nativeInsertFixture(source, pending.commands);
        await begin();
        expect(pending.attempts).toHaveLength(1);
        const projection = stabilizeMarkdownEditorProjection(createMarkdownEditorProjection(source), owner.documentIdentity);
        const anchor = projection.nodes.find(node => node.kind === 'anchor')!;
        editor.dispatchTransaction({ changes: [], history: 'skip', origin: 'programmatic',
            documentIdentity: owner.documentIdentity, expectedRevision: 0,
            selection: target === 'existing-anchor' ? { ...anchor.rawRange, direction: 'none' }
                : { start: 1, end: 1, direction: 'none' } });
        await flushPromises();
        pending.attempts[0]!.resolve();
        await flushPromises();
        // Preserve the destructive counterexample if a wrong implementation opens a form.
        const form = wrapper.find('form[role="dialog"]');
        if (form.exists())
        {
            await form.get('input').setValue('new-section');
            await form.trigger('submit');
            await flushPromises();
        }
        expect(readSource()).toBe(source);
        expect(owner.context.sourceRevision).toBe(0);
        expect(observations.every(item => item.consumed && item.event.accepted && item.event.transaction.changes.length === 0)).toBe(true);
        expect(wrapper.find('form[role="dialog"]').exists()).toBe(false);
    });

    it('refuses a pending open after a real source revision change without adding another transaction', async () =>
    {
        const source = 'First.\n\nOther ^existing';
        const pending = pendingNativeCommands();
        const { owner, editor, wrapper, observations, readSource, begin } = nativeInsertFixture(source, pending.commands);
        await begin();
        const selection = pending.attempts[0]!.context.selection;
        editor.dispatchTransaction({ changes: [{ from: source.length, to: source.length, insert: '\n\nTail' }],
            history: 'separate', origin: 'programmatic', documentIdentity: owner.documentIdentity, expectedRevision: 0, selection });
        await flushPromises();
        expect(owner.context.sourceRevision).toBe(1);
        pending.attempts[0]!.resolve();
        await flushPromises();
        expect(wrapper.find('form[role="dialog"]').exists()).toBe(false);
        expect(readSource()).toBe(`${source}\n\nTail`);
        expect(owner.context.sourceRevision).toBe(1);
        expect(observations.every(item => item.consumed && item.event.accepted)).toBe(true);
        expect(observations.filter(item => item.event.transaction.changes.length > 0)).toHaveLength(1);
    });

    it('cancels the pending open on the original owner same-source article switch', async () =>
    {
        const source = 'First.\n\nOther ^existing';
        const pending = pendingNativeCommands();
        const { owner, wrapper, observations, readSource, begin } = nativeInsertFixture(source, pending.commands);
        const identity = owner.documentIdentity;
        await begin();
        const receipt = owner.switchDocument({ articleId: 2, draftId: 'article:2', content: source, reason: 'article-switch' });
        expect(receipt).not.toBeNull();
        await wrapper.setProps({ documentIdentity: owner.documentIdentity });
        expect(pending.attempts[0]!.context.signal.aborted).toBe(true);
        pending.attempts[0]!.resolve();
        await flushPromises();
        expect(wrapper.find('form[role="dialog"]').exists()).toBe(false);
        expect(readSource()).toBe(source);
        expect(owner.context.sourceRevision).toBe(0);
        expect(owner.documentIdentity.id).not.toBe(identity.id);
        expect(owner.documentIdentity.epoch).toBe(identity.epoch + 1);
        expect(observations.every(item => item.consumed && item.event.accepted && item.event.transaction.changes.length === 0)).toBe(true);
    });

    it('refuses late readonly opening and permits a fresh native invocation afterward', async () =>
    {
        const source = 'First.\n\nOther ^existing';
        const pending = pendingNativeCommands();
        const { owner, wrapper, observations, readSource, begin } = nativeInsertFixture(source, pending.commands);
        await begin();
        await wrapper.setProps({ readonly: true });
        pending.attempts[0]!.resolve();
        await flushPromises();
        expect(wrapper.find('form[role="dialog"]').exists()).toBe(false);
        expect(readSource()).toBe(source);
        expect(owner.context.sourceRevision).toBe(0);
        await wrapper.setProps({ readonly: false });
        await begin();
        expect(pending.attempts).toHaveLength(2);
        pending.attempts[1]!.resolve();
        await flushPromises();
        const form = wrapper.get('form[role="dialog"]');
        expect(form.get('input').element.value).toBe('');
        await form.get('input').setValue('new-section');
        await form.trigger('submit');
        await flushPromises();
        expect(readSource()).toBe('First. ^new-section\n\nOther ^existing');
        expect(owner.context.sourceRevision).toBe(1);
        expect(observations.every(item => item.consumed && item.event.accepted)).toBe(true);
        expect(observations.filter(item => item.event.transaction.changes.length > 0)).toHaveLength(1);
    });

    it('does not reopen a cancelled form from a pending result at the same source and selection', async () =>
    {
        const source = 'First.\n\nOther ^existing';
        const pending = pendingNativeCommands();
        const { owner, wrapper, observations, readSource, begin } = nativeInsertFixture(source, pending.commands);
        await begin();
        pending.attempts[0]!.resolve();
        await flushPromises();
        const cancelled = wrapper.get('form[role="dialog"]');
        await cancelled.get('input').setValue('old-draft');
        await begin();
        expect(pending.attempts).toHaveLength(2);
        await cancelled.trigger('keydown', { key: 'Escape' });
        await flushPromises();
        pending.attempts[1]!.resolve();
        await flushPromises();
        expect(wrapper.find('form[role="dialog"]').exists()).toBe(false);
        expect(readSource()).toBe(source);
        expect(owner.context.sourceRevision).toBe(0);
        await begin();
        pending.attempts[2]!.resolve();
        await flushPromises();
        expect(wrapper.get('form[role="dialog"]').get('input').element.value).toBe('');
        expect(observations.every(item => item.consumed && item.event.accepted && item.event.transaction.changes.length === 0)).toBe(true);
    });

    it('keeps the latest native form and focus when an older concurrent command rejects through the real binding', async () =>
    {
        const source = 'First.\n\nSecond.\n\nOther ^existing';
        const pending = pendingNativeCommands(true);
        const { owner, editor, wrapper, observations, readSource, begin } = nativeInsertFixture(source, pending.commands);
        await begin();
        const projection = stabilizeMarkdownEditorProjection(createMarkdownEditorProjection(source), owner.documentIdentity);
        const second = projection.nodes.filter(node => node.kind === 'paragraph')[1]!;
        editor.dispatchTransaction({ changes: [], history: 'skip', origin: 'programmatic', documentIdentity: owner.documentIdentity,
            expectedRevision: 0, selection: { start: second.rawRange.end, end: second.rawRange.end, direction: 'none' } });
        await flushPromises();
        await wrapper.get('textarea').trigger('keydown', { key: 'q', ctrlKey: true });
        await flushPromises();
        expect(pending.attempts).toHaveLength(2);
        pending.attempts[1]!.resolve();
        await flushPromises();
        const form = wrapper.get('form[role="dialog"]');
        await form.get('input').setValue('new-section');
        pending.attempts[0]!.reject(new Error('obsolete native request'));
        await flushPromises();
        expect(document.activeElement).toBe(form.get('input').element);
        await form.trigger('submit');
        await flushPromises();
        expect(readSource()).toBe('First.\n\nSecond. ^new-section\n\nOther ^existing');
        expect(owner.context.sourceRevision).toBe(1);
        expect(wrapper.vm).toBe(editor);
        expect(observations.every(item => item.consumed && item.event.accepted)).toBe(true);
        expect(observations.filter(item => item.event.transaction.changes.length > 0)).toHaveLength(1);
    });

    it.each(['Escape', 'cancel-button'])('discards a cancelled native creation draft through %s before a fresh same-editor transaction', async cancellation =>
    {
        const source = 'First.\n\nOther ^existing';
        const { owner, wrapper, observations, readSource, open } = nativeInsertFixture(source);
        const identity = owner.documentIdentity;
        const editorInstance = wrapper.vm;
        const cancelled = await open();
        await cancelled.get('input').setValue('old-draft');
        if (cancellation === 'Escape')
        {
            await cancelled.trigger('keydown', { key: 'Escape' });
        }
        else
        {
            const button = cancelled.findAll('button').find(item => item.text() === resolveMarkdownEditorLocaleText().contextual.cancel)!;
            await button.trigger('click');
        }
        await flushPromises();
        expect(wrapper.find('form[role="dialog"]').exists()).toBe(false);
        expect(document.activeElement).toBe(wrapper.get('textarea').element);
        expect(readSource()).toBe(source);
        expect(owner.context.sourceRevision).toBe(0);
        expect(observations.every(item => item.consumed && item.event.accepted && item.event.transaction.changes.length === 0)).toBe(true);
        const fresh = await open();
        expect(fresh.get('input').element.value).toBe('');
        expect(fresh.find('[role="alert"]').exists()).toBe(false);
        expect(fresh.findAll('button')).toHaveLength(2);
        await fresh.get('input').setValue('new-section');
        await fresh.trigger('submit');
        await flushPromises();
        expect(readSource()).toBe('First. ^new-section\n\nOther ^existing');
        expect(owner.context.sourceRevision).toBe(1);
        expect(owner.documentIdentity).toEqual(identity);
        expect(wrapper.vm).toBe(editorInstance);
        expect(observations.every(item => item.consumed && item.event.accepted)).toBe(true);
        expect(observations.filter(item => item.event.transaction.changes.length > 0)).toHaveLength(1);
    });

    it('requires cancellation and a fresh open after selection-only creation target drift through the real binding', async () =>
    {
        const source = 'First.\n\nOther ^existing';
        const { owner, editor, wrapper, observations, readSource, open } = nativeInsertFixture(source);
        const identity = owner.documentIdentity;
        const stale = await open();
        await stale.get('input').setValue('old-draft');
        editor.dispatchTransaction({ changes: [], history: 'skip', origin: 'programmatic',
            documentIdentity: identity, expectedRevision: 0, selection: { start: 0, end: 0, direction: 'none' } });
        await flushPromises();
        await stale.trigger('submit');
        await flushPromises();
        expect(stale.get('[role="alert"]').text()).toBe(resolveMarkdownEditorLocaleText().results.stale);
        expect(readSource()).toBe(source);
        expect(owner.context.sourceRevision).toBe(0);
        expect(observations.every(item => item.consumed && item.event.accepted && item.event.transaction.changes.length === 0)).toBe(true);
        await stale.trigger('keydown', { key: 'Escape' });
        await flushPromises();
        const fresh = await open();
        expect(fresh.get('input').element.value).toBe('');
        expect(fresh.find('[role="alert"]').exists()).toBe(false);
        await fresh.get('input').setValue('new-section');
        await fresh.trigger('submit');
        await flushPromises();
        expect(readSource()).toBe('First. ^new-section\n\nOther ^existing');
        expect(owner.context.sourceRevision).toBe(1);
        expect(owner.documentIdentity).toEqual(identity);
        expect(wrapper.vm).toBe(editor);
        expect(observations.every(item => item.consumed && item.event.accepted)).toBe(true);
        expect(observations.filter(item => item.event.transaction.changes.length > 0)).toHaveLength(1);
    });

    it('does not turn an admitted insert form into an existing-anchor rename after a selection-only transaction', async () =>
    {
        const source = 'First.\n\nOther ^existing';
        const { owner, editor, observations, readSource, open } = nativeInsertFixture(source);
        const form = await open();
        await form.get('input').setValue('new-section');
        const projection = stabilizeMarkdownEditorProjection(createMarkdownEditorProjection(source), owner.documentIdentity);
        const anchor = projection.nodes.find(node => node.kind === 'anchor')!;
        editor.dispatchTransaction({ changes: [], history: 'skip', origin: 'programmatic',
            documentIdentity: owner.documentIdentity, expectedRevision: 0,
            selection: { ...anchor.rawRange, direction: 'none' } });
        await flushPromises();
        await form.trigger('submit');
        await flushPromises();
        expect(readSource()).toBe(source);
        expect(owner.context.sourceRevision).toBe(0);
        expect(observations.every(item => item.event.transaction.changes.length === 0)).toBe(true);
    });

    it('denies a late readonly submission through the actual dispatcher without changing source or revision', async () =>
    {
        const source = 'First.\n\nOther ^existing';
        const { owner, wrapper, observations, readSource, open } = nativeInsertFixture(source);
        const form = await open();
        await form.get('input').setValue('new-section');
        await wrapper.setProps({ readonly: true });
        await form.trigger('submit');
        await flushPromises();
        expect(readSource()).toBe(source);
        expect(owner.context.sourceRevision).toBe(0);
        expect(observations.at(-1)).toMatchObject({ consumed: false, event: { accepted: false, value: source,
            beforeRevision: 0, revision: 0 } });
        expect(observations.filter(item => item.event.accepted).every(item => item.consumed && item.event.value === source)).toBe(true);
    });

    it.each(['\n', '\r\n'])('keeps exact %j bytes, source identity and binding continuity through submit/undo/redo', async newline =>
    {
        const source = `First.${newline}${newline}Other ^existing`;
        const { owner, binding, wrapper, editor, observations, readSource, open } = nativeInsertFixture(source);
        const identity = owner.documentIdentity;
        const form = await open();
        const originalSelection = observations.at(-1)!.event.selection;
        await form.get('input').setValue('new-section');
        await form.trigger('submit');
        await flushPromises();
        const expected = `First. ^new-section${newline}${newline}Other ^existing`;
        expect(readSource()).toBe(expected);
        expect(owner.context.sourceRevision).toBe(1);
        expect(owner.documentIdentity).toEqual(identity);
        expect(binding.context).toBe(owner.context);
        expect(wrapper.find('form[role="dialog"]').exists()).toBe(false);
        expect(document.activeElement).toBe(wrapper.get('textarea').element);
        const commit = observations.find(item => item.event.transaction.changes.length > 0)!;
        expect(commit.consumed).toBe(true);
        expect(commit.event).toMatchObject({ accepted: true, beforeRevision: 0, revision: 1,
            documentIdentity: identity, value: expected, history: { canUndo: true, undoDepth: 1 },
            transaction: { changes: [{ from: 6, to: 6, insert: ' ^new-section' }], history: 'separate', origin: 'command' } });
        editor.undo();
        await flushPromises();
        expect(readSource()).toBe(source);
        expect(owner.context.sourceRevision).toBe(2);
        expect(observations.at(-1)).toMatchObject({ consumed: true, event: { accepted: true, revision: 2,
            value: source, selection: originalSelection, history: { canRedo: true, undoDepth: 0 } } });
        editor.redo();
        await flushPromises();
        expect(readSource()).toBe(expected);
        expect(owner.context.sourceRevision).toBe(3);
        expect(owner.documentIdentity).toEqual(identity);
        expect(observations.at(-1)).toMatchObject({ consumed: true, event: { accepted: true, revision: 3,
            value: expected, selection: originalSelection, history: { canUndo: true, redoDepth: 0 } } });
        expect(observations.every(item => item.event.accepted && item.consumed),
            JSON.stringify(observations.map(item => ({ consumed: item.consumed, event: item.event })))).toBe(true);
        expect(wrapper.vm).toBe(editor);
    });

    it.each(['Intro', 'existing'])('lets the canonical form reject exact ID %j without normalization, suffixes or source mutation', async id =>
    {
        const source = 'First.\n\nOther ^existing';
        const { owner, observations, readSource, open } = nativeInsertFixture(source);
        const form = await open();
        await form.get('input').setValue(id);
        await form.trigger('submit');
        await flushPromises();
        expect(form.get('[role="alert"]').text()).toBe(resolveMarkdownEditorLocaleText().contextual.invalidAnchor);
        expect(form.get('input').element.value).toBe(id);
        expect(readSource()).toBe(source);
        expect(owner.context.sourceRevision).toBe(0);
        expect(observations.every(item => item.event.value === source && item.event.beforeRevision === item.event.revision)).toBe(true);
    });
});
