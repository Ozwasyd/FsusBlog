<template>
  <div class="account-page article-list-wrapper account-motion-enter w-full">
    <FsusUiTaskPageHeader
      title="文章管理"
      description="检索文章、编辑状态与进入写作流程。"
      class="account-task-page-header"
      density="compact"
    />

    <CollectionWorkbench
      title="文章列表"
      title-id="article-list-title"
      :meta="articleListResultText"
      :state="articleWorkbenchState"
      :busy="isBusy"
    >
      <template #primary-filter>
        <el-form class="article-list-toolbar-form" :model="queryParam" @submit.prevent="handleSearch">
          <el-form-item class="article-list-toolbar-item !m-0">
            <div class="article-list-toolbar-search">
              <el-input
                v-model="queryParam.keyword"
                name="articleKeyword"
                aria-label="搜索文章标题"
                placeholder="搜索文章标题"
                clearable
                :disabled="isBusy"
                @clear="handleSearch"
                @keyup.enter="handleSearch"
              >
                <template #prefix>
                  <span class="text-[var(--fsusblog-text-muted)]">
                    <el-icon aria-hidden="true"><Search /></el-icon>
                  </span>
                </template>
              </el-input>
            </div>
          </el-form-item>

          <el-form-item class="article-list-toolbar-item !m-0">
            <div class="article-list-toolbar-select">
              <el-select
                v-model="queryParam.categoryId"
                clearable
                filterable
                placeholder="按分类筛选"
                aria-label="按分类筛选文章"
                :disabled="isBusy"
                @update:model-value="handleCategoryFilterChange"
              >
                <el-option
                  v-for="item in categories"
                  :key="item.id"
                  :label="item.name"
                  :value="item.id"
                />
              </el-select>
            </div>
          </el-form-item>

          <el-form-item class="article-list-toolbar-item !m-0">
            <div class="article-list-toolbar-select">
              <el-select
                v-model="queryParam.tagId"
                clearable
                filterable
                placeholder="按标签筛选"
                aria-label="按标签筛选文章"
                :disabled="isBusy"
                @update:model-value="handleTagFilterChange"
              >
                <el-option
                  v-for="item in tags"
                  :key="item.id"
                  :label="`# ${item.name}`"
                  :value="item.id"
                />
              </el-select>
            </div>
          </el-form-item>

          <el-form-item class="article-list-toolbar-item article-list-status-filter !m-0">
            <AdminSegmentedControl
              :model-value="queryParam.status"
              :items="statusFilters"
              aria-label="文章状态筛选"
              :disabled="isBusy"
              @update:model-value="handleStatusFilterChange"
            />
          </el-form-item>

          <el-form-item class="article-list-toolbar-item article-list-toolbar-buttons !m-0">
            <el-button type="primary" :loading="isBusy" @click="handleSearch">搜索</el-button>
            <el-button @click="resetQuery" :disabled="isBusy">重置</el-button>
            <el-button
              class="article-list-write-button"
              type="primary"
              :icon="Plus"
              @click="goToWriteArticle"
            >
              写新文章
            </el-button>
          </el-form-item>
        </el-form>

        <div
          v-if="activeFilterChips.length > 0"
          class="mt-2 flex flex-wrap items-center gap-2"
          aria-label="当前筛选条件"
        >
          <el-tag
            v-for="chip in activeFilterChips"
            :key="chip.key"
            closable
            type="info"
            @close="removeFilter(chip.key)"
          >
            {{ chip.label }}
          </el-tag>
        </div>
      </template>

      <template #loading>
        <div class="px-4 py-6" aria-busy="true"><el-skeleton :rows="6" animated /></div>
      </template>

      <template #results>
      <p
        v-if="rowMotion.summary.value"
        class="sr-only blog-motion-summary-enter"
        role="status"
        aria-live="polite"
      >
        {{ rowMotion.summary.value }}
      </p>
        <el-responsive-collection
        v-loading="loading"
        :items="articleListView"
        :row-key="getArticleRowKey"
        compact-query="(max-width: 767px)"
        aria-label="文章列表"
      >
        <template #card="{ item }">
          <AdminArticleCompactCard
            :row="item as ArticleListViewItem"
            :class="articleRowMotionClass((item as ArticleListViewItem).id)"
            @edit="handleEdit"
            @view="handleViewArticle"
            @move-to-trash="handleMoveToTrash"
          />
        </template>

        <template #table>
          <el-table
            class="article-list-table"
            :data="articleListView"
            :row-key="getArticleRowKey"
            :row-class-name="articleTableRowClassName"
          >
            <el-table-column prop="id" label="ID" width="96" align="center">
              <template #default="{ row }: { row: ArticleListViewItem }">
                <span class="article-id-cell tabular-nums">{{ row.id }}</span>
              </template>
            </el-table-column>

            <el-table-column label="内容概要" min-width="320">
              <template #default="{ row }: { row: ArticleListViewItem }">
                <div class="flex min-w-0 items-start gap-4 py-1">
                  <div v-if="row.coverImageUrl" class="article-cover-thumb" aria-hidden="true">
                    <img
                      :src="row.coverImageUrl"
                      alt=""
                      loading="lazy"
                    >
                  </div>
                  <div class="min-w-0 flex-1">
                    <el-link
                      type="primary"
                      @click="handleEdit(row.id)"
                    >
                      {{ row.title }}
                    </el-link>
                    <div class="flex flex-wrap items-center gap-x-6 gap-y-2 mt-2 text-[12px] text-[var(--fsusblog-text-muted)]">
                      <span class="flex items-center gap-1 tabular-nums">
                        <el-icon aria-hidden="true"><View /></el-icon> {{ row.views }} 阅读
                      </span>
                      <span class="flex items-center gap-1 tabular-nums">
                        <el-icon aria-hidden="true"><Calendar /></el-icon>
                        <span>{{ row.statusTimeLabel }}</span>
                        <SemanticTime :value="row.statusTimeValue" :text="row.statusTimeText" />
                      </span>
                    </div>
                  </div>
                </div>
              </template>
            </el-table-column>

            <el-table-column label="分类" width="130" align="center">
              <template #default="{ row }: { row: ArticleListViewItem }">
                <el-tag size="small">
                  {{ row.categoryName }}
                </el-tag>
              </template>
            </el-table-column>

            <el-table-column label="状态" width="100" align="center">
              <template #default="{ row }: { row: ArticleListViewItem }">
                <el-tag size="small" :type="row.statusTagType">
                  {{ row.statusText }}
                </el-tag>
              </template>
            </el-table-column>

            <el-table-column label="标签" min-width="180">
              <template #default="{ row }: { row: ArticleListViewItem }">
                <div class="flex flex-wrap gap-2">
                  <el-tag
                    v-for="tag in row.tags"
                    :key="tag.id"
                    size="small"
                    type="info"
                  >
                    {{ tag.name }}
                  </el-tag>
                </div>
              </template>
            </el-table-column>

            <el-table-column label="管理" width="160" fixed="right" align="right">
              <template #default="{ row }: { row: ArticleListViewItem }">
                <div class="flex justify-end items-center gap-x-1 pr-2">
                  <el-button link type="primary" @click="handleEdit(row.id)">{{ row.primaryActionLabel }}</el-button>
                  <el-dropdown>
                    <el-button link type="primary">
                      更多 <span class="ml-1 inline-flex"><el-icon aria-hidden="true"><ArrowDown /></el-icon></span>
                    </el-button>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item icon="Monitor" @click="handleViewArticle(row)">{{ row.previewActionLabel }}</el-dropdown-item>
                        <el-dropdown-item icon="Box" @click="handleMoveToTrash(row)">移入回收站</el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                </div>
              </template>
            </el-table-column>
          </el-table>
        </template>
        </el-responsive-collection>
      </template>

      <template #empty>
      <div
        v-loading="loading"
        class="article-list-empty-container"
      >
        <AdminInlineEmptyState
          class="article-list-empty-state"
          title="没有找到匹配的文章"
          description="调整筛选条件或新建文章。"
        >
          <template #actions>
            <div class="article-list-empty-actions">
              <el-button class="article-list-empty-action" :disabled="isBusy" @click="resetQuery">清空筛选</el-button>
              <el-button class="article-list-empty-action" type="primary" @click="goToWriteArticle">写新文章</el-button>
            </div>
          </template>
        </AdminInlineEmptyState>
      </div>
      </template>

      <template v-if="total > 0" #pagination>
        <div class="article-list-pagination flex w-full items-center justify-between">
        <span class="text-[12px] text-[var(--fsusblog-text-muted)] font-medium tabular-nums">
          {{ totalText }}
        </span>
        <el-pagination
          v-model:current-page="queryParam.page"
          v-model:page-size="queryParam.size"
          :page-sizes="pageSizeOptions"
          :layout="isCompactPagination ? 'prev, pager, next' : 'sizes, prev, pager, next'"
          :total="total"
          :disabled="isBusy"
          @size-change="handlePageSizeChange"
          @current-change="handlePageChange"
        />
      </div>
      </template>
    </CollectionWorkbench>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { FsusUiTaskPageHeader } from '@/fsusui'
