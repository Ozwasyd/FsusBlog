<template>
  <section class="bg-[var(--fsusblog-page-bg)] h-full flex flex-col">
    <header class="p-8 border-b border-[var(--fsusblog-panel-border)]">
      <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">近期互动</div>
      <h2 class="mt-4 text-3xl font-bold text-[var(--fsusblog-text-primary)]">最新评论</h2>
      <p class="mt-4 text-[11px] leading-relaxed text-[var(--fsusblog-text-tertiary)]">快速判断最近是否有值得跟进的读者互动，再进入内容管理继续处理。</p>
    </header>
    <div class="flex-1 min-h-0">
      <div v-if="!loading && view.recentComments.length === 0" class="h-75 flex flex-col items-center justify-center">
        <el-empty description="暂无近期互动" />
      </div>
      <el-scrollbar v-else height="100%">
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <article
            v-for="comment in view.recentComments"
            :key="comment.id"
            class="p-6 transition-colors hover:bg-[var(--fsusblog-panel-bg)] group"
          >
            <div class="flex items-start justify-between gap-4 mb-3">
              <p class="text-[13px] font-bold text-[var(--fsusblog-text-secondary)] group-hover:text-[var(--fsusblog-color-primary)] transition-colors">{{ comment.userName }}</p>
              <SemanticTime
                :value="comment.timeValue"
                :text="comment.timeText"
                class="shrink-0 text-[11px] tabular-nums font-bold text-[var(--fsusblog-text-muted)] tabular-nums normal-case"
              />
            </div>
            <p class="text-[13px] leading-relaxed text-[var(--fsusblog-text-tertiary)] whitespace-pre-wrap word-break-all">{{ comment.content }}</p>
            <div v-if="comment.isLatest" class="mt-4">
              <span class="inline-block px-2 py-0.5 bg-[var(--fsusblog-text-primary)] text-[11px] font-black normal-case text-[var(--fsusblog-page-bg)] tracking-normal">NEW</span>
            </div>
          </article>
        </div>
      </el-scrollbar>
    </div>
    <footer class="p-6 border-t border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg)]">
      <router-link
        :to="{ name: 'ManageArticleList' }"
        class="group flex items-center gap-3 text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-tertiary)] transition-colors hover:text-[var(--fsusblog-color-primary)]"
      >
        进入内容管理 <el-icon class="blog-motion-icon-nudge" aria-hidden="true"><ArrowRight /></el-icon>
      </router-link>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { ArrowRight } from '@/fsusui/icons';
import SemanticTime from '@/components/ui/SemanticTime.vue'
import type { AdminDashboardViewContract } from '@/view-contracts/adminStats';

defineProps<{
  view: AdminDashboardViewContract;
  loading: boolean;
}>();
</script>

<style scoped>
</style>
