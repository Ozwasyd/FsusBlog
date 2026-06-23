<template>
  <div class="blog-page-shell error-page-shell min-h-[75vh] px-5 py-16 sm:px-8 sm:py-20">
    <section class="mx-auto flex w-full max-w-5xl flex-col gap-8 animate-in fade-in duration-[var(--fsus-motion-control-fast)] sm:gap-12">
      <h1 class="text-6xl font-extrabold leading-none text-[var(--fsusblog-text-primary)] sm:text-9xl">
        {{ copy.codePrefix }}<span class="text-[var(--fsusblog-text-muted)]">.</span>
      </h1>

      <div class="h-px w-full max-w-2xl bg-[var(--fsusblog-panel-bg-soft)]"></div>

      <div class="safe-inline-wrap max-w-xl">
        <h2 class="text-2xl font-extrabold leading-tight text-[var(--fsusblog-text-primary)] sm:text-4xl">
          {{ copy.title }}
        </h2>
        <p class="mt-4 text-sm leading-7 text-[var(--fsusblog-text-secondary)]">
          {{ copy.description }}
        </p>

        <div class="mt-10 flex flex-col gap-3 sm:flex-row">
          <el-button
            :tag="RouterLink"
            to="/"
            type="primary"
          >
            {{ copy.homeCta }}
          </el-button>

          <el-button
            @click="handleSwitchAccount"
          >
            {{ copy.reLoginCta }}
          </el-button>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import { FSUSBLOG_ERRORS_COPY } from '@/copy'

const copy = FSUSBLOG_ERRORS_COPY.forbidden

const router = useRouter()
const route = useRoute()
const userStore = useUserStore()

const handleSwitchAccount = async () => {
  await userStore.logout()
  router.push({
    path: '/login',
    query: {
      redirect: route.fullPath
    }
  })
}
</script>

<style scoped>
@reference "@/assets/main.css";

.error-page-shell {
  background: var(--fsusblog-page-bg);
  color: var(--fsusblog-text-primary);
}
</style>