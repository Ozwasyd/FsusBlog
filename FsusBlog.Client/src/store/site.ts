import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getSiteConfig, type SiteConfig } from '@/api/system'

export const useSiteStore = defineStore('site', () => {
  // ================= State =================
  const siteInfo = ref<SiteConfig>({
    title: "Fsu's Blog",
    description: "Loading...",
    keywords: "",
    author: "Fsu",
    ogImage: ""
  })

  const isLoaded = ref(false)
  let fetchPromise: Promise<void> | null = null

  // ================= Actions =================
  /**
   * 拉取站点配置 (带任务池去抖)
   */
  const fetchSiteInfo = async (force = false) => {
    if (isLoaded.value && !force) return
    if (fetchPromise) return fetchPromise

    fetchPromise = (async () => {
      try {
        const res = await getSiteConfig()
        siteInfo.value = res
        isLoaded.value = true
      } catch (error) {
        console.error('[SiteStore] 获取站点配置失败:', error)
        // 保持默认值，不阻塞后续逻辑
      } finally {
        fetchPromise = null
      }
    })()

    return fetchPromise
  }

  return { siteInfo, isLoaded, fetchSiteInfo }
})