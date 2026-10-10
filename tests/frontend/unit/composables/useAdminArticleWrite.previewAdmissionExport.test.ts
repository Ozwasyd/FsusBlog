// @vitest-environment happy-dom

import { ElMarkdownEditor, type MarkdownEditorTransactionEvent } from '@ozwasyd/element-plus';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { defineComponent, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAdminArticleWrite } from '@/composables/useAdminArticleWrite';
import type { SeoConfigPublic } from '@/api/system';
import type { ArticleEditorContinuityPort } from '@/services/authoring/articleEditorContinuity';
import { ArticlePreviewSourceAdmission } from '@/services/authoring';
import { ArticlePreviewSourceAdmission as OriginalAdmission } from '@/services/authoring/articlePreviewSourceAdmission';
import { calculateOpenArticleDocumentDigest as digest } from '@/services/authoring/openArticleDocumentRegistry';
import type { ArticleDraftResponsibilitySource } from '@/view-contracts/articleDraftResponsibility';

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
    // The original authority retains a document across remounts. Each ordinary case owns a separate user scope.
    api.principalId = `preview-export-host-${++api.caseId}`;
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
    await vi.waitFor(() => expect(owner.pageLoading.value).toBe(false));
    return { wrapper, owner, reads: owner.privatePreviewCurrentAuthorities };
}

async function boundHost()
{
    const f = await host();
    let session: ReturnType<typeof f.owner.authoringEditorRuntime.bindEditor>;
    const editor = mount(ElMarkdownEditor, { props: { modelValue: f.owner.articleForm.content,
        mode: 'source', documentIdentity: f.owner.authoringDocumentIdentity.value,
        'onUpdate:modelValue': (value: string) => { f.owner.articleForm.content = value; },
        onTransaction: (event: MarkdownEditorTransactionEvent) => session?.binding.consumeTransaction(event) } });
    const commands = editor.vm as unknown as ArticleEditorContinuityPort;
    session = f.owner.authoringEditorRuntime.bindEditor(commands,
        { surface: 'source', configuration: { allowLatex: false, allowMermaid: false, baseUrl: null },
            identity: { themeDigest: digest({ ordinary: 'preview-current-host' }), locale: 'zh-CN' },
            cachePolicy: { maxEntryBytes: 65536, maxAgeMs: 60000, maxReceipts: 16 } });
    expect(session.binding.initialize()).toBe(true);
    expect(commands.dispatchTransaction({ changes: [{ from: 0, to: 0, insert: 'Actual host source' }],
        history: 'separate' }).accepted).toBe(true);
    expect(f.owner.articleForm.content).toBe('Actual host source');
    await nextTick();
    const editing: ArticleDraftResponsibilitySource = { inheritSiteAuthor: true, authors: [], reviewer: null,
        sources: [], updateSummary: null, updateReason: null, effectiveAt: null, conclusionImpact: null,
        responsiblePersonConfirmed: false };
    // Ordinary refusal port only. It never returns a fabricated asset projection or verification receipt.
    const business = { assess: vi.fn(async () => { throw new Error('ordinary-business-refusal'); }),
        verify: vi.fn().mockResolvedValue(false) };
    const release = session.bindPreviewOwners(business, () => ({ responsibility: editing, siteAuthor: 'Borrowed author' }));
    return { ...f, session, commands, editing, business, release };
}

describe('actual Writer shared preview admission export', () =>
{
    it('borrows the original public admission and the actual Writer unified preview lease', async () =>
    {
        const f = await boundHost();
        await f.reads.refresh(new AbortController().signal);
        expect(ArticlePreviewSourceAdmission).toBe(OriginalAdmission);
        const admission = ArticlePreviewSourceAdmission.attachRuntime(f.session.binding, () => f.reads.read());
        const earlier = f.session.binding.beginToolTask('publish-preview');
        const request = admission.begin();
        expect(earlier.signal.aborted).toBe(true);
        expect(request.context).toBe(f.owner.authoringDocumentContextAdapter.context);
        expect(request.signal.aborted).toBe(false);
        const compare = f.session.binding.beginToolTask('source-compare');
        expect(compare.isCurrent()).toBe(true);
        expect(request.signal.aborted).toBe(true);
        expect(admission.accept(request, 'late-preview')).toMatchObject({ accepted: false, value: null });
        expect(f.business.assess).not.toHaveBeenCalled();
        expect(f.business.verify).not.toHaveBeenCalled();
        expect(api.preview).not.toHaveBeenCalled();
        admission.dispose();
    });

    it('rejects a late preview after the public editor changes the actual source revision', async () =>
    {
        const f = await boundHost();
        await f.reads.refresh(new AbortController().signal);
        const admission = ArticlePreviewSourceAdmission.attachRuntime(f.session.binding, () => f.reads.read());
        const request = admission.begin();
        const revision = request.context.sourceRevision;
        const result = f.commands.dispatchTransaction({ changes: [{ from: 0, to: 0, insert: 'Later source\n' }], history: 'separate' });
        expect(result.accepted).toBe(true);
        await nextTick();
        expect(f.owner.authoringDocumentContextAdapter.context.sourceRevision).toBeGreaterThan(revision);
        expect(admission.accept(request, 'old-preview')).toMatchObject({ accepted: false, value: null });
        expect(api.preview).not.toHaveBeenCalled();
        expect(f.owner.articleForm.content).toBe('Later source\nActual host source');
        admission.dispose();
    });

    it('disposes only the preview consumer while the real Writer editor and owner remain current', async () =>
    {
        const f = await boundHost();
        await f.reads.refresh(new AbortController().signal);
        const admission = ArticlePreviewSourceAdmission.attachRuntime(f.session.binding, () => f.reads.read());
        const request = admission.begin();
        admission.dispose();
        expect(request.signal.aborted).toBe(true);
        expect(() => admission.begin()).toThrow('article-preview-source-disposed');
        expect(f.session.binding.context).toBe(f.owner.authoringDocumentContextAdapter.context);
        const compare = f.session.binding.beginToolTask('source-compare');
        expect(compare.isCurrent()).toBe(true);
        expect(f.commands.dispatchTransaction({ changes: [{ from: 0, to: 0, insert: 'Still owned\n' }], history: 'separate' }).accepted).toBe(true);
        expect(f.owner.articleForm.content).toBe('Still owned\nActual host source');
        expect(f.reads.state.currentResponsibilityTransport).toBe('unavailable');
        expect(f.business.assess).not.toHaveBeenCalled();
        expect(api.preview).not.toHaveBeenCalled();
    });
});
