<template>
  <section class="account-shell-panel h-full p-6">
    <header class="mb-4 border-b border-[#F4F4F5] pb-4">
      <div class="text-[10px] font-bold uppercase text-[#A1A1AA]">近期互动</div>
      <h2 class="mt-2 text-base font-bold text-[#27272A]">最新评论</h2>
      <p class="mt-2 text-sm leading-6 text-[#71717A]">快速判断最近是否有值得跟进的读者互动，再进入内容管理继续处理。</p>
    </header>
    <div v-if="!loading && view.recentComments.length === 0" class="h-75 flex flex-col items-center justify-center">
      <el-empty description="暂无近期互动" />
    </div>
    <el-scrollbar v-else height="320px">
      <div class="space-y-4 p-2">
        <article
          v-for="comment in view.recentComments"
          :key="comment.id"
          class="rounded-[8px] border p-5"
          :class="comment.isLatest ? 'border-[rgba(42,89,156,0.28)] bg-[rgba(42,89,156,0.04)]' : 'border-[#F4F4F5] bg-[#FCFCFC]'"
        >
          <div class="flex items-start justify-between gap-4">
            <p class="text-sm font-bold text-[#27272A]">{{ comment.userName }}</p>
            <time class="shrink-0 text-[10px] font-mono text-[#A1A1AA] tabular-nums">{{ comment.timeText }}</time>
          </div>
          <p class="mt-3 text-[#71717A] text-sm leading-relaxed whitespace-pre-wrap word-break-all">{{ comment.content }}</p>
        </article>
      </div>
    </el-scrollbar>
    <footer class="mt-5 border-t border-[#F4F4F5] pt-4">
      <router-link
        :to="{ name: 'ManageArticleList' }"
        class="text-[11px] font-semibold text-[#71717A] transition-colors hover:text-[#2A599C]"
      >
        进入内容管理
      </router-link>
    </footer>
  </section>
</template>

<script setup lang="ts">
import type { AdminDashboardViewContract } from '@/view-contracts/adminStats';

defineProps<{
  view: AdminDashboardViewContract;
  loading: boolean;
}>();
</script>

<style scoped>
</style>
