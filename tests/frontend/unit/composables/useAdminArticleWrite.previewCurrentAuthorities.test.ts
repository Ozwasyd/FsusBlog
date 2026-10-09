// @vitest-environment happy-dom

import { ElMarkdownEditor } from '@ozwasyd/element-plus';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { defineComponent, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAdminArticleWrite } from '@/composables/useAdminArticleWrite';
import type { SeoConfigPublic } from '@/api/system';
import type { ArticleEditorContinuityPort } from '@/services/authoring/articleEditorContinuity';
import { ArticlePreviewSourceAdmission } from '@/services/authoring/articlePreviewSourceAdmission';
import { calculateOpenArticleDocumentDigest as digest } from '@/services/authoring/openArticleDocumentRegistry';
import type { ArticleDraftResponsibilitySource } from '@/view-contracts/articleDraftResponsibility';

const api = vi.hoisted(() => ({ site: vi.fn(), history: vi.fn(), preview: vi.fn() }));
vi.mock('vue-router', () => ({ useRoute: () => ({ params: {}, query: {} }),
    useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/store/admin', () => ({ useAdminStore: () => ({ setPageTitle: vi.fn(),
    adminPrincipal: { id: 'preview-current-host', username: 'preview-current-host' } }) }));
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
vi.mock('@/composables/useImageUploadPreferences', () => ({ useImageUploadPreferences: () => ({ options: {},
    wasmOnlyMode: { value: false }, setOptions: vi.fn(), setWasmOnlyMode: vi.fn() }) }));
vi.mock('@/composables/useImageUploadRuntime', () => ({ useImageUploadRuntime: () => ({}) }));
vi.mock('@/composables/useImageUploadFlow', () => ({ useImageUploadFlow: () => ({ run: vi.fn(), cancel: vi.fn() }) }));
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
    api.site.mockReset().mockResolvedValue({ author: 'Canonical observed author' });
    api.history.mockReset().mockResolvedValue([]);
    api.preview.mockReset();
});
afterEach(() => vi.restoreAllMocks());

async function host()
{
    let owner!: ReturnType<typeof useAdminArticleWrite>;
    const wrapper = mount(defineComponent({ setup() { owner = useAdminArticleWrite(); return () => null; } }));
    await flushPromises();
    expect(owner.pageLoading.value).toBe(false);
    return { wrapper, owner, reads: owner.privatePreviewCurrentAuthorities };
}

async function boundHost()
{
    const f = await host();
    f.owner.articleForm.content = 'Actual host source';
    await nextTick();
    const editor = mount(ElMarkdownEditor, { props: { modelValue: f.owner.articleForm.content,
        mode: 'source', documentIdentity: f.owner.authoringDocumentIdentity.value } });
    const session = f.owner.authoringEditorRuntime.bindEditor(editor.vm as unknown as ArticleEditorContinuityPort,
        { surface: 'source', configuration: { allowLatex: false, allowMermaid: false, baseUrl: null },
            identity: { themeDigest: digest({ ordinary: 'preview-current-host' }), locale: 'zh-CN' },
            cachePolicy: { maxEntryBytes: 65536, maxAgeMs: 60000, maxReceipts: 16 } });
    expect(session.binding.initialize()).toBe(true);
    const editing: ArticleDraftResponsibilitySource = { inheritSiteAuthor: true, authors: [], reviewer: null,
        sources: [], updateSummary: null, updateReason: null, effectiveAt: null, conclusionImpact: null,
        responsiblePersonConfirmed: false };
    // Ordinary refusal port only. It never returns a fabricated asset projection or verification receipt.
    const business = { assess: vi.fn(async () => { throw new Error('ordinary-business-refusal'); }),
        verify: vi.fn().mockResolvedValue(false) };
    const release = session.bindPreviewOwners(business, () => ({ responsibility: editing, siteAuthor: 'Borrowed author' }));
    return { ...f, session, editing, business, release };
}