import { Search, View, Calendar, Plus, ArrowDown } from '@/fsusui/icons'
import { type ArticleListItemResponse } from '@/api/article'
import { useAdminArticleList } from '@/composables/useAdminArticleList'
import { useMediaQuery } from '@/composables/useMediaQuery'
import AdminArticleCompactCard from '@/components/admin/article/AdminArticleCompactCard.vue'
import CollectionWorkbench from '@/components/admin/CollectionWorkbench.vue'
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue'
import AdminSegmentedControl from '@/components/admin/AdminSegmentedControl.vue'
import SemanticTime from '@/components/ui/SemanticTime.vue'

type ArticleListViewItem = ArticleListItemResponse & {
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
const {
  router,
  loading,
  isBusy,
  articleListView,
  categories,
  tags,
  total,
  totalText,
  pageSizeOptions,
  statusFilters,
  activeFilterChips,
  rowMotion,
  queryParam,
  setStatusFilter,
  setCategoryFilter,
  setTagFilter,
  removeFilter,
  handlePageSizeChange,
  handlePageChange,
  handleSearch,
  resetQuery,
  handleEdit,
  handleMoreCommand
} = useAdminArticleList()

const getArticleRowKey = (row: unknown): string => String((row as ArticleListViewItem).id)
const articleRowMotionClass = (id: number): string => rowMotion.classFor(id)
const articleTableRowClassName = ({ row }: { row: ArticleListViewItem }): string => articleRowMotionClass(row.id)
const isCompactPagination = useMediaQuery('(max-width: 767px)')
const articleListResultText = computed(() => `文章列表 · ${total.value} 条结果`)
const hasArticleRows = computed(() => articleListView.value.length > 0)
const articleWorkbenchState = computed(() => loading.value && !hasArticleRows.value
  ? 'loading'
  : hasArticleRows.value
    ? 'ready'
    : 'empty')
const handleStatusFilterChange = (value: string | number | boolean | undefined): void => {
  setStatusFilter(typeof value === 'number' ? value as Parameters<typeof setStatusFilter>[0] : undefined)
}
const normalizeFilterId = (value: string | number | undefined): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}
const handleCategoryFilterChange = (value: string | number | undefined): void => {
  setCategoryFilter(normalizeFilterId(value))
}
const handleTagFilterChange = (value: string | number | undefined): void => {
  setTagFilter(normalizeFilterId(value))
}
const goToWriteArticle = async (): Promise<void> => {
  await router.push({ path: '/user/manage/article/write' })
}
const handleViewArticle = (row: ArticleListViewItem): void => handleMoreCommand('view', row)
const handleMoveToTrash = (row: ArticleListViewItem): void => handleMoreCommand('delete', row)
</script>

