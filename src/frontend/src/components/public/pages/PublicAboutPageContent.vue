<template>
  <PublicReadingPageFrame v-if="loading" as="section">
    <el-skeleton
      aria-hidden="true"
      style="--el-skeleton-color: var(--fsusblog-skeleton-bg); --el-skeleton-to-color: var(--fsusblog-skeleton-bg)"
    >
      <template #template>
        <div class="space-y-8 py-8">
          <div class="h-8 sm:h-12 w-2/3">
            <el-skeleton-item variant="h1" />
          </div>
          <div class="flex gap-6">
            <div class="h-4 w-24">
              <el-skeleton-item variant="text" />
            </div>
          </div>
          <div class="space-y-4 pt-8 sm:pt-12">
            <div v-for="i in 5" :key="i" class="h-4 w-full">
              <el-skeleton-item variant="text" />
            </div>
          </div>
        </div>
      </template>
    </el-skeleton>
  </PublicReadingPageFrame>

  <PublicReadingPageFrame v-else-if="!error" as="article">
    <header class="mb-14 border-b border-[var(--fsusblog-panel-border)] pb-10 sm:mb-20 sm:pb-12">
      <h1 class="mb-6 text-3xl font-bold leading-[1.15] tracking-normal text-[var(--fsusblog-text-heading)] sm:text-4xl">
        {{ view.header.title }}
      </h1>

      <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs tabular-nums font-semibold text-[var(--fsusblog-text-muted)] normal-case tracking-normal">
        <time>{{ view.header.currentYear }}</time>
        <span class="text-[var(--fsusblog-text-tertiary)]">{{ view.header.manifestoLabel }}</span>
        <span>{{ view.header.readmeLabel }}</span>
      </div>
    </header>

    <slot name="body">
      <div
        class="markdown-body prose max-w-none whitespace-pre-wrap"
        role="article"
        aria-live="polite"
      >
        {{ view.body.content }}
      </div>
    </slot>
  </PublicReadingPageFrame>

  <PublicReadingPageFrame v-else as="section" align="center">
    <PublicContentState
      title="内容连接中断"
      description="请稍后重试。"
      tone="error"
      size="page"
      role="alert"
    >
      <el-button
        type="primary"
        @click="emit('retry')"
      >
        重连
      </el-button>
      <el-button
        tag="a"
        href="/"
      >
        回到首页
      </el-button>
    </PublicContentState>
  </PublicReadingPageFrame>
</template>

<script setup lang="ts">
import PublicContentState from '@/components/public/PublicContentState.vue'
import PublicReadingPageFrame from '@/components/public/PublicReadingPageFrame.vue'
import type { AboutPageViewContract } from '@/view-contracts/aboutPage'

defineProps<{
  view: AboutPageViewContract
  loading?: boolean
  error?: boolean
}>()

const emit = defineEmits<{
  (event: 'retry'): void
}>()
</script>

<style scoped>
@reference "@/assets/main.css";
</style>
