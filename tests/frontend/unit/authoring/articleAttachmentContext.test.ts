// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { ElMarkdownEditor, type MarkdownEditorDispatchResult, type MarkdownEditorTransaction } from '@ozwasyd/element-plus';
import { createMarkdownAnchorMap } from '@ozwasyd/element-plus/markdown-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { ArticleAttachmentContextAdapter, validateArticleAttachmentIntent, validateArticleAttachmentLifecycle, type ArticleAttachmentPendingHandle, type ArticleAttachmentTransactionPort } from '@/services/authoring/articleAttachmentContext';
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
        for (let index = 0; index < 100; index++)
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

function lifecycle()
{
    let source = 'paragraph';
    const owner = createArticleDocumentContextAdapter({ articleId: 1, draftId: 'article:1', editorSessionId: 'session:lifecycle', siteScope: 'site:test', userScope: 'user:test', content: source });
    const anchors = new ArticleAnchorContextAdapter(owner);
    const adapter = new ArticleAttachmentContextAdapter(owner, 'article-assets', 'version:1', anchors);
    const binding = () => ({ document: owner.context, map: createMarkdownAnchorMap({ identity: owner.documentIdentity, source }) });
    const anchor = () => anchors.capture(binding(), { start: 0, end: 0, direction: 'none' }, { affinity: 'after', viewportOffset: 0, percentage: 0, surface: 'source', tool: 'none' });
    let commands: { dispatchTransaction(input: MarkdownEditorTransaction): MarkdownEditorDispatchResult; undo(): void; redo(): void; };
    const port: ArticleAttachmentTransactionPort = { dispatch: transaction => commands.dispatchTransaction(transaction),
        commitSource: result => { source = result.value; if (owner.context.sourceRevision < result.revision) owner.updateSource(source, result.revision); }, binding };
    const wrapper = mount(ElMarkdownEditor, { props: { mode: 'source', modelValue: source, documentIdentity: owner.documentIdentity,
        'onUpdate:modelValue': (value: string) => { source = value; owner.updateSource(value); },
        onTransaction: (result: MarkdownEditorDispatchResult) => adapter.consumeTransaction(result, port) } });
    commands = wrapper.vm as unknown as typeof commands;
    const insert = (files = [file]) =>
    {
        const captured = adapter.capture({ source, origin: 'pick', anchor: anchor(), files });
        if (captured.status !== 'created') throw new Error('capture rejected');
        return { captured, handles: adapter.commitCreated(captured, port) };
    };
    const resolved = (handle: ArticleAttachmentPendingHandle, href = '/asset.png') => ({ status: 'resolved' as const,
        ...handle.request, payload: { markdownKind: 'image' as const, href, alt: handle.snapshot.intent.candidate.name, mimeType: 'image/png' } });
    cleanup.push(() => { adapter.dispose(); wrapper.unmount(); });
    return { owner, anchors, adapter, binding, source: () => source, commands, port, insert, resolved, wrapper };
}

