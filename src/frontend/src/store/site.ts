import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import { getSiteConfig, type SeoConfigPublic } from '@/api/system'
import { readPublicHydrationPayload } from '@/bootstrap/publicHydrationBootstrap'

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
    baseUrl: payload?.baseUrl || resolveBaseUrl()
  })

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
        const res = await getSiteConfig()
        if (res) {
          siteInfo.value = { ...res }
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
    isLoaded,
    isMobileSearchOpen,
    fetchSiteInfo,
    setMobileSearchVisible
  }
})
