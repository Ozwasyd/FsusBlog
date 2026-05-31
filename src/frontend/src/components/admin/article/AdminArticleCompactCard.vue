<template>
  <article class="article-compact-card" role="listitem">
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
          <el-icon><View /></el-icon> {{ row.views }} 阅读
        </span>
        <SemanticTime :value="row.createTime" :text="row.createdAtText" class="tabular-nums" />
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
      <el-button text type="primary" @click="$emit('edit', row.id)">编辑</el-button>
      <el-dropdown>
        <el-button text type="primary">
          更多 <span class="ml-0.5 inline-flex"><el-icon><ArrowDown /></el-icon></span>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item icon="Monitor" @click="$emit('view', row)">前台预览</el-dropdown-item>
            <el-dropdown-item icon="Box" @click="$emit('move-to-trash', row)">移入回收站</el-dropdown-item>
            <el-dropdown-item icon="Warning" @click="$emit('permanent-remove', row)">永久删除</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
  </article>
</template>

<script setup lang="ts">
import { ArrowDown, View } from '@/ui/fsusIcons'
import SemanticTime from '@/components/ui/SemanticTime.vue'
import { type ArticleListItemResponse } from '@/api/article'

export type AdminArticleCompactCardRow = ArticleListItemResponse & {
  createdAtText: string
  categoryName: string
  statusText: string
  statusTagType: 'success' | 'warning' | 'info' | 'danger'
}

defineProps<{
  row: AdminArticleCompactCardRow
}>()

defineEmits<{
  (event: 'edit', id: number): void
  (event: 'view', row: AdminArticleCompactCardRow): void
  (event: 'move-to-trash', row: AdminArticleCompactCardRow): void
  (event: 'permanent-remove', row: AdminArticleCompactCardRow): void
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

.article-compact-actions {
  justify-content: flex-end;
}

.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