describe('Article attachment anchored provider lifecycle (#2256) actual public dispatch', () =>
{
    it('cancels created leases after an interrupted controlled dispatch without admitting pending work', () =>
    {
        const editor = lifecycle();
        const captured = editor.adapter.capture({ origin: 'paste', source: editor.source(), files: [file],
            anchor: editor.anchors.capture(editor.binding(), { start: 0, end: 0, direction: 'none' },
                { affinity: 'after', viewportOffset: 0, percentage: 0, surface: 'source', tool: 'none' }) });
        if (captured.status !== 'created') throw new Error('capture rejected');
        expect(() => editor.adapter.commitCreated(captured, { ...editor.port, dispatch: () => { throw new Error('interrupted'); } })).toThrow('attachment-insert-dispatch-failed');
        expect(captured.handles.every(handle => handle.signal.aborted)).toBe(true);
        expect(editor.source()).toBe('paragraph');
        expect(editor.adapter.lifecycleReceipts).toEqual([]);
        expect(() => editor.adapter.commitCreated(captured, editor.port)).toThrow();
    });

    it('fails a real disabled-editor completion and retries through a fresh admitted request', async () =>
    {
        const editor = lifecycle();
        const handle = editor.insert().handles[0]!;
        const source = editor.source();
        await editor.wrapper.setProps({ disabled: true });
        expect(editor.adapter.complete(handle, editor.resolved(handle), editor.port).state).toBe('failed');
        expect(handle.signal.aborted).toBe(true);
        expect(editor.source()).toBe(source);
        await editor.wrapper.setProps({ disabled: false });
        const retry = editor.adapter.retry(handle);
        expect(retry.request.requestId).not.toBe(handle.request.requestId);
        expect(editor.adapter.complete(retry, editor.resolved(retry), editor.port).state).toBe('transaction-committed');
    });

    it('denies foreign transaction events without touching the current pending request', () =>
    {
        const editor = lifecycle();
        const handle = editor.insert().handles[0]!;
        const result = editor.commands.dispatchTransaction({ changes: [], selection: { ...handle.snapshot.anchor.range, direction: 'none' }, history: 'skip' });
        expect(editor.adapter.consumeTransaction({ ...result, documentIdentity: { id: 'foreign', epoch: 1 }, value: 'foreign bytes' }, editor.port)).toBe(false);
        expect(editor.source()).toBe('![one.png]()paragraph');
        expect(handle.signal.aborted).toBe(false);
        expect(editor.adapter.complete(handle, editor.resolved(handle), editor.port).state).toBe('transaction-committed');
    });

    it('transitions through new anchored/pending leases and commits only a public provider plan', () =>
    {
        const editor = lifecycle();
        const { captured, handles } = editor.insert();
        const handle = handles[0]!;
        expect(captured.handles[0]!.signal.aborted).toBe(true);
        expect(handle.signal.aborted).toBe(false);
        expect(handle.snapshot.state).toBe('provider-pending');
        expect(handle.snapshot.task.taskRef).not.toBe(captured.handles[0]!.intent.task.taskRef);
        expect(validateArticleAttachmentLifecycle(handle.snapshot)).toBe(true);
        const result = editor.adapter.complete(handle, editor.resolved(handle), editor.port);
        expect(result.state).toBe('transaction-committed');
        expect(validateArticleAttachmentLifecycle(result)).toBe(true);
        expect(editor.source()).toBe('![one.png](/asset.png)paragraph');
        expect(() => editor.adapter.complete(handle, editor.resolved(handle), editor.port)).toThrow('attachment-pending-handle-invalid');
    });

    it('rebases through a real committed map without cancelling provider intent or manual scroll priority', () =>
    {
        const editor = lifecycle();
        const handle = editor.insert().handles[0]!;
        const before = handle.snapshot.anchor.range;
        editor.anchors.manual('wheel', 'source', Date.now());
        editor.commands.dispatchTransaction({ changes: [{ from: 0, to: 0, insert: 'prefix\n' }], history: 'separate' });
        expect(handle.signal.aborted).toBe(false);
        expect(handle.snapshot.anchor.range).toEqual({ start: before.start + 7, end: before.end + 7 });
        expect(handle.snapshot.anchor.document.sourceRevision).toBe(editor.owner.context.sourceRevision);
        expect(editor.anchors.userIntent.state).toBe('manual');
        expect(editor.adapter.complete(handle, editor.resolved(handle), editor.port).state).toBe('transaction-committed');
        expect(editor.source()).toBe('prefix\n![one.png](/asset.png)paragraph');
    });

    it('keeps file insertion order when completions arrive in reverse order', () =>
    {
        const editor = lifecycle();
        const handles = editor.insert([file, { ...file, name: 'two.png' }]).handles;
        editor.adapter.complete(handles[1]!, editor.resolved(handles[1]!, '/two.png'), editor.port);
        expect(handles[0]!.signal.aborted).toBe(false);
        editor.adapter.complete(handles[0]!, editor.resolved(handles[0]!, '/one.png'), editor.port);
        expect(editor.source()).toBe('![one.png](/one.png)\n![two.png](/two.png)paragraph');
    });

    it.each([1, 10, 100])('keeps %i public file intents in creation order through reversed completion', count =>
    {
        const editor = lifecycle();
        const files = Array.from({ length: count }, (_, index) => ({ ...file, name: `image-${index}.png` }));
        const handles = editor.insert(files).handles;
        expect(handles).toHaveLength(count);
        expect(editor.adapter.currentTaskLeases).toHaveLength(count);
        if (count === 100)
        {
            const anchor = editor.anchors.capture(editor.binding(), { start: 0, end: 0, direction: 'none' },
                { affinity: 'after', viewportOffset: 0, percentage: 0, surface: 'source', tool: 'none' });
            expect(editor.adapter.capture({ source: editor.source(), origin: 'pick', anchor, files: [file] }))
                .toEqual({ status: 'rejected', reason: 'created-intent-capacity' });
            expect(handles.every(handle => !handle.signal.aborted)).toBe(true);
        }
        for (let index = count - 1; index >= 0; index--)
        {
            const handle = handles[index]!;
            expect(editor.adapter.complete(handle, editor.resolved(handle, `/image-${index}.png`), editor.port).state).toBe('transaction-committed');
        }
        expect(editor.source()).toBe(files.map((item, index) => `![${item.name}](/image-${index}.png)`).join('\n') + 'paragraph');
        expect(handles.every(handle => handle.signal.aborted)).toBe(true);
        expect(editor.adapter.currentTaskLeases).toEqual([]);
    }, 30000);

    it('undo deletes a pending node and redo cannot revive the cancelled completion', () =>
    {
        const editor = lifecycle();
        const handle = editor.insert().handles[0]!;
        editor.commands.undo();
        expect(handle.snapshot.state).toBe('removed');
        expect(handle.signal.aborted).toBe(true);
        editor.commands.redo();
        const before = editor.source();
        expect(() => editor.adapter.complete(handle, editor.resolved(handle), editor.port)).toThrow();
        expect(editor.source()).toBe(before);
        expect(() => editor.adapter.retry(handle)).toThrow('attachment-retry-context-invalid');
    });

    it('partial deletion becomes explicitly stale and external revision without maps cancels', async () =>
    {
        const partial = lifecycle();
        const handle = partial.insert().handles[0]!;
        partial.commands.dispatchTransaction({ changes: [{ from: 2, to: 3, insert: '' }], history: 'separate' });
        expect(handle.snapshot.state).toBe('stale');
        expect(handle.signal.aborted).toBe(true);
        const external = lifecycle();
        const second = external.insert().handles[0]!;
        external.owner.updateSource('external update');
        await Promise.resolve();
        expect(second.snapshot.state).toBe('stale');
        expect(second.signal.aborted).toBe(true);
    });

    it('epoch change immediately cancels even with identical bytes and cannot be retried', () =>
    {
        const editor = lifecycle();
        const handle = editor.insert().handles[0]!;
        editor.owner.switchDocument({ articleId: 2, draftId: 'article:2', content: editor.source() });
        expect(handle.signal.aborted).toBe(true);
        expect(handle.snapshot.state).toBe('cancelled');
        expect(() => editor.adapter.complete(handle, editor.resolved(handle), editor.port)).toThrow();
        expect(() => editor.adapter.retry(handle)).toThrow();
    });

    it('rejects unsafe provider results and retries with a fresh request/signal without reviving the old capability', () =>
    {
        const editor = lifecycle();
        const old = editor.insert().handles[0]!;
        expect(editor.adapter.complete(old, editor.resolved(old, 'javascript:alert(1)'), editor.port).state).toBe('failed');
        const retry = editor.adapter.retry(old);
        expect(retry.request.requestId).not.toBe(old.request.requestId);
        expect(retry.snapshot.attempt).toBe(2);
        expect(retry.signal).not.toBe(old.signal);
        old.cancel();
        expect(retry.signal.aborted).toBe(false);
        expect(() => editor.adapter.complete(old, editor.resolved(old), editor.port)).toThrow();
        expect(editor.adapter.complete(retry, editor.resolved(retry), editor.port).state).toBe('transaction-committed');
    });

    it('remove and replace use real public plans and distinct successor identities', () =>
    {
        const editor = lifecycle();
        const old = editor.insert().handles[0]!;
        const replacement = editor.adapter.replace(old, { ...file, name: 'new.png' }, editor.port)[0]!;
        expect(old.signal.aborted).toBe(true);
        expect(replacement.snapshot.intent.task.taskRef).not.toBe(old.snapshot.intent.task.taskRef);
        expect(editor.source()).toBe('![new.png]()paragraph');
        expect(editor.adapter.remove(replacement, editor.port).state).toBe('removed');
        expect(editor.source()).toBe('paragraph');
        expect(() => editor.adapter.complete(replacement, editor.resolved(replacement), editor.port)).toThrow();
    });

    it('rejects copied capabilities and receipt tamper, bounds receipts and releases pending signals', () =>
    {
        const editor = lifecycle();
        const handle = editor.insert().handles[0]!;
        expect(() => editor.adapter.complete({ ...handle }, editor.resolved(handle), editor.port)).toThrow();
        expect(validateArticleAttachmentLifecycle({ ...handle.snapshot, attempt: 100 })).toBe(false);
        expect(validateArticleAttachmentLifecycle({ ...handle.snapshot, extra: true })).toBe(false);
        const receipts = editor.adapter.lifecycleReceipts;
        expect(receipts.length).toBeGreaterThan(0);
        expect(receipts.every(validateArticleAttachmentLifecycle)).toBe(true);
        editor.adapter.dispose();
        expect(handle.signal.aborted).toBe(true);
        expect(editor.adapter.lifecycleReceipts).toEqual([]);
    });
});

