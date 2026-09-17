import { type UploadRequestOptions } from '@ozwasyd/element-plus';
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';

import { listAssetLibrary } from '@/api/authoring';
import type { ApiRequestConfig } from '@/api/requestConfig';
import {
    deleteImage,
    getAdminPageData,
    getAdminSiteComplianceConfig,
    getAdminSiteConfig,
    refreshPageData,
    updatePageData,
    updateSiteComplianceConfig,
    updateSiteConfig,
    type SeoConfigAdmin,
    type SiteComplianceConfigAdmin
} from '@/api/system';
import type { ImageCompressionOptions } from '@/api/upload';
import { useAbortableTask } from '@/composables/useAbortableTask';
import { useAdminTaskFeedback } from '@/composables/useAdminTaskFeedback';
import { useImageUploadFlow } from '@/composables/useImageUploadFlow';
import { useImageUploadPreferences } from '@/composables/useImageUploadPreferences';
import { useImageUploadRuntime } from '@/composables/useImageUploadRuntime';
import { toast } from '@/fsusui/feedback';
import { DEFAULT_SITE_BRAND_CONFIG, DEFAULT_SITE_OG_IMAGE } from '@/store/site';
import { AppErrorCode, createAppError, toAppError } from '@/utils/appError';
import {
    generateBrandIconSet,
    isRasterBrandIconSource,
    type BrandIconField,
    type BrandIconUploadFormat
} from '@/utils/brandIconGenerator';
import { getKnownErrorInfo } from '@/utils/errorKinds';
import { showErrorToast, showWarningToast } from '@/utils/errorPresentation';
import { isAbortError } from '@/utils/errors';

type BrandAssetField =
  | BrandIconField
  | 'siteLogoUrl'
  | 'siteLogoDarkUrl'
  | 'siteWordmarkUrl'
  | 'adminLogoUrl'
  | 'adminCollapsedIconUrl'
  | 'loginLogoUrl'
  | 'loginIconUrl';
type BrandAssetUploadFormat = BrandIconUploadFormat | ImageCompressionOptions['format'];

const BRAND_ASSET_FIELD_LABELS: Record<BrandAssetField, string> = {
    faviconIcoUrl: 'ICO favicon',
    faviconPngUrl: 'PNG favicon',
    appleTouchIconUrl: 'Apple Touch Icon',
    pwaIcon192Url: 'PWA 192 图标',
    pwaIcon512Url: 'PWA 512 图标',
    pwaMaskableIconUrl: 'PWA maskable 图标',
    siteLogoUrl: '站点 Logo',
    siteLogoDarkUrl: '深色站点 Logo',
    siteWordmarkUrl: '站点字标',
    adminLogoUrl: '后台 Logo',
    adminCollapsedIconUrl: '后台折叠图标',
    loginLogoUrl: '登录 Logo',
    loginIconUrl: '登录图标'
};

const RAW_ASSET_UPLOAD_OPTIONS: ImageCompressionOptions = {
    format: 'png',
    quality: 100,
    scaleRatio: 1,
    maxEdge: 512,
    preserveAlpha: true
};

const BRAND_ASSET_FIELDS = new Set<BrandAssetField>(Object.keys(BRAND_ASSET_FIELD_LABELS) as BrandAssetField[]);

