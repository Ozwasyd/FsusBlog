<template>
  <div class="min-h-screen flex flex-col bg-white text-zinc-950 font-sans subpixel-antialiased selection:bg-zinc-950 selection:text-white w-full overflow-x-hidden relative">
    
    <!-- [修复 2026-02-24] P1 修复：跳过链接，专为键盘/屏读用户设计，聚焦时可见 -->
    <a 
      href="#user-main" 
      class="sr-only focus:not-sr-only focus:absolute focus:z-999 focus:p-4 focus:bg-zinc-950 focus:text-white focus:font-bold focus:text-[10px] focus:tracking-[0.2em] focus:uppercase focus:outline-none"
    >
      跳到主要内容
    </a>

    <header class="h-16 sm:h-20 border-b border-zinc-100 bg-white/80 backdrop-blur-md sticky top-0 z-50 w-full">
      <div class="max-w-3xl mx-auto px-6 sm:px-8 h-full flex items-center justify-between">
        
        <div class="flex items-center gap-3 sm:gap-5 select-none">
          <router-link 
            to="/" 
            class="text-lg sm:text-xl font-bold tracking-tighter hover:opacity-60 transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-zinc-950 focus-visible:ring-offset-4 rounded-sm"
          >
            {{ siteStore.siteInfo.title }}
          </router-link>
          <!-- 避免媒体查询冲突，使用 Tailwind 原生断点 -->
          <div class="hidden sm:block h-3 w-px bg-zinc-200" aria-hidden="true"></div>
          <span class="hidden sm:block text-[9px] font-bold uppercase tracking-[0.3em] text-zinc-400">账户</span>
        </div>

        <nav class="flex items-center gap-6 sm:gap-8" aria-label="用户全局导航">
          <router-link 
            to="/" 
            class="nav-link-minimal"
          >
            主页
          </router-link>
          
          <!-- [修复 2026-02-24] P0 修复：本地登出状态锁与无障碍反馈 -->
          <button 
            type="button" 
            @click="handleLogout" 
            :disabled="isLoggingOut"
            :aria-busy="isLoggingOut"
            class="nav-link-minimal hover:opacity-50 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="退出当前账号"
          >
            <span v-if="isLoggingOut" aria-hidden="true" class="animate-pulse">登出中...</span>
            <span v-else>登出</span>
          </button>
        </nav>
      </div>
    </header>

    <nav class="bg-zinc-50/50 border-b border-zinc-100 w-full" aria-label="用户中心子导航">
      <!-- [修复 2026-02-24] P2 修复：通过 scroll-snap 提升键盘 tab 导航时的滚动体验 -->
      <div 
        ref="scrollNav"
        class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-nowrap overflow-x-auto no-scrollbar items-center snap-x snap-mandatory"
        @focusin="handleNavFocus"
      >
        <!-- [修复 2026-02-24] P1 修复：暴露 router-link 内部状态，注入 aria-current -->
        <router-link to="/user/profile" custom v-slot="{ href, navigate, isActive, isExactActive }">
          <a 
            :href="href" 
            @click="navigate"
            :aria-current="isActive || isExactActive ? 'page' : undefined"
            class="sub-nav-link snap-start"
            :class="{ 'active-link': isActive || isExactActive }"
          >
            设置
          </a>
        </router-link>

        <router-link to="/user/comments" custom v-slot="{ href, navigate, isActive, isExactActive }">
          <a 
            :href="href" 
            @click="navigate"
            :aria-current="isActive || isExactActive ? 'page' : undefined"
            class="sub-nav-link snap-start"
            :class="{ 'active-link': isActive || isExactActive }"
          >
            我的评论
          </a>
        </router-link>

        <router-link to="/user/messagebox" custom v-slot="{ href, navigate, isActive, isExactActive }">
          <a 
            :href="href" 
            @click="navigate"
            :aria-current="isActive || isExactActive ? 'page' : undefined"
            class="sub-nav-link snap-start"
            :class="{ 'active-link': isActive || isExactActive }"
          >
            我的消息
          </a>
        </router-link>
        
        <!-- [修复 2026-02-24] P1 修复：为弹窗触发按钮提供严格的 ARIA 控制语义 -->
        <button 
          type="button" 
          @click="openPolicy('guidelines')" 
          class="sub-nav-link snap-start"
          aria-haspopup="dialog"
          aria-controls="policy-modal-overlay"
          :aria-expanded="showPolicy && policyType === 'guidelines'"
        >
          使用规范
        </button>

        <button 
          type="button" 
          @click="openPolicy('privacy')" 
          class="sub-nav-link snap-start"
          aria-haspopup="dialog"
          aria-controls="policy-modal-overlay"
          :aria-expanded="showPolicy && policyType === 'privacy'"
        >
          隐私政策
        </button>
      </div>
    </nav>

    <!-- [修复 2026-02-24] P1 修复：对应 Skip Link 的锚点 ID，并加上 tabindex="-1" 支持可编程聚焦 -->
    <main id="user-main" tabindex="-1" class="grow flex flex-col w-full max-w-3xl mx-auto px-6 sm:px-8 py-8 sm:py-12 outline-none">
      <router-view v-slot="{ Component }">
        <transition name="fade-fast" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </main>

    <footer class="py-12 sm:py-16 border-t border-zinc-100 mt-20 w-full select-none">
      <div class="max-w-3xl mx-auto px-6 sm:px-8">
        <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-10 sm:gap-8">
          <div class="space-y-3">
            <p class="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-950">
              {{ siteStore.siteInfo.title }} &copy; {{ currentYear }}
            </p>
            <p class="text-[10px] text-zinc-400 leading-relaxed max-w-60">
              你的数据受到端到端加密保护。本站严格遵守《隐私政策》与《使用规范》。
            </p>
          </div>
          
          <div class="flex items-center gap-6 sm:gap-8">
            <button 
              type="button"
              @click="openPolicy('guidelines')" 
              class="text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-400 hover:text-zinc-950 transition-colors py-2 outline-none focus-visible:ring-1 focus-visible:ring-zinc-950 rounded-sm"
              aria-haspopup="dialog"
              aria-controls="policy-modal-overlay"
              :aria-expanded="showPolicy && policyType === 'guidelines'"
            >
              使用规范
            </button>

            <button 
              type="button"
              @click="openPolicy('privacy')" 
              class="text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-400 hover:text-zinc-950 transition-colors py-2 outline-none focus-visible:ring-1 focus-visible:ring-zinc-950 rounded-sm"
              aria-haspopup="dialog"
              aria-controls="policy-modal-overlay"
              :aria-expanded="showPolicy && policyType === 'privacy'"
            >
              隐私政策
            </button>
          </div>
        </div>
      </div>
    </footer>

    <PolicyModal 
      v-model:visible="showPolicy" 
      :type="policyType"
    />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useUserStore } from '@/store/user'