describe('actual Writer preview current authority binding', () =>
{
    it('keeps a new draft explicitly missing and lends the genuine current host fields', async () =>
    {
        const f = await host();
        const context = f.owner.authoringDocumentContextAdapter.context;
        const state = await f.reads.refresh(new AbortController().signal);
        const input = f.reads.read();
        expect(input.context).toBe(context);
        expect(input.source).toBe(f.owner.articleForm.content);
        expect(input.attachmentLifecycleHistory).toEqual(f.owner.authoringAttachmentRuntime.receipts);
        expect(input.authoringInputDigest).toMatch(/^[a-f0-9]{64}$/u);
        expect(input.responsibility).toBeNull();
        expect(input.siteAuthor).toBe('Canonical observed author');
        expect(state.reasons).toContain('responsibility-missing');
        expect(state.currentResponsibilityTransport).toBe('unavailable');
        expect(api.history).not.toHaveBeenCalled();
        expect(f.owner.canGeneratePrivatePreview.value).toBe(false);
        expect(f.owner.authoringDocumentContextAdapter.isCurrentContext(context)).toBe(true);
    });

    it('withdraws observations on the actual host source change without releasing its owner', async () =>
    {
        const f = await host();
        await f.reads.refresh(new AbortController().signal);
        f.owner.articleForm.content = 'Changed ordinary host source';
        await nextTick();
        expect(f.reads.state.status).toBe('stale');
        expect(() => f.reads.read()).toThrow('preview-authorities-not-current');
        expect(f.owner.authoringDocumentContextAdapter.isCurrentContext(f.owner.authoringDocumentContextAdapter.context)).toBe(true);
        expect(api.history).not.toHaveBeenCalled();
    });

    it('uses only live borrowed editing fields and rejects older source admission after their edit', async () =>
    {
        const f = await boundHost();
        await f.reads.refresh(new AbortController().signal);
        expect(f.reads.readResponsibility()).toBe(f.editing);
        expect(f.reads.readSiteAuthor()).toBe('Canonical observed author');
        expect(f.reads.state.reasons).toContain('responsibility-person-unconfirmed');
        const admission = ArticlePreviewSourceAdmission.attachRuntime(f.session.binding, f.reads.read);
        const old = admission.begin();
        expect(old.responsibility.status).toBe('incomplete');
        f.editing.inheritSiteAuthor = false;
        f.editing.authors.push({ name: 'Actual changed editing input', profileUrl: null });
        expect(admission.accept(old, 'old ordinary response').accepted).toBe(false);
        const fresh = admission.begin();
        expect(fresh.responsibility.authors[0]?.name).toBe('Actual changed editing input');
        expect(fresh.responsibility.reasons).toContain('responsibility-person-unconfirmed');
        expect(f.editing.responsiblePersonConfirmed).toBe(false);
        expect(api.history).not.toHaveBeenCalled();
        admission.dispose();
        f.release();
    });

    it('refreshes canonical reads before the original generation flow and preserves a business refusal', async () =>
    {
        const f = await boundHost();
        expect(f.owner.canGeneratePrivatePreview.value).toBe(true);
        await f.owner.generatePrivatePreview();
        expect(api.site).toHaveBeenCalledTimes(1);
        expect(f.business.assess).toHaveBeenCalledTimes(1);
        expect(api.site.mock.invocationCallOrder[0]).toBeLessThan(f.business.assess.mock.invocationCallOrder[0]);
        expect(f.reads.readResponsibility()).toBe(f.editing);
        expect(f.reads.state.reasons).toContain('responsibility-person-unconfirmed');
        expect(f.owner.privatePreview.value).toBeNull();
        expect(api.preview).not.toHaveBeenCalled();
        expect(f.business.verify).not.toHaveBeenCalled();
        expect(f.owner.privatePreviewLoading.value).toBe(false);
        f.release();
        expect(f.reads.state.status).toBe('canceled');
    });

    it('disposes only the read consumer while its host owner remains current', async () =>
    {
        const f = await host();
        await f.reads.refresh(new AbortController().signal);
        const context = f.owner.authoringDocumentContextAdapter.context;
        f.reads.dispose();
        expect(() => f.reads.read()).toThrow('preview-authorities-disposed');
        expect(f.owner.authoringDocumentContextAdapter.context).toBe(context);
        expect(f.owner.authoringDocumentContextAdapter.isCurrentContext(context)).toBe(true);
    });

    it('aborts the actual read consumer on host unmount and refuses its abort-ignoring late response', async () =>
    {
        const f = await host();
        let complete!: (value: SeoConfigPublic) => void;
        api.site.mockImplementationOnce(() => new Promise<SeoConfigPublic>(resolve => { complete = resolve; }));
        const pending = f.reads.refresh(new AbortController().signal);
        const signal = api.site.mock.calls[0]![0].signal as AbortSignal;
        f.wrapper.unmount();
        expect(signal.aborted).toBe(true);
        expect((await pending).status).toBe('canceled');
        complete({ author: 'Ignored ordinary late author' } as SeoConfigPublic);
        await flushPromises();
        expect(() => f.reads.read()).toThrow('preview-authorities-disposed');
        expect(api.preview).not.toHaveBeenCalled();
    });
});
