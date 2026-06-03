<template>
  <div class="account-page article-list-wrapper account-motion-enter w-full">
    <header class="account-page-header account-page-header--compact">
      <div class="account-page-eyebrow">管理 / CONTENT</div>
      <h1 class="account-page-title">文章管理</h1>
      <p class="account-page-description">
        搜索、预览和维护已发布文章。常用写作入口保留在当前页，便于从列表直接进入编辑流程。
      </p>
    </header>

    <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)] py-6 px-4 mb-12">
      <div class="flex flex-wrap items-center justify-between gap-6">
        <el-form :inline="true" :model="queryParam" @submit.prevent="handleSearch">
          <el-form-item>
            <div class="w-64">
              <el-input
                v-model="queryParam.keyword"
                name="articleKeyword"
                aria-label="搜索文章标题"
                placeholder="输入博文标题检索..."
                clearable
                :disabled="isBusy"
                @clear="handleSearch"
                @keyup.enter="handleSearch"
              >
                <template #prefix>
                  <span class="text-[var(--fsusblog-text-muted)]">
                    <el-icon><Search /></el-icon>
                  </span>
                </template>
              </el-input>
            </div>
          </el-form-item>

          <el-form-item>
            <div class="w-48 sm:w-52">
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

          <el-form-item>
            <div class="w-48 sm:w-52">
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

          <el-form-item>
            <el-radio-group
              :model-value="queryParam.status"
              aria-label="文章状态筛选"
              :disabled="isBusy"
              @update:model-value="handleStatusFilterChange"
            >
              <el-radio-button
                v-for="item in statusFilters"
                :key="item.label"
                :value="item.value"
              >
                {{ item.label }}
              </el-radio-button>
            </el-radio-group>
          </el-form-item>

          <el-form-item>
            <el-button type="primary" :loading="isBusy" @click="handleSearch">搜索</el-button>
            <el-button @click="resetQuery" :disabled="isBusy">重置</el-button>
          </el-form-item>
        </el-form>

        <el-button
          type="primary"
          :icon="Plus"
          @click="goToWriteArticle"
        >
          发布新博文
        </el-button>
      </div>

      <div
        v-if="activeFilterChips.length > 0"
        class="mt-5 flex flex-wrap items-center gap-2"
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
    </section>

    <section class="border-t border-[var(--fsusblog-panel-border)]">
      <div class="px-4 py-3 border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] flex items-center justify-between">
        <div class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">文章列表 / ARTICLE LIST</div>
      </div>
      <el-responsive-collection
        v-loading="loading"
        :items="articleListView"
        :row-key="getArticleRowKey"
        compact-query="(max-width: 639px)"
        aria-label="文章列表"
      >
        <template #card="{ item }">
          <AdminArticleCompactCard
            :row="item as ArticleListViewItem"
            @edit="handleEdit"
            @view="handleViewArticle"
            @move-to-trash="handleMoveToTrash"
          />
        </template>

        <template #empty>
          <el-empty description="没有找到匹配的文章成果" />
        </template>

        <template #table>
          <el-table
            :data="articleListView"
            :row-key="getArticleRowKey"
          >
            <el-table-column prop="id" label="ID" width="80" align="center">
              <template #default="{ row }: { row: ArticleListViewItem }">
                <span class="tabular-nums">{{ row.id }}</span>
              </template>
            </el-table-column>

            <el-table-column label="内容概要" min-width="320">
              <template #default="{ row }: { row: ArticleListViewItem }">
                <div class="flex min-w-0 items-start gap-4 py-1">
                  <div class="article-cover-thumb" aria-hidden="true">
                    <img
                      v-if="row.coverImageUrl"
                      :src="row.coverImageUrl"
                      alt=""
                      loading="lazy"
                    >
                    <span v-else>{{ row.title.slice(0, 1) || '#' }}</span>
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
                        <el-icon><View /></el-icon> {{ row.views }} 阅读
                      </span>
                      <span class="flex items-center gap-1 tabular-nums">
                        <el-icon><Calendar /></el-icon>
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
                <div class="flex flex-wrap gap-1.5">
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
                <div class="flex justify-end items-center gap-1 pr-2">
                  <el-button link type="primary" @click="handleEdit(row.id)">{{ row.primaryActionLabel }}</el-button>
                  <el-divider direction="vertical" />
                  <el-dropdown>
                    <el-button link type="primary">
                      更多 <span class="ml-0.5 inline-flex"><el-icon><ArrowDown /></el-icon></span>
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

            <template #empty>
              <el-empty description="没有找到匹配的文章成果" />
            </template>
          </el-table>
        </template>
      </el-responsive-collection>

      <div class="article-list-pagination px-4 py-4 border-t border-[var(--fsusblog-panel-border)] flex items-center justify-between">
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
    </section>
  </div>
</template>

<script setup lang="ts">
import { Search, View, Calendar, Plus, ArrowDown } from '@/ui/fsusIcons'
import { type ArticleListItemResponse } from '@/api/article'
import { useAdminArticleList } from '@/composables/useAdminArticleList'
import { useMediaQuery } from '@/composables/useMediaQuery'
import AdminArticleCompactCard from '@/components/admin/article/AdminArticleCompactCard.vue'
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
const isCompactPagination = useMediaQuery('(max-width: 639px)')
const handleStatusFilterChange = (value: string | number | boolean): void => {
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

.tabular-nums {
  font-variant-numeric: tabular-nums;
}

.article-cover-thumb {
  display: grid;
  width: 4rem;
  height: 3rem;
  flex: 0 0 auto;
  place-items: center;
  overflow: hidden;
  border: 1px solid var(--fsusblog-panel-border);
  border-radius: 6px;
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

@media (max-width: 639px) {
  .article-list-pagination {
    align-items: flex-start;
    flex-direction: column;
    gap: 1rem;
  }
}
</style>