import { useSiteStore } from '@/store/site'
import { toast } from '@/utils/toast'
import PolicyModal from '@/components/PolicyModal.vue'

const userStore = useUserStore()
const siteStore = useSiteStore()

const showPolicy = ref(false)
const policyType = ref<'privacy' | 'guidelines'>('guidelines')

const currentYear = new Date().getFullYear()

// [修复 2026-02-24] P0 修复：本地防抖锁，处理登出失败的边界情况
const isLoggingOut = ref(false)

const scrollNav = ref<HTMLElement | null>(null)

/**
 * 登出逻辑拦截
 * 逻辑自洽：增加 Try-Catch 捕获底层可能抛出的异常并给予 UX 提示
 */
const handleLogout = async () => {
  if (isLoggingOut.value) return
  isLoggingOut.value = true
  
  try {
    await userStore.logout()
  } catch (err: any) {
    console.error('[UserLayout] Logout failed:', err)
    // 根据 userStore 设计，它会兜底清除本地状态并重定向。
    // 如果走到这里，说明是极其极端的运行环境异常。
    toast.error('登出遇到网络异常，本地状态已清理')
  } finally {
    isLoggingOut.value = false
  }
}

const openPolicy = (type: 'privacy' | 'guidelines') => {
  policyType.value = type
  showPolicy.value = true
}

/**
 * [修复 2026-02-24] P2 修复：键盘导航时的横向滚动对齐
 * 确保键盘用户 Tab 到溢出视口的子项时，能平滑滚动至可见区域
 */
const handleNavFocus = (e: FocusEvent) => {
  const target = e.target as HTMLElement
  if (target && scrollNav.value) {
    target.scrollIntoView({ inline: 'nearest', behavior: 'smooth', block: 'nearest' })
  }
}
</script>

<style scoped>
@reference "@/assets/main.css";

.font-sans {
  letter-spacing: 0.01em;
}

/* [修复 2026-02-24] P2 修复：将仅改变颜色的 focus 改为可见的环形边框，满足对比度标准 */
.nav-link-minimal {
  @apply text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500 hover:text-zinc-950 transition-all duration-300 outline-none focus-visible:text-zinc-950 focus-visible:ring-2 focus-visible:ring-zinc-950 focus-visible:ring-offset-4 rounded-sm;
}

/* 🌟 二级导航适配 */
.sub-nav-link {
  @apply py-5 px-3 sm:px-4 min-w-20 sm:min-w-25 text-center text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-400 transition-all border-b-2 border-transparent whitespace-nowrap shrink-0 outline-none focus-visible:text-zinc-950 focus-visible:bg-zinc-100;
}

button.sub-nav-link:hover,
a.sub-nav-link:hover {
  @apply text-zinc-950;
}

/* 通过 custom slot 注入的 active 类 */
.active-link {
  @apply text-zinc-950 border-zinc-950;
}

.fade-fast-enter-active,
.fade-fast-leave-active {
  transition: opacity 0.15s ease-in-out;
}
.fade-fast-enter-from,
.fade-fast-leave-to {
  opacity: 0;
}

.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>