<style scoped>

.article-list-toolbar-form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--fsus-space-3);
  width: 100%;
}

.article-list-toolbar-search {
  width: min(100%, 16rem);
}

.article-list-toolbar-select {
  width: min(100%, 13rem);
}

.article-list-status-filter {
  min-width: 17rem;
}

.article-list-toolbar-buttons {
  flex: 1 1 18rem;
  min-height: 2rem;
}

.article-list-toolbar-buttons :deep(.el-form-item__content) {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--fsus-space-3);
  width: 100%;
}

.article-list-toolbar-buttons :deep(.el-button + .el-button) {
  margin-left: 0;
}

.article-list-toolbar-buttons :deep(.el-button) {
  min-height: 3rem;
}

.article-list-toolbar-buttons :deep(.article-list-write-button.el-button) {
  margin-left: auto;
}

.tabular-nums {
  font-variant-numeric: tabular-nums;
}

.article-id-cell {
  display: inline-block;
  white-space: nowrap;
  word-break: keep-all;
}

.article-list-table :deep(.el-table-fixed-column--right.is-first-column) {
  border-left: 1px solid var(--fsusblog-panel-border);
}

.article-list-table :deep(.el-table-fixed-column--right.is-first-column::before) {
  box-shadow: none;
}

.article-cover-thumb {
  display: grid;
  width: 4rem;
  height: 2.25rem;
  flex: 0 0 auto;
  place-items: center;
  overflow: hidden;
  border: 1px solid var(--fsusblog-panel-border);
  border-radius: var(--fsus-radius-control);
  background: var(--fsusblog-panel-bg);
  color: var(--fsusblog-text-muted);
  font-size: 1rem;
  font-weight: 700;
}

.article-cover-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.article-list-empty-container {
  min-height: 10rem;
  border-top: 1px solid var(--fsusblog-panel-border);
  padding-block: var(--fsus-space-5) var(--fsus-space-6);
}

.article-list-empty-state {
  min-height: 7rem;
}

.article-list-empty-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--fsus-space-3);
  margin-top: var(--fsus-space-3);
}

.article-list-empty-action {
  min-width: 6.5rem;
}

@media (max-width: 639px) {
  .article-list-empty-actions {
    gap: var(--fsus-space-2);
  }

  .article-list-empty-action {
    min-width: 6rem;
  }
}

@media (max-width: 639px) {
  .article-list-toolbar-form,
  .article-list-toolbar-item,
  .article-list-toolbar-search,
  .article-list-toolbar-select,
  .article-list-status-filter {
    width: 100%;
  }

  .article-list-status-filter {
    min-width: 0;
  }

  .article-list-toolbar-buttons {
    flex: 1 1 100%;
  }

  .article-list-toolbar-buttons :deep(.article-list-write-button.el-button) {
    margin-left: 0;
  }

  .article-list-pagination {
    align-items: flex-start;
    flex-direction: column;
    gap: var(--fsus-space-4);
  }
}
</style>
