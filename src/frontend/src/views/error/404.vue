<template>
  <div class="blog-page-shell error-page-shell min-h-[75vh] px-5 py-16 sm:px-8 sm:py-20">
    <section class="mx-auto flex w-full max-w-5xl flex-col gap-8 animate-in fade-in duration-[var(--fsus-motion-control-fast)] sm:gap-12">
      <h1 class="text-6xl font-extrabold leading-none text-[var(--fsusblog-text-primary)] sm:text-9xl">
        404<span class="text-[var(--fsusblog-text-muted)]">.</span>
      </h1>

      <div class="h-px w-full max-w-2xl bg-[var(--fsusblog-panel-bg-soft)]"></div>

      <div class="safe-inline-wrap max-w-xl">
        <h2 class="text-2xl font-extrabold leading-tight text-[var(--fsusblog-text-primary)] sm:text-4xl">
          页面未找到
        </h2>
        <p class="mt-4 text-sm leading-7 text-[var(--fsusblog-text-secondary)]">
          抱歉，你所寻找的资源已移动、删除或从未存在。
        </p>

        <div class="mt-10 grid sm:inline-grid">
          <el-button
            :tag="RouterLink"
            to="/"
            type="primary"
          >
            回到主页
          </el-button>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useHumanReadProof } from '@/composables/useHumanReadProof'

const route = useRoute()

useHumanReadProof({
  scope: computed(() => 'site'),
  routeKey: computed(() => `not-found:${normalizeNotFoundPath(route.fullPath)}`)
})

function normalizeNotFoundPath(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ')
  return normalized.length > 0 ? normalized.slice(0, 96) : '/'
}
</script>

<style scoped>
@reference "@/assets/main.css";

.error-page-shell {
  background: var(--fsusblog-page-bg);
  color: var(--fsusblog-text-primary);
}
</style>
