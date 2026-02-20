<template>
  <div class="min-h-screen flex flex-col bg-white text-zinc-950 font-sans subpixel-antialiased selection:bg-zinc-950 selection:text-white w-full overflow-x-hidden">
    
    <header class="h-16 sm:h-20 border-b border-zinc-100 bg-white/80 backdrop-blur-md sticky top-0 z-50 w-full">
      <div class="max-w-3xl mx-auto px-6 sm:px-8 h-full flex items-center justify-between">
        
        <div class="flex items-center gap-3 sm:gap-5">
          <router-link to="/" class="text-lg sm:text-xl font-bold tracking-tighter hover:opacity-60 transition-opacity">
            {{ siteStore.siteInfo.title }}
          </router-link>
          <div class="hidden xs:block h-3 w-px bg-zinc-200"></div>
          <span class="hidden xs:block text-[9px] font-bold uppercase tracking-[0.3em] text-zinc-400">账户</span>
        </div>

        <div class="flex items-center gap-6 sm:gap-8">
          <router-link to="/" class="nav-link-minimal">主页</router-link>
          <button @click="handleLogout" class="nav-link-minimal hover:opacity-50 transition-opacity">
            登出
          </button>
        </div>
      </div>
    </header>

    <nav class="bg-zinc-50/50 border-b border-zinc-100 w-full">
      <div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-nowrap overflow-x-auto no-scrollbar items-center">
        <router-link to="/user/profile" class="sub-nav-link">设置</router-link>
        <router-link to="/user/comments" class="sub-nav-link">我的评论</router-link>
        <router-link to="/user/messagebox" class="sub-nav-link">我的消息</router-link>
        <button @click="openPolicy('guidelines')" class="sub-nav-link">使用规范</button>
        <button @click="openPolicy('privacy')" class="sub-nav-link">隐私政策</button>
      </div>
    </nav>

    <main class="grow flex flex-col w-full max-w-3xl mx-auto px-6 sm:px-8 py-8 sm:py-12">
      <router-view v-slot="{ Component }">
        <transition name="fade-fast" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </main>

    <footer class="py-12 sm:py-16 border-t border-zinc-100 mt-20 w-full">
      <div class="max-w-3xl mx-auto px-6 sm:px-8">
        <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-10 sm:gap-8">
          <div class="space-y-3">
            <p class="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-950">
              {{ siteStore.siteInfo.title }} &copy; 2026
            </p>
            <p class="text-[10px] text-zinc-400 leading-relaxed max-w-60">
              你的数据受到端到端加密保护。本站严格遵守《隐私政策》与《使用规范》。
            </p>
          </div>
          
          <div class="flex items-center gap-6 sm:gap-8">
            <button 
              @click="openPolicy('guidelines')" 
              class="text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-400 hover:text-zinc-950 transition-colors py-2"
            >
              使用规范
            </button>

            <button 
              @click="openPolicy('privacy')" 
              class="text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-400 hover:text-zinc-950 transition-colors py-2"
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
import PolicyModal from '@/components/PolicyModal.vue'

const userStore = useUserStore()
const siteStore = useSiteStore()

const showPolicy = ref(false)
const policyType = ref<'privacy' | 'guidelines'>('guidelines')

const handleLogout = async () => {
  await userStore.logout()
}

const openPolicy = (type: 'privacy' | 'guidelines') => {
  policyType.value = type
  showPolicy.value = true
}
</script>

<style scoped>
@reference "@/assets/main.css";

.font-sans {
  letter-spacing: 0.01em;
}

.nav-link-minimal {
  @apply text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500 hover:text-zinc-950 transition-colors duration-300;
}

/* 🌟 二级导航适配：px-3 配合 min-w 让滑动更流畅，防止撑开页面宽度 */
.sub-nav-link {
  @apply py-5 px-3 sm:px-4 min-w-20 sm:min-w-25 text-center text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-400 transition-all border-b-2 border-transparent whitespace-nowrap shrink-0;
}

button.sub-nav-link:hover,
a.sub-nav-link:hover {
  @apply text-zinc-950;
}

.sub-nav-link.router-link-active {
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

/* 隐藏横向滚动条 */
.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

@media (max-width: 400px) {
  .xs\:block {
    display: none;
  }
}
</style>