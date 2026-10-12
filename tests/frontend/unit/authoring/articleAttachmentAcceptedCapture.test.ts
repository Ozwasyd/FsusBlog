// @vitest-environment happy-dom
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { ElMarkdownEditor, type MarkdownEditorTransaction, type MarkdownEditorDispatchResult,
    type MarkdownEditorTransactionEvent, type MarkdownAttachmentBatchIntent,
    type MarkdownAttachmentCaptureObservation } from '@ozwasyd/element-plus';
import { createMarkdownAnchorMap } from '@ozwasyd/element-plus/markdown-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArticleAttachmentContextAdapter, type ArticleAttachmentFilePort } from '@/services/authoring/articleAttachmentContext';
import { ArticleAnchorContextAdapter } from '@/services/authoring/articleAnchorContext';
import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';

const disposals: (() => void)[] = [];
enableAutoUnmount(afterEach);
afterEach(() => disposals.splice(0).forEach(dispose => dispose()));
const options = { surface: 'source', tool: 'none', affinity: 'after', viewportOffset: 0, percentage: 0 } as const;
const nativeFile = (name = 'same.png') => new File(['same'], name, { type: 'image/png', lastModified: 1 });
let sequence = 0;
function fixture()
{
    const owner = createArticleDocumentContextAdapter({ articleId: 1, draftId: 'article:1',
        editorSessionId: `accepted:${++sequence}`, siteScope: 'site:test', userScope: 'user:test', content: 'paragraph' });
    const anchors = new ArticleAnchorContextAdapter(owner);
    const attachments = new ArticleAttachmentContextAdapter(owner, 'article-assets', 'version:1', anchors);
    disposals.push(() => { attachments.dispose(); owner.dispose(); });
    const events: MarkdownEditorTransactionEvent[] = [];
    const editor = mount(ElMarkdownEditor, { props: { mode: 'source', modelValue: 'paragraph', documentIdentity: owner.documentIdentity,
        onTransaction: (event: MarkdownEditorTransactionEvent) => { events.push(event); attachments.consumeTransaction(event, port); } } });
    const native = editor.vm as unknown as ArticleAttachmentFilePort & {
        dispatchTransaction(transaction: MarkdownEditorTransaction): MarkdownEditorDispatchResult;
    };
    const dispatch = vi.fn((transaction: MarkdownEditorTransaction) => native.dispatchTransaction(transaction));
    const port = { dispatch, withAttachmentFile: native.withAttachmentFile.bind(native),
        commitSource: (result: MarkdownEditorDispatchResult) => {
            if (result.revision > owner.context.sourceRevision) owner.updateSource(result.value, result.revision);
        }, binding: () => ({ document: owner.context,
            map: createMarkdownAnchorMap({ identity: owner.documentIdentity, source: events.at(-1)?.value ?? 'paragraph' }) }) };
    return { owner, attachments, editor, native, port, events, dispatch,
        admit: (batch: MarkdownAttachmentBatchIntent, capture: MarkdownAttachmentCaptureObservation | undefined) =>
            attachments.admitAcceptedCapture({ batch, capture, anchorOptions: options }, port) };
}
async function capture(f: ReturnType<typeof fixture>, files: File[], origin: 'pick' | 'paste' | 'drop' = 'pick', replacement = false)
{
    const textarea = f.editor.get<HTMLTextAreaElement>('textarea').element;
    textarea.setSelectionRange(0, replacement ? textarea.value.length : 0);
    if (origin === 'pick') {
        const picker = f.editor.get<HTMLInputElement>('input[type="file"]');
        Object.defineProperty(picker.element, 'files', { configurable: true, value: files });
        await picker.trigger('change');
    } else {
        const event = new Event(origin, { bubbles: true, cancelable: true });
        Object.defineProperty(event, origin === 'paste' ? 'clipboardData' : 'dataTransfer',
            { value: { files, types: ['Files'], getData: () => '' } });
        if (origin === 'drop') {
            Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true,
                value: () => ({ offset: 0, offsetNode: textarea }) });
            Object.defineProperties(event, { clientX: { value: 10 }, clientY: { value: 10 } });
        }
        textarea.dispatchEvent(event);
    }
    const emitted = f.editor.emitted('upload-image')!.at(-1)!;
    return { batch: emitted[0] as MarkdownAttachmentBatchIntent, observation: emitted[1] as MarkdownAttachmentCaptureObservation };
}

