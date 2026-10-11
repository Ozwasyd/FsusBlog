import { computed, onMounted, onUnmounted, reactive, ref, shallowRef, toRaw, useTemplateRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import {
    getAdminArticleById,
    createArticle,
    updateArticle,
    ArticlePublishStatus,
    type ArticleDetailResponse,
    type ArticleRightsRequest,
    type ArticleRightsResponse,
    type ArticleWriteRequest
} from '@/api/article';
import {
    checkArticlePrepublish,
    cleanupOrphanAssets,
    createArticlePreviewSourceIdentity,
    discardServerDraft,
    generateAiAssist,
    getArticleRevision,
    getServerDraft,
    listAssetLibrary,
    listArticleRevisions,
    previewArticleDraft,
    reindexArticleAssets,
    rollbackArticleRevision,
    saveServerDraft,
    type AiAssistResponse,
    type AssetLibraryItemResponse,
    type ArticlePreviewResponse,
    type ArticleRevisionDetailResponse,
    type ArticleRevisionSummaryResponse,
    type PrepublishIssue,
    type ServerDraftResponse,
    type ServerDraftSaveRequest
} from '@/api/authoring';
import { createCategory, getCategories, type CategoryItem } from '@/api/category';
import type { ApiRequestConfig } from '@/api/requestConfig';
import { getAdminSiteComplianceConfig, getAdminSiteConfig, type SeoConfigAdmin, type SiteComplianceConfigAdmin } from '@/api/system';
import { createTag, getTags, type TagItem } from '@/api/tag';
import { useArticlePreviewGeneration } from '@/composables/articlePreviewGeneration';
import { useAbortableTask } from '@/composables/useAbortableTask';
import { ensureAdminSensitiveProof } from '@/composables/useAdminSensitiveProof';
import { useAdminTaskFeedback } from '@/composables/useAdminTaskFeedback';
import { useImageUploadFlow } from '@/composables/useImageUploadFlow';
import { useImageUploadPreferences } from '@/composables/useImageUploadPreferences';
import { useImageUploadRuntime } from '@/composables/useImageUploadRuntime';
import { usePow } from '@/composables/usePow';
import { BinaryTransportError } from '@/composition/binaryTransport';
import { createMarkdownAnchorMap, type MarkdownEditorDispatchResult } from '@/fsusui/articlePositionMaps';
import { toast } from '@/fsusui/feedback';
import { isFsusUiOk } from '@/fsusui/result';
import {
    ArticleRecoveryCoordinator,
    ArticleRecoveryFlushOwner,
    articleRecoveryArticleKey,
    articleRecoveryJournal,
    articleRecoverySourceHash,
    assessArticleRecoveryDivergence,
    bindArticleRecoveryLifecycleFlush,
    createArticleRecoveryOperationRunner,
    createArticleRecoveryClientRevision,
    summarizeArticleRecoveryComparison,
    type ArticleRecoveryDivergence,
    type ArticleRecoveryFlushResult,
    type ArticleRecoveryJournalRecord,
    type ArticleRecoveryJournalWriteResult,
    type ArticleRecoveryOperationKind
} from '@/services/articleRecoveryJournal';
import { ArticlePreviewSourceAdmission, type ArticlePreviewSourceInput } from '@/services/authoring';
import { ArticleAnchorContextAdapter } from '@/services/authoring/articleAnchorContext';
import { createArticleAttachmentBusinessIntentReader } from '@/services/authoring/articleAttachmentBusinessIntentReader';
import { ArticleAttachmentContextAdapter, type ArticleAttachmentPendingHandle, type ArticleAttachmentTransactionPort, type ArticleAttachmentFilePort } from '@/services/authoring/articleAttachmentContext';
import { createArticleAttachmentUploadProvider, type AttachmentUploadObservation } from '@/services/authoring/articleAttachmentUploadProvider';
import {
    articleDocumentContextAuthority,
    type ArticleDocumentContextAdapter
} from '@/services/authoring/articleDocumentContext';
import type { ArticleEditorContinuityPort } from '@/services/authoring/articleEditorContinuity';
import { bindArticleEditorRuntime, type ArticleEditorRuntimeBinding, type ArticleEditorRuntimeBindingOptions } from '@/services/authoring/articleEditorRuntimeBinding';
import { ArticleEditorSearchRuntime } from '@/services/authoring/articleEditorSearchRuntime';
import { validateArticleEditorSurfacePreference, type ArticleEditorSurfacePreference } from '@/services/authoring/articleEditorSurface';
import { ArticleEditorSurfaceRuntime } from '@/services/authoring/articleEditorSurfaceRuntime';
import { ArticleLiveCapabilitySession } from '@/services/authoring/articleLiveCapability';
import type { ArticlePreviewAttachmentPort } from '@/services/authoring/articlePreviewAttachments';
import { createArticlePreviewCurrentAuthorities } from '@/services/authoring/articlePreviewCurrentAuthorities';
import { calculateOpenArticleDocumentDigest } from '@/services/authoring/openArticleDocumentRegistry';
import { purgeRetiredArticleDraftMetadata } from '@/services/privateStorageRegistry';
import { useAdminStore } from '@/store/admin';
import { showErrorToast, showWarningToast } from '@/utils/errorPresentation';
import { isAbortError } from '@/utils/errors';

import type { FormItemProp, FormValidateCallback, FormValidationResult } from '@ozwasyd/element-plus';

interface ArticleParams {
    title: string;
    content: string;
    summary: string;
    coverImageUrl: string;
    categoryId: number | undefined;
    tagIds: number[];
    status: ArticlePublishStatus;
    scheduledPublishAt: string;
    rights: ArticleRightsForm;
}

interface ArticleDraftSnapshot extends ArticleParams {
    savedAt: number;
    sourceArticleId: number | null;
    baseRevisionId: string | null;
    isEdit: boolean;
    source: 'local' | 'server';
    clientRevision: string;
    serverRevision: number | null;
    documentContextDigest: string;
}

/** Borrow original live business and attribution owners; this host produces no asset grants or responsibility data. */
type ArticleWriterPreviewOwners = Readonly<{
    binding: ArticleEditorRuntimeBinding;
    business: ArticlePreviewAttachmentPort;
    readAttribution: () => Pick<ArticlePreviewSourceInput, 'responsibility' | 'siteAuthor'>;
}>;

export interface ArticleRevisionConflictMetadata {
    currentRevisionId: string;
    revisionNo: number;
    status: number;
    updatedAt: string;
}

export const parseArticleRevisionConflictDetails = (details?: string | null): ArticleRevisionConflictMetadata | null =>
{
    if (!details)
    {
        return null;
    }

    try
    {
        const value = JSON.parse(details) as Partial<ArticleRevisionConflictMetadata>;
        if (typeof value.currentRevisionId !== 'string'
      || !/^\d+$/.test(value.currentRevisionId)
      || !Number.isInteger(value.revisionNo)
      || !Number.isInteger(value.status)
      || typeof value.updatedAt !== 'string')
        {
            return null;
        }
        return value as ArticleRevisionConflictMetadata;
    }
    catch
    {
        return null;
    }
};

export interface ServerDraftConflictMetadata {
    currentServerRevision: number | null;
    currentUpdatedAt: string | null;
    titleSummary: string | null;
}

export const parseServerDraftConflictDetails = (details?: string | null): ServerDraftConflictMetadata | null =>
{
    if (!details)
    {
        return null;
    }

    try
    {
        const value = JSON.parse(details) as Partial<ServerDraftConflictMetadata>;
        if (value.currentServerRevision !== null
      && (!Number.isSafeInteger(value.currentServerRevision) || Number(value.currentServerRevision) < 1))
        {
            return null;
        }
        if (value.currentUpdatedAt !== null && typeof value.currentUpdatedAt !== 'string')
        {
            return null;
        }
        if (value.titleSummary !== null && typeof value.titleSummary !== 'string')
        {
            return null;
        }
        return {
            currentServerRevision: value.currentServerRevision ?? null,
            currentUpdatedAt: value.currentUpdatedAt ?? null,
            titleSummary: value.titleSummary ?? null
        };
    }
    catch
    {
        return null;
    }
};

export const shouldRetryServerDraftSave = (error: unknown): boolean =>
    !(error instanceof BinaryTransportError && error.message === 'draft_conflict');

interface ArticleRecoveryCandidateView {
    id: string;
    label: string;
    detail: string;
    excerpt: string;
    divergence: ArticleRecoveryDivergence;
}

interface ArticleSeoPreviewState {
    title: string;
    description: string;
    canonicalUrl: string;
    slug: string;
    ogImage: string;
    titleLength: number;
    descriptionLength: number;
    canonicalValid: boolean;
}

interface ArticleRightsForm {
    mode: 'site' | 'custom';
    enabled: boolean;
    licenseType: string;
    copyrightHolder: string;
    copyrightYear: number | null;
    rightsStatement: string;
    attributionTemplate: string;
    copyPolicy: string;
    maxExcerptChars: number;
    allowCodeCopy: boolean;
    showPublicBadge: boolean;
    proofBindingEnabled: boolean;
}

const CREATE_DRAFT_KEY = 'fsus:article-draft:create';
const EDIT_DRAFT_PREFIX = 'fsus:article-draft:edit:';
const DRAFT_SAVE_DELAY_MS = 700;
const ARTICLE_RECOVERY_FLUSH_INTERVAL_MS = 2_000;
const ARTICLE_RIGHTS_LICENSE_TYPES = [
    'all-rights-reserved',
    'CC-BY-4.0',
    'CC-BY-SA-4.0',
    'CC-BY-NC-4.0',
    'CC0-1.0'
] as const;
const ARTICLE_RIGHTS_COPY_POLICIES = [
    'append-attribution',
    'excerpt-only',
    'disabled'
] as const;
const ARTICLE_RIGHTS_EXCERPT_MAX = 10_000;

const articleRightsLicenseOptions = [
    { label: '保留所有权利', value: 'all-rights-reserved' },
    { label: 'CC BY 4.0', value: 'CC-BY-4.0' },
    { label: 'CC BY-SA 4.0', value: 'CC-BY-SA-4.0' },
    { label: 'CC BY-NC 4.0', value: 'CC-BY-NC-4.0' },
    { label: 'CC0 1.0', value: 'CC0-1.0' }
] as const;

const articleRightsCopyPolicyOptions = [
    { label: '复制时追加署名', value: 'append-attribution' },
    { label: '仅允许摘录复制', value: 'excerpt-only' },
    { label: '禁用复制增强', value: 'disabled' }
] as const;

const resolveLicenseTypeFromCompliance = (compliance: SiteComplianceConfigAdmin | null): string =>
{
    const licenseText = `${compliance?.contentLicenseName ?? ''} ${compliance?.contentLicenseUrl ?? ''}`.toLowerCase();
    if (licenseText.includes('cc0'))
    {
        return 'CC0-1.0';
    }
    if (licenseText.includes('by-sa'))
    {
        return 'CC-BY-SA-4.0';
    }
    if (licenseText.includes('by-nc'))
    {
        return 'CC-BY-NC-4.0';
    }
    if (licenseText.includes('cc-by') || licenseText.includes('/by/'))
    {
        return 'CC-BY-4.0';
    }
    return 'all-rights-reserved';
};

const normalizeArticlePublishStatus = (value: unknown): ArticlePublishStatus =>
{
    const status = Number(value);
    return status === ArticlePublishStatus.Draft
    || status === ArticlePublishStatus.Scheduled
    || status === ArticlePublishStatus.Published
    || status === ArticlePublishStatus.Archived
    || status === ArticlePublishStatus.Deleted
        ? status
        : ArticlePublishStatus.Published;
};

const createDefaultArticleRightsForm = (mode: ArticleRightsForm['mode'] = 'site'): ArticleRightsForm => ({
    mode,
    enabled: true,
    licenseType: 'all-rights-reserved',
    copyrightHolder: '',
    copyrightYear: null,
    rightsStatement: '',
    attributionTemplate: '',
    copyPolicy: 'append-attribution',
    maxExcerptChars: 300,
    allowCodeCopy: true,
    showPublicBadge: true,
    proofBindingEnabled: true
});

const normalizeOptionalRightsText = (value: unknown): string => typeof value === 'string' ? value : '';

const firstNonEmptyText = (...values: readonly (string | null | undefined)[]): string =>
{
    for (const value of values)
    {
        if (typeof value === 'string' && value.length > 0)
        {
            return value;
        }
    }
    return '';
};

const nonEmptyTextOrNull = (value: string | null | undefined): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;

const normalizeNullableRightsYear = (value: unknown): number | null =>
{
    if (value === null || value === undefined || value === '')
    {
        return null;
    }

    const year = Number(value);
    return Number.isInteger(year) ? year : null;
};

const normalizeArticleRightsForm = (value: unknown): ArticleRightsForm =>
{
    const defaults = createDefaultArticleRightsForm();
    if (typeof value !== 'object' || value === null)
    {
        return defaults;
    }

    const raw = value as Partial<ArticleRightsForm & ArticleRightsRequest & ArticleRightsResponse>;
    const maxExcerptChars = typeof raw.maxExcerptChars === 'number' && Number.isFinite(raw.maxExcerptChars)
        ? Math.trunc(raw.maxExcerptChars)
        : defaults.maxExcerptChars;

    return {
        mode: raw.mode === 'custom' ? 'custom' : raw.mode === 'site' ? 'site' : defaults.mode,
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : defaults.enabled,
        licenseType: firstNonEmptyText(normalizeOptionalRightsText(raw.licenseType), defaults.licenseType),
        copyrightHolder: normalizeOptionalRightsText(raw.copyrightHolder),
        copyrightYear: normalizeNullableRightsYear(raw.copyrightYear),
        rightsStatement: normalizeOptionalRightsText(raw.rightsStatement),
        attributionTemplate: normalizeOptionalRightsText(raw.attributionTemplate),
        copyPolicy: firstNonEmptyText(normalizeOptionalRightsText(raw.copyPolicy), defaults.copyPolicy),
        maxExcerptChars,
        allowCodeCopy: typeof raw.allowCodeCopy === 'boolean' ? raw.allowCodeCopy : defaults.allowCodeCopy,
        showPublicBadge: typeof raw.showPublicBadge === 'boolean' ? raw.showPublicBadge : defaults.showPublicBadge,
        proofBindingEnabled: typeof raw.proofBindingEnabled === 'boolean' ? raw.proofBindingEnabled : defaults.proofBindingEnabled
    };
};

const hasNonDefaultArticleRights = (rights: ArticleRightsForm): boolean =>
{
    if (rights.mode === 'site')
    {
        return false;
    }

    const defaults = createDefaultArticleRightsForm('custom');
    return Object.keys(defaults).some((key) => rights[key as keyof ArticleRightsForm] !== defaults[key as keyof ArticleRightsForm]);
};

const areArticleRightsSame = (left: ArticleRightsForm, right: ArticleRightsForm): boolean =>
    left.mode === right.mode
  && left.enabled === right.enabled
  && left.licenseType === right.licenseType
  && left.copyrightHolder === right.copyrightHolder
  && left.copyrightYear === right.copyrightYear
  && left.rightsStatement === right.rightsStatement
  && left.attributionTemplate === right.attributionTemplate
  && left.copyPolicy === right.copyPolicy
  && left.maxExcerptChars === right.maxExcerptChars
  && left.allowCodeCopy === right.allowCodeCopy
  && left.showPublicBadge === right.showPublicBadge
  && left.proofBindingEnabled === right.proofBindingEnabled;

const normalizeDateTimeInput = (value: string | null | undefined): string =>
{
    if (!value)
    {
        return '';
    }

    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed))
    {
        return '';
    }

    const local = new Date(parsed);
    const pad = (part: number): string => String(part).padStart(2, '0');
    return `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}T${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`;
};

