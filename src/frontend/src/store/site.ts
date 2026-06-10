import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import {
  getSiteComplianceConfig,
  getSiteConfig,
  type SeoConfigPublic,
  type SiteComplianceConfigPublic
} from '@/api/system'
import { readPublicHydrationPayload } from '@/bootstrap/publicHydrationBootstrap'

export const DEFAULT_SITE_BRAND_CONFIG = {
  faviconSvgUrl: '/favicon.svg',
  faviconIcoUrl: '/favicon.ico',
  faviconPngUrl: '',
  appleTouchIconUrl: '/apple-touch-icon.png',
  manifestName: 'FsusBlog',
  manifestShortName: 'FsusBlog',
  pwaIcon192Url: '/icons/icon-192.png',
  pwaIcon512Url: '/icons/icon-512.png',
  pwaMaskableIconUrl: '/icons/maskable-512.png',
  themeColor: '#0f0f11',
  backgroundColor: '#fcfcfc',
  siteLogoUrl: '',
  siteLogoDarkUrl: '',
  siteWordmarkUrl: '',
  adminLogoUrl: '',
  adminCollapsedIconUrl: '',
  loginLogoUrl: '',
  loginIconUrl: ''
} as const

function resolveBaseUrl(): string {
  if (typeof window === 'undefined') {
    return 'https://fsus.blog'
  }

  return window.location.origin
}

export const useSiteStore = defineStore('site', () => {
  // ================= State =================
  const payload = readPublicHydrationPayload()

  const siteInfo = shallowRef<SeoConfigPublic>({
    title: payload?.siteTitle || payload?.title || "Fsu's Blog",
    description: payload?.siteDescription || "极简主义个人内容发布系统",
    keywords: "Minimalism, Blog, Fsu",
    author: "Fsu",
    ogImage: "",
    baseUrl: payload?.baseUrl || resolveBaseUrl(),
    ...DEFAULT_SITE_BRAND_CONFIG,
    siteLogoUrl: payload?.siteLogoUrl || DEFAULT_SITE_BRAND_CONFIG.siteLogoUrl,
    siteLogoDarkUrl: payload?.siteLogoDarkUrl || DEFAULT_SITE_BRAND_CONFIG.siteLogoDarkUrl,
    siteWordmarkUrl: payload?.siteWordmarkUrl || DEFAULT_SITE_BRAND_CONFIG.siteWordmarkUrl,
    loginLogoUrl: payload?.loginLogoUrl || DEFAULT_SITE_BRAND_CONFIG.loginLogoUrl,
    loginIconUrl: payload?.loginIconUrl || DEFAULT_SITE_BRAND_CONFIG.loginIconUrl
  })
  const complianceInfo = shallowRef<SiteComplianceConfigPublic | null>(payload?.compliance ?? null)

  const isLoaded = ref(Boolean(payload))

  // [新增] 移动端搜索层显示状态
  const isMobileSearchOpen = ref(false)

  let fetchPromise: Promise<void> | null = null

  // ================= Actions =================

  /**
   * [新增] 修改搜索层可见性 (解决 P1 级单向数据流)
   * 动作封装：所有状态变更必须通过 Action 触发，便于后续审计与拦截
   */
  const setMobileSearchVisible = (visible: boolean) => {
    isMobileSearchOpen.value = visible
  }

  /**
   * 拉取站点配置 (带任务池去抖)
   */
  const fetchSiteInfo = async (force = false) => {
    if (isLoaded.value && !force) return
    if (fetchPromise) return fetchPromise

    fetchPromise = (async () => {
      try {
        const [res, compliance] = await Promise.all([
          getSiteConfig(),
          getSiteComplianceConfig().catch((error) => {
            console.error('[SiteStore] 获取合规配置失败:', error)
            return null
          })
        ])
        if (res) {
          siteInfo.value = { ...DEFAULT_SITE_BRAND_CONFIG, ...res }
        }
        if (compliance) {
          complianceInfo.value = { ...compliance }
        }
        if (res || compliance) {
          isLoaded.value = true
        }
      } catch (error) {
        console.error('[SiteStore] 获取站点配置失败:', error)
      } finally {
        fetchPromise = null
      }
    })()

    return fetchPromise
  }

  return {
    siteInfo,
    complianceInfo,
    isLoaded,
    isMobileSearchOpen,
    fetchSiteInfo,
    setMobileSearchVisible
  }
})
