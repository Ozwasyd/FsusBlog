// @vitest-environment happy-dom

import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { defineComponent, ref, toRaw } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAdminArticleWrite } from '@/composables/useAdminArticleWrite';
import { ElMarkdownEditor, type MarkdownEditorTransaction, type MarkdownEditorDispatchResult, type MarkdownEditorTransactionEvent } from '@ozwasyd/element-plus';

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
    let owner!: ReturnType<typeof useAdminArticleWrite>;
    const wrapper = mount(defineComponent({ setup() { owner = useAdminArticleWrite(); return () => null; } }));
    await flushPromises();
    await vi.waitFor(() => expect(owner.pageLoading.value).toBe(false));
    return { wrapper, owner, reads: owner.privatePreviewCurrentAuthorities };
}


async function pending(file: File)
{
    const f = await host();
    const runtime = f.owner.authoringAttachmentRuntime;
    const editor = mount(ElMarkdownEditor, { props: {
        mode: 'source', modelValue: f.owner.articleForm.content,
        documentIdentity: f.owner.authoringDocumentIdentity.value,
        'onUpdate:modelValue': (value: string) => { f.owner.articleForm.content = value; },
        onTransaction: (event: MarkdownEditorTransactionEvent) => runtime.consumeTransaction(event)
    } });
    const commands = editor.vm as unknown as { dispatchTransaction(transaction: MarkdownEditorTransaction): MarkdownEditorDispatchResult };
    const release = runtime.bindEditor({ dispatch: transaction => commands.dispatchTransaction(transaction) });
    const anchor = runtime.captureAnchor({ start: 0, end: 0, direction: 'none' },
        { surface: 'source', tool: 'none', affinity: 'after', viewportOffset: 0, percentage: 0 });
    const captured = runtime.capture({ origin: 'pick', anchor,
        files: [{ name: file.name, mimeType: file.type, byteLength: file.size }] });
    expect(captured.status).toBe('created');
    const handle = runtime.commitCreated(captured)[0]!;
    expect(runtime.readOwnedIntent(handle)?.current).toBe(true);
    const asset = { assetId: 'ordinary-asset', publicUrl: '/uploads/ordinary.png', sha256: 'a'.repeat(64),
        assetVersionSha256: 'b'.repeat(64), referenceLedgerSha256: 'c'.repeat(64), sizeBytes: file.size };
    upload.getUploadStatus.mockReset().mockImplementation(async (_id, signal) => {
        expect(f.owner.imageUploadRuntime.activeSession.uploadId).toBe('');
        expect(f.owner.imageUploadRuntime.phase).toBe('completed');
        expect(signal).toBeInstanceOf(AbortSignal);
        return { uploadId: '0123456789abcdef0123456789abcdef', totalBytes: file.size, uploadedBytes: file.size, status: 'completed' };
    });
    upload.readCommittedUploadPreview.mockReset().mockResolvedValue({ ...asset, bytes: new Uint8Array(file.size) });
    facts.readCommittedUploadFacts.mockReset().mockResolvedValue(asset);
    return { ...f, handle, runtime, release, asset, source: f.owner.articleForm.content };
}
const small = () => new File([new Uint8Array(3)], 'small-current.png', { type: 'image/png' });

