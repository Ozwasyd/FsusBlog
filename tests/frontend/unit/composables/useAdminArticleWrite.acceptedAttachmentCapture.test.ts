// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, ref, toRaw } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ArticleWriteEditor from '@/components/admin/article/ArticleWriteEditor.vue';
import { useAdminArticleWrite } from '@/composables/useAdminArticleWrite';
import type { MarkdownAttachmentBatchIntent, MarkdownAttachmentCaptureObservation } from '@/fsusui/articleAttachments';
import { ElDrawer, ElMarkdownEditor, type MarkdownEditorTransaction, type MarkdownEditorDispatchResult, type MarkdownEditorTransactionEvent } from '@ozwasyd/element-plus';

const upload = vi.hoisted(() => ({ initUploadSession: vi.fn(), uploadPart: vi.fn(), completeUpload: vi.fn(),
    abortUpload: vi.fn(), getUploadStatus: vi.fn(), getUploadPartMap: vi.fn(), readCommittedUploadPreview: vi.fn(), compress: vi.fn(), hash: vi.fn() }));
vi.mock('@/api/upload', () => upload);
const facts = vi.hoisted(() => ({ readCommittedUploadFacts: vi.fn() }));
vi.mock('@/api/uploadFacts', () => facts);
vi.mock('@/utils/imageCompression', () => ({ compressImageFileWithRuntime: upload.compress, sha256Hex: upload.hash }));
vi.mock('@/utils/wasmImageCodec', () => ({ getWasmSupportedFormats: vi.fn().mockResolvedValue(['png']) }));

const api = vi.hoisted(() => ({ site: vi.fn(), history: vi.fn(), preview: vi.fn(), principalId: '', caseId: 0 }));
vi.mock('vue-router', () => ({ useRoute: () => ({ params: {}, query: {} }),
    useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/store/admin', () => ({ useAdminStore: () => ({ setPageTitle: vi.fn(),
    adminPrincipal: { id: api.principalId, username: api.principalId } }) }));
vi.mock('@/api/article', () => ({ ArticlePublishStatus: { Draft: 0, Published: 1, Scheduled: 2, Private: 3 },
    createArticle: vi.fn(), updateArticle: vi.fn(), getAdminArticleById: vi.fn() }));
vi.mock('@/api/authoring', () => ({ getArticleResponsibilityHistory: api.history, previewArticleDraft: api.preview,
    saveServerDraft: vi.fn(), getServerDraft: vi.fn().mockResolvedValue(null), discardServerDraft: vi.fn(),
    checkArticlePrepublish: vi.fn(), generateAiAssist: vi.fn(), createArticlePreviewSourceIdentity: vi.fn(),
    cleanupOrphanAssets: vi.fn(), listAssetLibrary: vi.fn().mockResolvedValue([]),
    listArticleRevisions: vi.fn().mockResolvedValue([]), getArticleRevision: vi.fn(),
    reindexArticleAssets: vi.fn(), rollbackArticleRevision: vi.fn() }));
vi.mock('@/api/system', () => ({ getSiteConfig: api.site,
    getAdminSiteConfig: vi.fn().mockResolvedValue({ author: 'Host cached author', baseUrl: 'https://consumer.test',
        enableArticleRights: false, rights: {} }), getAdminSiteComplianceConfig: vi.fn().mockResolvedValue({}) }));
vi.mock('@/api/category', () => ({ getCategories: vi.fn().mockResolvedValue([]), createCategory: vi.fn() }));
vi.mock('@/api/tag', () => ({ getTags: vi.fn().mockResolvedValue([]), createTag: vi.fn() }));
vi.mock('@/composables/useImageUploadPreferences', () => ({ useImageUploadPreferences: () => ({ options: ref({ format: 'png', quality: 100, scaleRatio: 1, maxEdge: 1920, preserveAlpha: true }),
    wasmOnlyMode: ref(true), setOptions: vi.fn(), setWasmOnlyMode: vi.fn() }) }));
vi.mock('@/composables/usePow', () => ({ usePow: () => ({ prewarm: vi.fn() }) }));
vi.mock('@/utils/errorPresentation', () => ({ showErrorToast: vi.fn(), showWarningToast: vi.fn() }));
vi.mock('@/services/articleRecoveryJournal', async importOriginal => ({
    ...await importOriginal<typeof import('@/services/articleRecoveryJournal')>(),
    articleRecoveryJournal: { write: vi.fn().mockResolvedValue({ status: 'stored',
        record: { id: 'ordinary-preview-host', clientRevision: 'fixture-1', sourceHash: 'fixture-source' } }),
    confirm: vi.fn().mockResolvedValue(true), list: vi.fn().mockResolvedValue({ status: 'ok', records: [] }),
    discard: vi.fn().mockResolvedValue(true), clearScope: vi.fn().mockResolvedValue(true) }
}));