export function useAdminSettingsPage()
{
    const mountedBrowserBaseUrl = ref(typeof window !== 'undefined' ? window.location.origin : '');

    const activeTab = ref('site');
    const savingSite = ref(false);
    const savingCompliance = ref(false);
    const savingPage = ref(false);
    const refreshingPage = ref(false);
    const pageLoading = ref(false);
    const imageLoading = ref(false);
    const brandAssetUploadingField = ref<BrandAssetField | ''>('');
    const iconSetGenerating = ref(false);
    const siteLoadFailed = ref(false);
    const complianceLoadFailed = ref(false);
    const {
        options: imageUploadOptions,
        wasmOnlyMode,
        setOptions: setImageUploadOptions,
        setWasmOnlyMode: setImageUploadWasmOnlyMode
    } = useImageUploadPreferences();
    const imageUploadRuntime = useImageUploadRuntime();

    const siteForm = reactive({
        title: '',
        description: '',
        keywords: '',
        author: '',
        ogImage: DEFAULT_SITE_OG_IMAGE,
        baseUrl: '',
        faviconSvgUrl: DEFAULT_SITE_BRAND_CONFIG.faviconSvgUrl,
        faviconIcoUrl: DEFAULT_SITE_BRAND_CONFIG.faviconIcoUrl,
        faviconPngUrl: DEFAULT_SITE_BRAND_CONFIG.faviconPngUrl,
        appleTouchIconUrl: DEFAULT_SITE_BRAND_CONFIG.appleTouchIconUrl,
        manifestName: DEFAULT_SITE_BRAND_CONFIG.manifestName,
        manifestShortName: DEFAULT_SITE_BRAND_CONFIG.manifestShortName,
        pwaIcon192Url: DEFAULT_SITE_BRAND_CONFIG.pwaIcon192Url,
        pwaIcon512Url: DEFAULT_SITE_BRAND_CONFIG.pwaIcon512Url,
        pwaMaskableIconUrl: DEFAULT_SITE_BRAND_CONFIG.pwaMaskableIconUrl,
        themeColor: DEFAULT_SITE_BRAND_CONFIG.themeColor,
        backgroundColor: DEFAULT_SITE_BRAND_CONFIG.backgroundColor,
        siteLogoUrl: DEFAULT_SITE_BRAND_CONFIG.siteLogoUrl,
        siteLogoDarkUrl: DEFAULT_SITE_BRAND_CONFIG.siteLogoDarkUrl,
        siteWordmarkUrl: DEFAULT_SITE_BRAND_CONFIG.siteWordmarkUrl,
        adminLogoUrl: DEFAULT_SITE_BRAND_CONFIG.adminLogoUrl,
        adminCollapsedIconUrl: DEFAULT_SITE_BRAND_CONFIG.adminCollapsedIconUrl,
        loginLogoUrl: DEFAULT_SITE_BRAND_CONFIG.loginLogoUrl,
        loginIconUrl: DEFAULT_SITE_BRAND_CONFIG.loginIconUrl
    });
    const complianceForm = reactive<SiteComplianceConfigAdmin>({
        enabled: false,
        regionMode: 'global',
        copyrightOwner: '',
        copyrightStartYear: null,
        copyrightText: '',
        contentLicenseName: '',
        contentLicenseUrl: '',
        icpRecordNumber: '',
        icpRecordUrl: 'https://beian.miit.gov.cn/',
        policeRecordNumber: '',
        policeRecordUrl: 'https://beian.mps.gov.cn/',
        policeBadgeIconUrl: '',
        operatorName: '',
        contactEmail: ''
    });

    const siteTask = useAbortableTask();
    const complianceTask = useAbortableTask();
    const pageTask = useAbortableTask();
    const initialLoadTask = useAbortableTask();
    const taskFeedback = useAdminTaskFeedback();
    const imageUploadFlow = useImageUploadFlow({
        runtime: imageUploadRuntime,
        getOptions: () => imageUploadOptions.value,
        getWasmOnly: () => wasmOnlyMode.value,
        notify: {
            success: (message) => toast.success(message),
            warning: (message) => showWarningToast(message, message),
            error: (message) => showErrorToast(message, message)
        }
    });

    const previousOgImage = ref('');
    const originalSiteSnapshot = ref('');
    const originalComplianceSnapshot = ref('');
    const currentSlug = ref('about');
    const pageContent = ref('');
    const originalPageContent = ref('');
    const pendingPageSwitchSlug = ref('');
    const hasActivatedPagesTab = ref(false);
    const pageTargets = [
        { value: 'about', label: '关于我' },
        { value: 'privacy', label: '隐私政策' },
        { value: 'guidelines', label: '用户守则' },
        { value: 'copyright', label: '版权声明' }
    ] as const;
    let pageLoadGeneration = 0;
    let pageSaveGeneration = 0;
    let active = true;

    const buildSignalConfig = (signal: AbortSignal): ApiRequestConfig => ({ signal });

    const readStringField = (source: Record<string, unknown>, camel: string, pascal: string): string =>
    {
        const camelValue = source[camel];
        if (typeof camelValue === 'string')
        {
            return camelValue;
        }

        const pascalValue = source[pascal];
        return typeof pascalValue === 'string' ? pascalValue : '';
    };

    const normalizeSiteConfig = (value: unknown): SeoConfigAdmin =>
    {
        if (!value || typeof value !== 'object')
        {
            return {
                title: '',
                description: '',
                keywords: '',
                author: '',
                ogImage: DEFAULT_SITE_OG_IMAGE,
                baseUrl: '',
                ...DEFAULT_SITE_BRAND_CONFIG
            };
        }

        const source = value as Record<string, unknown>;
        return {
            title: readStringField(source, 'title', 'Title'),
            description: readStringField(source, 'description', 'Description'),
            keywords: readStringField(source, 'keywords', 'Keywords'),
            author: readStringField(source, 'author', 'Author'),
            ogImage: readStringField(source, 'ogImage', 'OgImage') || DEFAULT_SITE_OG_IMAGE,
            baseUrl: readStringField(source, 'baseUrl', 'BaseUrl'),
            faviconSvgUrl: readStringField(source, 'faviconSvgUrl', 'FaviconSvgUrl') || DEFAULT_SITE_BRAND_CONFIG.faviconSvgUrl,
            faviconIcoUrl: readStringField(source, 'faviconIcoUrl', 'FaviconIcoUrl') || DEFAULT_SITE_BRAND_CONFIG.faviconIcoUrl,
            faviconPngUrl: readStringField(source, 'faviconPngUrl', 'FaviconPngUrl') || DEFAULT_SITE_BRAND_CONFIG.faviconPngUrl,
            appleTouchIconUrl: readStringField(source, 'appleTouchIconUrl', 'AppleTouchIconUrl') || DEFAULT_SITE_BRAND_CONFIG.appleTouchIconUrl,
            manifestName: readStringField(source, 'manifestName', 'ManifestName') || DEFAULT_SITE_BRAND_CONFIG.manifestName,
            manifestShortName: readStringField(source, 'manifestShortName', 'ManifestShortName') || DEFAULT_SITE_BRAND_CONFIG.manifestShortName,
            pwaIcon192Url: readStringField(source, 'pwaIcon192Url', 'PwaIcon192Url') || DEFAULT_SITE_BRAND_CONFIG.pwaIcon192Url,
            pwaIcon512Url: readStringField(source, 'pwaIcon512Url', 'PwaIcon512Url') || DEFAULT_SITE_BRAND_CONFIG.pwaIcon512Url,
            pwaMaskableIconUrl: readStringField(source, 'pwaMaskableIconUrl', 'PwaMaskableIconUrl') || DEFAULT_SITE_BRAND_CONFIG.pwaMaskableIconUrl,
            themeColor: readStringField(source, 'themeColor', 'ThemeColor') || DEFAULT_SITE_BRAND_CONFIG.themeColor,
            backgroundColor: readStringField(source, 'backgroundColor', 'BackgroundColor') || DEFAULT_SITE_BRAND_CONFIG.backgroundColor,
            siteLogoUrl: readStringField(source, 'siteLogoUrl', 'SiteLogoUrl'),
            siteLogoDarkUrl: readStringField(source, 'siteLogoDarkUrl', 'SiteLogoDarkUrl'),
            siteWordmarkUrl: readStringField(source, 'siteWordmarkUrl', 'SiteWordmarkUrl'),
            adminLogoUrl: readStringField(source, 'adminLogoUrl', 'AdminLogoUrl'),
            adminCollapsedIconUrl: readStringField(source, 'adminCollapsedIconUrl', 'AdminCollapsedIconUrl'),
            loginLogoUrl: readStringField(source, 'loginLogoUrl', 'LoginLogoUrl'),
            loginIconUrl: readStringField(source, 'loginIconUrl', 'LoginIconUrl')
        };
    };

    const readBooleanField = (source: Record<string, unknown>, camel: string, pascal: string): boolean =>
    {
        const value = source[camel] ?? source[pascal];
        return value === true || value === 'true';
    };

    const readNullableNumberField = (source: Record<string, unknown>, camel: string, pascal: string): number | null =>
    {
        const value = source[camel] ?? source[pascal];
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
    };

    const normalizeComplianceConfig = (value: unknown): SiteComplianceConfigAdmin =>
    {
        if (!value || typeof value !== 'object')
        {
            return { ...complianceForm };
        }

        const source = value as Record<string, unknown>;
        return {
            enabled: readBooleanField(source, 'enabled', 'Enabled'),
            regionMode: 'global',
            copyrightOwner: readStringField(source, 'copyrightOwner', 'CopyrightOwner'),
            copyrightStartYear: readNullableNumberField(source, 'copyrightStartYear', 'CopyrightStartYear'),
            copyrightText: readStringField(source, 'copyrightText', 'CopyrightText'),
            contentLicenseName: readStringField(source, 'contentLicenseName', 'ContentLicenseName'),
            contentLicenseUrl: readStringField(source, 'contentLicenseUrl', 'ContentLicenseUrl'),
            icpRecordNumber: readStringField(source, 'icpRecordNumber', 'IcpRecordNumber'),
            icpRecordUrl: readStringField(source, 'icpRecordUrl', 'IcpRecordUrl') || 'https://beian.miit.gov.cn/',
            policeRecordNumber: readStringField(source, 'policeRecordNumber', 'PoliceRecordNumber'),
            policeRecordUrl: readStringField(source, 'policeRecordUrl', 'PoliceRecordUrl') || 'https://beian.mps.gov.cn/',
            policeBadgeIconUrl: readStringField(source, 'policeBadgeIconUrl', 'PoliceBadgeIconUrl'),
            operatorName: readStringField(source, 'operatorName', 'OperatorName'),
            contactEmail: readStringField(source, 'contactEmail', 'ContactEmail')
        };
    };

    const normalizedBaseUrl = computed(() => siteForm.baseUrl.trim().replace(/\/+$/u, ''));

    const resolveAssetDisplayUrl = (value: string): string =>
    {
        const url = value.trim();
        if (!url)
        {
            return '';
        }

        if (/^https?:\/\//u.test(url))
        {
            try
            {
                const parsed = new URL(url);
                return mountedBrowserBaseUrl.value && parsed.origin === mountedBrowserBaseUrl.value ? url : '';
            }
            catch
            {
                return '';
            }
        }

        if (url.startsWith('//'))
        {
            return '';
        }

        return url.startsWith('/') ? url : `/${url}`;
    };

    const displayUrl = computed(() => resolveAssetDisplayUrl(siteForm.ogImage));
    const resolveBrandAssetPreviewUrl = (field: BrandAssetField): string => resolveAssetDisplayUrl(siteForm[field]);
    const computedKeywords = computed(() =>
    siteForm.keywords ? siteForm.keywords.split(',').map((value) => value.trim()).filter((value) => value) : []);
    const hasOgImage = computed(() => Boolean(siteForm.ogImage));
    const loadingSite = computed(() => initialLoadTask.isRunning.value);
    const loadingCompliance = computed(() => complianceTask.isRunning.value);
    const siteFormDisabled = computed(() => loadingSite.value || savingSite.value || siteLoadFailed.value);
    const complianceFormDisabled = computed(() => loadingCompliance.value || savingCompliance.value || complianceLoadFailed.value);
    const siteSubmitText = computed(() => (savingSite.value ? '保存中...' : '保存同步'));
    const complianceSubmitText = computed(() => (savingCompliance.value ? '保存中...' : '保存合规信息'));
    const pageSubmitText = computed(() => (savingPage.value ? '发布中...' : '发布更新'));
    const isPageDirty = computed(() => pageContent.value !== originalPageContent.value);
    const currentPageTarget = computed(() => pageTargets.find((item) => item.value === currentSlug.value) ?? pageTargets[0]);
    const pageContentLength = computed(() => pageContent.value.trim().length);
    const siteSearchPreview = computed(() => ({
        title: siteForm.title.trim() || "Fsu's Blog",
        url: normalizedBaseUrl.value || 'https://fsus.blog',
        description: siteForm.description.trim() || '站点描述将在这里显示。'
    }));
    const compliancePreview = computed(() => ({
        copyright: `© ${resolveComplianceYearText()} ${complianceForm.copyrightOwner.trim() || siteForm.title.trim() || "Fsu's Blog"}。${complianceForm.copyrightText.trim() || '保留所有权利。'}`,
        icp: complianceForm.icpRecordNumber.trim(),
        police: complianceForm.policeRecordNumber.trim(),
        license: complianceForm.contentLicenseName.trim()
    }));
    const mainlandLaunchChecklist = computed(() => [
        { label: '基础 URL 已配置', done: Boolean(siteForm.baseUrl.trim()) },
        { label: 'ICP 备案号已配置', done: Boolean(complianceForm.icpRecordNumber.trim()) },
        { label: '公安备案号已配置', done: Boolean(complianceForm.policeRecordNumber.trim()) },
        { label: '隐私政策已纳入页面编辑', done: pageTargets.some((item) => item.value === 'privacy') },
        { label: '用户守则已纳入页面编辑', done: pageTargets.some((item) => item.value === 'guidelines') },
        { label: '版权声明已纳入页面编辑', done: pageTargets.some((item) => item.value === 'copyright') },
        { label: 'RSS 公开入口可访问', done: true },
        { label: 'sitemap 与 robots 公开分发已启用', done: true }
    ]);

    const serializeSiteForm = (): string => JSON.stringify({
        title: siteForm.title.trim(),
        description: siteForm.description.trim(),
        keywords: siteForm.keywords.trim(),
        author: siteForm.author.trim(),
        ogImage: siteForm.ogImage.trim(),
        baseUrl: normalizedBaseUrl.value,
        faviconSvgUrl: siteForm.faviconSvgUrl.trim(),
        faviconIcoUrl: siteForm.faviconIcoUrl.trim(),
        faviconPngUrl: siteForm.faviconPngUrl.trim(),
        appleTouchIconUrl: siteForm.appleTouchIconUrl.trim(),
        manifestName: siteForm.manifestName.trim(),
        manifestShortName: siteForm.manifestShortName.trim(),
        pwaIcon192Url: siteForm.pwaIcon192Url.trim(),
        pwaIcon512Url: siteForm.pwaIcon512Url.trim(),
        pwaMaskableIconUrl: siteForm.pwaMaskableIconUrl.trim(),
        themeColor: siteForm.themeColor.trim(),
        backgroundColor: siteForm.backgroundColor.trim(),
        siteLogoUrl: siteForm.siteLogoUrl.trim(),
        siteLogoDarkUrl: siteForm.siteLogoDarkUrl.trim(),
        siteWordmarkUrl: siteForm.siteWordmarkUrl.trim(),
        adminLogoUrl: siteForm.adminLogoUrl.trim(),
        adminCollapsedIconUrl: siteForm.adminCollapsedIconUrl.trim(),
        loginLogoUrl: siteForm.loginLogoUrl.trim(),
        loginIconUrl: siteForm.loginIconUrl.trim()
    });
    const serializeComplianceForm = (): string => JSON.stringify({
        enabled: complianceForm.enabled,
        regionMode: 'global',
        copyrightOwner: complianceForm.copyrightOwner.trim(),
        copyrightStartYear: complianceForm.copyrightStartYear,
        copyrightText: complianceForm.copyrightText.trim(),
        contentLicenseName: complianceForm.contentLicenseName.trim(),
        contentLicenseUrl: complianceForm.contentLicenseUrl.trim(),
        icpRecordNumber: complianceForm.icpRecordNumber.trim(),
        icpRecordUrl: complianceForm.icpRecordUrl.trim(),
        policeRecordNumber: complianceForm.policeRecordNumber.trim(),
        policeRecordUrl: complianceForm.policeRecordUrl.trim(),
        policeBadgeIconUrl: complianceForm.policeBadgeIconUrl.trim(),
        operatorName: complianceForm.operatorName.trim(),
        contactEmail: complianceForm.contactEmail.trim()
    });

    const isSiteDirty = computed(() => serializeSiteForm() !== originalSiteSnapshot.value);
    const isComplianceDirty = computed(() => serializeComplianceForm() !== originalComplianceSnapshot.value);
    const siteChangeSummary = computed(() =>
    {
        if (!originalSiteSnapshot.value)
        {
            return [];
        }

        const before = JSON.parse(originalSiteSnapshot.value) as Record<string, string>;
        const after = JSON.parse(serializeSiteForm()) as Record<string, string>;
        const labels: Record<string, string> = {
            title: '网站标题',
            description: 'SEO 描述',
            keywords: '关键词',
            author: '作者名称',
            ogImage: '社交分享图',
            baseUrl: '站点基础 URL',
            faviconSvgUrl: 'SVG favicon',
            faviconIcoUrl: 'ICO favicon',
            faviconPngUrl: 'PNG favicon',
            appleTouchIconUrl: 'Apple Touch Icon',
            manifestName: 'PWA 名称',
            manifestShortName: 'PWA 短名称',
            pwaIcon192Url: 'PWA 192 图标',
            pwaIcon512Url: 'PWA 512 图标',
            pwaMaskableIconUrl: 'PWA maskable 图标',
            themeColor: '主题色',
            backgroundColor: '启动背景色',
            siteLogoUrl: '站点 Logo',
            siteLogoDarkUrl: '深色站点 Logo',
            siteWordmarkUrl: '站点字标',
            adminLogoUrl: '后台 Logo',
            adminCollapsedIconUrl: '后台折叠图标',
            loginLogoUrl: '登录 Logo',
            loginIconUrl: '登录图标'
        };

        return Object.keys(labels).filter((key) => before[key] !== after[key]).map((key) => labels[key]);
    });

    const sanitizeKeywords = (): void =>
    {
        if (!siteForm.keywords)
        {
            return;
        }

        const raw = siteForm.keywords.replace(/，/g, ',').replace(/[<>"/\\`]/g, '');
        siteForm.keywords = Array.from(new Set(raw.split(',')))
            .map((value) => value.trim())
            .filter((value) => value)
            .join(',');
    };

    const validateBaseUrl = (url: string): boolean =>
    {
        try
        {
            const parsed = new URL(url);
            return ['http:', 'https:'].includes(parsed.protocol);
        }
        catch
        {
            return false;
        }
    };

    const resolveComplianceYearText = (): string =>
    {
        const currentYear = new Date().getFullYear();
        const startYear = complianceForm.copyrightStartYear;
        return startYear && startYear < currentYear ? `${startYear}-${currentYear}` : `${currentYear}`;
    };

    const validateOptionalHttpUrl = (url: string): boolean =>
    {
        const value = url.trim();
        return !value || validateBaseUrl(value);
    };

    const validateAssetUrl = (url: string): boolean =>
    {
        const value = url.trim();
        if (!value)
        {
            return true;
        }

        if (value.startsWith('//') || value.includes('\u0000'))
        {
            return false;
        }

        if (value.startsWith('/'))
        {
            return value.length > 1;
        }

        return validateBaseUrl(value);
    };

    const validateHexColor = (color: string): boolean => /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu.test(color.trim());

    const isBrandAssetField = (value: string): value is BrandAssetField => BRAND_ASSET_FIELDS.has(value as BrandAssetField);

    const isSvgUpload = (file: File): boolean => file.type.toLowerCase().includes('svg') || /\.svg$/iu.test(file.name);

    const isIcoUpload = (file: File): boolean =>
    {
        const mimeType = file.type.trim().toLowerCase();
        return mimeType === 'image/x-icon'
      || mimeType === 'image/vnd.microsoft.icon'
      || /\.ico$/iu.test(file.name);
    };

    const uploadBrandAssetFile = async (
        file: File,
        format: BrandAssetUploadFormat,
        bypassCompression: boolean
    ): Promise<string> =>
    {
        const uploadOptions: ImageCompressionOptions = bypassCompression
            ? RAW_ASSET_UPLOAD_OPTIONS
            : {
        ...imageUploadOptions.value,
        format: format === 'ico' ? 'png' : format,
        preserveAlpha: format === 'png' ? true : imageUploadOptions.value.preserveAlpha
      };

        return imageUploadRuntime.uploadFile(
            file,
            uploadOptions,
            {
                wasmOnly: bypassCompression ? false : wasmOnlyMode.value,
                bypassCompression,
                targetFormat: format
            }
        );
    };

    const collectComplianceWarnings = (): string[] =>
    {
        const warnings: string[] = [];
        const icp = complianceForm.icpRecordNumber.trim();
        const police = complianceForm.policeRecordNumber.trim();
        if (icp && !/^[\u4e00-\u9fa5]ICP备\d{8,12}号(-\d+)?$/u.test(icp))
        {
            warnings.push('ICP 备案号格式需要人工复核');
        }
        if (police && !/^[\u4e00-\u9fa5]公网安备\d{14}号$/u.test(police))
        {
            warnings.push('公安备案号格式需要人工复核');
        }
        return warnings;
    };

    const syncSeoConfig = async (signal?: AbortSignal): Promise<void> =>
    {
        try
        {
            sanitizeKeywords();
            if (siteForm.baseUrl)
            {
                siteForm.baseUrl = normalizedBaseUrl.value;
                if (!validateBaseUrl(siteForm.baseUrl))
                {
                    throw createAppError(AppErrorCode.Validation, 'BASEURL_PROTOCOL_INVALID');
                }
            }
            siteForm.faviconSvgUrl = siteForm.faviconSvgUrl.trim();
            siteForm.faviconIcoUrl = siteForm.faviconIcoUrl.trim();
            siteForm.faviconPngUrl = siteForm.faviconPngUrl.trim();
            siteForm.appleTouchIconUrl = siteForm.appleTouchIconUrl.trim();
            siteForm.manifestName = siteForm.manifestName.trim();
            siteForm.manifestShortName = siteForm.manifestShortName.trim();
            siteForm.pwaIcon192Url = siteForm.pwaIcon192Url.trim();
            siteForm.pwaIcon512Url = siteForm.pwaIcon512Url.trim();
            siteForm.pwaMaskableIconUrl = siteForm.pwaMaskableIconUrl.trim();
            siteForm.themeColor = siteForm.themeColor.trim().toLowerCase();
            siteForm.backgroundColor = siteForm.backgroundColor.trim().toLowerCase();
            siteForm.siteLogoUrl = siteForm.siteLogoUrl.trim();
            siteForm.siteLogoDarkUrl = siteForm.siteLogoDarkUrl.trim();
            siteForm.siteWordmarkUrl = siteForm.siteWordmarkUrl.trim();
            siteForm.adminLogoUrl = siteForm.adminLogoUrl.trim();
            siteForm.adminCollapsedIconUrl = siteForm.adminCollapsedIconUrl.trim();
            siteForm.loginLogoUrl = siteForm.loginLogoUrl.trim();
            siteForm.loginIconUrl = siteForm.loginIconUrl.trim();

            await updateSiteConfig({ ...siteForm }, signal ? buildSignalConfig(signal) : undefined);
            previousOgImage.value = siteForm.ogImage;
            originalSiteSnapshot.value = serializeSiteForm();
        }
        catch (error: unknown)
        {
            if (!isAbortError(error))
            {
                siteForm.ogImage = previousOgImage.value;
                const normalized = toAppError(error, '配置同步失败，已回退状态');
                const message = getKnownErrorInfo(normalized).message;
                const errorMsg = message === 'BASEURL_PROTOCOL_INVALID' ? '站点URL协议不合法' : '配置同步失败，已回退状态';
                showWarningToast(normalized, errorMsg);
                throw normalized;
            }
        }
    };

    const handleImageAction = async (options: UploadRequestOptions): Promise<void> =>
    {
        const file = options.file as File;
        imageLoading.value = true;
        previousOgImage.value = siteForm.ogImage;
        try
        {
            await imageUploadFlow.startUpload({
                files: [file],
                messages: {
                    uploadFailed: '配置图上传失败，可继续恢复',
                    uploadSucceeded: '配置图已更新'
                },
                onSuccess: async ([url]) =>
                {
                    siteForm.ogImage = url;
                    await nextTick();
                    toast.success('配置图已更新，请保存同步');
                },
                onError: (message, error) =>
                {
                    if (!isAbortError(error))
                    {
                        console.error('[Settings] Upload failed:', error);
                        siteForm.ogImage = previousOgImage.value;
                        showErrorToast(error, message);
                    }
                }
            });
        }
        finally
        {
            imageLoading.value = false;
        }
    };

    const handleBrandAssetUpload = async (options: UploadRequestOptions, targetFieldValue: string): Promise<void> =>
    {
        if (!isBrandAssetField(targetFieldValue))
        {
            showWarningToast('品牌资产字段不受支持', '品牌资产字段不受支持');
            return;
        }

        const targetField = targetFieldValue;
        const file = options.file as File;
        if (isSvgUpload(file))
        {
            showWarningToast('不支持 SVG 上传，请填写已清洗的 SVG URL', '不支持 SVG 上传，请填写已清洗的 SVG URL');
            return;
        }

        const isIcoTarget = targetField === 'faviconIcoUrl';
        if (isIcoTarget && !isIcoUpload(file))
        {
            showWarningToast('ICO favicon 只接受 .ico 文件；PNG/JPG/WebP 请使用图标组生成', 'ICO favicon 只接受 .ico 文件；PNG/JPG/WebP 请使用图标组生成');
            return;
        }
        if (!isIcoTarget && !isRasterBrandIconSource(file))
        {
            showWarningToast('品牌资产上传只支持 PNG、JPG 或 WebP', '品牌资产上传只支持 PNG、JPG 或 WebP');
            return;
        }

        const previousUrl = siteForm[targetField];
        brandAssetUploadingField.value = targetField;
        try
        {
            const url = await uploadBrandAssetFile(file, isIcoTarget ? 'ico' : 'png', isIcoTarget);
            siteForm[targetField] = url;
            await nextTick();
            toast.success(`${BRAND_ASSET_FIELD_LABELS[targetField]} 已更新，请保存同步`);
        }
        catch (error: unknown)
        {
            siteForm[targetField] = previousUrl;
            if (!isAbortError(error))
            {
                showErrorToast(error, `${BRAND_ASSET_FIELD_LABELS[targetField]} 上传失败`);
            }
        }
        finally
        {
            brandAssetUploadingField.value = '';
        }
    };

    const handleFaviconSetGeneration = async (options: UploadRequestOptions): Promise<void> =>
    {
        const file = options.file as File;
        if (isSvgUpload(file) || !isRasterBrandIconSource(file))
        {
            showWarningToast('图标组生成只支持 PNG、JPG 或 WebP，不支持 SVG 上传，请填写已清洗的 SVG URL', '图标组生成只支持 PNG、JPG 或 WebP');
            return;
        }

        const previousUrls = new Map<BrandIconField, string>();
        iconSetGenerating.value = true;
        try
        {
            const generated = await generateBrandIconSet(file);
            for (const assignment of generated)
            {
                previousUrls.set(assignment.field, siteForm[assignment.field]);
                brandAssetUploadingField.value = assignment.field;
                const url = await uploadBrandAssetFile(assignment.file, assignment.format, true);
                siteForm[assignment.field] = url;
            }
            await nextTick();
            toast.success('图标组已生成，请保存同步');
        }
        catch (error: unknown)
        {
            previousUrls.forEach((url, field) =>
            {
                siteForm[field] = url;
            });
            if (!isAbortError(error))
            {
                showErrorToast(error, '图标组生成失败');
            }
        }
        finally
        {
            iconSetGenerating.value = false;
            brandAssetUploadingField.value = '';
        }
    };

    const resumeImageUpload = async (): Promise<void> =>
    {
        imageLoading.value = true;
        previousOgImage.value = siteForm.ogImage;
        try
        {
            await imageUploadFlow.resumeUpload({
                messages: {
                    resumeMissing: '没有可恢复的上传任务',
                    resumeFailed: '恢复上传失败',
                    uploadSucceeded: '配置图恢复上传成功'
                },
                onSuccess: async ([url]) =>
                {
                    siteForm.ogImage = url;
                    await nextTick();
                    toast.success('配置图恢复上传成功，请保存同步');
                },
                onError: (message, error) =>
                {
                    if (!isAbortError(error))
                    {
                        console.error('[Settings] Resume upload failed:', error);
                        siteForm.ogImage = previousOgImage.value;
                        showErrorToast(error, message);
                    }
                }
            });
        }
        finally
        {
            imageLoading.value = false;
        }
    };

    const handleImageRemove = async (): Promise<void> =>
    {
        imageLoading.value = true;
        previousOgImage.value = siteForm.ogImage;

        try
        {
            siteForm.ogImage = '';
            toast.success('预览图已从待保存配置移除，请保存同步');
        }
        finally
        {
            imageLoading.value = false;
        }
    };

    const handleImageDelete = async (): Promise<void> =>
    {
        const current = siteForm.ogImage;
        if (!current)
        {
            return;
        }

        imageLoading.value = true;
        previousOgImage.value = current;
        try
        {
            const asset = (await listAssetLibrary()).find(item => item.url === current);
            if (!asset)
            {
                throw createAppError(
                    AppErrorCode.NotFound,
                    '当前图片不是可删除的本地资产'
                );
            }
            await deleteImage(asset.id);
            siteForm.ogImage = '';
            toast.success('预览图已从配置移除并删除服务器文件，请保存同步');
        }
        catch (error: unknown)
        {
            siteForm.ogImage = previousOgImage.value;
            showErrorToast(error, '服务器文件删除失败');
        }
        finally
        {
            imageLoading.value = false;
        }
    };

    const saveSiteConfig = async (): Promise<void> =>
    {
        if (loadingSite.value)
        {
            showWarningToast('站点配置仍在加载，请稍后保存', '站点配置仍在加载，请稍后保存');
            return;
        }

        sanitizeKeywords();

        if (!siteForm.title.trim())
        {
            showWarningToast('标题不可为空', '标题不可为空');
            return;
        }
        if (!siteForm.author.trim())
        {
            showWarningToast('作者名称不可为空', '作者名称不可为空');
            return;
        }
        if (!siteForm.baseUrl.trim() || !validateBaseUrl(siteForm.baseUrl))
        {
            showWarningToast('请提供合法的站点基础 URL (http/https)', '请提供合法的站点基础 URL (http/https)');
            return;
        }
        if (!siteForm.manifestName.trim() || !siteForm.manifestShortName.trim())
        {
            showWarningToast('PWA 名称和短名称不可为空', 'PWA 名称和短名称不可为空');
            return;
        }

        const assetUrls = [
            siteForm.ogImage,
            siteForm.faviconSvgUrl,
            siteForm.faviconIcoUrl,
            siteForm.faviconPngUrl,
            siteForm.appleTouchIconUrl,
            siteForm.pwaIcon192Url,
            siteForm.pwaIcon512Url,
            siteForm.pwaMaskableIconUrl,
            siteForm.siteLogoUrl,
            siteForm.siteLogoDarkUrl,
            siteForm.siteWordmarkUrl,
            siteForm.adminLogoUrl,
            siteForm.adminCollapsedIconUrl,
            siteForm.loginLogoUrl,
            siteForm.loginIconUrl
        ];
        if (assetUrls.some((url) => !validateAssetUrl(url)))
        {
            showWarningToast('品牌资产 URL 仅支持站内路径或 http/https', '品牌资产 URL 仅支持站内路径或 http/https');
            return;
        }
        if (!validateHexColor(siteForm.themeColor) || !validateHexColor(siteForm.backgroundColor))
        {
            showWarningToast('主题色和背景色需使用 #RGB 或 #RRGGBB', '主题色和背景色需使用 #RGB 或 #RRGGBB');
            return;
        }

        savingSite.value = true;
        taskFeedback.begin('正在保存站点信息', '保存后将清理 AOT 缓存', 'settings-site');
        try
        {
            await siteTask.run(async (signal) =>
            {
                await syncSeoConfig(signal);
                if (!signal.aborted)
                {
                    taskFeedback.succeed('站点信息已保存', 'SEO 配置已同步并刷新缓存', 'settings-site');
                    toast.success('SEO 配置同步成功');
                }
            });
        }
        catch (error: unknown)
        {
            if (!isAbortError(error))
            {
                taskFeedback.fail('站点信息保存失败', error, '站点信息保存失败', 'settings-site');
            }
        }
        finally
        {
            savingSite.value = false;
        }
    };

    const loadSiteConfig = async (): Promise<void> =>
    {
        try
        {
            siteLoadFailed.value = false;
            await initialLoadTask.run(async (signal) =>
            {
                const data = await getAdminSiteConfig(buildSignalConfig(signal));
                if (!data)
                {
                    return;
                }

                const normalized = normalizeSiteConfig(data);
                Object.assign(siteForm, normalized);
                previousOgImage.value = siteForm.ogImage;
                sanitizeKeywords();
                originalSiteSnapshot.value = serializeSiteForm();
            });
        }
        catch (error: unknown)
        {
            if (!isAbortError(error))
            {
                siteLoadFailed.value = true;
                console.error('[Settings] Fetch Error:', error);
            }
        }
    };

    const loadComplianceConfig = async (): Promise<void> =>
    {
        try
        {
            complianceLoadFailed.value = false;
            await complianceTask.run(async (signal) =>
            {
                const data = await getAdminSiteComplianceConfig(buildSignalConfig(signal));
                if (!data || signal.aborted)
                {
                    return;
                }

                Object.assign(complianceForm, normalizeComplianceConfig(data));
                originalComplianceSnapshot.value = serializeComplianceForm();
            });
        }
        catch (error: unknown)
        {
            if (!isAbortError(error))
            {
                complianceLoadFailed.value = true;
                console.error('[Settings] Compliance fetch error:', error);
            }
        }
    };

    const saveComplianceConfig = async (): Promise<void> =>
    {
        if (loadingCompliance.value)
        {
            showWarningToast('合规配置仍在加载，请稍后保存', '合规配置仍在加载，请稍后保存');
            return;
        }

        const currentYear = new Date().getFullYear();
        const startYear = complianceForm.copyrightStartYear;
        if (startYear !== null && (startYear < 1990 || startYear > currentYear))
        {
            showWarningToast(`版权起始年份需在 1990 到 ${currentYear} 之间`, `版权起始年份需在 1990 到 ${currentYear} 之间`);
            return;
        }

        const urls = [
            complianceForm.icpRecordUrl,
            complianceForm.policeRecordUrl,
            complianceForm.policeBadgeIconUrl,
            complianceForm.contentLicenseUrl
        ];
        if (urls.some((url) => !validateOptionalHttpUrl(url)))
        {
            showWarningToast('链接只支持 http/https 协议', '链接只支持 http/https 协议');
            return;
        }

        const warnings = collectComplianceWarnings();
        if (warnings.length > 0)
        {
            showWarningToast(warnings.join('，'), warnings.join('，'));
        }

        savingCompliance.value = true;
        taskFeedback.begin('正在保存大陆合规信息', '保存后将刷新公开 footer、RSS 和 AOT 缓存', 'settings-compliance');
        try
        {
            await complianceTask.run(async (signal) =>
            {
                await updateSiteComplianceConfig({ ...complianceForm, regionMode: 'global' }, buildSignalConfig(signal));
                if (!signal.aborted)
                {
                    originalComplianceSnapshot.value = serializeComplianceForm();
                    taskFeedback.succeed('大陆合规信息已保存', '公开 footer 与缓存已刷新', 'settings-compliance');
                    toast.success('合规信息已保存并刷新公开缓存');
                }
            });
        }
        catch (error: unknown)
        {
            if (!isAbortError(error))
            {
                taskFeedback.fail('大陆合规信息保存失败', error, '大陆合规信息保存失败', 'settings-compliance');
                showErrorToast(error, '大陆合规信息保存失败');
            }
        }
        finally
        {
            savingCompliance.value = false;
        }
    };

    const loadPage = async (slug: string): Promise<boolean> =>
    {
        const generation = ++pageLoadGeneration;
        pageLoading.value = true;
        try
        {
            let loaded = false;
            await pageTask.run(async (signal) =>
            {
                const data = await getAdminPageData(slug, buildSignalConfig(signal));
                if (!signal.aborted && active && generation === pageLoadGeneration && activeTab.value === 'pages')
                {
                    currentSlug.value = slug;
                    pageContent.value = data?.content || '';
                    originalPageContent.value = pageContent.value;
                    loaded = true;
                }
            });
            return loaded;
        }
        catch (error: unknown)
        {
            if (!isAbortError(error))
            {
                console.error('[Settings] Load failed:', error);
            }
            return false;
        }
        finally
        {
            if (generation === pageLoadGeneration)
            {
                pageLoading.value = false;
            }
        }
    };

    const savePageContent = async (): Promise<boolean> =>
    {
        if (savingPage.value)
        {
            return false;
        }

        const generation = ++pageSaveGeneration;
        const savedSlug = currentSlug.value;
        const savedContent = pageContent.value;
        try
        {
            savingPage.value = true;
            taskFeedback.begin('正在发布静态页面', currentPageTarget.value.label, 'settings-page');
            await updatePageData({ slug: savedSlug, content: savedContent });
            await refreshPageData(savedSlug);
            if (!active || generation !== pageSaveGeneration || currentSlug.value !== savedSlug || pageContent.value !== savedContent)
            {
                return false;
            }
            originalPageContent.value = savedContent;
            taskFeedback.succeed('静态页面已发布', currentPageTarget.value.label, 'settings-page');
            toast.success('发布并刷新缓存成功');
            return true;
        }
        catch (error: unknown)
        {
            taskFeedback.fail('静态页面发布失败', error, '静态页面发布失败', 'settings-page');
            showErrorToast(error, '静态页面发布失败');
            return false;
        }
        finally
        {
            savingPage.value = false;
        }
    };

    const refreshPageCache = async (): Promise<void> =>
    {
        refreshingPage.value = true;
        taskFeedback.begin('正在刷新页面缓存', currentPageTarget.value.label, 'settings-page');
        try
        {
            await refreshPageData(currentSlug.value);
            taskFeedback.succeed('页面缓存已刷新', currentPageTarget.value.label, 'settings-page');
            toast.success('页面缓存已刷新');
        }
        catch (error: unknown)
        {
            taskFeedback.fail('页面缓存刷新失败', error, '页面缓存刷新失败', 'settings-page');
            showErrorToast(error, '页面缓存刷新失败');
        }
        finally
        {
            refreshingPage.value = false;
        }
    };

    const switchPage = async (slug: string): Promise<void> =>
    {
        if (slug === currentSlug.value)
        {
            return;
        }

        await loadPage(slug);
    };

    const requestPageSwitch = async (value: unknown): Promise<void> =>
    {
        if (typeof value !== 'string')
        {
            return;
        }

        const slug = value;
        if (slug === currentSlug.value)
        {
            return;
        }

        if (isPageDirty.value)
        {
            pendingPageSwitchSlug.value = slug;
            return;
        }

        await switchPage(slug);
    };

    const cancelPageSwitch = (): void =>
    {
        pendingPageSwitchSlug.value = '';
    };

    const discardPageChangesAndSwitch = async (): Promise<void> =>
    {
        const slug = pendingPageSwitchSlug.value;
        pendingPageSwitchSlug.value = '';
        pageContent.value = originalPageContent.value;
        if (slug)
        {
            await switchPage(slug);
        }
    };

    const savePageAndSwitch = async (): Promise<void> =>
    {
        if (!pendingPageSwitchSlug.value || savingPage.value)
        {
            return;
        }

        const saved = await savePageContent();
        if (!saved || activeTab.value !== 'pages')
        {
            return;
        }
        const slug = pendingPageSwitchSlug.value;
        pendingPageSwitchSlug.value = '';
        if (slug)
        {
            await switchPage(slug);
        }
    };

    const handleBeforeUnload = (event: BeforeUnloadEvent): void =>
    {
        if (!isPageDirty.value)
        {
            return;
        }

        event.preventDefault();
        event.returnValue = '';
    };

    watch(activeTab, (value) =>
    {
        if (value !== 'pages')
        {
            pageLoadGeneration += 1;
            pageTask.cancel();
            pageLoading.value = false;
            return;
        }

        hasActivatedPagesTab.value = true;
        void loadPage(currentSlug.value);
    }, { immediate: true });

    onMounted(() =>
    {
        if (!mountedBrowserBaseUrl.value && typeof window !== 'undefined')
        {
            mountedBrowserBaseUrl.value = window.location.origin;
        }
        window.addEventListener('beforeunload', handleBeforeUnload);
        void loadSiteConfig();
        void loadComplianceConfig();
    });

    onUnmounted(() =>
    {
        active = false;
        pageLoadGeneration += 1;
        pageSaveGeneration += 1;
        window.removeEventListener('beforeunload', handleBeforeUnload);
        siteTask.cancel();
        complianceTask.cancel();
        pageTask.cancel();
        initialLoadTask.cancel();
        imageUploadFlow.cancel();
        pageContent.value = '';
    });

    return {
        activeTab,
        taskFeedback,
        savingSite,
        savingCompliance,
        savingPage,
        refreshingPage,
        loadingSite,
        loadingCompliance,
        siteFormDisabled,
        complianceFormDisabled,
        siteLoadFailed,
        complianceLoadFailed,
        pageLoading,
        imageLoading,
        brandAssetUploadingField,
        iconSetGenerating,
        siteForm,
        complianceForm,
        currentSlug,
        pageContent,
        pageTargets,
        displayUrl,
        resolveBrandAssetPreviewUrl,
        hasOgImage,
        computedKeywords,
        normalizedBaseUrl,
        isSiteDirty,
        isComplianceDirty,
        siteChangeSummary,
        siteSearchPreview,
        compliancePreview,
        mainlandLaunchChecklist,
        siteSubmitText,
        complianceSubmitText,
        pageSubmitText,
        isPageDirty,
        currentPageTarget,
        pageContentLength,
        pendingPageSwitchSlug,
        imageUploadOptions,
        imageUploadWasmOnlyMode: wasmOnlyMode,
        setImageUploadWasmOnlyMode,
        setImageUploadOptions,
        imageUploadRuntime,
        resumeImageUpload,
        sanitizeKeywords,
        handleImageAction,
        handleBrandAssetUpload,
        handleFaviconSetGeneration,
        handleImageRemove,
        handleImageDelete,
        loadSiteConfig,
        loadComplianceConfig,
        saveSiteConfig,
        saveComplianceConfig,
        savePageContent,
        refreshPageCache,
        requestPageSwitch,
        cancelPageSwitch,
        discardPageChangesAndSwitch,
        savePageAndSwitch
    };
}
