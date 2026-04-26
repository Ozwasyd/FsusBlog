<template>
  <div class="fsus-page-shell min-h-[75vh] bg-[#F7F7F8] px-5 py-16 text-[#0F0F11] subpixel-antialiased dark:bg-[#0F0F11] dark:text-[#FCFCFC] sm:px-8 sm:py-20">
    <section class="mx-auto flex w-full max-w-5xl flex-col gap-8 animate-in fade-in duration-700 sm:gap-12">
      <h1 class="text-6xl font-extrabold leading-none text-[#0F0F11] sm:text-9xl dark:text-[#FCFCFC]">
        403<span class="text-[#A1A1AA]">.</span>
      </h1>

      <div class="h-px w-full max-w-2xl bg-[#E4E4E7] dark:bg-[#27272A]"></div>

      <div class="safe-inline-wrap max-w-xl">
        <h2 class="text-2xl font-extrabold leading-tight text-[#0F0F11] sm:text-4xl dark:text-[#FCFCFC]">
          访问被拒绝
        </h2>
        <p class="mt-4 text-sm leading-7 text-[#52525B] dark:text-[#A1A1AA]">
          抱歉，当前账户权限不足以访问此区域。
        </p>

        <div class="action-row mt-10 sm:flex-row">
          <router-link
            to="/"
            class="inline-flex min-h-11 items-center justify-center rounded-[8px] bg-[#0F0F11] px-5 text-sm font-bold text-white shadow-[0_32px_64px_rgba(0,0,0,0.08)] transition-colors hover:bg-[#2A599C] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#F7F7F8] dark:bg-[#FCFCFC] dark:text-[#0F0F11] dark:hover:bg-[#7EA7E0] dark:focus-visible:ring-[#7EA7E0] dark:focus-visible:ring-offset-[#0F0F11]"
          >
            回到主页
          </router-link>

          <button
            type="button"
            @click="handleSwitchAccount"
            class="inline-flex min-h-11 items-center justify-center rounded-[8px] border border-[#E4E4E7] bg-[#FCFCFC] px-5 text-sm font-bold text-[#0F0F11] transition-colors hover:border-[#2A599C] hover:text-[#2A599C] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#F7F7F8] dark:border-[#27272A] dark:bg-[#18181B] dark:text-[#FCFCFC] dark:hover:border-[#7EA7E0] dark:hover:text-[#7EA7E0] dark:focus-visible:ring-[#7EA7E0] dark:focus-visible:ring-offset-[#0F0F11]"
          >
            重新登录
          </button>
        </div>
      </div>
    </section>
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
</style>