describe('Article attachment owned-handle currentness reader (#2256)', () =>
{
    it('borrows the exact pending handle and actual map instead of cloned handles or receipts', () =>
    {
        const editor = lifecycle();
        const { captured, handles } = editor.insert();
        const handle = handles[0]!;
        const observed = editor.adapter.readOwnedIntent(handle, editor.binding());
        expect(observed?.snapshot).toBe(handle.snapshot);
        expect(observed).toMatchObject({ current: true, sourceReferenced: true, disposition: 'current',
            intentRef: handle.snapshot.intent.task.taskRef, nodeId: handle.snapshot.anchor.nodeId,
            transactionRef: handle.snapshot.transactionRef, providerRef: 'article-assets', providerVersion: 'version:1',
            contextDigest: editor.owner.context.contextDigest, sourceOrder: 0, sourceUrl: null });
        expect(Object.isFrozen(observed)).toBe(true);
        expect(editor.adapter.readOwnedIntent({ ...handle }, editor.binding())).toBeNull();
        expect(editor.adapter.readOwnedIntent({ ...handle, snapshot: editor.adapter.lifecycleReceipts.at(-1)! }, editor.binding())).toBeNull();
        expect(editor.adapter.readOwnedIntent(captured.handles[0] as unknown as ArticleAttachmentPendingHandle, editor.binding())).toBeNull();
        expect(lifecycle().adapter.readOwnedIntent(handle, editor.binding())).toBeNull();
    });

    it('denies foreign context, identity, bytes and absent public syntax without claiming deletion', () =>
    {
        const editor = lifecycle();
        const handle = editor.insert().handles[0]!;
        const binding = editor.binding();
        const foreign = lifecycle();
        const invalid = [foreign.binding(), { ...binding, map: createMarkdownAnchorMap({ identity: { id: 'foreign', epoch: 1 }, source: editor.source() }) },
            { ...binding, map: createMarkdownAnchorMap({ identity: editor.owner.documentIdentity, source: 'different' }) },
            { ...binding, map: { ...binding.map, syntax: [] } }];
        for (const other of invalid)
        {
            expect(editor.adapter.readOwnedIntent(handle, other)).toMatchObject({ current: false, sourceReferenced: null, disposition: 'stale' });
        }
        expect(editor.adapter.readOwnedIntent(handle, binding)?.current).toBe(true);
    });

    it('rejects equal-length foreign source bytes for both a pending node and a real removal tombstone', () =>
    {
        const editor = lifecycle();
        const handle = editor.insert().handles[0]!;
        const altered = '![two.png]()paragraph';
        expect(altered.length).toBe(editor.source().length);
        const mismatched = { document: editor.owner.context,
            map: createMarkdownAnchorMap({ identity: editor.owner.documentIdentity, source: altered }) };
        expect(editor.adapter.readOwnedIntent(handle, mismatched)).toMatchObject({ current: false,
            sourceReferenced: null, disposition: 'stale' });
        editor.adapter.remove(handle, editor.port);
        const removed = { document: editor.owner.context,
            map: createMarkdownAnchorMap({ identity: editor.owner.documentIdentity, source: 'different' }) };
        expect(removed.map.source.length).toBe(editor.source().length);
        expect(editor.adapter.readOwnedIntent(handle, removed)).toMatchObject({ current: false,
            sourceReferenced: null, disposition: 'removed' });
        expect(editor.adapter.readOwnedIntent(handle, editor.binding())?.sourceReferenced).toBe(false);
    });

    it('separates cancelled ownership from a placeholder still present in the current public map', () =>
    {
        const editor = lifecycle();
        const handle = editor.insert().handles[0]!;
        handle.cancel();
        expect(editor.adapter.readOwnedIntent(handle, editor.binding())).toMatchObject({ current: false,
            sourceReferenced: true, disposition: 'cancelled', sourceUrl: null });
        const retry = editor.adapter.retry(handle);
        expect(editor.adapter.readOwnedIntent(handle, editor.binding())?.current).toBe(false);
        expect(editor.adapter.readOwnedIntent(retry, editor.binding())?.current).toBe(true);
    });

    it('reads rebased pending leases and fails closed during a missing-map revision window', () =>
    {
        const editor = lifecycle();
        const handle = editor.insert().handles[0]!;
        const previous = editor.adapter.readOwnedIntent(handle, editor.binding())!;
        editor.commands.dispatchTransaction({ changes: [{ from: 0, to: 0, insert: 'prefix\n' }], history: 'separate' });
        const observed = editor.adapter.readOwnedIntent(handle, editor.binding())!;
        expect(observed.current).toBe(true);
        expect(observed.snapshot).not.toBe(previous.snapshot);
        expect(observed.contextDigest).toBe(editor.owner.context.contextDigest);
        expect(observed.transactionRef).not.toBe(previous.transactionRef);
        editor.owner.updateSource('external');
        expect(editor.adapter.readOwnedIntent(handle, editor.binding())).toMatchObject({ current: false, sourceReferenced: null });
    });

    it('attests a real completed successor lease only at its exact commit revision', async () =>
    {
        const editor = lifecycle();
        const handle = editor.insert().handles[0]!;
        const snapshot = editor.adapter.complete(handle, editor.resolved(handle, '/actual.png'), editor.port);
        // Flush the document owner's actual missing-map microtask queued during controlled dispatch.
        await Promise.resolve();
        expect(handle.snapshot).toBe(snapshot);
        expect(handle.signal.aborted).toBe(true);
        expect(editor.adapter.currentTaskLeases).toEqual([]);
        expect(editor.adapter.readOwnedIntent(handle, editor.binding())).toMatchObject({ snapshot, current: true,
            sourceReferenced: true, sourceUrl: '/actual.png', disposition: 'current' });
        expect(snapshot.task.status).toBe('completed');
        editor.commands.dispatchTransaction({ changes: [{ from: 0, to: 0, insert: 'prefix\n' }], history: 'separate' });
        expect(editor.adapter.readOwnedIntent(handle, editor.binding())).toMatchObject({ current: false,
            sourceReferenced: null, disposition: 'stale', sourceUrl: null });
        editor.commands.undo();
        expect(editor.adapter.readOwnedIntent(handle, editor.binding())?.current).toBe(false);
    });

    it('observes actual removal tombstones and never revives them on undo or redo', () =>
    {
        const editor = lifecycle();
        const handle = editor.insert().handles[0]!;
        editor.adapter.remove(handle, editor.port);
        expect(editor.adapter.readOwnedIntent(handle, editor.binding())).toMatchObject({ current: false,
            sourceReferenced: false, disposition: 'removed', sourceUrl: null });
        editor.commands.undo();
        expect(editor.adapter.readOwnedIntent(handle, editor.binding())).toMatchObject({ current: false,
            sourceReferenced: null, disposition: 'removed' });
        editor.commands.redo();
        expect(editor.adapter.readOwnedIntent(handle, editor.binding())?.current).toBe(false);
        const deleted = lifecycle();
        const removed = deleted.insert().handles[0]!;
        deleted.commands.undo();
        expect(deleted.adapter.readOwnedIntent(removed, deleted.binding())).toMatchObject({ current: false,
            sourceReferenced: false, disposition: 'removed' });
    });

    it('preserves a real committed removal when its optional tombstone map observation throws', () =>
    {
        const editor = lifecycle();
        const handle = editor.insert().handles[0]!;
        let bindingReads = 0;
        const port: ArticleAttachmentTransactionPort = { ...editor.port, binding: () =>
        {
            bindingReads++;
            // The original public removal plan reads once before dispatch, then binds its commit.
            if (bindingReads > 2) throw new Error('unexpected-binding-reread');
            return editor.binding();
        }, dispatch: transaction =>
        {
            const committed = editor.commands.dispatchTransaction(transaction);
            expect(committed.accepted).toBe(true);
            return { ...committed, positionMap: { ...committed.positionMap!, mapRange: () =>
            {
                throw new Error('tombstone-observation-unavailable');
            } } };
        } };
        expect(editor.adapter.remove(handle, port).state).toBe('removed');
        expect(bindingReads).toBe(2);
        expect(editor.source()).toBe('paragraph');
        expect(editor.adapter.readOwnedIntent(handle, editor.binding())).toMatchObject({ current: false,
            sourceReferenced: null, disposition: 'removed' });
    });

    it('denies failed leases, partial deletions, epoch switches and disposed owners without fabricated facts', () =>
    {
        const failed = lifecycle();
        const failure = failed.insert().handles[0]!;
        failed.adapter.complete(failure, failed.resolved(failure, 'javascript:alert(1)'), failed.port);
        expect(failed.adapter.readOwnedIntent(failure, failed.binding())).toMatchObject({ current: false,
            sourceReferenced: true, disposition: 'failed' });
        const partial = lifecycle();
        const handle = partial.insert().handles[0]!;
        partial.commands.dispatchTransaction({ changes: [{ from: 2, to: 3, insert: '' }], history: 'separate' });
        expect(partial.adapter.readOwnedIntent(handle, partial.binding())).toMatchObject({ current: false, sourceReferenced: null, disposition: 'stale' });
        const epoch = lifecycle();
        const old = epoch.insert().handles[0]!;
        epoch.owner.switchDocument({ articleId: 2, draftId: 'article:2', content: epoch.source() });
        expect(epoch.adapter.readOwnedIntent(old, epoch.binding())).toMatchObject({ current: false, sourceReferenced: null, disposition: 'cancelled' });
        epoch.adapter.dispose();
        expect(epoch.adapter.readOwnedIntent(old, epoch.binding())).toBeNull();
    });
});
