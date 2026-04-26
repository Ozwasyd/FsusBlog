import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import { getSiteConfig, type SeoConfigPublic } from '@/api/system'

export const useSiteStore = defineStore('site', () => {
  // ================= State =================
  const siteInfo = shallowRef<SeoConfigPublic>({
    title: "Fsu's Blog",
    description: "极简主义个人内容发布系统",
    keywords: "Minimalism, Blog, Fsu",
    author: "Fsu",
    ogImage: "",
    baseUrl: window.location.origin
  })

  const isLoaded = ref(false)
  
  // [新增] 移动端搜索层显示状态
  const isMobileSearchOpen = ref(false)
  
  // [新增] 物理滚动锁定计数器 (解决 P0 级冲突)
  // 逻辑自洽：通过引用计数法，确保全站多个弹出层共存时，只有最后一个关闭才会恢复滚动
  const scrollLockCount = ref(0)

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
   * [新增] 物理滚动锁定
   * 算法最优：仅在第一个弹出层打开时修改 DOM，后续仅增加计数，减少渲染开销
   */
  const lockScroll = () => {
    scrollLockCount.value++
    if (scrollLockCount.value === 1) {
      document.body.style.setProperty('overflow', 'hidden')
      document.body.style.setProperty('touch-action', 'none') // 防止 iOS 橡皮筋
    }
  }

  /**
   * [新增] 物理滚动解锁
   * 逻辑自洽：只有当所有弹出层都关闭（计数归零）时，才恢复 body 滚动
   */
  const unlockScroll = () => {
    if (scrollLockCount.value > 0) {
      scrollLockCount.value--
      if (scrollLockCount.value === 0) {
        forceUnlockScroll()
      }
    }
  }

  /**
   * [新增] 强制重置滚动锁定 (安全性保障)
   * 用于路由跳转或组件卸载时的物理兜底，防止白屏死锁
   */
  const forceUnlockScroll = () => {
    scrollLockCount.value = 0
    document.body.style.removeProperty('overflow')
    document.body.style.removeProperty('touch-action')
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
    // 导出新增方法
    setMobileSearchVisible,
    lockScroll,
    unlockScroll,
    forceUnlockScroll
  }
})