describe('native accepted attachment admission through the original adapter', () => {
    // Source control only: UNRUN under current runtime/test/list holds.
    it('settles only the actual native input transfer and keeps its pending provider obligation', async () => {
        const f = fixture(); const c = await capture(f, [nativeFile()]);
        const result = f.admit(c.batch, c.observation);
        if (result.status !== 'admitted') throw new Error(result.reason);
        const handle = result.items[0]!.handle;
        const inputRef = handle.snapshot.intent.task.taskRef;
        const providerRef = handle.snapshot.task.taskRef;
        expect(inputRef).not.toBe(providerRef);
        expect(f.owner.pendingTaskRefs).not.toContain(inputRef);
        expect(f.owner.pendingTaskRefs).toContain(providerRef);
        handle.cancel();
        expect(f.owner.pendingTaskRefs).toContain(providerRef);
    });

    it.each(['pick', 'paste', 'drop'] as const)('admits the original %s capture at the post-context without a second dispatch', async origin => {
        const f = fixture(); const file = nativeFile(); const c = await capture(f, [file], origin);
        expect(c.observation.transaction).toBe(f.events[0]);
        const result = f.admit(c.batch, c.observation);
        expect(result.status).toBe('admitted'); if (result.status !== 'admitted') throw new Error(result.reason);
        expect(result.items[0]!.file).toBe(file); expect(result.items[0]!.item).toBe(c.batch.items[0]);
        const handle = result.items[0]!.handle;
        expect(handle.snapshot.intent.task.context.contextDigest).toBe(f.owner.context.contextDigest);
        expect(handle.snapshot.task.taskRef).not.toBe(handle.snapshot.predecessorTaskRef);
        expect(f.attachments.readOwnedIntent(handle, f.port.binding())?.current).toBe(true);
        expect(f.dispatch).not.toHaveBeenCalled(); expect(f.events).toHaveLength(1);
        expect(f.admit(c.batch, c.observation)).toEqual({ status: 'rejected', reason: 'capture-already-admitted' });
    });
    it('refuses copied observation, copied batch, copied item, metadata-only and foreign captures', async () => {
        for (const kind of ['observation', 'batch', 'item', 'metadata', 'foreign']) {
            const f = fixture(); const c = await capture(f, [nativeFile()]);
            const foreign = fixture(); const x = await capture(foreign, [nativeFile()]);
            const batch = kind === 'batch' ? { ...c.batch } : kind === 'item' ? { ...c.batch, items: [{ ...c.batch.items[0]! }] } : kind === 'foreign' ? x.batch : c.batch;
            const observation = kind === 'metadata' ? undefined : kind === 'observation' ? { ...c.observation } : kind === 'foreign' ? x.observation : c.observation;
            expect(f.admit(batch, observation).status).toBe('rejected');
            expect(f.attachments.currentTaskLeases).toHaveLength(0); expect(f.dispatch).not.toHaveBeenCalled();
        }
    });
    it('refuses reentry into the same original capture while borrowing an actual File', async () => {
        const f = fixture(); const c = await capture(f, [nativeFile()]); let reentry: unknown;
        const port = { ...f.port, withAttachmentFile: (...args: Parameters<ArticleAttachmentFilePort['withAttachmentFile']>) => {
            reentry = f.admit(c.batch, c.observation); return f.port.withAttachmentFile(...args);
        } };
        expect(f.attachments.admitAcceptedCapture({ batch: c.batch, capture: c.observation, anchorOptions: options }, port).status).toBe('admitted');
        expect(reentry).toEqual({ status: 'rejected', reason: 'capture-already-admitted' });
        expect(f.attachments.currentTaskLeases).toHaveLength(1); expect(f.events).toHaveLength(1);
    });
    it('refuses a genuine capture after a source revision advances', async () => {
        const f = fixture(); const c = await capture(f, [nativeFile()]);
        f.native.dispatchTransaction({ changes: [{ from: 0, to: 0, insert: 'later' }], origin: 'input', history: 'separate',
            documentIdentity: f.owner.documentIdentity, expectedRevision: f.owner.context.sourceRevision });
        expect(f.admit(c.batch, c.observation).status).toBe('rejected'); expect(f.attachments.currentTaskLeases).toHaveLength(0);
    });
    it('drops the original File on native cancellation and never readmits a cancelled capture', async () => {
        const f = fixture(); const file = nativeFile(); const c = await capture(f, [file]); const result = f.admit(c.batch, c.observation);
        if (result.status !== 'admitted') throw new Error(result.reason);
        const handle = result.items[0]!.handle;
        (f.editor.vm as unknown as { applyAttachmentResult: (result: unknown) => boolean }).applyAttachmentResult({
            status: 'cancelled', batchId: c.batch.batchId, itemId: c.batch.items[0]!.itemId });
        expect(handle.signal.aborted).toBe(true); expect(f.attachments.matchesCapturedFile(handle, file)).toBe(false);
        expect(f.admit(c.batch, c.observation).status).toBe('rejected');
    });
    it('keeps same-metadata native Files and pending handles independent across a two-file batch', async () => {
        const f = fixture(); const files = [nativeFile(), nativeFile()]; const c = await capture(f, files); const result = f.admit(c.batch, c.observation);
        if (result.status !== 'admitted') throw new Error(result.reason);
        const [first, second] = result.items;
        expect(first!.file).toBe(files[0]); expect(second!.file).toBe(files[1]);
        expect(f.attachments.matchesCapturedFile(first!.handle, files[1]!)).toBe(false);
        first!.handle.cancel(); expect(second!.handle.signal.aborted).toBe(false);
        expect(f.attachments.readOwnedIntent(second!.handle, f.port.binding())?.current).toBe(true);
        expect(f.events).toHaveLength(1); expect(f.dispatch).not.toHaveBeenCalled();
    });
    it('accepts a fresh authentic equal-byte replacement while revoking its predecessor', async () => {
        const f = fixture(); const first = await capture(f, [nativeFile()]);
        const original = f.admit(first.batch, first.observation); if (original.status !== 'admitted') throw new Error(original.reason);
        // Replace just the inserted native placeholder; preserve the following paragraph.
        const textarea = f.editor.get<HTMLTextAreaElement>('textarea').element;
        textarea.setSelectionRange(0, first.observation.placements[0]!.range.end);
        const picker = f.editor.get<HTMLInputElement>('input[type="file"]'); const file = nativeFile();
        Object.defineProperty(picker.element, 'files', { configurable: true, value: [file] }); await picker.trigger('change');
        const emitted = f.editor.emitted('upload-image')!.at(-1)!;
        const batch = emitted[0] as MarkdownAttachmentBatchIntent; const observation = emitted[1] as MarkdownAttachmentCaptureObservation;
        expect(observation.transaction.beforeRevision).toBe(observation.transaction.revision);
        expect(observation.transaction.positionMap).toBeDefined(); expect(original.items[0]!.handle.signal.aborted).toBe(true);
        const successor = f.admit(batch, observation); expect(successor.status).toBe('admitted');
        if (successor.status !== 'admitted') throw new Error(successor.reason);
        expect(successor.items[0]!.file).toBe(file); expect(f.events).toHaveLength(2); expect(f.dispatch).not.toHaveBeenCalled();
    });
    it('refuses metadata-only retry and replacement of a native admission', async () => {
        const f = fixture(); const c = await capture(f, [nativeFile()]); const result = f.admit(c.batch, c.observation);
        if (result.status !== 'admitted') throw new Error(result.reason);
        const handle = result.items[0]!.handle;
        expect(() => f.attachments.replace(handle, { name: 'next.png', mimeType: 'image/png', byteLength: 4 }, f.port))
            .toThrow('attachment-native-capture-required');
        handle.cancel(); expect(() => f.attachments.retry(handle)).toThrow('attachment-retry-context-invalid');
        expect(f.events).toHaveLength(1); expect(f.dispatch).not.toHaveBeenCalled();
    });
    it('checks whole-batch capacity before issuing any pending handle', async () => {
        const f = fixture(); const c = await capture(f, [nativeFile(), nativeFile()]);
        const binding = f.port.binding();
        const anchor = new ArticleAnchorContextAdapter(f.owner).capture(binding, { start: 0, end: 0, direction: 'none' }, options);
        const created = f.attachments.capture({ origin: 'pick', source: binding.map.source, anchor,
            files: Array.from({ length: 99 }, (_, index) => ({ name: `${index}.png`, mimeType: 'image/png', byteLength: 1 })) });
        expect(created.status).toBe('created');
        expect(f.admit(c.batch, c.observation)).toEqual({ status: 'rejected', reason: 'capacity-exceeded' });
        expect(f.attachments.currentTaskLeases).toHaveLength(0); expect(f.events).toHaveLength(1);
    });
});
