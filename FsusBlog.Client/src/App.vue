<script setup lang="ts">
import { onMounted, computed, watch, onUnmounted } from 'vue'
import { RouterView } from 'vue-router'
import { ElConfigProvider } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import { useHead } from '@vueuse/head' 

import { useUserStore } from '@/store/user'
import { useSiteStore } from '@/store/site'
import { useNotification } from '@/composables/useNotification'
import { notificationService } from '@/services/notificationService'

const userStore = useUserStore()
const siteStore = useSiteStore()
// 从 composable 中获取初始化方法
const { initNotification } = useNotification()

/**
 * 动态 SEO 引擎
 */
useHead({
  titleTemplate: (titleChunk) => {
    const siteTitle = siteStore.siteInfo.title
    return titleChunk ? `${titleChunk} - ${siteTitle}` : siteTitle
  },
  meta: [
    { name: 'description', content: computed(() => siteStore.siteInfo.description) },
    { name: 'keywords', content: computed(() => siteStore.siteInfo.keywords) },
    { name: 'viewport', content: 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no' },
  ],
  bodyAttrs: {
    class: 'bg-white text-zinc-950 overflow-x-hidden selection:bg-zinc-950 selection:text-white'
  }
})

/**
 * 🌟 SignalR 状态同步监听
 * 当用户从“游客”变为“登录”，或从“登录”变为“登出”时，
 * 触发 initNotification 内部的重连逻辑，以刷新后端的 Group 归属和权限。
 */
watch(
  () => userStore.isLoggedIn,
  async (loggedIn) => {
    // 仅监听变化，不使用 immediate: true 避免初次加载时的双重连接
    await initNotification(loggedIn);
  }
);

onMounted(async () => {
  // 1. 并行初始化任务池 (性能最大化)
  const tasks: Promise<any>[] = [
    siteStore.fetchSiteInfo(),
    userStore.fetchUserInfo()
  ]

  // 使用 allSettled 确保即使一个任务失败（如未登录时 fetchUserInfo 401），
  // 也能继续执行后续逻辑
  await Promise.allSettled(tasks)

  // 2. 🌟 确立身份后，发起初次通知服务连接
  // 此时身份已定（游客或会员），只会进行一次 PoW 或 Token 握手
  try {
    await initNotification(userStore.isLoggedIn);
  } catch (e) {
    console.warn('[App] 初始通知服务连接受限');
  }

  // 3. 移除首屏静态 Loader
  const loader = document.getElementById('global-loader')
  if (loader) {
    loader.style.opacity = '0'
    setTimeout(() => loader.remove(), 600)
  }
})

onUnmounted(() => {
  // 组件销毁（通常是全页面刷新或关闭）时停止服务
  notificationService.stop()
})
</script>

<template>
  <el-config-provider :locale="zhCn">
    <div class="app-wrapper w-full min-h-screen flex flex-col overflow-x-hidden">
      <transition name="banner-slide">
        <div 
          v-if="userStore.isLoggedIn && userStore.isBanned" 
          class="w-full bg-zinc-950 text-white py-2 px-6 flex items-center justify-center gap-4 z-200 relative"
        >
          <span class="text-[10px] font-bold tracking-[0.2em] uppercase">
            当前账号处于管控状态：{{ userStore.userInfo?.banReason || '仅限阅读模式' }}
          </span>
          <router-link to="/user/messagebox" class="text-[9px] underline underline-offset-4 opacity-70 hover:opacity-100 transition-opacity uppercase font-bold tracking-widest">
            查看详情
          </router-link>
        </div>
      </transition>

      <router-view v-slot="{ Component }">
        <transition name="page-fade" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </div>
  </el-config-provider>
</template>

<style>
/* 样式部分保持不变 */
@reference "@/assets/main.css";

html, body {
  margin: 0; padding: 0;
  width: 100%; height: 100%;
  scroll-behavior: smooth;
  -webkit-tap-highlight-color: transparent;
}

* { box-sizing: border-box; }

.page-fade-enter-active,
.page-fade-leave-active {
  transition: opacity 0.25s ease;
}
.page-fade-enter-from,
.page-fade-leave-to {
  opacity: 0;
}

.banner-slide-enter-active, .banner-slide-leave-active { transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1); }
.banner-slide-enter-from, .banner-slide-leave-to { transform: translateY(-100%); }
</style>