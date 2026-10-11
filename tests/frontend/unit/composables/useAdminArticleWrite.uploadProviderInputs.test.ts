// @vitest-environment happy-dom

import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { defineComponent, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAdminArticleWrite } from '@/composables/useAdminArticleWrite';
import type { SeoConfigPublic } from '@/api/system';

const upload = vi.hoisted(() => ({ initUploadSession: vi.fn(), uploadPart: vi.fn(), completeUpload: vi.fn(),
    abortUpload: vi.fn(), getUploadStatus: vi.fn(), getUploadPartMap: vi.fn(), compress: vi.fn(), hash: vi.fn() }));
vi.mock('@/api/upload', () => upload);
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
    api.principalId = `preview-current-host-${++api.caseId}`;
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

// This is the current actual Writer/runtime/flow, with controlled upload/compression endpoints only.
// Cover transport uses its existing document lease; this does not qualify body attachment input.
describe('actual Writer cover transport contracts', () =>
{
    it('uploads a large cover through the real Writer and clears transport state without body attachment effects', async () =>
    {
        const f = await host();
        const source = f.owner.articleForm.content;
        const coverBefore = f.owner.articleForm.coverImageUrl;
        const file = new File([new Uint8Array(20_971_520)], 'large-current.png', { type: 'image/png', lastModified: 1 });
        let finish!: (value: { url: string }) => void;
        upload.completeUpload.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const task = f.owner.handleCoverUpload([file]);
        await vi.waitFor(() => expect(upload.completeUpload).toHaveBeenCalledOnce());
        expect(upload.initUploadSession.mock.calls[0]![0]).toMatchObject({ totalBytes: file.size, sha256: 'a'.repeat(64) });
        expect(upload.completeUpload).toHaveBeenCalledWith('0123456789abcdef0123456789abcdef',
            'ordinary-owned-session-token', 'a'.repeat(64));
        expect(Object.keys(f.owner.imageUploadRuntime.activeSession).sort()).toEqual(['fileName', 'resumeKey', 'uploadId']);
        expect(f.owner.imageUploadRuntime.activeSession.uploadId).toBe('0123456789abcdef0123456789abcdef');
        expect(f.owner.articleForm.coverImageUrl).toBe(coverBefore);
        finish({ url: '/uploads/illustration/ordinary-complete.png' });
        await task;
        expect(f.owner.articleForm.coverImageUrl).toBe('/uploads/illustration/ordinary-complete.png');
        expect(f.owner.taskFeedback.phase.value).toBe('success');
        expect(f.owner.imageUploadRuntime.phase).toBe('completed');
        expect(f.owner.imageUploadRuntime.activeSession).toMatchObject({ uploadId: '', resumeKey: '', fileName: '' });
        expect(localStorage.length).toBe(0);
        expect(f.owner.authoringAttachmentRuntime.receipts).toEqual([]);
        expect(f.owner.articleForm.content).toBe(source);
        expect(f.owner.privatePreview.value).toBeNull();
        expect(api.preview).not.toHaveBeenCalled();
    });

    it('preserves the cover sentinel and disposed source when completion arrives after Writer unmount', async () =>
    {
        const f = await host();
        const coverSentinel = '/uploads/illustration/preserved-cover.png';
        f.owner.articleForm.coverImageUrl = coverSentinel;
        let finish!: (value: { url: string }) => void;
        upload.completeUpload.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const task = f.owner.handleCoverUpload([new File([new Uint8Array(3)], 'small-current.png',
            { type: 'image/png', lastModified: 1 })]);
        await vi.waitFor(() => expect(upload.completeUpload).toHaveBeenCalledOnce());
        f.wrapper.unmount();
        await flushPromises();
        const disposedSource = f.owner.articleForm.content;
        finish({ url: '/uploads/illustration/ordinary-late.png' });
        await task;
        expect(f.owner.articleForm.coverImageUrl).toBe(coverSentinel);
        expect(f.owner.articleForm.content).toBe(disposedSource);
        expect(f.owner.authoringAttachmentRuntime.receipts).toEqual([]);
        expect(f.owner.privatePreview.value).toBeNull();
        expect(api.preview).not.toHaveBeenCalled();
    });
});
