import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { ElMarkdownEditor } from 'fsusui';
import { createMarkdownAnchorMap, type MarkdownEditorDispatchResult, type MarkdownEditorTransaction } from '@/fsusui/articlePositionMaps';
import { ArticleAnchorContextAdapter } from '@/services/authoring/articleAnchorContext';
import {
    ArticleAttachmentContextAdapter,
    type ArticleAttachmentPendingHandle,
    type ArticleAttachmentTransactionPort
} from '@/services/authoring/articleAttachmentContext';
import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';
import {
    createArticleAttachmentBusinessIntentReader,
    type ArticleAttachmentBusinessIntentNode
} from '@/services/authoring/articleAttachmentBusinessIntentReader';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(dispose => dispose()));

/** Actual upstream editor dispatch, source/map and original owned-handle reader; no receipt oracle. */
function editor()
{
    let source = 'paragraph';
    const owner = createArticleDocumentContextAdapter({ articleId: 1, draftId: 'article:1',
        editorSessionId: 'session:business-intent', siteScope: 'site:test', userScope: 'user:test', content: source });
    const anchors = new ArticleAnchorContextAdapter(owner);
    const attachments = new ArticleAttachmentContextAdapter(owner, 'article-assets', 'version:1', anchors);
    const binding = () => ({ document: owner.context,
        map: createMarkdownAnchorMap({ identity: owner.documentIdentity, source }) });
    let commands: { dispatchTransaction(input: MarkdownEditorTransaction): MarkdownEditorDispatchResult; };
    const port: ArticleAttachmentTransactionPort = {
        dispatch: transaction => commands.dispatchTransaction(transaction),
        commitSource: result =>
        {
            source = result.value;
            if (owner.context.sourceRevision < result.revision) owner.updateSource(source, result.revision);
        },
        binding
    };
    const wrapper = mount(ElMarkdownEditor, { props: { mode: 'source', modelValue: source,
        documentIdentity: owner.documentIdentity,
        'onUpdate:modelValue': (value: string) => { source = value; owner.updateSource(value); },
        onTransaction: (result: MarkdownEditorDispatchResult) => attachments.consumeTransaction(result, port) } });
    commands = wrapper.vm as unknown as typeof commands;
    const anchor = anchors.capture(binding(), { start: 0, end: 0, direction: 'none' },
        { affinity: 'after', viewportOffset: 0, percentage: 0, surface: 'source', tool: 'none' });
    const captured = attachments.capture({ source, origin: 'pick', anchor,
        files: [{ name: 'one.png', mimeType: 'image/png', byteLength: 100 }] });
    if (captured.status !== 'created') throw new Error('capture rejected');
    const handle = attachments.commitCreated(captured, port)[0]!;
    let selected: ArticleAttachmentPendingHandle | null = handle;
    const reader = createArticleAttachmentBusinessIntentReader({ attachments,
        handle: () => selected, binding });
    const node = (): ArticleAttachmentBusinessIntentNode =>
    {
        const observed = attachments.readOwnedIntent(handle, binding());
        if (!observed) throw new Error('original observation missing');
        return { intentRef: observed.intentRef, nodeId: observed.nodeId, transactionRef: observed.transactionRef,
            providerRef: observed.providerRef, contextDigest: observed.contextDigest, sourceOrder: observed.sourceOrder,
            sourceReferenced: observed.sourceReferenced, disposition: observed.disposition, sourceUrl: observed.sourceUrl };
    };
    cleanup.push(() => { attachments.dispose(); wrapper.unmount(); });
    return { owner, attachments, binding, commands, port, handle, reader, node,
        select: (value: ArticleAttachmentPendingHandle | null) => { selected = value; } };
}

