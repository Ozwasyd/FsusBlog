<template>
  <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]" aria-labelledby="comment-moderation-title">
    <header class="border-b border-[var(--fsusblog-panel-border)] p-8">
      <div class="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">评论审核 / MODERATION</div>
          <h2 id="comment-moderation-title" class="mt-4 text-3xl font-bold text-[var(--fsusblog-text-primary)]">待审摘要</h2>
          <p class="mt-4 text-[11px] leading-relaxed text-[var(--fsusblog-text-tertiary)]">
            最新待审评论优先呈现，高风险处置保持管理员二次验证边界。
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <el-button :icon="Refresh" size="small" :loading="loading" @click="refreshQueue">刷新</el-button>
          <el-button
            :tag="RouterLink"
            :to="{ name: 'ManageCommentModeration' }"
            type="primary"
            size="small"
            :icon="ArrowRight"
          >
            进入评论审核
          </el-button>
        </div>
      </div>
    </header>

    <div class="grid grid-cols-1 sm:grid-cols-3 gap-px bg-[var(--fsusblog-panel-bg-soft)]">
      <div v-for="counter in counters" :key="counter.label" class="bg-[var(--fsusblog-page-bg)] p-6">
        <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ counter.label }}</div>
        <div class="mt-3 text-3xl font-bold tabular-nums text-[var(--fsusblog-text-primary)]">{{ counter.value }}</div>
      </div>
    </div>

    <div class="border-t border-[var(--fsusblog-panel-border)] p-8" v-loading="loading">
      <div v-if="!loading && pendingItems.length === 0" class="flex min-h-40 items-center justify-center">
        <el-empty description="暂无待审评论" />
      </div>

      <div v-else class="divide-y divide-[var(--fsusblog-panel-border)] border-y border-[var(--fsusblog-panel-border)]">
        <article v-for="comment in pendingItems" :key="comment.id" class="bg-[var(--fsusblog-page-bg)] p-5">
          <div class="flex flex-wrap items-center gap-3">
            <span class="text-xs font-bold text-[var(--fsusblog-text-primary)]">{{ comment.userName }}</span>
            <span class="text-[11px] font-bold tabular-nums text-[var(--fsusblog-text-muted)]">#{{ comment.id }}</span>
            <span class="text-[11px] font-bold text-[var(--fsusblog-text-muted)]">文章 {{ comment.articleId }} · {{ comment.articleTitle }}</span>
            <SemanticTime
              :value="comment.createTime"
              class="text-[11px] font-bold tabular-nums text-[var(--fsusblog-text-muted)]"
            />
          </div>
          <p class="mt-3 line-clamp-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--fsusblog-text-secondary)]">{{ comment.content }}</p>
          <div class="mt-3 flex flex-wrap gap-2">
            <el-tag v-for="reason in comment.hitReasonLabels" :key="reason" size="small" type="info">
              {{ reason }}
            </el-tag>
          </div>
        </article>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { ArrowRight, Refresh } from '@/fsusui/icons'
import SemanticTime from '@/components/ui/SemanticTime.vue'
import { CommentModerationStatus } from '@/api/authoring'
import { useCommentModerationQueue } from '@/composables/useCommentModerationQueue'

const {
  loading,
  allItems,
  counters,
  refreshQueue
} = useCommentModerationQueue({
  initialStatus: CommentModerationStatus.Pending,
  limit: 5
})

const pendingItems = computed(() => allItems.value.slice(0, 5))

onMounted(() => {
  void refreshQueue()
})
</script>

<style scoped>
.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