const buildSubmitSuccessMessage = (isEdit: boolean, status: ArticlePublishStatus): string =>
{
    if (status === ArticlePublishStatus.Draft)
    {
        return isEdit ? '草稿已更新' : '草稿已保存';
    }
    if (status === ArticlePublishStatus.Scheduled)
    {
        return isEdit ? '定时发布已更新' : '定时发布已创建';
    }
    if (status === ArticlePublishStatus.Archived)
    {
        return isEdit ? '文章已归档' : '文章已保存为归档';
    }
    return isEdit ? '博文已成功修订' : '博文已上线发布';
};

const hasDraftContent = (draft: Pick<ArticleParams, 'title' | 'content' | 'summary' | 'categoryId' | 'tagIds' | 'rights'>): boolean =>
    draft.title.trim().length > 0
  || draft.content.trim().length > 0
  || draft.summary.trim().length > 0
  || draft.categoryId !== undefined
  || draft.tagIds.length > 0
  || hasNonDefaultArticleRights(draft.rights);

const stripMarkdownForSeo = (content: string, maxLength = 180): string => content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
    .replace(/\[[^\]]+]\([^)]+\)/g, (match) => match.slice(1, match.indexOf(']')))
    .replace(/[#>*_`~|\-[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);

const normalizeSeoBaseUrl = (value: string): string | null =>
{
    const candidate = value.trim();
    if (!candidate)
    {
        return null;
    }
    try
    {
        const url = new URL(candidate);
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
        {
            return null;
        }

        url.pathname = url.pathname.replace(/\/+$/u, '');
        url.search = '';
        url.hash = '';
        return url.toString().replace(/\/$/u, '');
    }
    catch
    {
        return null;
    }
};

const slugifyTitle = (title: string): string =>
{
    const slug = title
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
    return firstNonEmptyText(slug, 'draft-preview');
};

export function useAdminArticleWrite()
{
    const route = useRoute();
    const router = useRouter();
    const powProvider = usePow();
    const adminStore = useAdminStore();
    const formRef = useTemplateRef<{
        validate: (callback?: FormValidateCallback) => FormValidationResult;
        scrollToField: (prop: FormItemProp) => void;
    }>('formRef');
    const articleId = computed(() =>
    {
        const raw = route.params.id ?? route.query.id;
        const parsed = Number(raw);
        return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    });

    const pageLoading = ref(false);
    const submitting = ref(false);
    const categories = shallowRef<CategoryItem[]>([]);
    const tags = shallowRef<TagItem[]>([]);
    const siteConfig = ref<SeoConfigAdmin | null>(null);
    const siteComplianceConfig = ref<SiteComplianceConfigAdmin | null>(null);
    const mountedBrowserSeoBaseUrl = ref('');
    const assetLibrary = shallowRef<AssetLibraryItemResponse[]>([]);
    const assetLibraryLoading = ref(false);
    const assetLibraryStatusText = ref('资产库等待同步');
    const draftStatusText = ref('');
    const pendingDraft = ref<ArticleDraftSnapshot | null>(null);
    const draftSavedAt = ref<number | null>(null);
    const draftConflictText = ref('');
    const articleRecoveryCandidates = shallowRef<readonly ArticleRecoveryJournalRecord[]>([]);
    const selectedArticleRecoveryId = ref('');
    const articleRecoveryStorageWarning = ref('');
    const articleRecoveryComparison = ref('');
    const comparedArticleRecoveryId = ref('');
    const articleRecoveryOperationKind = ref<ArticleRecoveryOperationKind | null>(null);
    const articleRecoveryOperationError = ref('');
    const currentRevisionId = ref<string | null>(null);
    const currentRevisionNo = ref<number | null>(null);
    const serverDraftRevision = ref<number | null>(null);
    const serverDraftSyncPaused = ref(false);
    const articleRevisions = shallowRef<ArticleRevisionSummaryResponse[]>([]);
    const selectedRevision = ref<ArticleRevisionDetailResponse | null>(null);
    const revisionLoading = ref(false);
    const revisionRollbacking = ref(false);
    const revisionStatusText = ref('');
    const privatePreview = ref<ArticlePreviewResponse | null>(null);
    const privatePreviewLoading = ref(false);
    const privatePreviewStatusText = ref('预览仅在作者工作台内生成');
    const previewOwners = shallowRef<ArticleWriterPreviewOwners | null>(null);
    const seoIssues = ref<PrepublishIssue[]>([]);
    const seoChecking = ref(false);
    const seoStatusText = ref('发布前检查随表单实时更新');
    const aiAssist = shallowRef<AiAssistResponse | null>(null);
    const aiAssistLoading = ref(false);
    const aiAssistStatusText = ref('');
    const prepublishWarningOverrideReason = ref('');
    const quickCreatingCategory = ref(false);
    const quickCreatingTag = ref(false);
    const {
        options: imageUploadOptions,
        wasmOnlyMode,
        setOptions: setImageUploadOptions,
        setWasmOnlyMode: setImageUploadWasmOnlyMode
    } = useImageUploadPreferences();
    const imageUploadRuntime = useImageUploadRuntime();

    const isEdit = computed(() => articleId.value !== null);
    const articleForm = reactive<ArticleParams>({
        title: '',
        content: '',
        summary: '',
        coverImageUrl: '',
        categoryId: undefined,
        tagIds: [],
        status: ArticlePublishStatus.Published,
        scheduledPublishAt: '',
        rights: createDefaultArticleRightsForm()
    });
    const siteInheritedRights = computed<ArticleRightsForm>(() =>
    {
        const compliance = siteComplianceConfig.value;
        return {
            ...createDefaultArticleRightsForm('site'),
            copyrightHolder: firstNonEmptyText(
                compliance?.copyrightOwner?.trim(),
                siteConfig.value?.title?.trim()
            ),
            copyrightYear: compliance?.copyrightStartYear ?? null,
            rightsStatement: firstNonEmptyText(compliance?.copyrightText?.trim()),
            attributionTemplate: firstNonEmptyText(compliance?.contentLicenseName?.trim()),
            licenseType: resolveLicenseTypeFromCompliance(compliance)
        };
    });
    const articleRightsUsingSiteDefaults = computed(() => articleForm.rights.mode === 'site');
    const articleRightsInheritanceText = computed(() =>
    {
        const inherited = siteInheritedRights.value;
        const holder = firstNonEmptyText(inherited.copyrightHolder, '未设置版权主体');
        const year = inherited.copyrightYear ? `${inherited.copyrightYear} 年起` : '按站点年份';
        const statement = firstNonEmptyText(inherited.rightsStatement, '保留所有权利。');
        return articleRightsUsingSiteDefaults.value
            ? `当前继承：${holder}，${year}，${statement}`
            : `自定义本文版权；可从站点默认值继续调整。`;
    });
    const submitButtonText = computed(() =>
    {
        if (articleForm.status === ArticlePublishStatus.Draft)
        {
            return '保存草稿';
        }
        if (articleForm.status === ArticlePublishStatus.Scheduled)
        {
            return '定时发布';
        }
        if (articleForm.status === ArticlePublishStatus.Archived)
        {
            return '保存为归档';
        }
        return isEdit.value ? '更新文章' : '发布文章';
    });
    const submitConfirmContent = computed(() =>
    {
        if (articleForm.status === ArticlePublishStatus.Draft)
        {
            return '保存后文章保持草稿状态，不会出现在公开阅读页。';
        }
        if (articleForm.status === ArticlePublishStatus.Scheduled)
        {
            return '到达所选时间后文章会自动公开，提交前请检查时间与 SEO 摘要。';
        }
        if (articleForm.status === ArticlePublishStatus.Archived)
        {
            return '保存后文章进入归档隐藏状态，不会出现在公开阅读页。';
        }
        return isEdit.value ? '更新后会生成新的文章版本并刷新公开缓存。' : '发布后文章会进入公开阅读页并同步搜索索引。';
    });
    const draftKey = computed(() => (isEdit.value && articleId.value !== null ? `${EDIT_DRAFT_PREFIX}${articleId.value}` : CREATE_DRAFT_KEY));
    const selectedArticleRecovery = computed(() =>
        articleRecoveryCandidates.value.find(candidate => candidate.id === selectedArticleRecoveryId.value)
    ?? articleRecoveryCandidates.value[0]
    ?? null);
    const selectedArticleRecoveryDivergence = computed<ArticleRecoveryDivergence>(() =>
    {
        const selected = selectedArticleRecovery.value;
        return selected
            ? assessArticleRecoveryDivergence(selected, {
          currentRevisionId: currentRevisionId.value,
          serverRevision: serverDraftRevision.value
        })
            : 'none';
    });
    const articleRecoveryCandidateViews = computed<ArticleRecoveryCandidateView[]>(() =>
        articleRecoveryCandidates.value.map((candidate, index) =>
        {
            const divergence = assessArticleRecoveryDivergence(candidate, {
                currentRevisionId: currentRevisionId.value,
                serverRevision: serverDraftRevision.value
            });
            const divergenceText = divergence === 'newer-current-revision'
                ? '当前文章已有较新修订'
                : divergence === 'newer-server-draft'
          ? '服务端草稿已更新'
          : '可直接恢复后继续自动保存';
            const excerpt = candidate.content
                .replace(/\s+/gu, ' ')
                .trim()
                .slice(0, 120);
            return {
                id: candidate.id,
                label: `标签页版本 ${index + 1} · ${new Date(candidate.updatedAt).toLocaleString()}`,
                detail: `${candidate.content.length.toLocaleString()} 字 · ${divergenceText}`,
                excerpt: firstNonEmptyText(excerpt, '（正文为空；此版本记录了删除后的未同步状态）'),
                divergence
            };
        }));
    const hasArticleRecoveryCandidates = computed(() => articleRecoveryCandidates.value.length > 0);
    const hasLocalDraft = computed(() => pendingDraft.value !== null || hasArticleRecoveryCandidates.value);
    const pendingDraftSourceLabel = computed(() =>
    {
        if (hasArticleRecoveryCandidates.value)
        {
            return articleRecoveryCandidates.value.length > 1
                ? `${articleRecoveryCandidates.value.length} 个标签页的未同步正文`
                : '未同步正文';
        }
        return '服务端草稿';
    });
    const pendingDraftDescription = computed(() =>
    {
        if (hasArticleRecoveryCandidates.value)
        {
            const selected = selectedArticleRecovery.value;
            if (!selected)
            {
                return '';
            }
            const divergence = assessArticleRecoveryDivergence(selected, {
                currentRevisionId: currentRevisionId.value,
                serverRevision: serverDraftRevision.value
            });
            if (divergence === 'newer-current-revision')
            {
                return '当前文章已有较新修订。请先比较再明确选择；恢复只替换当前表单正文，并继续现有 revision conflict 流程。';
            }
            if (divergence === 'newer-server-draft')
            {
                return '服务端已有较新的草稿。请先比较再明确选择；不会自动覆盖服务端版本。';
            }
            if (articleRecoveryCandidates.value.length > 1)
            {
                return '不同标签页各自保留版本，没有 last-write-wins。请选择一个版本恢复或逐个丢弃。';
            }
            return '此正文尚未得到服务端确认。恢复只替换当前表单正文，随后继续现有自动保存。';
        }
        if (draftConflictText.value)
        {
            return draftConflictText.value;
        }

        return '恢复会覆盖当前表单，丢弃会删除服务端草稿与浏览器中的保存记录。';
    });
    const draftRestoreButtonText = computed(() =>
    hasArticleRecoveryCandidates.value ? '恢复所选正文' : '恢复服务端草稿');
    const draftDiscardButtonText = computed(() =>
    hasArticleRecoveryCandidates.value ? '丢弃所选正文' : '丢弃服务端草稿');
    const articleRecoveryOperationPending = computed(() => articleRecoveryOperationKind.value !== null);
    const articleRecoveryOperationStatusText = computed(() =>
    {
        switch (articleRecoveryOperationKind.value)
        {
            case 'compare':
                return '正在比较所选正文';
            case 'recover':
                return '正在恢复所选正文';
            case 'discard':
                return '正在丢弃所选正文';
            default:
                return '';
        }
    });
    const articleRecoveryComparisonRequired = computed(() => (
        selectedArticleRecovery.value !== null
    && selectedArticleRecoveryDivergence.value !== 'none'
    && comparedArticleRecoveryId.value !== selectedArticleRecovery.value.id
    ));
    const recoveryAwareDraftStatusText = computed(() =>
        [draftStatusText.value.trim(), articleRecoveryStorageWarning.value.trim()].filter(Boolean).join('；'));
    const requiresLeaveConfirm = computed(() => hasDraftContent(articleForm) || hasLocalDraft.value);
    const selectedRevisionLabel = computed(() => selectedRevision.value ? `版本 ${selectedRevision.value.revisionNo}` : '未选择历史版本');
    const canGeneratePrivatePreview = computed(() => previewOwners.value !== null
        && (articleForm.title.trim().length > 0 || articleForm.content.trim().length > 0));
    const seoPreview = computed<ArticleSeoPreviewState>(() =>
    {
        const baseUrl = normalizeSeoBaseUrl(firstNonEmptyText(
            siteConfig.value?.baseUrl,
            mountedBrowserSeoBaseUrl.value
        ));
        const routePath = articleId.value ? `/article/${articleId.value}` : `/article/${slugifyTitle(articleForm.title)}`;
        const title = firstNonEmptyText(articleForm.title.trim(), '未命名文章');
        const description = firstNonEmptyText(
            articleForm.summary.trim(),
            stripMarkdownForSeo(articleForm.content),
            siteConfig.value?.description
        ).slice(0, 220);
        const ogImage = firstNonEmptyText(
            articleForm.coverImageUrl.trim(),
            siteConfig.value?.ogImage?.trim()
        );
        return {
            title: siteConfig.value?.title ? `${title} | ${siteConfig.value.title}` : title,
            description,
            canonicalUrl: baseUrl ? `${baseUrl}${routePath}` : routePath,
            slug: routePath,
            ogImage,
            titleLength: title.length,
            descriptionLength: description.length,
            canonicalValid: baseUrl !== null
        };
    });
    const revisionCompareText = computed(() =>
    {
        const revision = selectedRevision.value;
        if (!revision)
        {
            return '选择一个历史版本后，可查看它与当前表单的差异摘要。';
        }

        const changes: string[] = [];
        if (revision.title !== articleForm.title)
        {
            changes.push('标题不同');
        }
        if ((revision.summary ?? '') !== articleForm.summary)
        {
            changes.push('摘要不同');
        }
        if ((revision.coverImageUrl ?? '') !== articleForm.coverImageUrl)
        {
            changes.push('头图不同');
        }
        if (revision.categoryId !== (articleForm.categoryId ?? 0))
        {
            changes.push('分类不同');
        }
        if (revision.tagIds.join(',') !== articleForm.tagIds.join(','))
        {
            changes.push('标签不同');
        }
        if (revision.content !== articleForm.content)
        {
            const delta = revision.content.length - articleForm.content.length;
            changes.push(`正文长度 ${delta >= 0 ? '+' : ''}${delta}`);
        }

        return changes.length > 0 ? changes.join('，') : '当前表单与该历史版本一致。';
    });

    const rules = {
        title: [{ required: true, message: '博文标题是必填项', trigger: 'blur' }],
        content: [
            { required: true, message: '请键入正文内容', trigger: 'blur' },
            { max: 200000, message: '内容长度超出系统限制 (200KB)', trigger: 'blur' }
        ],
        categoryId: [{ required: true, message: '请为文章指定一个分类', trigger: 'change' }]
    };

    const taskFeedback = useAdminTaskFeedback();
    const buildSignalConfig = (signal: AbortSignal): ApiRequestConfig => ({ signal });

    let draftSaveTimer: ReturnType<typeof window.setTimeout> | null = null;
    let serverDraftRetryTimer: ReturnType<typeof window.setTimeout> | null = null;
    let suppressDraftSave = true;
    let serverDraftSaveToken = 0;
    let draftSaveInFlightIdentity: string | null = null;
    let acceptedPrepublishIdentity: string | null = null;
    let active = true;
    let activeRecoveryClientRevision: string | null = null;
    let authoritativeArticleSourceHash: string | null = null;
    let authoritativeServerDraftSourceHash: string | null = null;
    let authoritativeArticleContent = '';
    let authoritativeServerDraftContent: string | null = null;
    let articleRecoveryRefreshToken = 0;
    let initInvocation = 0;
    const recoveryCoordinator = new ArticleRecoveryCoordinator({
        BroadcastChannel: typeof window === 'undefined'
            ? null
            : (window as Window & { BroadcastChannel?: typeof BroadcastChannel; }).BroadcastChannel ?? null
    });
    // Canonical author endpoints resolve the primary site; a browser host is not its authority.
    const documentSiteScope = 'primary-site';
    const documentUserScope = `user:${adminStore.adminPrincipal?.id?.trim() ?? 'unknown'}`
        .replace(/[^a-zA-Z0-9._:-]/gu, '-');
    const articleDocumentContextBinding = articleDocumentContextAuthority.acquire({
        articleId: articleId.value,
        siteScope: documentSiteScope,
        userScope: documentUserScope,
        content: articleForm.content
    });
    const articleDocumentContextAdapter: ArticleDocumentContextAdapter =
        articleDocumentContextBinding.adapter;
    const authoringDocumentContext = shallowRef(articleDocumentContextAdapter.context);
    const syncAuthoringDocumentContext = (): void =>
    {
        authoringDocumentContext.value = articleDocumentContextAdapter.context;
    };
    const authoringDocumentIdentity = computed(() => Object.freeze({
        id: authoringDocumentContext.value.documentId,
        epoch: authoringDocumentContext.value.documentEpoch
    }));
    // Every authoring consumer shares the existing canonical document binding.
    const authoringAnchors = new ArticleAnchorContextAdapter(articleDocumentContextAdapter);
    const authoringAttachments = new ArticleAttachmentContextAdapter(articleDocumentContextAdapter,
        'article-assets', 'article-assets:v1', authoringAnchors);
    let attachmentEditor: Pick<ArticleAttachmentTransactionPort, 'dispatch'> & Partial<ArticleAttachmentFilePort> | null = null;
    const attachmentPort: ArticleAttachmentTransactionPort & ArticleAttachmentFilePort = {
        withAttachmentFile: (batch, item, consume) => active && !!attachmentEditor
            && attachmentEditor.withAttachmentFile?.(batch, item, consume) === true,
        dispatch: transaction =>
        {
            if (!active || !attachmentEditor)
            {
                throw new Error('article-attachment-editor-unbound');
            }
            return attachmentEditor.dispatch(transaction);
        },
        commitSource: result =>
        {
            const current = articleDocumentContextAdapter.context;
            if (!active || !result.accepted || result.documentIdentity.id !== current.documentId
                || result.documentIdentity.epoch !== current.documentEpoch
                || (result.beforeRevision !== current.sourceRevision && result.revision !== current.sourceRevision))
            {
                throw new Error('article-attachment-source-commit-invalid');
            }
            // Commit the public revision first; the synchronous source watch is then idempotent.
            if (result.revision > current.sourceRevision)
            {
                articleDocumentContextAdapter.updateSource(result.value, result.revision);
            }
            else if (articleForm.content !== result.value)
            {
                throw new Error('article-attachment-source-commit-invalid');
            }
            articleForm.content = result.value;
            syncAuthoringDocumentContext();
        },
        binding: () => ({ document: articleDocumentContextAdapter.context,
            map: createMarkdownAnchorMap({ identity: articleDocumentContextAdapter.documentIdentity,
                source: articleForm.content }) })
    };
    // Only the caller-held original handle and this invocation's loan survive an await.
    let attachmentUploadAttempt: { handle: ArticleAttachmentPendingHandle; file: File; } | null = null;
    type UploadAttemptObservation = Readonly<{ status: 'observing' | 'settled' | 'interrupted';
        observation: AttachmentUploadObservation | null; reason: string | null; }>;
    // One consumption per genuine handle, without retaining the File or session credentials.
    const consumedAttachmentUploads = new WeakMap<ArticleAttachmentPendingHandle, UploadAttemptObservation>();
    const attachmentUploadObligations = new Map<ArticleAttachmentPendingHandle, UploadAttemptObservation>();
    const assertUploadObligationAbsent = (handle?: ArticleAttachmentPendingHandle): void =>
    {
        if (handle ? attachmentUploadObligations.has(handle) : attachmentUploadObligations.size > 0)
        {
            throw new Error('article-attachment-upload-recovery-required');
        }
    };
    const authoringAttachmentRuntime = Object.freeze({
        readUploadObservation: (handle: ArticleAttachmentPendingHandle) => consumedAttachmentUploads.get(handle) ?? null,
        get uploadObligations()
        {
            return Object.freeze(Array.from(attachmentUploadObligations, ([handle, observation]) =>
                Object.freeze({ handle, ...observation })));
        },
        observeUpload: (handle: ArticleAttachmentPendingHandle, file: File, signal?: AbortSignal) =>
            observeOwnedImageUpload(handle, file, signal),
        captureAnchor: (selection: Parameters<ArticleAnchorContextAdapter['capture']>[1],
            options: Parameters<ArticleAnchorContextAdapter['capture']>[2]) => authoringAnchors.capture(attachmentPort.binding(), selection, options),
        capture: (input: Omit<Parameters<ArticleAttachmentContextAdapter['capture']>[0], 'source'>) =>
            authoringAttachments.capture({ ...input, source: articleForm.content }),
        admitAcceptedCapture: (input: Parameters<ArticleAttachmentContextAdapter['admitAcceptedCapture']>[0]) =>
            authoringAttachments.admitAcceptedCapture(input, attachmentPort),
        commitCreated: (capture: Parameters<ArticleAttachmentContextAdapter['commitCreated']>[0]) =>
            authoringAttachments.commitCreated(capture, attachmentPort),
        complete: (handle: Parameters<ArticleAttachmentContextAdapter['complete']>[0], result: Parameters<ArticleAttachmentContextAdapter['complete']>[1]) =>
        {
            assertUploadObligationAbsent(handle);
            return authoringAttachments.complete(handle, result, attachmentPort);
        },
        remove: (handle: Parameters<ArticleAttachmentContextAdapter['remove']>[0]) => authoringAttachments.remove(handle, attachmentPort),
        replace: (handle: Parameters<ArticleAttachmentContextAdapter['replace']>[0], file: Parameters<ArticleAttachmentContextAdapter['replace']>[1]) =>
        {
            assertUploadObligationAbsent(handle);
            return authoringAttachments.replace(handle, file, attachmentPort);
        },
        retry: (handle: Parameters<ArticleAttachmentContextAdapter['retry']>[0]) =>
        {
            assertUploadObligationAbsent(handle);
            return authoringAttachments.retry(handle);
        },
        readOwnedIntent: (handle: Parameters<ArticleAttachmentContextAdapter['readOwnedIntent']>[0]) =>
            authoringAttachments.readOwnedIntent(handle, attachmentPort.binding()),
        // Borrow one actual caller-held capability; the original adapter validates membership.
        bindBusinessIntent: (handle: Parameters<ArticleAttachmentContextAdapter['readOwnedIntent']>[0]) =>
            createArticleAttachmentBusinessIntentReader({ attachments: authoringAttachments,
                handle: intentRef => handle.snapshot.intent.task.taskRef === intentRef ? handle : null,
                binding: () => attachmentPort.binding() }),
        consumeTransaction: (result: MarkdownEditorDispatchResult) => authoringAttachments.consumeTransaction(result, attachmentPort),
        get receipts()
        {
            return authoringAttachments.lifecycleReceipts;
        },
        bindEditor: (editor: Pick<ArticleAttachmentTransactionPort, 'dispatch'> & Partial<ArticleAttachmentFilePort>) =>
        {
            if (!active || attachmentEditor)
            {
                throw new Error('article-attachment-editor-binding-invalid');
            }
            attachmentEditor = editor;
            return () =>
            {
                if (attachmentEditor !== editor)
                {
                    return;
                }
                attachmentEditor = null;
                authoringAttachments.cancelPending('article-attachment-editor-release');
            };
        }
    });
    let editorRuntimeBinding: ArticleEditorRuntimeBinding | null = null;
    let releaseEditorRuntime: (() => void) | null = null;
    const authoringEditorRuntime = Object.freeze({
        bindEditor: (editor: ArticleEditorContinuityPort & Partial<ArticleAttachmentFilePort>, options: ArticleEditorRuntimeBindingOptions) =>
        {
            if (!active || editorRuntimeBinding)
            {
                throw new Error('article-editor-runtime-already-bound');
            }
            const releaseAttachmentEditor = authoringAttachmentRuntime.bindEditor({ dispatch: transaction => editor.dispatchTransaction(transaction),
                withAttachmentFile: (batch, item, consume) => editor.withAttachmentFile?.(batch, item, consume) === true });
            let binding: ArticleEditorRuntimeBinding;
            try
            {
                binding = bindArticleEditorRuntime(articleDocumentContextAdapter, authoringAnchors, authoringAttachments,
                    attachmentPort, () => articleForm.content, editor, options);
            }
            catch (error)
            {
                releaseAttachmentEditor();
                throw error;
            }
            let searchRuntime: ArticleEditorSearchRuntime;
            try
            {
                searchRuntime = new ArticleEditorSearchRuntime(articleDocumentContextAdapter, binding);
            }
            catch (error)
            {
                binding.dispose();
                releaseAttachmentEditor();
                throw error;
            }
            editorRuntimeBinding = binding;
            let surfaceRuntime: ArticleEditorSurfaceRuntime | null = null;
            const release = (): void =>
            {
                if (editorRuntimeBinding !== binding)
                {
                    return;
                }
                editorRuntimeBinding = null;
                releaseEditorRuntime = null;
                if (previewOwners.value?.binding === binding)
                {
                    previewOwners.value = null;
                    previewTask.cancel();
                    previewCurrentAuthorities.cancel();
                }
                searchRuntime.dispose();
                surfaceRuntime?.dispose();
                surfaceRuntime = null;
                binding.dispose();
                releaseAttachmentEditor();
            };
            releaseEditorRuntime = release;
            const bindSurfacePreference = (readPreference: () => ArticleEditorSurfacePreference | null): ArticleEditorSurfaceRuntime =>
            {
                if (!active || editorRuntimeBinding !== binding || surfaceRuntime || typeof readPreference !== 'function')
                {
                    throw new Error('article-editor-surface-binding-invalid');
                }
                const readCurrentPreference = (): ArticleEditorSurfacePreference =>
                {
                    const preference = readPreference();
                    const context = binding.context;
                    if (!articleDocumentContextAdapter.isCurrentContext(context) || !validateArticleEditorSurfacePreference(preference)
                        || preference.siteScope !== context.siteScope || preference.userScope !== context.userScope)
                    {
                        throw new Error('article-editor-surface-preference-unavailable');
                    }
                    return preference;
                };
                // No guessed preference: admission requires a real current owner snapshot before construction.
                readCurrentPreference();
                surfaceRuntime = new ArticleEditorSurfaceRuntime(articleDocumentContextAdapter, binding,
                    new ArticleLiveCapabilitySession(articleDocumentContextAdapter), readCurrentPreference);
                return surfaceRuntime;
            };
            const bindPreviewOwners = (business: ArticlePreviewAttachmentPort,
                readAttribution: ArticleWriterPreviewOwners['readAttribution']): (() => void) =>
            {
                if (!active || editorRuntimeBinding !== binding || previewOwners.value !== null
                    || typeof business?.assess !== 'function' || typeof business.verify !== 'function'
                    || typeof readAttribution !== 'function')
                {
                    throw new Error('article-preview-owner-binding-invalid');
                }
                const owners = Object.freeze({ binding, business, readAttribution });
                previewOwners.value = owners;
                return () =>
                {
                    if (previewOwners.value === owners)
                    {
                        previewOwners.value = null;
                        previewTask.cancel();
                        previewCurrentAuthorities.cancel();
                    }
                };
            };
            return Object.freeze({ binding, release, bindSurfacePreference, bindPreviewOwners, search: searchRuntime });
        }
    });
    const initTask = useAbortableTask({
        registry: articleDocumentContextAdapter,
        kind: 'refresh',
        producerRef: 'article-write:init'
    });
    const submitTask = useAbortableTask({
        registry: articleDocumentContextAdapter,
        kind: 'refresh',
        producerRef: 'article-write:submit'
    });
    const taxonomyTask = useAbortableTask({
        registry: articleDocumentContextAdapter,
        kind: 'refresh',
        producerRef: 'article-write:taxonomy'
    });
    // Source admission owns the document preview lease; this controller only cancels the caller.
    const previewTask = useAbortableTask();
    const prepublishTask = useAbortableTask({
        registry: articleDocumentContextAdapter,
        kind: 'feature',
        producerRef: 'article-write:prepublish'
    });
    const aiAssistTask = useAbortableTask({
        registry: articleDocumentContextAdapter,
        kind: 'feature',
        producerRef: 'article-write:ai-assist'
    });
    const assetTask = useAbortableTask({
        registry: articleDocumentContextAdapter,
        kind: 'attachment',
        producerRef: 'article-write:asset'
    });
    const revisionRefreshTask = useAbortableTask({
        registry: articleDocumentContextAdapter,
        kind: 'refresh',
        producerRef: 'article-write:revision-refresh'
    });
    const revisionCompareTask = useAbortableTask({
        registry: articleDocumentContextAdapter,
        kind: 'compare',
        producerRef: 'article-write:revision-compare'
    });
    const imageUploadFlow = useImageUploadFlow({
        runtime: imageUploadRuntime,
        getOptions: () => imageUploadOptions.value,
        getWasmOnly: () => wasmOnlyMode.value,
        taskRegistry: articleDocumentContextAdapter,
        taskProducerRef: 'article-write:image-upload',
        get getAttemptBinding()
        {
            return attachmentUploadAttempt ? (file: File) =>
            {
                const attempt = attachmentUploadAttempt;
                return attempt?.file === toRaw(file) ? { owner: authoringAttachments,
                    documentOwner: articleDocumentContextAdapter, intent: attempt.handle,
                    getBinding: () => attachmentPort.binding() } : null;
            } : undefined;
        },
        notify: {
            success: (message) => toast.success(message),
            warning: (message) => showWarningToast(message, message),
            error: (message) => showErrorToast(message, message)
        }
    });

    const observeOwnedImageUpload = async (
        handle: ArticleAttachmentPendingHandle,
        file: File,
        signal?: AbortSignal
    ): Promise<AttachmentUploadObservation> =>
    {
        signal?.throwIfAborted();
        const observation = authoringAttachments.readOwnedIntent(handle, attachmentPort.binding());
        const candidate = observation?.snapshot.intent.candidate;
        if (!active || !attachmentEditor || !observation?.current || handle.signal.aborted
            || !authoringAttachments.matchesCapturedFile(handle, toRaw(file))
            || candidate?.name !== file.name || candidate.mimeType !== file.type
            || candidate.byteLength !== file.size)
        {
            throw new Error('article-attachment-upload-intent-invalid');
        }
        if (attachmentUploadAttempt)
        {
            throw new Error('article-attachment-upload-busy');
        }
        if (consumedAttachmentUploads.has(handle))
        {
            throw new Error('article-attachment-upload-consumed');
        }
        assertUploadObligationAbsent();
        if (imageUploadFlow.pendingContext.value)
        {
            throw new Error('article-attachment-upload-busy');
        }
        const reservation: UploadAttemptObservation = Object.freeze({ status: 'observing', observation: null, reason: null });
        consumedAttachmentUploads.set(handle, reservation);
        attachmentUploadObligations.set(handle, reservation);
        const attempt = { handle, file };
        attachmentUploadAttempt = attempt;
        const outcome: { value: AttachmentUploadObservation | null; error: Error | null; } = { value: null, error: null };
        const cancel = (): void => imageUploadFlow.cancel();
        signal?.addEventListener('abort', cancel, { once: true });
        try
        {
            await imageUploadFlow.startUpload({ files: [file], maxFiles: 1,
                notifyOnSuccess: false, notifyOnError: false,
                onError: (_message, error) =>
                {
                    outcome.error = error instanceof Error ? error : new Error('article-attachment-upload-failed');
                },
                onFileUploaded: async completion =>
                {
                    if (toRaw(completion.file) !== file || completion.intent !== handle
                        || attachmentUploadAttempt !== attempt)
                    {
                        throw new Error('article-attachment-upload-session-unavailable');
                    }
                    // Public runtime session has been cleared. Project named private loan fields
                    // into the original provider, which freezes enumerable constructor input.
                    outcome.value = await completion.borrow.withSession(async (facts, loanSignal) =>
                    {
                        const provider = createArticleAttachmentUploadProvider({
                            uploadId: facts.uploadId, uploadToken: facts.uploadToken,
                            sha256: facts.sha256, totalBytes: facts.totalBytes,
                            commitMayHaveStarted: facts.commitMayHaveStarted
                        });
                        return await provider.observe(loanSignal);
                    });
                }
            });
            signal?.throwIfAborted();
            if (outcome.error)
            {
                throw outcome.error;
            }
            if (!active || !outcome.value || !authoringAttachments.readOwnedIntent(handle, attachmentPort.binding())?.current)
            {
                throw new Error('article-attachment-upload-observation-unavailable');
            }
            // Facts are transport observations. A later business-authorized document
            // transaction must run outside the loan callback and own its own grants.
            Object.freeze(outcome.value);
            const settled: UploadAttemptObservation = Object.freeze({ status: 'settled', observation: outcome.value, reason: null });
            consumedAttachmentUploads.set(handle, settled);
            if (outcome.value.status === 'committed' || outcome.value.status === 'cancelled')
            {
                attachmentUploadObligations.delete(handle);
            }
            else
            {
                attachmentUploadObligations.set(handle, settled);
            }
            return outcome.value;
        }
        catch (error)
        {
            const interrupted: UploadAttemptObservation = Object.freeze({ status: 'interrupted', observation: outcome.value,
                reason: error instanceof Error ? error.message : 'article-attachment-upload-observation-unavailable' });
            consumedAttachmentUploads.set(handle, interrupted);
            attachmentUploadObligations.set(handle, interrupted);
            throw error;
        }
        finally
        {
            signal?.removeEventListener('abort', cancel);
            attachmentUploadAttempt = null;
            // An unconfirmed attempt retains the original flow context and Writer obligation.
            if (!attachmentUploadObligations.has(handle))
            {
                imageUploadFlow.clearPending();
            }
        }
    };

    const handleUploadImg = (
        _files: File[],
        _callback: (urls: string[]) => void,
        onError: (message: string) => void
    ): Promise<void> =>
    {
        // The legacy File[] callback carries no original document-intent capability.
        onError('article-attachment-upload-intent-required');
        return Promise.resolve();
    };

    const resumeImageUpload = async (): Promise<void> =>
    {
        if (attachmentUploadAttempt)
        {
            throw new Error('article-attachment-upload-busy');
        }
        assertUploadObligationAbsent();
        await imageUploadFlow.resumeUpload({
            messages: {
                resumeMissing: '没有可恢复的上传任务',
                resumeFailed: '继续上传失败'
            }
        });
    };

    const handleCoverUpload = async (files: File[]): Promise<void> =>
    {
        if (attachmentUploadAttempt)
        {
            throw new Error('article-attachment-upload-busy');
        }
        assertUploadObligationAbsent();
        if (files.length === 0)
        {
            return;
        }
        taskFeedback.begin('正在上传文章头图', `待同步 ${files.length} 个文件`, 'article-cover');
        await imageUploadFlow.startUpload({
            files: [files[0]],
            maxFiles: 1,
            messages: {
                tooManyFiles: '一次只能设置一张头图',
                uploadFailed: '头图上传失败',
                uploadSucceeded: '文章头图已更新'
            },
            onSuccess: (urls) =>
            {
                if (urls.length > 0)
                {
                    articleForm.coverImageUrl = urls[0];
                    taskFeedback.succeed('文章头图已更新', '头图已进入待保存配置', 'article-cover');
                }
            },
            onError: (message) =>
            {
                taskFeedback.fail('文章头图上传失败', message, message, 'article-cover');
                showErrorToast(message, message);
            }
        });
    };
    let unsubscribeArticleRecoveryCoordination: (() => void) | null = null;
    let disposeArticleRecoveryLifecycle: (() => void) | null = null;

    const clearDraftSaveTimer = (): void =>
    {
        if (draftSaveTimer !== null)
        {
            window.clearTimeout(draftSaveTimer);
            draftSaveTimer = null;
        }
        if (serverDraftRetryTimer !== null)
        {
            window.clearTimeout(serverDraftRetryTimer);
            serverDraftRetryTimer = null;
        }
    };

    const buildDraftSnapshot = (
        clientRevision: string,
        source: ArticleDraftSnapshot['source'] = 'local'
    ): ArticleDraftSnapshot => ({
        title: articleForm.title,
        content: articleForm.content,
        summary: articleForm.summary,
        coverImageUrl: articleForm.coverImageUrl,
        categoryId: articleForm.categoryId,
        tagIds: [...articleForm.tagIds],
        status: articleForm.status,
        scheduledPublishAt: articleForm.scheduledPublishAt,
        rights: { ...articleForm.rights },
        savedAt: Date.now(),
        sourceArticleId: articleId.value,
        baseRevisionId: isEdit.value ? currentRevisionId.value : null,
        isEdit: isEdit.value,
        source,
        clientRevision,
        serverRevision: serverDraftRevision.value,
        documentContextDigest: articleDocumentContextAdapter.context.contextDigest
    });

    const buildServerDraftRequest = (snapshot: ArticleDraftSnapshot): ServerDraftSaveRequest => ({
        draftKey: draftKey.value,
        articleId: snapshot.sourceArticleId,
        baseRevisionId: snapshot.baseRevisionId,
        title: snapshot.title,
        content: snapshot.content,
        summary: nonEmptyTextOrNull(snapshot.summary),
        coverImageUrl: nonEmptyTextOrNull(snapshot.coverImageUrl),
        categoryId: snapshot.categoryId ?? 0,
        tagIds: [...snapshot.tagIds],
        clientRevision: snapshot.clientRevision,
        status: snapshot.status,
        scheduledPublishAt: snapshot.status === ArticlePublishStatus.Scheduled && snapshot.scheduledPublishAt
            ? snapshot.scheduledPublishAt
            : null,
        rights: { ...snapshot.rights },
        expectedServerRevision: snapshot.serverRevision
    });

    const buildDraftSemanticIdentity = (snapshot: ArticleDraftSnapshot): string => JSON.stringify({
        draftKey: draftKey.value,
        articleId: snapshot.sourceArticleId,
        baseRevisionId: snapshot.baseRevisionId,
        title: snapshot.title,
        content: snapshot.content,
        summary: snapshot.summary,
        coverImageUrl: snapshot.coverImageUrl,
        categoryId: snapshot.categoryId ?? 0,
        tagIds: snapshot.tagIds,
        status: snapshot.status,
        scheduledPublishAt: snapshot.scheduledPublishAt,
        rights: snapshot.rights,
        expectedServerRevision: snapshot.serverRevision
    });

    const currentPrepublishIdentity = (): string => buildDraftSemanticIdentity(
        buildDraftSnapshot('', 'server')
    );

    const previewCurrentAuthorities = createArticlePreviewCurrentAuthorities({
        documentContext: articleDocumentContextAdapter,
        readHost: () => ({
            context: articleDocumentContextAdapter.context,
            source: articleForm.content,
            revisionId: currentRevisionId.value,
            attachmentLifecycleHistory: authoringAttachments.lifecycleReceipts,
            authoringInputDigest: calculateOpenArticleDocumentDigest(currentPrepublishIdentity())
        }),
        readEditingResponsibility: () =>
        {
            const owners = previewOwners.value;
            // No editable responsibility fields exist in ArticleParams. Only a real live owner can supply them.
            // Explicitly missing current input never falls back to saved-revision history.
            return owners?.binding === editorRuntimeBinding
                ? owners.readAttribution().responsibility : null;
        },
        readCurrentSiteAuthor: () => siteConfig.value?.author
    });

    const articlePreviewGeneration = useArticlePreviewGeneration({
        target: privatePreview,
        documentContext: articleDocumentContextAdapter,
        attachmentBusiness: () => previewOwners.value?.business ?? null,
        sourceAdmission: () =>
        {
            const owners = previewOwners.value;
            if (editorRuntimeBinding !== owners?.binding)
            {
                throw new Error('article-preview-owner-unavailable');
            }
            return ArticlePreviewSourceAdmission.attachRuntime(owners.binding, () => previewCurrentAuthorities.read());
        },
        readRequest: () => buildServerDraftRequest(
            buildDraftSnapshot(createArticleRecoveryClientRevision(), 'server')
        ),
        readCurrentSnapshot: () => ({
            title: articleForm.title,
            content: articleForm.content,
            summary: articleForm.summary,
            coverImageUrl: articleForm.coverImageUrl
        }),
        createIdentity: createArticlePreviewSourceIdentity,
        requestPreview: (request, signal) =>
            previewArticleDraft(request, buildSignalConfig(signal))
    });

    const snapshotFromServerDraft = (draft: ServerDraftResponse): ArticleDraftSnapshot =>
    {
        const savedAt = Date.parse(draft.updatedAt);
        return {
            title: draft.title,
            content: draft.content,
            summary: draft.summary ?? '',
            coverImageUrl: draft.coverImageUrl ?? '',
            categoryId: draft.categoryId > 0 ? draft.categoryId : undefined,
            tagIds: Array.isArray(draft.tagIds) ? draft.tagIds.map(Number).filter((item) => Number.isFinite(item)) : [],
            status: normalizeArticlePublishStatus(draft.status),
            scheduledPublishAt: normalizeDateTimeInput(draft.scheduledPublishAt),
            rights: normalizeArticleRightsForm(draft.rights),
            savedAt: Number.isFinite(savedAt) ? savedAt : 0,
            sourceArticleId: draft.articleId,
            baseRevisionId: draft.baseRevisionId,
            isEdit: draft.articleId !== null,
            source: 'server',
            clientRevision: draft.clientRevision ?? '',
            serverRevision: draft.serverRevision,
            documentContextDigest: articleDocumentContextAdapter.context.contextDigest
        };
    };

    const recoveryIdentityId = (): string | null =>
    {
        const identity = adminStore.adminPrincipal?.id?.trim();
        return typeof identity === 'string' && identity.length > 0 ? identity : null;
    };

    const safeRecoverySourceHash = async (content: string): Promise<string | null> =>
    {
        try
        {
            return await articleRecoverySourceHash(content);
        }
        catch
        {
            articleRecoveryStorageWarning.value = '浏览器短期恢复不可用，服务端自动保存继续';
            return null;
        }
    };

    const updateRecoveryStorageWarning = (status: ArticleRecoveryJournalWriteResult['status']): void =>
    {
        switch (status)
        {
            case 'stored':
                articleRecoveryStorageWarning.value = '';
                break;
            case 'oversize':
                articleRecoveryStorageWarning.value = '正文超过浏览器短期恢复上限，服务端自动保存继续';
                break;
            case 'quota-exceeded':
            case 'capacity-exceeded':
                articleRecoveryStorageWarning.value = '浏览器短期恢复空间不足，服务端自动保存继续';
                break;
            default:
                articleRecoveryStorageWarning.value = '浏览器短期恢复不可用，服务端自动保存继续';
                break;
        }
    };

    const articleRecoveryFlushOwner = new ArticleRecoveryFlushOwner(async (input) =>
    {
        const result = await articleRecoveryJournal.write(input);
        updateRecoveryStorageWarning(result.status);
        if (result.status === 'stored')
        {
            recoveryCoordinator.notify('changed', input.articleId);
        }
        return result;
    });

    const stageArticleRecoveryWrite = (
        content: string,
        clientRevision: string,
        coordinates: {
            articleId: number | null;
            baseRevisionId: string | null;
            serverRevision: number | null;
        }
    ): boolean =>
    {
        const identityId = recoveryIdentityId();
        if (!identityId)
        {
            updateRecoveryStorageWarning('unavailable');
            return false;
        }

        articleRecoveryFlushOwner.stage({
            identityId,
            articleId: coordinates.articleId,
            tabId: recoveryCoordinator.tabId,
            baseRevisionId: coordinates.baseRevisionId,
            serverRevision: coordinates.serverRevision,
            clientRevision,
            content
        });
        return true;
    };

    const flushArticleRecoveryWrite = async (): Promise<ArticleRecoveryJournalWriteResult> =>
    {
        let result: ArticleRecoveryFlushResult;
        try
        {
            result = await articleRecoveryFlushOwner.flush();
        }
        catch
        {
            result = {
                status: 'unavailable',
                record: null
            };
        }
        if (!result)
        {
            return {
                status: 'unavailable',
                record: null
            };
        }
        return result;
    };

    const queueArticleRecoveryWrite = (
        content: string,
        clientRevision: string,
        coordinates: {
            articleId: number | null;
            baseRevisionId: string | null;
            serverRevision: number | null;
        }
    ): Promise<ArticleRecoveryJournalWriteResult> =>
    {
        if (!stageArticleRecoveryWrite(content, clientRevision, coordinates))
        {
            return Promise.resolve({
                status: 'unavailable',
                record: null
            });
        }
        return flushArticleRecoveryWrite();
    };

    const saveServerDraftSnapshot = async (
        snapshot: ArticleDraftSnapshot,
        recoveryRecord: ArticleRecoveryJournalRecord | null
    ): Promise<void> =>
    {
        if (serverDraftSyncPaused.value
            || articleDocumentContextAdapter.context.contextDigest !== snapshot.documentContextDigest)
        {
            draftStatusText.value = '当前更改尚未同步，请先处理已有服务端草稿';
            return;
        }

        const token = ++serverDraftSaveToken;
        const task = articleDocumentContextAdapter.beginTask('refresh', 'article-write:draft-save');
        try
        {
            const saved = await saveServerDraft(buildServerDraftRequest(snapshot), buildSignalConfig(task.signal));
            if (!task.isCurrent())
            {
                return;
            }
            if (recoveryRecord)
            {
                const confirmed = await articleRecoveryJournal.confirm({
                    id: recoveryRecord.id,
                    clientRevision: recoveryRecord.clientRevision,
                    sourceHash: recoveryRecord.sourceHash
                });
                if (confirmed)
                {
                    articleRecoveryFlushOwner.markConfirmed({
                        id: recoveryRecord.id,
                        clientRevision: recoveryRecord.clientRevision,
                        sourceHash: recoveryRecord.sourceHash
                    });
                    recoveryCoordinator.notify('cleared', snapshot.sourceArticleId);
                    if (activeRecoveryClientRevision === recoveryRecord.clientRevision)
                    {
                        activeRecoveryClientRevision = null;
                    }
                }
            }
            if (token !== serverDraftSaveToken || !task.isCurrent())
            {
                return;
            }

            const savedAt = Date.parse(saved.updatedAt);
            serverDraftRevision.value = saved.serverRevision;
            articleDocumentContextAdapter.updateDraftRevision(
                saved.serverRevision === null || saved.serverRevision === undefined
                    ? null
                    : `server:${saved.serverRevision}`
            );
            syncAuthoringDocumentContext();
            draftSavedAt.value = Number.isFinite(savedAt) ? savedAt : snapshot.savedAt;
            draftStatusText.value = `服务端草稿已保存 ${new Date(draftSavedAt.value).toLocaleTimeString()}`;
        }
        catch (error: unknown)
        {
            if (!task.isCurrent())
            {
                return;
            }
            if (token === serverDraftSaveToken)
            {
                if (!shouldRetryServerDraftSave(error))
                {
                    clearDraftSaveTimer();
                    const details = parseServerDraftConflictDetails(
                        error instanceof BinaryTransportError ? error.details : null
                    );
                    serverDraftSyncPaused.value = true;
                    draftConflictText.value = details?.currentUpdatedAt
                        ? `服务端已有版本 ${details.currentServerRevision ?? '未知'}（${new Date(details.currentUpdatedAt).toLocaleString()}），当前页面更改未覆盖它。请比较后选择恢复或丢弃。`
                        : '服务端草稿已变化，当前页面更改未覆盖它。请重新载入并比较。';
                    draftStatusText.value = '自动保存已暂停';
                    try
                    {
                        const current = await getServerDraft(draftKey.value, buildSignalConfig(task.signal));
                        pendingDraft.value = current ? snapshotFromServerDraft(current) : null;
                    }
                    catch
                    {
                        pendingDraft.value = null;
                    }
                    return;
                }

                draftStatusText.value = '服务端草稿暂不可用；当前页面仍保留更改，请勿关闭';
                if (!serverDraftSyncPaused.value && typeof window !== 'undefined')
                {
                    if (serverDraftRetryTimer !== null)
                    {
                        window.clearTimeout(serverDraftRetryTimer);
                    }
                    serverDraftRetryTimer = window.setTimeout(() =>
                    {
                        serverDraftRetryTimer = null;
                        void saveServerDraftSnapshot(snapshot, recoveryRecord);
                    }, 1_200);
                }
            }
        }
        finally
        {
            task.complete();
        }
    };

    const saveDraftNow = (): void =>
    {
        if (suppressDraftSave || !hasDraftContent(articleForm))
        {
            return;
        }

        clearDraftSaveTimer();
        const clientRevision = activeRecoveryClientRevision ?? createArticleRecoveryClientRevision();
        activeRecoveryClientRevision = clientRevision;
        const snapshot = buildDraftSnapshot(clientRevision);
        const identity = buildDraftSemanticIdentity(snapshot);
        if (draftSaveInFlightIdentity === identity)
        {
            return;
        }
        draftSaveInFlightIdentity = identity;
        draftSavedAt.value = snapshot.savedAt;
        draftStatusText.value = '正在保存服务端草稿…';
        void queueArticleRecoveryWrite(snapshot.content, snapshot.clientRevision, {
            articleId: snapshot.sourceArticleId,
            baseRevisionId: snapshot.baseRevisionId,
            serverRevision: snapshot.serverRevision
        })
            .then(result => saveServerDraftSnapshot(snapshot, result.record))
            .finally(() =>
            {
                if (draftSaveInFlightIdentity === identity)
                {
                    draftSaveInFlightIdentity = null;
                }
            });
    };

    const scheduleDraftSave = (): void =>
    {
        if (suppressDraftSave || typeof window === 'undefined')
        {
            return;
        }

        clearDraftSaveTimer();
        draftSaveTimer = window.setTimeout(saveDraftNow, DRAFT_SAVE_DELAY_MS);
    };

    const isDraftSameAsForm = (draft: ArticleDraftSnapshot): boolean =>
        draft.title === articleForm.title
    && draft.content === articleForm.content
    && draft.summary === articleForm.summary
    && draft.coverImageUrl === articleForm.coverImageUrl
    && draft.categoryId === articleForm.categoryId
    && draft.status === articleForm.status
    && draft.scheduledPublishAt === articleForm.scheduledPublishAt
    && draft.tagIds.length === articleForm.tagIds.length
    && draft.tagIds.every((tagId, index) => tagId === articleForm.tagIds[index])
    && areArticleRightsSame(draft.rights, articleForm.rights);

    const readServerDraftSnapshot = async (signal: AbortSignal): Promise<ArticleDraftSnapshot | null> =>
    {
        try
        {
            const serverDraft = await getServerDraft(draftKey.value, buildSignalConfig(signal));
            return serverDraft ? snapshotFromServerDraft(serverDraft) : null;
        }
        catch
        {
            return null;
        }
    };

    const refreshArticleRecoveryCandidates = async (parentSignal?: AbortSignal): Promise<void> =>
    {
        const identityId = recoveryIdentityId();
        if (!identityId)
        {
            articleRecoveryCandidates.value = [];
            selectedArticleRecoveryId.value = '';
            return;
        }
        const task = articleDocumentContextAdapter.beginTask('refresh', 'article-write:recovery-refresh');
        const abortParent = (): void =>
        {
            task.cancel('parent-task-aborted');
        };
        parentSignal?.addEventListener('abort', abortParent, { once: true });
        const token = ++articleRecoveryRefreshToken;
        try
        {
            const [result, currentFormSourceHash] = await Promise.all([
                articleRecoveryJournal.list(identityId, articleId.value),
                safeRecoverySourceHash(articleForm.content)
            ]);
            if (!task.isCurrent() || token !== articleRecoveryRefreshToken)
            {
                return;
            }
            if (result.status === 'unavailable' || currentFormSourceHash === null)
            {
                articleRecoveryStorageWarning.value = '浏览器短期恢复不可用，服务端自动保存继续';
                articleRecoveryCandidates.value = [];
                selectedArticleRecoveryId.value = '';
                return;
            }

            const redundantRecords = result.records.filter(record => (
                record.sourceHash === authoritativeArticleSourceHash
      || record.sourceHash === authoritativeServerDraftSourceHash
            ));
            for (const record of redundantRecords)
            {
                if (!task.isCurrent())
                {
                    return;
                }
                await articleRecoveryJournal.discard(record.id);
            }
            if (redundantRecords.length > 0)
            {
                recoveryCoordinator.notify('cleared', articleId.value);
            }

            const candidates = result.records.filter(record => (
                !redundantRecords.some(redundant => redundant.id === record.id)
      && record.sourceHash !== currentFormSourceHash
            ));
            articleRecoveryCandidates.value = Object.freeze(candidates);
            if (!candidates.some(candidate => candidate.id === selectedArticleRecoveryId.value))
            {
                selectedArticleRecoveryId.value = candidates[0]?.id ?? '';
            }
            const hasDivergentRecovery = candidates.some(candidate => (
                assessArticleRecoveryDivergence(candidate, {
                    currentRevisionId: currentRevisionId.value,
                    serverRevision: serverDraftRevision.value
                }) !== 'none'
            ));
            if (hasDivergentRecovery)
            {
                serverDraftSyncPaused.value = true;
            }
            else if (pendingDraft.value?.source !== 'server' && !draftConflictText.value)
            {
                serverDraftSyncPaused.value = false;
            }
        }
        finally
        {
            parentSignal?.removeEventListener('abort', abortParent);
            task.complete();
        }
    };

    const detectDraftCandidates = async (signal: AbortSignal): Promise<void> =>
    {
        authoritativeArticleContent = articleForm.content;
        authoritativeArticleSourceHash = await safeRecoverySourceHash(articleForm.content);
        const serverDraft = await readServerDraftSnapshot(signal);
        if (signal.aborted)
        {
            return;
        }
        serverDraftRevision.value = serverDraft?.serverRevision ?? null;
        authoritativeServerDraftContent = serverDraft?.content ?? null;
        authoritativeServerDraftSourceHash = serverDraft
            ? await safeRecoverySourceHash(serverDraft.content)
            : null;
        if (signal.aborted)
        {
            return;
        }

        const draft = serverDraft && hasDraftContent(serverDraft) && !isDraftSameAsForm(serverDraft)
            ? serverDraft
            : null;
        if (!draft)
        {
            pendingDraft.value = null;
            draftConflictText.value = '';
            serverDraftSyncPaused.value = false;
            draftSavedAt.value = serverDraft?.savedAt ?? null;
        }
        else
        {
            pendingDraft.value = draft;
            serverDraftRevision.value = draft.serverRevision;
            draftSavedAt.value = draft.savedAt;
            draftConflictText.value = '';
            serverDraftSyncPaused.value = draft.source === 'server';
            draftStatusText.value = `发现 ${new Date(draft.savedAt).toLocaleString()} 保存的服务端草稿`;
        }

        await refreshArticleRecoveryCandidates(signal);
    };

    const applyDraftToForm = (draft: ArticleDraftSnapshot): void =>
    {
        suppressDraftSave = true;
        articleForm.title = draft.title;
        articleForm.content = draft.content;
        articleForm.summary = draft.summary;
        articleForm.coverImageUrl = draft.coverImageUrl;
        articleForm.categoryId = draft.categoryId;
        articleForm.tagIds = [...draft.tagIds];
        articleForm.status = draft.status;
        articleForm.scheduledPublishAt = draft.scheduledPublishAt;
        articleForm.rights = { ...draft.rights };
        serverDraftRevision.value = draft.serverRevision;
        if (draft.isEdit)
        {
            currentRevisionId.value = draft.baseRevisionId;
        }
        serverDraftSyncPaused.value = false;
        suppressDraftSave = false;
    };

    const clearArticleRecoveryScope = async (): Promise<void> =>
    {
        await articleRecoveryFlushOwner.drain();
        articleRecoveryFlushOwner.clear();
        const identityId = recoveryIdentityId();
        if (identityId)
        {
            await articleRecoveryJournal.clearScope(identityId, articleId.value);
            recoveryCoordinator.notify('cleared', articleId.value);
        }
        articleRecoveryCandidates.value = [];
        selectedArticleRecoveryId.value = '';
        activeRecoveryClientRevision = null;
    };

    const articleRecoveryOperationRunner = createArticleRecoveryOperationRunner((state) =>
    {
        articleRecoveryOperationKind.value = state.kind;
        articleRecoveryOperationError.value = state.error;
    });
    const runArticleRecoveryOperation = async (
        kind: ArticleRecoveryOperationKind,
        failureMessage: string,
        operation: () => void | Promise<void>
    ): Promise<boolean> =>
    {
        const task = articleDocumentContextAdapter.beginTask('compare', `article-write:recovery-${kind}`);
        try
        {
            return await articleRecoveryOperationRunner(kind, failureMessage, async () =>
            {
                if (!task.isCurrent())
                {
                    throw new Error('article-document-recovery-task-stale');
                }
                await operation();
                if (!task.isCurrent())
                {
                    throw new Error('article-document-recovery-task-stale');
                }
            });
        }
        finally
        {
            task.complete();
        }
    };

    const compareSelectedArticleRecovery = async (): Promise<void> =>
    {
        await runArticleRecoveryOperation(
            'compare',
            '所选正文比较失败，请保留当前选择并重试',
            () =>
            {
                const recovery = selectedArticleRecovery.value;
                if (!recovery)
                {
                    throw new Error('article_recovery_comparison_selection_required');
                }
                const sources = [{
                    label: '初始化时的当前文章正文',
                    content: authoritativeArticleContent
                }];
                if (authoritativeServerDraftContent !== null)
                {
                    sources.push({
                        label: '初始化时的服务端草稿正文',
                        content: authoritativeServerDraftContent
                    });
                }
                articleRecoveryComparison.value = summarizeArticleRecoveryComparison(recovery, sources);
                comparedArticleRecoveryId.value = recovery.id;
            }
        );
    };

    const performRestoreLocalDraft = async (): Promise<void> =>
    {
        const recovery = selectedArticleRecovery.value;
        if (recovery)
        {
            const previousContent = articleForm.content;
            const previousServerDraftSyncPaused = serverDraftSyncPaused.value;
            clearDraftSaveTimer();
            suppressDraftSave = true;
            articleForm.content = recovery.content;
            pendingDraft.value = null;
            serverDraftSyncPaused.value = false;
            draftConflictText.value = '';
            const clientRevision = createArticleRecoveryClientRevision();
            activeRecoveryClientRevision = clientRevision;
            const snapshot = buildDraftSnapshot(clientRevision);
            suppressDraftSave = false;
            articleDocumentContextAdapter.updateSource(articleForm.content);
            syncAuthoringDocumentContext();
            draftStatusText.value = '已恢复未同步正文，正在继续服务端自动保存';
            const result = await queueArticleRecoveryWrite(snapshot.content, snapshot.clientRevision, {
                articleId: snapshot.sourceArticleId,
                baseRevisionId: snapshot.baseRevisionId,
                serverRevision: snapshot.serverRevision
            });
            if (result.status !== 'stored' || !result.record)
            {
                suppressDraftSave = true;
                articleForm.content = previousContent;
                serverDraftSyncPaused.value = previousServerDraftSyncPaused;
                suppressDraftSave = false;
                throw new Error(`article_recovery_restore_flush_failed:${result.status}`);
            }
            if (result.record.id !== recovery.id)
            {
                const discarded = await articleRecoveryJournal.discard(recovery.id);
                if (!discarded)
                {
                    throw new Error('article_recovery_restore_source_discard_failed');
                }
            }
            await refreshArticleRecoveryCandidates();
            serverDraftSyncPaused.value = false;
            void saveServerDraftSnapshot(snapshot, result.record);
            toast.success('已恢复未同步正文');
            return;
        }

        if (!pendingDraft.value)
        {
            return;
        }
        const sourceLabel = pendingDraftSourceLabel.value;
        await clearArticleRecoveryScope();
        applyDraftToForm(pendingDraft.value);
        articleDocumentContextAdapter.updateSource(articleForm.content);
        syncAuthoringDocumentContext();
        pendingDraft.value = null;
        draftConflictText.value = '';
        draftStatusText.value = `已恢复${sourceLabel}`;
        saveDraftNow();
        toast.success(`已恢复${sourceLabel}`);
    };

    const performDiscardLocalDraft = async (): Promise<void> =>
    {
        const recovery = selectedArticleRecovery.value;
        if (recovery)
        {
            const discarded = await articleRecoveryJournal.discard(recovery.id);
            if (!discarded)
            {
                throw new Error('article_recovery_discard_failed');
            }
            recoveryCoordinator.notify('cleared', recovery.articleId);
            await refreshArticleRecoveryCandidates();
            toast.success('所选未同步正文已丢弃');
            return;
        }

        const shouldDiscardServerDraft = pendingDraft.value?.source === 'server';
        if (shouldDiscardServerDraft)
        {
            try
            {
                const expectedServerRevision = pendingDraft.value?.serverRevision;
                if (expectedServerRevision === null || expectedServerRevision === undefined)
                {
                    throw new Error('expected_server_revision_required');
                }
                await discardServerDraft(draftKey.value, expectedServerRevision);
            }
            catch
            {
                showWarningToast('服务端草稿删除失败，请稍后重试', '服务端草稿删除失败，请稍后重试');
                throw new Error('server_draft_discard_failed');
            }
        }
        await clearArticleRecoveryScope();

        pendingDraft.value = null;
        draftConflictText.value = '';
        serverDraftSyncPaused.value = false;
        serverDraftRevision.value = null;
        draftSavedAt.value = null;
        draftStatusText.value = '';
        toast.success('服务端草稿已丢弃');
    };

    const restoreLocalDraft = async (): Promise<void> =>
    {
        if (articleRecoveryComparisonRequired.value)
        {
            articleRecoveryOperationError.value = '此版本与较新的权威正文坐标不同，请先比较再明确恢复';
            return;
        }
        await runArticleRecoveryOperation(
            'recover',
            '正文恢复失败，所选版本仍保留，请重试',
            performRestoreLocalDraft
        );
    };

    const discardLocalDraft = async (): Promise<void> =>
    {
        await runArticleRecoveryOperation(
            'discard',
            '正文丢弃失败，所选版本仍保留，请重试',
            performDiscardLocalDraft
        );
    };

    const clearLocalDraft = async (): Promise<void> =>
    {
        clearDraftSaveTimer();
        await clearArticleRecoveryScope();
        pendingDraft.value = null;
        draftConflictText.value = '';
        serverDraftSyncPaused.value = false;
        serverDraftRevision.value = null;
        draftSavedAt.value = null;
        draftStatusText.value = '';
    };

    const clearDraftAfterSubmit = async (): Promise<void> =>
    {
        const expectedServerRevision = serverDraftRevision.value;
        await clearLocalDraft();
        if (expectedServerRevision !== null)
        {
            try
            {
                await discardServerDraft(draftKey.value, expectedServerRevision);
            }
            catch
            {
                // The article mutation already succeeded; a newer draft must not be removed by stale cleanup.
            }
        }
    };

    const refreshTaxonomy = async (signal?: AbortSignal): Promise<void> =>
    {
        const requestConfig = signal ? buildSignalConfig(signal) : undefined;
        const [catRes, tagRes] = await Promise.all([
            getCategories(requestConfig),
            getTags(requestConfig)
        ]);
        if (signal?.aborted)
        {
            return;
        }
        categories.value = catRes || [];
        tags.value = tagRes || [];
    };

    const refreshSeoConfig = async (signal?: AbortSignal): Promise<void> =>
    {
        try
        {
            const config = await getAdminSiteConfig(signal ? buildSignalConfig(signal) : undefined);
            if (signal?.aborted)
            {
                return;
            }
            siteConfig.value = config;
        }
        catch
        {
            if (signal?.aborted)
            {
                return;
            }
            siteConfig.value = null;
            seoStatusText.value = '站点 SEO 配置暂不可用，canonical 使用当前访问域名';
        }
    };

    const refreshSiteComplianceConfig = async (signal?: AbortSignal): Promise<void> =>
    {
        try
        {
            const config = await getAdminSiteComplianceConfig(signal ? buildSignalConfig(signal) : undefined);
            if (signal?.aborted)
            {
                return;
            }
            siteComplianceConfig.value = config;
            if (!isEdit.value && articleForm.rights.mode === 'site')
            {
                articleForm.rights = { ...siteInheritedRights.value };
            }
        }
        catch
        {
            if (signal?.aborted)
            {
                return;
            }
            siteComplianceConfig.value = null;
        }
    };

    const refreshAssetLibrary = async (signal?: AbortSignal): Promise<void> =>
    {
        const task = articleDocumentContextAdapter.beginTask('attachment', 'article-write:asset-refresh');
        const abortParent = (): void =>
        {
            task.cancel('parent-task-aborted');
        };
        signal?.addEventListener('abort', abortParent, { once: true });
        assetLibraryLoading.value = true;
        try
        {
            const assets = await listAssetLibrary(buildSignalConfig(task.signal));
            if (!task.isCurrent())
            {
                return;
            }

            assetLibrary.value = assets;
            const orphanCount = assets.filter((asset) => asset.referenceCount === 0).length;
            assetLibraryStatusText.value = orphanCount > 0
                ? `已载入 ${assets.length} 项，${orphanCount} 项待清理`
                : `已载入 ${assets.length} 项可复用资产`;
        }
        catch (error: unknown)
        {
            if (!isAbortError(error))
            {
                assetLibraryStatusText.value = '资产库暂不可用';
            }
        }
        finally
        {
            signal?.removeEventListener('abort', abortParent);
            task.complete();
            assetLibraryLoading.value = false;
        }
    };

    const applyArticleDetailToForm = (data: ArticleDetailResponse): void =>
    {
        articleForm.title = data.title ?? '';
        articleForm.content = data.content ?? '';
        articleForm.summary = data.summary ?? '';
        articleForm.coverImageUrl = data.coverImageUrl ?? '';
        articleForm.categoryId = data.category?.id ? Number(data.category.id) : undefined;
        articleForm.tagIds = Array.isArray(data.tags) ? data.tags.map((item) => Number(item.id)) : [];
        articleForm.status = normalizeArticlePublishStatus(data.status);
        articleForm.scheduledPublishAt = normalizeDateTimeInput(data.scheduledPublishAt);
        articleForm.rights = { ...normalizeArticleRightsForm(data.rights), mode: 'custom' };
        currentRevisionId.value = data.currentRevisionId ?? null;
        currentRevisionNo.value = data.revisionNo ?? null;
        draftConflictText.value = '';
    };

    const loadArticleDetailIntoForm = async (signal: AbortSignal): Promise<void> =>
    {
        if (!isEdit.value || articleId.value === null)
        {
            return;
        }

        const data = await getAdminArticleById(articleId.value, buildSignalConfig(signal));
        if (!signal.aborted)
        {
            applyArticleDetailToForm(data);
        }
    };

    const refreshArticleRevisions = async (): Promise<void> =>
    {
        if (!isEdit.value || articleId.value === null)
        {
            articleRevisions.value = [];
            selectedRevision.value = null;
            revisionStatusText.value = '';
            return;
        }

        revisionLoading.value = true;
        try
        {
            await revisionRefreshTask.run(async (signal) =>
            {
                const revisions = await listArticleRevisions(articleId.value!, buildSignalConfig(signal));
                if (signal.aborted)
                {
                    return;
                }

                articleRevisions.value = revisions;
                if (selectedRevision.value && !revisions.some((revision) => revision.id === selectedRevision.value?.id))
                {
                    selectedRevision.value = null;
                }
                revisionStatusText.value = revisions.length > 0 ? `已载入 ${revisions.length} 个历史版本` : '暂无修订历史';
            });
        }
        catch (error: unknown)
        {
            if (!isAbortError(error))
            {
                revisionStatusText.value = '修订历史暂不可用';
            }
        }
        finally
        {
            revisionLoading.value = false;
        }
    };

    const selectArticleRevision = async (revision: ArticleRevisionSummaryResponse): Promise<void> =>
    {
        if (!isEdit.value || articleId.value === null)
        {
            return;
        }

        revisionLoading.value = true;
        try
        {
            await revisionCompareTask.run(async (signal) =>
            {
                const selected = await getArticleRevision(articleId.value!, revision.id, buildSignalConfig(signal));
                if (signal.aborted)
                {
                    return;
                }
                selectedRevision.value = selected;
                revisionStatusText.value = `正在比较版本 ${selected.revisionNo}`;
            });
        }
        catch (error: unknown)
        {
            if (!isAbortError(error))
            {
                showErrorToast(error, '历史版本载入失败，请稍后重试');
            }
        }
        finally
        {
            revisionLoading.value = false;
        }
    };

    const rollbackSelectedRevision = async (selection: { targetStatus: 0 | 2 | 3; reason: string; }): Promise<void> =>
    {
        if (!selectedRevision.value || articleId.value === null)
        {
            return;
        }

        revisionRollbacking.value = true;
        taskFeedback.begin('正在回滚历史版本', `目标版本 ${selectedRevision.value.revisionNo}`, 'article-revision');
        const task = articleDocumentContextAdapter.beginTask('feature', 'article-write:revision-rollback');
        try
        {
            const revisionNo = selectedRevision.value.revisionNo;
            const mfaProofToken = await ensureAdminSensitiveProof();
            if (!task.isCurrent())
            {
                return;
            }
            if (!currentRevisionId.value)
            {
                throw new Error('article_base_revision_required');
            }
            const rollback = await rollbackArticleRevision(
                articleId.value,
                selectedRevision.value.id,
                {
                    baseRevisionId: currentRevisionId.value,
                    targetStatus: selection.targetStatus,
                    reason: selection.reason.trim()
                },
                { mfaProofToken, signal: task.signal });
            if (!task.isCurrent())
            {
                return;
            }
            currentRevisionId.value = String(rollback.revisionId);
            currentRevisionNo.value = rollback.revisionNo;

            suppressDraftSave = true;
            const expectedServerRevision = serverDraftRevision.value;
            await clearLocalDraft();
            if (expectedServerRevision !== null)
            {
                try
                {
                    await discardServerDraft(draftKey.value, expectedServerRevision);
                }
                catch
                {
                    // Rollback already persisted the article; a newer draft must not be removed.
                }
            }

            await loadArticleDetailIntoForm(task.signal);
            if (!task.isCurrent())
            {
                return;
            }
            articleDocumentContextAdapter.updateSource(articleForm.content);
            syncAuthoringDocumentContext();
            await refreshArticleRevisions();
            selectedRevision.value = null;
            revisionStatusText.value = `已从版本 ${revisionNo} 创建新版本 ${rollback.revisionNo}`;
            taskFeedback.succeed('历史版本回滚完成', `已创建新版本 ${rollback.revisionNo}`, 'article-revision');
            toast.success(`已从版本 ${revisionNo} 创建新版本 ${rollback.revisionNo}`);
        }
        catch (error: unknown)
        {
            if (!isAbortError(error) && task.isCurrent())
            {
                taskFeedback.fail('历史版本回滚失败', error, '历史版本回滚失败，请稍后重试', 'article-revision');
                showErrorToast(error, '历史版本回滚失败，请稍后重试');
            }
        }
        finally
        {
            task.complete();
            suppressDraftSave = false;
            revisionRollbacking.value = false;
        }
    };

    const generatePrivatePreview = async (): Promise<void> =>
    {
        if (!canGeneratePrivatePreview.value)
        {
            const reason = previewOwners.value === null ? '预览所需的附件与责任信息尚未就绪' : '请先填写标题或正文';
            showWarningToast(reason, reason);
            return;
        }

        privatePreviewLoading.value = true;
        taskFeedback.begin('正在生成私有预览', '预览不会发布到公开站点', 'article-preview');
        try
        {
            await previewTask.run(async (signal) =>
            {
                await previewCurrentAuthorities.refresh(signal);
                const preview = await articlePreviewGeneration.generate(signal);
                if (!preview)
                {
                    return;
                }

                const errorCount = preview.issues.filter((issue) => issue.severity.toLowerCase() === 'error').length;
                privatePreviewStatusText.value = errorCount > 0
                    ? `已生成预览，存在 ${errorCount} 个发布阻断项`
                    : `已生成预览，正文 ${preview.plainText.length} 字符`;
                taskFeedback.succeed('私有预览已生成', privatePreviewStatusText.value, 'article-preview');
            });
        }
        catch (error: unknown)
        {
            if (!isAbortError(error))
            {
                taskFeedback.fail('私有预览生成失败', error, '私有预览生成失败，请稍后重试', 'article-preview');
                showErrorToast(error, '私有预览生成失败，请稍后重试');
                privatePreviewStatusText.value = '私有预览暂不可用';
            }
        }
        finally
        {
            privatePreviewLoading.value = false;
        }
    };

    const buildLocalSeoIssues = (): PrepublishIssue[] =>
    {
        if (seoPreview.value.canonicalValid)
        {
            return [];
        }

        return [{
            severity: 'error',
            code: 'canonical_invalid',
            message: '站点 Base URL 无法生成 canonical。'
        }];
    };

    const prepublishErrorIssues = computed(() => seoIssues.value
        .filter((issue) => issue.severity.toLowerCase() === 'error'));
    const prepublishWarningIssues = computed(() => seoIssues.value
        .filter((issue) => issue.severity.toLowerCase() === 'warning'));
    const prepublishWarningsNeedOverride = computed(() =>
        (articleForm.status === ArticlePublishStatus.Published || articleForm.status === ArticlePublishStatus.Scheduled)
    && prepublishErrorIssues.value.length === 0
    && prepublishWarningIssues.value.length > 0);

    const refreshPrepublishCheck = async (warningOverrideReason?: string): Promise<boolean> =>
    {
        if (seoChecking.value)
        {
            return false;
        }

        const requestIdentity = currentPrepublishIdentity();
        acceptedPrepublishIdentity = null;
        seoChecking.value = true;
        taskFeedback.begin('正在运行发布前检查', warningOverrideReason ? '包含 warning override 审计理由' : '检查 SEO 与发布阻断项', 'article-prepublish');
        try
        {
            let canPublish = true;
            await prepublishTask.run(async (signal) =>
            {
                const snapshot = buildDraftSnapshot(createArticleRecoveryClientRevision(), 'server');
                const request = {
                    ...buildServerDraftRequest(snapshot),
                    warningOverrideReason: nonEmptyTextOrNull(warningOverrideReason?.trim())
                };
                const result = await checkArticlePrepublish(request, buildSignalConfig(signal));
                if (signal.aborted || requestIdentity !== currentPrepublishIdentity())
                {
                    acceptedPrepublishIdentity = null;
                    seoStatusText.value = '草稿已变化，请重新运行发布前检查';
                    canPublish = false;
                    return;
                }

                const issues = [...result.issues, ...buildLocalSeoIssues()];
                const errorCount = issues.filter((issue) => issue.severity.toLowerCase() === 'error').length;
                const warningCount = issues.filter((issue) => issue.severity.toLowerCase() === 'warning').length;
                seoIssues.value = issues;
                canPublish = result.canPublish && errorCount === 0;
                acceptedPrepublishIdentity = canPublish ? requestIdentity : null;
                seoStatusText.value = errorCount > 0
                    ? `发现 ${errorCount} 个发布阻断项`
                    : warningCount > 0
            ? `发现 ${warningCount} 个发布提醒项`
            : '发布前检查通过';
                if (errorCount > 0)
                {
                    taskFeedback.partial('发布前检查完成', seoStatusText.value, 'article-prepublish');
                }
                else
                {
                    taskFeedback.succeed('发布前检查完成', seoStatusText.value, 'article-prepublish');
                }
            });
            return canPublish;
        }
        catch (error: unknown)
        {
            acceptedPrepublishIdentity = null;
            if (!isAbortError(error))
            {
                taskFeedback.fail('发布前检查失败', error, '发布前检查失败，请稍后重试', 'article-prepublish');
                showErrorToast(error, '发布前检查失败，请稍后重试');
                seoStatusText.value = '发布前检查暂不可用';
            }
            return false;
        }
        finally
        {
            seoChecking.value = false;
        }
    };

    const confirmPrepublishWarningOverride = async (): Promise<boolean> =>
    {
        if (articleForm.status !== ArticlePublishStatus.Published && articleForm.status !== ArticlePublishStatus.Scheduled)
        {
            return true;
        }

        if (acceptedPrepublishIdentity !== currentPrepublishIdentity())
        {
            showWarningToast('草稿已变化，请重新运行发布前检查', '草稿已变化，请重新运行发布前检查');
            return false;
        }

        if (!prepublishWarningsNeedOverride.value)
        {
            return true;
        }

        const reason = prepublishWarningOverrideReason.value.trim();
        if (reason.length < 8)
        {
            showWarningToast('请填写至少 8 个字符的发布警告跳过理由', '请填写至少 8 个字符的发布警告跳过理由');
            return false;
        }

        const ready = await refreshPrepublishCheck(reason);
        if (!ready || prepublishErrorIssues.value.length > 0)
        {
            showWarningToast('存在发布阻断项，请先处理发布前检查结果', '存在发布阻断项，请先处理发布前检查结果');
            return false;
        }

        toast.success('发布警告跳过理由已记录');
        return true;
    };

    const reindexCurrentArticleAssets = async (): Promise<void> =>
    {
        if (!isEdit.value || articleId.value === null)
        {
            showWarningToast('新文章发布后才能重建资产索引', '新文章发布后才能重建资产索引');
            return;
        }

        assetLibraryLoading.value = true;
        taskFeedback.begin('正在重建资产索引', `文章 ${articleId.value}`, 'article-assets');
        try
        {
            await assetTask.run(async (signal) =>
            {
                const assets = await reindexArticleAssets(articleId.value!, buildSignalConfig(signal));
                if (signal.aborted)
                {
                    return;
                }

                assetLibrary.value = assets;
                assetLibraryStatusText.value = `资产库已重建，当前 ${assets.length} 项`;
                taskFeedback.succeed('资产索引已重建', assetLibraryStatusText.value, 'article-assets');
                toast.success('资产库已重建');
            });
        }
        catch (error: unknown)
        {
            if (!isAbortError(error))
            {
                taskFeedback.fail('资产索引重建失败', error, '资产索引重建失败，请稍后重试', 'article-assets');
                showErrorToast(error, '资产索引重建失败，请稍后重试');
            }
        }
        finally
        {
            assetLibraryLoading.value = false;
        }
    };

    const cleanupAssetOrphans = async (): Promise<void> =>
    {
        assetLibraryLoading.value = true;
        taskFeedback.begin('正在清理孤儿资产', '仅清理无引用资源', 'article-assets');
        try
        {
            await assetTask.run(async (signal) =>
            {
                const deleted = await cleanupOrphanAssets(buildSignalConfig(signal));
                if (signal.aborted)
                {
                    return;
                }

                await refreshAssetLibrary(signal);
                taskFeedback.succeed('孤儿资产清理完成', `已清理 ${deleted} 个孤儿资产`, 'article-assets');
                toast.success(`已清理 ${deleted} 个孤儿资产`);
            });
        }
        catch (error: unknown)
        {
            if (!isAbortError(error))
            {
                taskFeedback.fail('孤儿资产清理失败', error, '孤儿资产清理失败，请稍后重试', 'article-assets');
                showErrorToast(error, '孤儿资产清理失败，请稍后重试');
            }
        }
        finally
        {
            assetLibraryLoading.value = false;
        }
    };

    const insertAssetIntoContent = (asset: AssetLibraryItemResponse, insertAtCursor?: (markdown: string) => boolean): void =>
    {
        if (!asset.url || asset.referenceCount === 0)
        {
            return;
        }

        const alt = firstNonEmptyText(asset.altText?.trim(), 'image');
        const markdown = `![${alt}](${asset.url})`;
        if (insertAtCursor?.(`\n${markdown}\n`) === true)
        {
            toast.success('资产已插入光标位置');
            saveDraftNow();
            return;
        }

        articleForm.content = articleForm.content.trim().length > 0
            ? `${articleForm.content.trimEnd()}\n\n${markdown}\n`
            : `${markdown}\n`;
        toast.success('资产已插入正文');
        saveDraftNow();
    };

    const quickCreateCategory = async (name: string): Promise<boolean> =>
    {
        const trimmed = name.trim();
        if (trimmed.length < 2 || trimmed.length > 20)
        {
            showWarningToast('分类名称需为 2-20 个字符', '分类名称需为 2-20 个字符');
            return false;
        }

        quickCreatingCategory.value = true;
        taskFeedback.begin('正在创建分类', trimmed, 'article-taxonomy');
        try
        {
            await taxonomyTask.run(async (signal) =>
            {
                const result = await createCategory(trimmed, buildSignalConfig(signal));
                await refreshTaxonomy(signal);
                if (signal.aborted)
                {
                    return;
                }
                const created = categories.value.find((item) => item.id === result.id)
          ?? categories.value.find((item) => item.name === trimmed);
                if (created)
                {
                    articleForm.categoryId = created.id;
                }
                else if (result.id > 0)
                {
                    categories.value = [...categories.value, { id: result.id, name: trimmed, articleCount: 0 }];
                    articleForm.categoryId = result.id;
                }
            });
            taskFeedback.succeed('分类已创建并选中', trimmed, 'article-taxonomy');
            return true;
        }
        catch (error: unknown)
        {
            if (!isAbortError(error))
            {
                taskFeedback.fail('分类创建失败', error, '分类创建失败，请稍后重试', 'article-taxonomy');
            }
            return false;
        }
        finally
        {
            quickCreatingCategory.value = false;
        }
    };

    const quickCreateTag = async (name: string): Promise<boolean> =>
    {
        const trimmed = name.trim();
        if (trimmed.length < 1 || trimmed.length > 20)
        {
            showWarningToast('标签名称需为 1-20 个字符', '标签名称需为 1-20 个字符');
            return false;
        }

        quickCreatingTag.value = true;
        taskFeedback.begin('正在创建标签', trimmed, 'article-taxonomy');
        try
        {
            await taxonomyTask.run(async (signal) =>
            {
                const result = await createTag(trimmed, buildSignalConfig(signal));
                await refreshTaxonomy(signal);
                if (signal.aborted)
                {
                    return;
                }
                const created = tags.value.find((item) => item.id === result.id)
          ?? tags.value.find((item) => item.name === trimmed);
                if (created && !articleForm.tagIds.includes(created.id))
                {
                    articleForm.tagIds = [...articleForm.tagIds, created.id];
                }
                else if (result.id > 0 && !articleForm.tagIds.includes(result.id))
                {
                    tags.value = [...tags.value, { id: result.id, name: trimmed, articleCount: 0 }];
                    articleForm.tagIds = [...articleForm.tagIds, result.id];
                }
            });
            taskFeedback.succeed('标签已创建并关联', trimmed, 'article-taxonomy');
            return true;
        }
        catch (error: unknown)
        {
            if (!isAbortError(error))
            {
                taskFeedback.fail('标签创建失败', error, '标签创建失败，请稍后重试', 'article-taxonomy');
            }
            return false;
        }
        finally
        {
            quickCreatingTag.value = false;
        }
    };

    const initData = async () =>
    {
        const invocation = ++initInvocation;
        pageLoading.value = true;
        try
        {
            await initTask.run(async (signal) =>
            {
                await Promise.all([
                    refreshTaxonomy(signal),
                    refreshSeoConfig(signal),
                    refreshSiteComplianceConfig(signal)
                ]);

                if (signal.aborted)
                {
                    return;
                }

                if (isEdit.value && articleId.value !== null)
                {
                    try
                    {
                        await loadArticleDetailIntoForm(signal);
                    }
                    catch (error: unknown)
                    {
                        if (isAbortError(error) || signal.aborted)
                        {
                            return;
                        }
                    }

                    if (signal.aborted)
                    {
                        return;
                    }
                }

                await detectDraftCandidates(signal);
            });
        }
        catch (error: unknown)
        {
            if (!isAbortError(error))
            {
                showErrorToast('无法同步远程配置资源', '无法同步远程配置资源');
                console.error('[Write Init Error]', error);
            }
        }
        finally
        {
            if (active && invocation === initInvocation)
            {
                suppressDraftSave = false;
                articleDocumentContextAdapter.updateSource(articleForm.content);
                articleDocumentContextAdapter.updateDraftRevision(
                    serverDraftRevision.value === null
                        ? null
                        : `server:${serverDraftRevision.value}`
                );
                syncAuthoringDocumentContext();
                pageLoading.value = false;
            }
        }
    };

    const validateArticleRights = (): boolean =>
    {
        const rights = buildEffectiveArticleRightsForm();
        const licenseType = rights.licenseType.trim();
        const copyPolicy = rights.copyPolicy.trim();
        if (licenseType.trim().length === 0)
        {
            showWarningToast('版权许可类型不能为空', '版权许可类型不能为空');
            return false;
        }
        if (!ARTICLE_RIGHTS_LICENSE_TYPES.includes(licenseType as typeof ARTICLE_RIGHTS_LICENSE_TYPES[number]))
        {
            showWarningToast('版权许可类型不在允许范围内', '版权许可类型不在允许范围内');
            return false;
        }
        if (copyPolicy.trim().length === 0)
        {
            showWarningToast('复制策略不能为空', '复制策略不能为空');
            return false;
        }
        if (!ARTICLE_RIGHTS_COPY_POLICIES.includes(copyPolicy as typeof ARTICLE_RIGHTS_COPY_POLICIES[number]))
        {
            showWarningToast('复制策略不在允许范围内', '复制策略不在允许范围内');
            return false;
        }
        if (rights.copyrightYear !== null)
        {
            const currentYear = new Date().getFullYear();
            if (!Number.isInteger(rights.copyrightYear) || rights.copyrightYear < 1900 || rights.copyrightYear > currentYear + 1)
            {
                showWarningToast('版权年份必须是有效年份', '版权年份必须是有效年份');
                return false;
            }
        }
        if (!Number.isInteger(rights.maxExcerptChars) || rights.maxExcerptChars < 0 || rights.maxExcerptChars > ARTICLE_RIGHTS_EXCERPT_MAX)
        {
            showWarningToast(`摘录长度必须在 0-${ARTICLE_RIGHTS_EXCERPT_MAX} 之间`, `摘录长度必须在 0-${ARTICLE_RIGHTS_EXCERPT_MAX} 之间`);
            return false;
        }

        return true;
    };

    const firstInvalidFormProperty = ref<string | null>(null);
    const validateBeforeSubmit = async (): Promise<boolean> =>
    {
        firstInvalidFormProperty.value = null;
        if (!formRef.value || submitting.value)
        {
            return false;
        }

        const captureInvalidProperty: FormValidateCallback = (valid, fields): void =>
        {
            firstInvalidFormProperty.value = valid ? null : Object.keys(fields ?? {})[0] ?? null;
        };
        const validation = await formRef.value.validate(captureInvalidProperty);
        if (!isFsusUiOk(validation))
        {
            return false;
        }

        if (!validateArticleRights())
        {
            return false;
        }

        if (articleForm.status === ArticlePublishStatus.Published || articleForm.status === ArticlePublishStatus.Scheduled)
        {
            const ready = await refreshPrepublishCheck();
            if (!ready)
            {
                showWarningToast('存在发布阻断项，请先处理发布前检查结果', '存在发布阻断项，请先处理发布前检查结果');
                return false;
            }
            if (!prepublishWarningsNeedOverride.value)
            {
                prepublishWarningOverrideReason.value = '';
            }
        }
        return true;
    };

    const buildEffectiveArticleRightsForm = (): ArticleRightsForm =>
    articleForm.rights.mode === 'site'
        ? siteInheritedRights.value
        : articleForm.rights;

    const buildArticleRightsRequest = (): ArticleRightsRequest =>
    {
        const rights = buildEffectiveArticleRightsForm();
        return {
            mode: articleForm.rights.mode,
            enabled: rights.enabled,
            licenseType: rights.licenseType.trim(),
            copyrightHolder: nonEmptyTextOrNull(rights.copyrightHolder.trim()),
            copyrightYear: rights.copyrightYear,
            rightsStatement: nonEmptyTextOrNull(rights.rightsStatement.trim()),
            attributionTemplate: nonEmptyTextOrNull(rights.attributionTemplate.trim()),
            copyPolicy: rights.copyPolicy.trim(),
            maxExcerptChars: rights.maxExcerptChars,
            allowCodeCopy: rights.allowCodeCopy,
            showPublicBadge: rights.showPublicBadge,
            proofBindingEnabled: rights.proofBindingEnabled
        };
    };

    const useSiteRightsDefaults = (): void =>
    {
        articleForm.rights = { ...siteInheritedRights.value };
    };

    const useCustomArticleRights = (): void =>
    {
        articleForm.rights = {
            ...siteInheritedRights.value,
            mode: 'custom'
        };
    };

    const setArticleRightsMode = (mode: ArticleRightsForm['mode']): void =>
    {
        if (mode === 'site')
        {
            useSiteRightsDefaults();
            return;
        }

        useCustomArticleRights();
    };

    const validatePublishState = (): boolean =>
    {
        if (articleForm.status !== ArticlePublishStatus.Scheduled)
        {
            return true;
        }

        const scheduledTime = Date.parse(articleForm.scheduledPublishAt);
        if (!Number.isFinite(scheduledTime) || scheduledTime <= Date.now())
        {
            showWarningToast('定时发布时间必须晚于当前时间', '定时发布时间必须晚于当前时间');
            return false;
        }

        return true;
    };

    const submitForm = async () =>
    {
        if (submitting.value || !validatePublishState())
        {
            return;
        }
        if (
            (articleForm.status === ArticlePublishStatus.Published || articleForm.status === ArticlePublishStatus.Scheduled)
            && acceptedPrepublishIdentity !== currentPrepublishIdentity()
        )
        {
            showWarningToast('草稿已变化，请重新运行发布前检查', '草稿已变化，请重新运行发布前检查');
            return;
        }

        try
        {
            submitting.value = true;
            taskFeedback.begin(`${submitButtonText.value}处理中`, '正在写入文章并同步相关缓存', 'article-submit');
            await submitTask.run(async (signal) =>
            {
                const config: ApiRequestConfig = { signal };
                const articlePayload: ArticleWriteRequest = {
                    title: articleForm.title,
                    content: articleForm.content,
                    summary: articleForm.summary,
                    coverImageUrl: articleForm.coverImageUrl,
                    categoryId: articleForm.categoryId,
                    tagIds: [...articleForm.tagIds],
                    status: articleForm.status,
                    scheduledPublishAt: articleForm.status === ArticlePublishStatus.Scheduled ? articleForm.scheduledPublishAt : null,
                    rights: buildArticleRightsRequest(),
                    baseRevisionId: isEdit.value ? currentRevisionId.value : null
                };

                let targetArticleId: number | null = null;
                const successMessage = buildSubmitSuccessMessage(isEdit.value, articleForm.status);

                if (isEdit.value)
                {
                    if (articleId.value === null)
                    {
                        return;
                    }

                    if (!currentRevisionId.value)
                    {
                        throw new Error('article_base_revision_required');
                    }
                    const result = await updateArticle(articleId.value, articlePayload, config);
                    if (signal.aborted || !active)
                    {
                        return;
                    }
                    currentRevisionId.value = String(result.revisionId);
                    currentRevisionNo.value = result.revisionNo;
                    targetArticleId = articleId.value;
                }
                else
                {
                    const result = await createArticle(articlePayload, config);
                    if (signal.aborted || !active)
                    {
                        return;
                    }
                    const createdId = Number(result?.articleId ?? result?.id);
                    currentRevisionId.value = String(result.revisionId);
                    currentRevisionNo.value = result.revisionNo;
                    if (Number.isFinite(createdId) && createdId > 0)
                    {
                        targetArticleId = createdId;
                    }
                }

                if (targetArticleId === null)
                {
                    throw new Error('article_write_succeeded_without_id');
                }

                toast.success(successMessage);
                taskFeedback.succeed(successMessage, '文章写入完成，准备返回列表', 'article-submit');

                suppressDraftSave = true;
                await clearDraftAfterSubmit();
                if (signal.aborted || !active)
                {
                    return;
                }
                articleForm.content = '';
                await router.push('/user/manage/article/list');
            });
        }
        catch (error: unknown)
        {
            if (!isAbortError(error))
            {
                if (error instanceof BinaryTransportError && error.message === 'article_revision_conflict')
                {
                    let latestRevision = '较新的版本';
                    const details = parseArticleRevisionConflictDetails(error.details);
                    if (details)
                    {
                        latestRevision = `版本 ${details.revisionNo}`;
                    }
                    draftConflictText.value = `检测到${latestRevision}，当前编辑内容未提交。请先重新载入并比较后再保存。`;
                }
                taskFeedback.fail(isEdit.value ? '博文更新失败' : '博文发布失败', error, isEdit.value ? '博文更新失败，请稍后重试' : '博文发布失败，请稍后重试', 'article-submit');
                showErrorToast(error, isEdit.value ? '博文更新失败，请稍后重试' : '博文发布失败，请稍后重试');
                console.error('[Article Submit] Critical Error:', error);
            }
        }
        finally
        {
            submitting.value = false;
        }
    };

    const autoGenerateSummary = () =>
    {
        if (!articleForm.content)
        {
            showWarningToast('博文正文为空', '博文正文为空');
            return;
        }

        const cleanStr = articleForm.content
            .replace(/```[\s\S]*?```/g, '')
            .replace(/(!\[.*?]\(.*?\))|(\[.*?]\(.*?\))/g, '')
            .replace(/[#*`>|-]/g, '')
            .replace(/(\r\n|\n|\r)/gm, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 180);

        articleForm.summary = cleanStr + (cleanStr.length >= 180 ? '...' : '');
        toast.success('摘要草稿已生成');
    };

    const requestAiAssist = async () =>
    {
        if (!articleForm.title.trim() && !articleForm.content.trim())
        {
            showWarningToast('请先填写标题或正文', '请先填写标题或正文');
            return;
        }

        aiAssistLoading.value = true;
        aiAssistStatusText.value = '正在检查草稿';
        taskFeedback.begin('正在检查草稿', '摘要草稿、标签匹配、标题备选与结构检查', 'article-ai-assist');
        try
        {
            await aiAssistTask.run(async (signal) =>
            {
                const response = await generateAiAssist({
                    title: articleForm.title,
                    content: articleForm.content,
                    locale: typeof navigator === 'undefined' ? null : navigator.language,
                    operation: 'summary-tags-title-structure-translate'
                }, buildSignalConfig(signal));
                if (signal.aborted)
                {
                    return;
                }
                aiAssist.value = response;
                aiAssistStatusText.value = '草稿检查完成';
                if (!articleForm.summary.trim() && response.suggestedSummary.trim())
                {
                    articleForm.summary = response.suggestedSummary.trim();
                }
                taskFeedback.succeed('草稿检查结果已生成', aiAssistStatusText.value, 'article-ai-assist');
                toast.success('草稿检查结果已生成');
            });
        }
        catch (error: unknown)
        {
            if (!isAbortError(error))
            {
                taskFeedback.fail('草稿检查失败', error, '草稿检查失败', 'article-ai-assist');
                showErrorToast(error, '草稿检查失败');
            }
        }
        finally
        {
            aiAssistLoading.value = false;
        }
    };

    const applyAiSummary = () =>
    {
        const summary = aiAssist.value?.suggestedSummary?.trim();
        if (!summary)
        {
            return;
        }

        articleForm.summary = summary;
        toast.success('已使用这版摘要');
    };

    const applyAiTitleCandidate = (title: string) =>
    {
        const normalized = title.trim();
        if (!normalized)
        {
            return;
        }

        articleForm.title = normalized.slice(0, 100);
        toast.success('已采用标题候选');
    };

    const applyAiSuggestedTags = () =>
    {
        const suggestions = new Set((aiAssist.value?.suggestedTags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean));
        if (suggestions.size === 0)
        {
            return;
        }

        const matchedIds = tags.value
            .filter((tag) => suggestions.has(tag.name.trim().toLowerCase()))
            .map((tag) => tag.id);
        if (matchedIds.length === 0)
        {
            showWarningToast('建议标签尚未存在，请先新建标签', '建议标签尚未存在，请先新建标签');
            return;
        }

        articleForm.tagIds = [...new Set([...articleForm.tagIds, ...matchedIds])];
        toast.success('已匹配已有标签');
    };

    const applyAiTranslationDraft = () =>
    {
        const translation = aiAssist.value?.translationDraft?.trim();
        if (!translation)
        {
            return;
        }

        articleForm.content = translation;
        toast.success('已使用翻译草稿');
    };

    const leaveEditor = () =>
    {
        void router.back();
    };

    const resetArticleDocumentState = (): void =>
    {
        clearDraftSaveTimer();
        serverDraftSaveToken += 1;
        draftSaveInFlightIdentity = null;
        articleRecoveryRefreshToken += 1;
        activeRecoveryClientRevision = null;
        authoritativeArticleSourceHash = null;
        authoritativeServerDraftSourceHash = null;
        authoritativeArticleContent = '';
        authoritativeServerDraftContent = null;
        suppressDraftSave = true;
        pendingDraft.value = null;
        draftSavedAt.value = null;
        draftConflictText.value = '';
        draftStatusText.value = '';
        serverDraftRevision.value = null;
        serverDraftSyncPaused.value = false;
        articleRecoveryCandidates.value = [];
        selectedArticleRecoveryId.value = '';
        articleRecoveryComparison.value = '';
        comparedArticleRecoveryId.value = '';
        articleRecoveryOperationKind.value = null;
        articleRecoveryOperationError.value = '';
        articleForm.title = '';
        articleForm.content = '';
        articleForm.summary = '';
        articleForm.coverImageUrl = '';
        articleForm.categoryId = undefined;
        articleForm.tagIds = [];
        articleForm.status = ArticlePublishStatus.Published;
        articleForm.scheduledPublishAt = '';
        articleForm.rights = createDefaultArticleRightsForm();
        currentRevisionId.value = null;
        currentRevisionNo.value = null;
        articleRevisions.value = [];
        selectedRevision.value = null;
        privatePreview.value = null;
        privatePreviewLoading.value = false;
        privatePreviewStatusText.value = '预览仅在作者工作台内生成';
        seoIssues.value = [];
        seoChecking.value = false;
        seoStatusText.value = '发布前检查随表单实时更新';
        prepublishWarningOverrideReason.value = '';
        acceptedPrepublishIdentity = null;
        aiAssist.value = null;
        aiAssistLoading.value = false;
        aiAssistStatusText.value = '';
        revisionLoading.value = false;
        revisionRollbacking.value = false;
        assetLibrary.value = [];
        assetLibraryLoading.value = false;
        assetLibraryStatusText.value = '资产库等待同步';
        suppressDraftSave = false;
    };

    watch(
        () => articleForm.status,
        (status) =>
        {
            if (status !== ArticlePublishStatus.Scheduled)
            {
                articleForm.scheduledPublishAt = '';
            }
        }
    );

    watch(articleId, (next, previous) =>
    {
        if (next !== previous)
        {
            articleDocumentContextBinding.switchDocument({
                articleId: next,
                content: '',
                reason: next === null ? 'draft-switch' : 'article-switch'
            });
            imageUploadFlow.cancel();
            if (typeof imageUploadFlow.clearPending === 'function')
            {
                imageUploadFlow.clearPending();
            }
            resetArticleDocumentState();
            syncAuthoringDocumentContext();
            void initData();
        }
    });

    watch(
        () => articleForm.content,
        (content) =>
        {
            if (suppressDraftSave)
            {
                return;
            }
            articleDocumentContextAdapter.updateSource(content);
            syncAuthoringDocumentContext();
            const clientRevision = createArticleRecoveryClientRevision();
            activeRecoveryClientRevision = clientRevision;
            stageArticleRecoveryWrite(content, clientRevision, {
                articleId: articleId.value,
                baseRevisionId: isEdit.value ? currentRevisionId.value : null,
                serverRevision: serverDraftRevision.value
            });
            void flushArticleRecoveryWrite();
        },
        { flush: 'sync' }
    );

    watch(selectedArticleRecoveryId, () =>
    {
        comparedArticleRecoveryId.value = '';
        articleRecoveryComparison.value = '';
        articleRecoveryOperationError.value = '';
    });

    watch(
        () => ({
            title: articleForm.title,
            content: articleForm.content,
            summary: articleForm.summary,
            coverImageUrl: articleForm.coverImageUrl,
            categoryId: articleForm.categoryId,
            tagIds: [...articleForm.tagIds],
            status: articleForm.status,
            scheduledPublishAt: articleForm.scheduledPublishAt,
            rights: { ...articleForm.rights }
        }),
        scheduleDraftSave,
        { deep: true }
    );

    onMounted(() =>
    {
        if (typeof window !== 'undefined')
        {
            mountedBrowserSeoBaseUrl.value = window.location.origin;
            try
            {
                purgeRetiredArticleDraftMetadata(window.localStorage);
            }
            catch
            {
                // Private-mode storage access must not block the editor or server autosave.
            }
        }
        unsubscribeArticleRecoveryCoordination = recoveryCoordinator.subscribe((message) =>
        {
            if (message.articleKey === articleRecoveryArticleKey(articleId.value) && !suppressDraftSave)
            {
                void refreshArticleRecoveryCandidates();
            }
        });
        if (typeof window !== 'undefined' && typeof document !== 'undefined')
        {
            disposeArticleRecoveryLifecycle = bindArticleRecoveryLifecycleFlush(async () =>
            {
                await flushArticleRecoveryWrite();
                if (!suppressDraftSave)
                {
                    await refreshArticleRecoveryCandidates();
                }
            }, { document, window }, ARTICLE_RECOVERY_FLUSH_INTERVAL_MS);
        }
        powProvider.prewarm();
        void initData();
    });

    onUnmounted(() =>
    {
        active = false;
        suppressDraftSave = true;
        unsubscribeArticleRecoveryCoordination?.();
        unsubscribeArticleRecoveryCoordination = null;
        disposeArticleRecoveryLifecycle?.();
        disposeArticleRecoveryLifecycle = null;
        recoveryCoordinator.dispose();
        previewCurrentAuthorities.dispose();
        releaseEditorRuntime?.();
        attachmentEditor = null;
        authoringAttachments.dispose();
        articleDocumentContextBinding.release();
        initTask.cancel();
        submitTask.cancel();
        taxonomyTask.cancel();
        previewTask.cancel();
        prepublishTask.cancel();
        aiAssistTask.cancel();
        assetTask.cancel();
        imageUploadFlow.cancel();
        if (typeof imageUploadFlow.clearPending === 'function')
        {
            imageUploadFlow.clearPending();
        }
        clearDraftSaveTimer();
        articleForm.title = '';
        articleForm.content = '';
        articleForm.summary = '';
        articleForm.rights = createDefaultArticleRightsForm();
    });

    return {
        formRef,
        taskFeedback,
        pageLoading,
        submitting,
        categories,
        tags,
        assetLibrary,
        assetLibraryLoading,
        assetLibraryStatusText,
        isEdit,
        submitButtonText,
        submitConfirmContent,
        requiresLeaveConfirm,
        pendingDraft,
        draftConflictText,
        draftStatusText: recoveryAwareDraftStatusText,
        pendingDraftSourceLabel,
        pendingDraftDescription,
        draftRestoreButtonText,
        draftDiscardButtonText,
        articleRecoveryComparison,
        articleRecoveryComparisonRequired,
        articleRecoveryOperationError,
        articleRecoveryOperationKind,
        articleRecoveryOperationPending,
        articleRecoveryOperationStatusText,
        hasLocalDraft,
        articleRecoveryCandidateViews,
        selectedArticleRecoveryId,
        hasArticleRecoveryCandidates,
        articleRevisions,
        selectedRevision,
        selectedRevisionLabel,
        revisionLoading,
        revisionRollbacking,
        revisionStatusText,
        revisionCompareText,
        privatePreview,
        privatePreviewLoading,
        privatePreviewStatusText,
        privatePreviewAttachmentState: articlePreviewGeneration.attachmentState,
        privatePreviewCurrentAuthorities: previewCurrentAuthorities,
        canGeneratePrivatePreview,
        aiAssist,
        aiAssistLoading,
        aiAssistStatusText,
        seoPreview,
        seoIssues,
        prepublishWarningIssues,
        prepublishWarningsNeedOverride,
        prepublishWarningOverrideReason,
        seoChecking,
        seoStatusText,
        articleForm,
        authoringDocumentContext,
        authoringDocumentIdentity,
        authoringDocumentContextAdapter: articleDocumentContextAdapter,
        authoringAttachmentRuntime,
        authoringEditorRuntime,
        currentRevisionId,
        currentRevisionNo,
        articleRightsUsingSiteDefaults,
        articleRightsInheritanceText,
        articleRightsLicenseOptions,
        articleRightsCopyPolicyOptions,
        articleRightsExcerptMax: ARTICLE_RIGHTS_EXCERPT_MAX,
        rules,
        validateBeforeSubmit,
        firstInvalidFormProperty,
        saveDraftNow,
        compareSelectedArticleRecovery,
        handleUploadImg,
        handleCoverUpload,
        submitForm,
        restoreLocalDraft,
        discardLocalDraft,
        refreshArticleRevisions,
        selectArticleRevision,
        rollbackSelectedRevision,
        generatePrivatePreview,
        requestAiAssist,
        applyAiSummary,
        applyAiTitleCandidate,
        applyAiSuggestedTags,
        applyAiTranslationDraft,
        refreshPrepublishCheck,
        confirmPrepublishWarningOverride,
        refreshAssetLibrary,
        reindexCurrentArticleAssets,
        cleanupAssetOrphans,
        insertAssetIntoContent,
        setArticleRightsMode,
        quickCreateCategory,
        quickCreateTag,
        quickCreatingCategory,
        quickCreatingTag,
        autoGenerateSummary,
        imageUploadOptions,
        imageUploadWasmOnlyMode: wasmOnlyMode,
        setImageUploadWasmOnlyMode,
        setImageUploadOptions,
        imageUploadRuntime,
        resumeImageUpload,
        leaveEditor
    };
}