enableAutoUnmount(afterEach);
beforeEach(() => {
    // The original authority retains a document across remounts. Each ordinary case owns a separate user scope.
    api.principalId = `owned-upload-host-${++api.caseId}`;
    api.site.mockReset().mockResolvedValue({ author: 'Canonical observed author' });
    api.history.mockReset().mockResolvedValue([]);
    api.preview.mockReset();
    localStorage.clear();
    upload.initUploadSession.mockReset().mockResolvedValue({ uploadId: '0123456789abcdef0123456789abcdef',
        uploadToken: 'ordinary-owned-session-token' });
    upload.uploadPart.mockReset().mockImplementation(async (_id, _token, _part, offset, chunk) => ({ uploadedBytes: offset + chunk.size }));
    upload.completeUpload.mockReset().mockResolvedValue({ url: '/uploads/illustration/ordinary-complete.png' });
    upload.abortUpload.mockReset().mockResolvedValue({ uploadId: '0123456789abcdef0123456789abcdef', status: 'aborted' });
    upload.hash.mockReset().mockResolvedValue('a'.repeat(64));
    upload.compress.mockReset().mockImplementation(async file => ({ file, preview: { width: 1, height: 1,
        format: 'png', originalBytes: file.size, compressedBytes: file.size, pipeline: 'wasm', wasmCapability: 'wasm' } }));
});
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

async function host()
{
    let binding: ReturnType<ReturnType<typeof useAdminArticleWrite>['authoringEditorRuntime']['bindEditor']>['binding'] | null = null;
    let owner!: ReturnType<typeof useAdminArticleWrite>;
    const wrapper = mount(defineComponent({ setup() { owner = useAdminArticleWrite(); return () => h(ArticleWriteEditor, { modelValue: owner.articleForm.content,
            documentIdentity: owner.authoringDocumentIdentity.value, documentContext: owner.authoringDocumentContext.value,
            'onUpdate:modelValue': (value: string) => { owner.articleForm.content = value; },
            onTransaction: (event: MarkdownEditorTransactionEvent) => { binding?.consumeTransaction(event); } }); } }), { global: { components: { ElDrawer } } });
    await flushPromises();
    await vi.waitFor(() => expect(owner.pageLoading.value).toBe(false));
    const product = wrapper.findComponent(ArticleWriteEditor);
    const native = wrapper.findComponent(ElMarkdownEditor);
    const port = product.vm.getAuthoringEditorPort(); if (!port) throw new Error('real-port-missing');
    const bound = owner.authoringEditorRuntime.bindEditor(port, { surface: 'source',
        configuration: { allowLatex: true, allowMermaid: true, baseUrl: null },
        identity: { themeDigest: 'a'.repeat(64), locale: 'zh-CN' }, cachePolicy: { maxEntryBytes: 4096, maxAgeMs: 1000, maxReceipts: 4 } });
    binding = bound.binding;
    return { wrapper, owner, product, native, release: bound.release };
}


async function captured(files: File[] = [new File(['same'], 'native.png', { type: 'image/png' })])
{
    const f = await host();
    const textarea = f.native.get<HTMLTextAreaElement>('textarea').element; textarea.setSelectionRange(0, 0);
    const picker = f.native.get<HTMLInputElement>('input[type="file"]');
    Object.defineProperty(picker.element, 'files', { configurable: true, value: files }); await picker.trigger('change');
    const emitted = f.product.emitted('attachment-capture')!.at(-1)!;
    const batch = emitted[0] as MarkdownAttachmentBatchIntent; const capture = emitted[1] as MarkdownAttachmentCaptureObservation;
    const anchorOptions = emitted[2] as Parameters<typeof f.owner.authoringAttachmentRuntime.admitAcceptedCapture>[0]['anchorOptions'];
    const runtime = f.owner.authoringAttachmentRuntime;
    const admit = () => runtime.admitAcceptedCapture({ batch, capture, anchorOptions });
    const asset = { assetId: 'native-owned-asset', publicUrl: '/uploads/native.png', sha256: 'a'.repeat(64),
        assetVersionSha256: 'b'.repeat(64), referenceLedgerSha256: 'c'.repeat(64), sizeBytes: files[0]!.size };
    upload.getUploadStatus.mockReset().mockImplementation(async () => ({ uploadId: '0123456789abcdef0123456789abcdef',
        totalBytes: files[0]!.size, uploadedBytes: files[0]!.size, status: 'completed' }));
    upload.readCommittedUploadPreview.mockReset().mockResolvedValue({ ...asset, bytes: new Uint8Array(files[0]!.size) });
    facts.readCommittedUploadFacts.mockReset().mockResolvedValue(asset);
    return { ...f, runtime, admit, batch, capture, anchorOptions, files, asset };
}