describe('Original owned intent business adapter', () =>
{
    it('verifies the actual current pending handle without a lifecycle receipt or new store', async () =>
    {
        const current = editor();
        expect(current.reader.readOwnedIntent(current.node().intentRef, current.owner.context)?.snapshot)
            .toBe(current.handle.snapshot);
        expect(await current.reader.verifyIntent(current.node(), current.owner.context)).toBe(true);
        expect(Object.isFrozen(current.reader)).toBe(true);
    });

    it('verifies the actual committed successor after the original owner microtask', async () =>
    {
        const current = editor();
        current.attachments.complete(current.handle, { status: 'resolved', ...current.handle.request,
            payload: { markdownKind: 'image', href: '/actual.png', alt: 'one.png', mimeType: 'image/png' } }, current.port);
        await Promise.resolve();
        expect(current.handle.signal.aborted).toBe(true);
        expect(current.node().sourceUrl).toBe('/actual.png');
        expect(await current.reader.verifyIntent(current.node(), current.owner.context)).toBe(true);
    });

    it.each(['intentRef', 'nodeId', 'transactionRef', 'providerRef', 'contextDigest', 'sourceOrder',
        'sourceReferenced', 'disposition', 'sourceUrl'] as const)('rejects changed business %s coordinates', async key =>
    {
        const current = editor();
        const changed = { ...current.node(), [key]: key === 'sourceOrder' ? 99
            : key === 'sourceReferenced' ? false : 'changed' } as ArticleAttachmentBusinessIntentNode;
        expect(await current.reader.verifyIntent(changed, current.owner.context)).toBe(false);
    });

    it.each(['clone', 'receipt', 'foreign', 'missing'] as const)('refuses an original handle lookup replaced by %s', async kind =>
    {
        const current = editor();
        const node = current.node();
        const selected = kind === 'missing' ? null : kind === 'foreign' ? editor().handle
            : { ...current.handle, ...(kind === 'receipt' ? { snapshot: current.attachments.lifecycleReceipts.at(-1)! } : {}) };
        current.select(selected);
        expect(current.reader.readOwnedIntent(node.intentRef, current.owner.context)).toBeNull();
        expect(await current.reader.verifyIntent(node, current.owner.context)).toBe(false);
    });

    it('preserves actual removal false and denies a current intent grant for a terminal handle', async () =>
    {
        const current = editor();
        const intentRef = current.node().intentRef;
        current.attachments.remove(current.handle, current.port);
        expect(current.reader.readOwnedIntent(intentRef, current.owner.context))
            .toMatchObject({ current: false, sourceReferenced: false, disposition: 'removed' });
        expect(await current.reader.verifyIntent(current.node(), current.owner.context)).toBe(false);
    });

    it('preserves unknown source relation without turning it into proven removal', async () =>
    {
        const current = editor();
        const node = current.node();
        const reader = createArticleAttachmentBusinessIntentReader({ attachments: current.attachments,
            handle: () => current.handle, binding: () => ({ ...current.binding(),
                map: { ...current.binding().map, syntax: [] } }) });
        expect(reader.readOwnedIntent(node.intentRef, current.owner.context))
            .toMatchObject({ current: false, sourceReferenced: null, disposition: 'stale' });
        expect(await reader.verifyIntent(node, current.owner.context)).toBe(false);
    });

    it('rereads handle ownership after the promise boundary', async () =>
    {
        const current = editor();
        const node = current.node();
        queueMicrotask(() => current.select({ ...current.handle }));
        expect(await current.reader.verifyIntent(node, current.owner.context)).toBe(false);
    });

    it('rereads the actual host context after a concurrent source edit', async () =>
    {
        const current = editor();
        const node = current.node();
        const context = current.owner.context;
        queueMicrotask(() => current.commands.dispatchTransaction({ changes: [{ from: 0, to: 0, insert: 'prefix\n' }],
            history: 'separate' }));
        expect(await current.reader.verifyIntent(node, context)).toBe(false);
    });

    it('propagates caller cancellation at the promise boundary', async () =>
    {
        const current = editor();
        const controller = new AbortController();
        const reason = new Error('business intent read cancelled');
        queueMicrotask(() => controller.abort(reason));
        await expect(current.reader.verifyIntent(current.node(), current.owner.context, controller.signal))
            .rejects.toBe(reason);
    });

    it('rejects after the original adapter is disposed', async () =>
    {
        const current = editor();
        const node = current.node();
        current.attachments.dispose();
        expect(await current.reader.verifyIntent(node, current.owner.context)).toBe(false);
    });
});