describe('actual Writer owned upload observation', () =>
{
    it('observes large facts through the original per-attempt loan after public session clearing', async () =>
    {
        const file = new File([new Uint8Array(20_971_520)], 'large-current.png', { type: 'image/png' });
        // The actual flow stores files in a Vue deep ref. Recover the same object,
        // without replacing either the genuine pending handle or the original flow.
        expect(toRaw(ref({ files: [file] }).value.files[0])).toBe(file);
        const f = await pending(file);
        const result = await f.runtime.observeUpload(f.handle, file);
        expect(result).toEqual({ status: 'committed', asset: f.asset });
        expect(facts.readCommittedUploadFacts).toHaveBeenCalledOnce();
        expect(facts.readCommittedUploadFacts).toHaveBeenCalledWith('0123456789abcdef0123456789abcdef',
            'ordinary-owned-session-token', 'a'.repeat(64), expect.any(AbortSignal));
        expect(upload.readCommittedUploadPreview).not.toHaveBeenCalled();
        expect(Object.keys(result)).toEqual(['status', 'asset']);
        expect(f.owner.articleForm.content).toBe(f.source);
        expect(f.handle.snapshot.state).toBe('provider-pending');
        expect(f.owner.privatePreview.value).toBeNull();
        expect(localStorage.length).toBe(0);
    });

    it('uses the original bounded preview read for small files and returns no bytes', async () =>
    {
        const file = small(); const f = await pending(file);
        expect(await f.runtime.observeUpload(f.handle, file)).toEqual({ status: 'committed', asset: f.asset });
        expect(upload.readCommittedUploadPreview).toHaveBeenCalledOnce();
        expect(facts.readCommittedUploadFacts).not.toHaveBeenCalled();
        expect(f.owner.articleForm.content).toBe(f.source);
    });

    it('refuses a cloned pending handle before starting the original upload', async () =>
    {
        const file = small(); const f = await pending(file);
        await expect(f.runtime.observeUpload({ ...f.handle }, file)).rejects.toThrow('article-attachment-upload-intent-invalid');
        expect(upload.initUploadSession).not.toHaveBeenCalled();
    });

    it('refuses mismatched file metadata before starting the original upload', async () =>
    {
        const f = await pending(small());
        await expect(f.runtime.observeUpload(f.handle, new File(['different'], 'other.png', { type: 'image/png' })))
            .rejects.toThrow('article-attachment-upload-intent-invalid');
        expect(upload.initUploadSession).not.toHaveBeenCalled();
    });

    it('refuses the legacy body callback without an original document intent', async () =>
    {
        const f = await host(); const success = vi.fn(); const failure = vi.fn();
        await f.owner.handleUploadImg([small()], success, failure);
        expect(failure).toHaveBeenCalledWith('article-attachment-upload-intent-required');
        expect(success).not.toHaveBeenCalled();
        expect(upload.initUploadSession).not.toHaveBeenCalled();
    });

    it('refuses a concurrent owned invocation without replacing the original attempt', async () =>
    {
        const file = small(); const f = await pending(file);
        let finish!: (value: { url: string }) => void;
        upload.completeUpload.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const task = f.runtime.observeUpload(f.handle, file);
        await vi.waitFor(() => expect(upload.completeUpload).toHaveBeenCalledOnce());
        await expect(f.runtime.observeUpload(f.handle, file)).rejects.toThrow('article-attachment-upload-busy');
        finish({ url: '/uploads/ordinary.png' });
        expect(await task).toEqual({ status: 'committed', asset: f.asset });
        expect(upload.initUploadSession).toHaveBeenCalledOnce();
    });

    it('rejects late completion after the genuine intent is cancelled', async () =>
    {
        const file = small(); const f = await pending(file);
        let finish!: (value: { url: string }) => void;
        upload.completeUpload.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const task = f.runtime.observeUpload(f.handle, file); const assertion = expect(task).rejects.toThrow();
        await vi.waitFor(() => expect(upload.completeUpload).toHaveBeenCalledOnce());
        f.handle.cancel(); finish({ url: '/uploads/ordinary.png' }); await assertion;
        expect(upload.getUploadStatus).not.toHaveBeenCalled();
        expect(facts.readCommittedUploadFacts).not.toHaveBeenCalled();
    });

    it('rejects late completion after the actual Writer unmounts', async () =>
    {
        const file = small(); const f = await pending(file);
        let finish!: (value: { url: string }) => void;
        upload.completeUpload.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const task = f.runtime.observeUpload(f.handle, file); const assertion = expect(task).rejects.toThrow();
        await vi.waitFor(() => expect(upload.completeUpload).toHaveBeenCalledOnce());
        f.wrapper.unmount(); finish({ url: '/uploads/ordinary.png' }); await assertion;
        expect(upload.getUploadStatus).not.toHaveBeenCalled();
    });

    it('releases the loan signal after an observation and never grants a source transaction', async () =>
    {
        const file = small(); const f = await pending(file);
        await f.runtime.observeUpload(f.handle, file);
        const signal = upload.getUploadStatus.mock.calls[0]![1] as AbortSignal;
        expect(signal.aborted).toBe(true);
        expect(f.runtime.readOwnedIntent(f.handle)).toMatchObject({ current: true, sourceReferenced: true, sourceUrl: null });
        expect(f.handle.snapshot.state).toBe('provider-pending');
        expect(f.owner.articleForm.content).toBe(f.source);
    });

    it('retains recovery-required observations without retrying or deleting an uncertain commit', async () =>
    {
        const file = small(); const f = await pending(file);
        upload.getUploadStatus.mockRejectedValueOnce(new Error('unknown committed outcome'));
        expect(await f.runtime.observeUpload(f.handle, file)).toEqual({ status: 'recovery-required', reason: 'upload_observation_failed' });
        expect(upload.completeUpload).toHaveBeenCalledOnce();
        expect(upload.abortUpload).not.toHaveBeenCalled();
        expect(f.owner.articleForm.content).toBe(f.source);
    });
    it('rejects a late provider read when the calling signal aborts the original flow lease', async () =>
    {
        const file = small(); const f = await pending(file); const controller = new AbortController();
        let finish!: (value: unknown) => void;
        upload.getUploadStatus.mockImplementationOnce((_id, signal) => {
            expect(signal.aborted).toBe(false);
            return new Promise(resolve => { finish = resolve; });
        });
        const task = f.runtime.observeUpload(f.handle, file, controller.signal);
        const assertion = expect(task).rejects.toThrow();
        await vi.waitFor(() => expect(upload.getUploadStatus).toHaveBeenCalledOnce());
        controller.abort(new DOMException('Caller cancelled', 'AbortError'));
        finish({ uploadId: '0123456789abcdef0123456789abcdef', totalBytes: file.size,
            uploadedBytes: file.size, status: 'completed' });
        await assertion;
        expect(upload.getUploadStatus.mock.calls[0]![1].aborted).toBe(true);
        expect(upload.readCommittedUploadPreview).not.toHaveBeenCalled();
        expect(upload.abortUpload).not.toHaveBeenCalled();
        expect(f.owner.articleForm.content).toBe(f.source);
    });

    it('rejects a late preview observation after the actual editor owner is released', async () =>
    {
        const file = small(); const f = await pending(file);
        let finish!: (value: unknown) => void;
        upload.readCommittedUploadPreview.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const task = f.runtime.observeUpload(f.handle, file); const assertion = expect(task).rejects.toThrow();
        await vi.waitFor(() => expect(upload.readCommittedUploadPreview).toHaveBeenCalledOnce());
        f.release(); finish({ ...f.asset, bytes: new Uint8Array(file.size) }); await assertion;
        expect(upload.getUploadStatus.mock.calls[0]![1].aborted).toBe(true);
        expect(upload.abortUpload).not.toHaveBeenCalled();
        expect(f.owner.articleForm.content).toBe(f.source);
    });

});
