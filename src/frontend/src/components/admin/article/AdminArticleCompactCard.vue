<template>
  <article class="article-compact-card" role="listitem">
    <div class="flex min-w-0 items-start gap-3">
      <div v-if="row.coverImageUrl" class="article-compact-cover" aria-hidden="true">
        <img
          :src="row.coverImageUrl"
          alt=""
          loading="lazy"
        >
      </div>
      <div class="min-w-0">
        <el-link
          type="primary"
          class="article-compact-title"
          @click="$emit('edit', row.id)"
        >
          {{ row.title }}
        </el-link>
        <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-[var(--fsusblog-text-muted)]">
          <span class="inline-flex items-center gap-1 tabular-nums">
            <el-icon aria-hidden="true"><View /></el-icon> {{ row.views }} 阅读
          </span>
          <span class="inline-flex items-center gap-1 tabular-nums">
            {{ row.statusTimeLabel }}
            <SemanticTime :value="row.statusTimeValue" :text="row.statusTimeText" />
          </span>
        </div>
      </div>
    </div>

    <div class="article-compact-tags">
      <el-tag size="small">
        {{ row.categoryName }}
      </el-tag>
      <el-tag size="small" :type="row.statusTagType">
        {{ row.statusText }}
      </el-tag>
    </div>

    <div class="article-compact-actions">
      <el-button text type="primary" @click="$emit('edit', row.id)">{{ row.primaryActionLabel }}</el-button>
      <el-dropdown>
        <el-button text type="primary">
          更多 <span class="ml-0.5 inline-flex"><el-icon aria-hidden="true"><ArrowDown /></el-icon></span>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item icon="Monitor" @click="$emit('view', row)">{{ row.previewActionLabel }}</el-dropdown-item>
            <el-dropdown-item icon="Box" @click="$emit('move-to-trash', row)">移入回收站</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
  </article>
</template>

<script setup lang="ts">
import { ArrowDown, View } from '@/fsusui/icons'
import SemanticTime from '@/components/ui/SemanticTime.vue'
import { type ArticleListItemResponse } from '@/api/article'

export type AdminArticleCompactCardRow = ArticleListItemResponse & {
  createdAtText: string
  categoryName: string
  statusText: string
  statusTagType: 'success' | 'warning' | 'info' | 'danger'
  statusTimeLabel: string
  statusTimeText: string
  statusTimeValue: string
  primaryActionLabel: string
  previewActionLabel: string
  publicPreviewAvailable: boolean
}

defineProps<{
  row: AdminArticleCompactCardRow
}>()

defineEmits<{
  (event: 'edit', id: number): void
  (event: 'view', row: AdminArticleCompactCardRow): void
  (event: 'move-to-trash', row: AdminArticleCompactCardRow): void
}>()
</script>

<style scoped>
.article-compact-card {
  display: grid;
  gap: 1rem;
  padding: 1.25rem 1rem;
  background: var(--fsusblog-page-bg);
}

.article-compact-title {
  max-width: 100%;
  min-width: 0;
  overflow-wrap: anywhere;
  text-align: left;
}

.article-compact-tags,
.article-compact-actions {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.article-compact-cover {
  display: grid;
  width: 4.5rem;
  height: 3.375rem;
  flex: 0 0 auto;
  place-items: center;
  overflow: hidden;
  border: 1px solid var(--fsusblog-panel-border);
  border-radius: 6px;
  background: var(--fsusblog-panel-bg);
  color: var(--fsusblog-text-muted);
  font-weight: 700;
}

.article-compact-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.article-compact-actions {
  justify-content: flex-end;
}

.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
