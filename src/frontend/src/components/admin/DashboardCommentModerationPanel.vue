<template>
  <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]" aria-labelledby="comment-moderation-title">
    <header class="border-b border-[var(--fsusblog-panel-border)] px-8 py-6">
      <div class="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <FsusUiSectionHeader
          id="comment-moderation-title"
          class="dashboard-section-header--flush"
          title="评论审核"
          description="处理待审评论；高风险操作需要二次确认。"
        />
        <div class="flex flex-wrap items-center gap-3">
          <el-button :icon="Refresh" size="small" :loading="loading" @click="refreshQueue">刷新</el-button>
          <el-button
            :tag="RouterLink"
            :to="{ name: 'ManageModerationComments' }"
            type="primary"
            size="small"
            :icon="ArrowRight"
          >
            进入审核
          </el-button>
        </div>
      </div>
    </header>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div v-for="counter in counters" :key="counter.label" class="bg-[var(--fsusblog-page-bg)] p-6">
        <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ counter.label }}</div>
        <div class="mt-3 text-2xl font-bold tabular-nums text-[var(--fsusblog-text-primary)]">{{ counter.value }}</div>
      </div>
    </div>

    <div class="border-t border-[var(--fsusblog-panel-border)] p-8" v-loading="loading" :aria-busy="loading">
      <div v-if="!loading && pendingItems.length === 0" class="dashboard-inline-empty" role="status" aria-live="polite">
        <p class="dashboard-inline-empty__title">暂无待审评论</p>
        <p class="dashboard-inline-empty__description">高风险操作仍需二次确认。</p>
        <RouterLink class="dashboard-inline-empty__link" :to="{ name: 'ManageModerationAudit' }">
          查看审核日志
        </RouterLink>
      </div>

      <div v-else class="divide-y divide-[var(--fsusblog-panel-border)] border-y border-[var(--fsusblog-panel-border)]">
        <article v-for="comment in pendingItems" :key="comment.id" class="bg-[var(--fsusblog-page-bg)] p-5">
          <div class="flex flex-wrap items-center gap-3">
            <span class="text-xs font-bold text-[var(--fsusblog-text-primary)]">{{ comment.actorDisplayName }}</span>
            <span class="text-xs font-semibold tabular-nums text-[var(--fsusblog-text-muted)]">#{{ comment.id }}</span>
            <span class="text-xs font-semibold text-[var(--fsusblog-text-muted)]">文章 {{ comment.articleId }} · {{ comment.articleTitle }}</span>
            <SemanticTime
              :value="comment.createTime"
              class="text-xs font-semibold tabular-nums text-[var(--fsusblog-text-muted)]"
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
import { FsusUiSectionHeader } from '@/fsusui'
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

.dashboard-inline-empty {
  border-top: 1px solid var(--fsusblog-panel-border);
  padding: 1.25rem 0 0;
  color: var(--fsusblog-text-tertiary);
}

.dashboard-inline-empty__title {
  margin: 0;
  color: var(--fsusblog-text-secondary);
  font-size: 0.9375rem;
  font-weight: 680;
}

.dashboard-inline-empty__description {
  margin: 0.375rem 0 0;
  font-size: 0.8125rem;
  line-height: 1.6;
}

.dashboard-inline-empty__link {
  display: inline-flex;
  margin-top: 0.75rem;
  color: var(--fsusblog-color-primary);
  font-size: 0.8125rem;
  font-weight: 680;
  text-decoration: none;
}

.dashboard-inline-empty__link:hover,
.dashboard-inline-empty__link:focus-visible {
  text-decoration: underline;
}
</style>
