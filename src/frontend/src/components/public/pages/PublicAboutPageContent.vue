<template>
  <section v-if="loading" class="blog-page-shell max-w-3xl mx-auto px-5 sm:px-8 min-h-screen flex flex-col">
    <el-skeleton animated aria-hidden="true">
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
  </section>

  <article v-else-if="!error" class="blog-page-shell max-w-3xl mx-auto px-5 sm:px-8 min-h-screen flex flex-col animate-in fade-in slide-in-from-bottom-4 duration-[var(--fsus-motion-control-fast)]">
    <header class="mb-16 sm:mb-24 pb-12 sm:pb-16 border-b border-[var(--fsusblog-panel-border)]">
      <h1 class="text-4xl sm:text-6xl font-bold text-[var(--fsusblog-text-primary)] leading-[1.1] tracking-normal mb-8">
        {{ view.header.title }}
      </h1>

      <div class="flex flex-wrap items-center gap-6 text-[10px] sm:text-[11px] tabular-nums font-bold text-[var(--fsusblog-text-muted)] normal-case tracking-normal">
        <time>{{ view.header.currentYear }}</time>
        <span class="text-[var(--fsusblog-text-subtle)] font-thin" aria-hidden="true">/</span>
        <span class="text-[var(--fsusblog-text-tertiary)]">{{ view.header.manifestoLabel }}</span>
        <span class="text-[var(--fsusblog-text-subtle)] font-thin" aria-hidden="true">/</span>
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

    <footer class="mt-20 sm:mt-32 mb-16 sm:mb-20 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6 border-t border-[var(--fsusblog-panel-border)] pt-12 sm:pt-16 opacity-60 transition-opacity hover:opacity-100">
      <span class="text-[10px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-primary)]">
        {{ view.footer.siteTitle }}
      </span>
    </footer>
  </article>

  <section v-else class="blog-page-shell max-w-3xl mx-auto px-5 sm:px-8 min-h-screen flex grow flex-col items-center justify-center py-24 sm:py-32">
    <p class="text-xs tabular-nums font-medium normal-case text-[var(--fsusblog-text-muted)] mb-6">
      连接丢失。
    </p>
    <el-button
      type="primary"
      @click="emit('retry')"
    >
      重连
    </el-button>
    <el-button
      class="mt-3"
      :tag="RouterLink"
      to="/"
    >
      回到首页
    </el-button>
  </section>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router'
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
