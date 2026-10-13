import { defineStore } from 'pinia';
import { ref, shallowRef } from 'vue';

import {
    getSiteComplianceConfig,
    getSiteConfig,
    type SeoConfigPublic,
    type SiteComplianceConfigPublic
} from '@/api/system';
import { readPublicHydrationPayload } from '@/bootstrap/publicHydrationBootstrap';
import {
    normalizePublicComplianceConfig,
    normalizePublicSiteDescription,
    normalizePublicSiteTitle
} from '@/public-renderers/publicSiteIdentity';

type SiteBrandConfig = Omit<SeoConfigPublic, 'title' | 'description' | 'keywords' | 'author' | 'ogImage' | 'baseUrl'>;

export const DEFAULT_SITE_OG_IMAGE = '/social/og-image.png';

export const DEFAULT_SITE_BRAND_CONFIG: SiteBrandConfig = {
    faviconSvgUrl: '/favicon/favicon.svg',
    faviconIcoUrl: '/favicon/favicon.ico',
    faviconPngUrl: '/favicon/favicon-32x32.png',
    appleTouchIconUrl: '/favicon/apple-touch-icon.png',
    manifestName: "Fsu's Blog",
    manifestShortName: 'FsusBlog',
    pwaIcon192Url: '/favicon/pwa-192x192.png',
    pwaIcon512Url: '/favicon/pwa-512x512.png',
    pwaMaskableIconUrl: '/favicon/maskable-icon-512x512.png',
    themeColor: '#0B4F7A',
    backgroundColor: '#FFFFFF',
    siteLogoUrl: '',
    siteLogoDarkUrl: '',
    siteWordmarkUrl: '',
    adminLogoUrl: '',
    adminCollapsedIconUrl: '',
    loginLogoUrl: '',
    loginIconUrl: ''
};

const DEFAULT_SITE_KEYWORDS = '.NET, 前端性能, 系统设计, UI 系统, 技术博客, FsusBlog';

function resolveBaseUrl(): string
{
    if (typeof window === 'undefined')
    {
        return 'https://fsus.blog';
    }

    return window.location.origin;
}

export const useSiteStore = defineStore('site', () =>
{
    // ================= State =================
    const payload = readPublicHydrationPayload();

    const siteInfo = shallowRef<SeoConfigPublic>({
        title: normalizePublicSiteTitle(payload?.siteTitle ?? payload?.title),
        description: normalizePublicSiteDescription(payload?.siteDescription),
        keywords: DEFAULT_SITE_KEYWORDS,
        author: 'Fsu',
        ogImage: DEFAULT_SITE_OG_IMAGE,
        baseUrl: payload?.baseUrl || resolveBaseUrl(),
        ...DEFAULT_SITE_BRAND_CONFIG,
        siteLogoUrl: payload?.siteLogoUrl || DEFAULT_SITE_BRAND_CONFIG.siteLogoUrl,
        siteLogoDarkUrl: payload?.siteLogoDarkUrl || DEFAULT_SITE_BRAND_CONFIG.siteLogoDarkUrl,
        siteWordmarkUrl: payload?.siteWordmarkUrl || DEFAULT_SITE_BRAND_CONFIG.siteWordmarkUrl,
        loginLogoUrl: payload?.loginLogoUrl || DEFAULT_SITE_BRAND_CONFIG.loginLogoUrl,
        loginIconUrl: payload?.loginIconUrl || DEFAULT_SITE_BRAND_CONFIG.loginIconUrl
    });
    const complianceInfo = shallowRef<SiteComplianceConfigPublic | null>(normalizePublicComplianceConfig(payload?.compliance));

    const isLoaded = ref(Boolean(payload));

    let fetchPromise: Promise<void> | null = null;

    // ================= Actions =================

    /**
   * 拉取站点配置 (带任务池去抖)
   */
    const fetchSiteInfo = async (force = false) =>
    {
        if (isLoaded.value && !force)
        {
            return;
        }
        if (fetchPromise)
        {
            return fetchPromise;
        }

        fetchPromise = (async () =>
        {
            try
            {
                const [res, compliance] = await Promise.all([
                    getSiteConfig(),
                    getSiteComplianceConfig().catch((error) =>
                    {
                        console.error('[SiteStore] 获取合规配置失败:', error);
                        return null;
                    })
                ]);
                if (res)
                {
                    siteInfo.value = {
                        ...DEFAULT_SITE_BRAND_CONFIG,
                        ...res,
                        title: normalizePublicSiteTitle(res.title),
                        description: normalizePublicSiteDescription(res.description)
                    };
                }
                if (compliance)
                {
                    complianceInfo.value = normalizePublicComplianceConfig(compliance);
                }
                if (res || compliance)
                {
                    isLoaded.value = true;
                }
            }
            catch (error)
            {
                console.error('[SiteStore] 获取站点配置失败:', error);
            }
            finally
            {
                fetchPromise = null;
            }
        })();

        return fetchPromise;
    };

    return {
        siteInfo,
        complianceInfo,
        isLoaded,
        fetchSiteInfo
    };
});
