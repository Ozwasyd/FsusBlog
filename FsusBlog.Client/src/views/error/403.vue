<template>
  <div class="min-h-[75vh] flex items-center justify-center px-6 sm:px-8 subpixel-antialiased">
    
    <div class="flex flex-col sm:flex-row items-center gap-10 sm:gap-16 animate-in fade-in duration-1000">
      
      <h1 class="text-7xl sm:text-9xl font-extrabold tracking-tighter text-zinc-950">
        403<span class="text-zinc-200">.</span>
      </h1>
      
      <div class="hidden sm:block w-px h-24 bg-zinc-200"></div>
      <div class="sm:hidden w-16 h-px bg-zinc-200"></div>
      
      <div class="flex flex-col items-center sm:items-start text-center sm:text-left">
        
        <h2 class="text-[10px] sm:text-xs font-mono font-bold tracking-[0.3em] text-zinc-400 uppercase mb-4">
          Access Forbidden
        </h2>
        
        <p class="text-sm text-zinc-500 leading-relaxed max-w-65 mb-10">
          抱歉，当前账户权限不足以访问此区域。
        </p>
        
        <div class="flex flex-col sm:flex-row items-center gap-8">
          <router-link 
            to="/" 
            class="group inline-flex items-center gap-3 text-[10px] sm:text-xs font-bold tracking-[0.2em] uppercase text-zinc-950 hover:text-zinc-500 transition-colors"
          >
            <span class="group-hover:-translate-x-1 transition-transform duration-300">←</span>
            回到主页
          </router-link>

          <button 
            @click="handleSwitchAccount"
            class="group inline-flex items-center gap-3 text-[10px] sm:text-xs font-bold tracking-[0.2em] uppercase text-zinc-400 hover:text-zinc-950 transition-colors"
          >
            重新登录
            <span class="group-hover:translate-x-1 transition-transform duration-300">→</span>
          </button>
        </div>
        
      </div>
      
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'

const router = useRouter()
const userStore = useUserStore()

const handleSwitchAccount = async () => {
  await userStore.logout()
  router.push('/login')
}
</script>

<style scoped>
@reference "@/assets/main.css";

/* 继承全局 subpixel-antialiased 确保 Windows 字体边缘清晰 */
</style>