describe('real mounted Writer consumes authentic native attachment captures', () => {
    it.each(['pending', 'failed', 'recovery-required'] as const)('the actual Write handler surfaces and stops on %s instead of dropping the result', async status => {
        const f = await captured([new File(['one'], 'one.png', { type: 'image/png' }), new File(['two'], 'two.png', { type: 'image/png' })]);
        // Execute the actual page handler source, not a copied implementation or full-page/browser qualification.
        const page = readFileSync(resolve(process.cwd(), 'src/views/admin/article/Write.vue'), 'utf8');
        const start = page.indexOf('async function consumeAcceptedAttachmentCapture(');
        const end = page.indexOf('function consumeAuthoringTransaction(', start);
        expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
        const ts = createRequire(resolve(process.cwd(), 'package.json'))('typescript');
        const script = ts.transpileModule(page.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
        const observeUpload = vi.fn().mockResolvedValue(status === 'pending'
            ? { status, uploadedBytes: 0, totalBytes: 3 } : { status, reason: 'original-observation-obligation' });
        const notify = vi.fn();
        const consume = new Function('authoringAttachmentRuntime', 'showErrorToast',
            script + '; return consumeAcceptedAttachmentCapture;')({ ...f.runtime, observeUpload }, notify);
        await consume(f.batch, f.capture, f.anchorOptions);
        expect(observeUpload).toHaveBeenCalledOnce(); expect(notify).toHaveBeenCalledOnce();
        expect(f.native.emitted('transaction')).toHaveLength(1); expect(upload.initUploadSession).not.toHaveBeenCalled();
    });

    it('retains the genuine pending observation and refuses a new upload handle while its outcome is unconfirmed', async () => {
        const f = await captured([new File(['one'], 'one.png', { type: 'image/png' }), new File(['two'], 'two.png', { type: 'image/png' })]);
        const admitted = f.admit(); if (admitted.status !== 'admitted') throw new Error(admitted.reason);
        upload.getUploadStatus.mockResolvedValueOnce({ uploadId: '0123456789abcdef0123456789abcdef', totalBytes: 3, uploadedBytes: 0, status: 'pending' });
        const first = admitted.items[0]!; const second = admitted.items[1]!;
        const result = await f.runtime.observeUpload(first.handle, first.file);
        expect(result).toEqual({ status: 'pending', uploadedBytes: 0, totalBytes: 3 });
        expect(f.runtime.uploadObligations[0]!.observation).toBe(result);
        await expect(f.runtime.observeUpload(second.handle, second.file)).rejects.toThrow('article-attachment-upload-recovery-required');
        expect(f.runtime.readUploadObservation(second.handle)).toBeNull();
        expect(upload.initUploadSession).toHaveBeenCalledOnce(); expect(upload.abortUpload).not.toHaveBeenCalled();
    });
    it('retains interrupted observation ownership after cancellation without inventing an abort acknowledgement', async () => {
        const f = await captured(); const admitted = f.admit(); if (admitted.status !== 'admitted') throw new Error(admitted.reason);
        const item = admitted.items[0]!; let finish!: (value: unknown) => void;
        upload.getUploadStatus.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const controller = new AbortController(); const task = f.runtime.observeUpload(item.handle, item.file, controller.signal);
        const rejected = expect(task).rejects.toThrow();
        await vi.waitFor(() => expect(upload.getUploadStatus).toHaveBeenCalledOnce());
        controller.abort(new DOMException('Caller cancelled', 'AbortError'));
        finish({ uploadId: '0123456789abcdef0123456789abcdef', totalBytes: 4, uploadedBytes: 4, status: 'completed' });
        await rejected;
        expect(f.runtime.readUploadObservation(item.handle)?.status).toBe('interrupted');
        expect(f.runtime.uploadObligations[0]!.handle).toBe(item.handle);
        expect(f.runtime.uploadObligations[0]!.observation).toBeNull();
        expect(() => f.runtime.retry(item.handle)).toThrow('article-attachment-upload-recovery-required');
        expect(upload.abortUpload).not.toHaveBeenCalled();
    });
    it('refuses unsupported native completion without dispatching or claiming committed ownership', async () => {
        const f = await captured(); const admitted = f.admit(); if (admitted.status !== 'admitted') throw new Error(admitted.reason);
        const handle = admitted.items[0]!.handle; const source = f.owner.articleForm.content;
        const result = f.runtime.complete(handle, { ...handle.request, status: 'resolved',
            payload: { markdownKind: 'image', href: '/native-completed.png', alt: 'native.png', mimeType: 'image/png' } });
        expect(result).toMatchObject({ state: 'failed', reason: 'attachment-native-completion-unavailable' });
        expect(f.owner.articleForm.content).toBe(source);
        expect(f.native.emitted('transaction')).toHaveLength(1);
        expect(f.runtime.receipts.some(receipt => receipt.state === 'transaction-committed')).toBe(false);
    });
    it.each(['committed', 'recovery-required'] as const)('consumes a genuine handle once after a %s observation', async status => {
        const f = await captured(); const admitted = f.admit(); if (admitted.status !== 'admitted') throw new Error(admitted.reason);
        const item = admitted.items[0]!;
        if (status === 'recovery-required') upload.getUploadStatus.mockRejectedValueOnce(new Error('unreadable acknowledged upload'));
        const result = await f.runtime.observeUpload(item.handle, item.file);
        expect(result.status).toBe(status);
        expect(f.runtime.readUploadObservation(item.handle)?.observation).toBe(result);
        expect(f.runtime.readUploadObservation({ ...item.handle })).toBeNull();
        if (status === 'recovery-required')
        {
            expect(f.runtime.uploadObligations).toHaveLength(1);
            expect(f.runtime.uploadObligations[0]!.handle).toBe(item.handle);
            expect(f.runtime.uploadObligations[0]!.observation).toBe(result);
            expect(() => f.runtime.retry(item.handle)).toThrow('article-attachment-upload-recovery-required');
            expect(() => f.runtime.replace(item.handle, { name: 'replacement.png', mimeType: 'image/png', byteLength: 3 }))
                .toThrow('article-attachment-upload-recovery-required');
            await expect(f.owner.resumeImageUpload()).rejects.toThrow('article-attachment-upload-recovery-required');
            await expect(f.owner.handleCoverUpload([item.file])).rejects.toThrow('article-attachment-upload-recovery-required');
        }
        else expect(f.runtime.uploadObligations).toHaveLength(0);
        await expect(f.runtime.observeUpload(item.handle, item.file)).rejects.toThrow('article-attachment-upload-consumed');
        expect(upload.initUploadSession).toHaveBeenCalledOnce(); expect(upload.completeUpload).toHaveBeenCalledOnce();
        expect(upload.abortUpload).not.toHaveBeenCalled();
    });

    it('preserves the actual event and File identities through the product wrappers and uploads once', async () => {
        const f = await captured(); const result = f.admit();
        expect(result.status).toBe('admitted'); if (result.status !== 'admitted') throw new Error(result.reason);
        expect(f.capture).toBe(f.native.emitted('upload-image')![0]![1]);
        expect(f.capture.transaction).toBe(f.native.emitted('transaction')![0]![0]);
        expect(result.items[0]!.file).toBe(f.files[0]);
        expect(f.wrapper.findAll('input[type="file"]')).toHaveLength(1);
        expect(f.product.emitted('upload-img')).toBeUndefined();
        expect(f.owner.articleForm.content).not.toContain('fsus-upload-placeholder://');
        const source = f.owner.articleForm.content;
        expect(await f.runtime.observeUpload(result.items[0]!.handle, result.items[0]!.file)).toEqual({ status: 'committed', asset: f.asset });
        expect(upload.completeUpload).toHaveBeenCalledOnce(); expect(upload.readCommittedUploadPreview).toHaveBeenCalledOnce();
        expect(f.native.emitted('transaction')).toHaveLength(1); expect(f.owner.articleForm.content).toBe(source);
        expect(f.owner.privatePreview.value).toBeNull(); expect(localStorage.length).toBe(0);
    });
    it('rejects a different same-metadata File and a copied handle through the original upload gates', async () => {
        const f = await captured(); const result = f.admit(); if (result.status !== 'admitted') throw new Error(result.reason);
        const item = result.items[0]!;
        await expect(f.runtime.observeUpload(item.handle, new File(['same'], 'native.png', { type: 'image/png' })))
            .rejects.toThrow('article-attachment-upload-intent-invalid');
        await expect(f.runtime.observeUpload({ ...item.handle }, item.file)).rejects.toThrow('article-attachment-upload-intent-invalid');
        expect(upload.initUploadSession).not.toHaveBeenCalled();
    });
    it('refuses copied observation, foreign capture and replay without duplicating a transaction', async () => {
        const f = await captured();
        expect(f.runtime.admitAcceptedCapture({ batch: f.batch, capture: { ...f.capture }, anchorOptions: f.anchorOptions }).status).toBe('rejected');
        const foreign = mount(ElMarkdownEditor, { props: { mode: 'source', modelValue: '', documentIdentity: { id: 'foreign', epoch: 1 } } });
        const picker = foreign.get<HTMLInputElement>('input[type="file"]');
        Object.defineProperty(picker.element, 'files', { configurable: true, value: [new File(['same'], 'native.png', { type: 'image/png' })] });
        await picker.trigger('change'); const event = foreign.emitted('upload-image')![0]!;
        expect(f.runtime.admitAcceptedCapture({ batch: event[0] as MarkdownAttachmentBatchIntent,
            capture: event[1] as MarkdownAttachmentCaptureObservation, anchorOptions: f.anchorOptions }).status).toBe('rejected');
        expect(f.admit().status).toBe('admitted'); expect(f.admit().status).toBe('rejected');
        expect(f.native.emitted('transaction')).toHaveLength(1); expect(upload.initUploadSession).not.toHaveBeenCalled();
    });
    it('refuses reentrant admission during the actual bound editor File callback', async () => {
        const f = await captured(); const port = f.product.vm.getAuthoringEditorPort()!;
        const actual = (port as unknown as { withAttachmentFile: (...args: unknown[]) => boolean }).withAttachmentFile;
        let nested: unknown;
        const spy = vi.spyOn(port as unknown as { withAttachmentFile: (...args: unknown[]) => boolean }, 'withAttachmentFile')
            .mockImplementation((...args) => { nested = f.admit(); return actual(...args); });
        expect(f.admit().status).toBe('admitted'); expect(nested).toEqual({ status: 'rejected', reason: 'capture-already-admitted' });
        spy.mockRestore(); expect(f.native.emitted('transaction')).toHaveLength(1);
    });
    it('refuses a stale native capture after a real guarded editor transaction', async () => {
        const f = await captured(); const port = f.product.vm.getAuthoringEditorPort()!;
        port.dispatchTransaction({ changes: [{ from: 0, to: 0, insert: 'later' }], origin: 'input', history: 'separate',
            documentIdentity: f.owner.authoringDocumentIdentity.value, expectedRevision: f.owner.authoringDocumentContext.value.sourceRevision });
        expect(f.admit().status).toBe('rejected'); expect(upload.initUploadSession).not.toHaveBeenCalled();
    });
    it('revokes an old native handle when actual equal-byte input replaces its placeholder', async () => {
        const f = await captured(); const first = f.admit(); if (first.status !== 'admitted') throw new Error(first.reason);
        const textarea = f.native.get<HTMLTextAreaElement>('textarea').element;
        textarea.setSelectionRange(0, f.capture.placements[0]!.range.end);
        const picker = f.native.get<HTMLInputElement>('input[type="file"]'); const file = new File(['same'], 'native.png', { type: 'image/png' });
        Object.defineProperty(picker.element, 'files', { configurable: true, value: [file] }); await picker.trigger('change');
        expect(first.items[0]!.handle.signal.aborted).toBe(true);
        const emitted = f.product.emitted('attachment-capture')!.at(-1)!;
        const batch = emitted[0] as MarkdownAttachmentBatchIntent; const capture = emitted[1] as MarkdownAttachmentCaptureObservation;
        expect(capture.transaction.beforeRevision).toBe(capture.transaction.revision);
        const second = f.runtime.admitAcceptedCapture({ batch, capture, anchorOptions: f.anchorOptions }); expect(second.status).toBe('admitted');
        if (second.status !== 'admitted') throw new Error(second.reason); expect(second.items[0]!.file).toBe(file);
        await expect(f.runtime.observeUpload(first.items[0]!.handle, first.items[0]!.file)).rejects.toThrow('article-attachment-upload-intent-invalid');
        expect(f.native.emitted('transaction')).toHaveLength(2); expect(upload.initUploadSession).not.toHaveBeenCalled();
    });
    it('uses the bound editor rather than a metadata-only or unbound input', async () => {
        const f = await captured(); f.release();
        expect(f.admit().status).toBe('rejected');
        expect(f.runtime.admitAcceptedCapture({ batch: f.batch, capture: undefined, anchorOptions: f.anchorOptions }).status).toBe('rejected');
        expect(upload.initUploadSession).not.toHaveBeenCalled();
    });
    it('keeps native paste with its owner instead of producing a legacy placeholder', async () => {
        const f = await host(); const file = new File(['same'], 'pasted.png', { type: 'image/png' });
        const event = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', { value: { files: [file], types: ['Files'], getData: () => '' } });
        f.native.get('textarea').element.dispatchEvent(event); await flushPromises();
        expect(f.product.emitted('attachment-capture')).toHaveLength(1); expect(f.product.emitted('upload-img')).toBeUndefined();
        expect(f.native.emitted('transaction')).toHaveLength(1); expect(f.owner.articleForm.content).not.toContain('fsus-upload-placeholder://');
    });
    it('cancels the genuine handle on native revocation and refuses a later upload', async () => {
        const f = await captured(); const result = f.admit(); if (result.status !== 'admitted') throw new Error(result.reason);
        const item = result.items[0]!;
        f.native.vm.applyAttachmentResult({ status: 'cancelled', batchId: f.batch.batchId, itemId: item.item.itemId });
        expect(item.handle.signal.aborted).toBe(true);
        await expect(f.runtime.observeUpload(item.handle, item.file)).rejects.toThrow('article-attachment-upload-intent-invalid');
        expect(f.admit().status).toBe('rejected'); expect(upload.initUploadSession).not.toHaveBeenCalled();
    });
    it('never promotes metadata retry or replacement to a fresh File authority', async () => {
        const f = await captured(); const result = f.admit(); if (result.status !== 'admitted') throw new Error(result.reason);
        const item = result.items[0]!;
        expect(() => f.runtime.replace(item.handle, { name: 'other.png', mimeType: 'image/png', byteLength: 4 }))
            .toThrow('attachment-native-capture-required');
        item.handle.cancel(); expect(() => f.runtime.retry(item.handle)).toThrow('attachment-retry-context-invalid');
        expect(f.native.emitted('transaction')).toHaveLength(1); expect(upload.initUploadSession).not.toHaveBeenCalled();
    });
    it('keeps two same-metadata Files independent and observes each per-call completion', async () => {
        const files = [new File(['same'], 'native.png', { type: 'image/png' }), new File(['same'], 'native.png', { type: 'image/png' })];
        const f = await captured(files); const result = f.admit(); if (result.status !== 'admitted') throw new Error(result.reason);
        for (const item of result.items) expect(await f.runtime.observeUpload(item.handle, item.file)).toEqual({ status: 'committed', asset: f.asset });
        expect(result.items[0]!.handle).not.toBe(result.items[1]!.handle);
        expect(upload.completeUpload).toHaveBeenCalledTimes(2); expect(upload.readCommittedUploadPreview).toHaveBeenCalledTimes(2);
        expect(f.native.emitted('transaction')).toHaveLength(1);
    });
    it('refuses late completion after actual Writer unmount through the original cancellation gate', async () => {
        const f = await captured(); const result = f.admit(); if (result.status !== 'admitted') throw new Error(result.reason);
        let finish!: (value: { url: string }) => void;
        upload.completeUpload.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const task = f.runtime.observeUpload(result.items[0]!.handle, result.items[0]!.file);
        const rejection = expect(task).rejects.toThrow();
        await vi.waitFor(() => expect(upload.completeUpload).toHaveBeenCalledOnce()); f.wrapper.unmount();
        finish({ url: '/uploads/late.png' }); await rejection;
        expect(upload.readCommittedUploadPreview).not.toHaveBeenCalled(); expect(facts.readCommittedUploadFacts).not.toHaveBeenCalled();
    });
});
