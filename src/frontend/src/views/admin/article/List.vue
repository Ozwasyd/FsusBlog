<template>
  <div class="account-page article-list-wrapper w-full">
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
    </section>

    <section class="border-t border-[var(--fsusblog-panel-border)]">
      <div class="px-4 py-3 border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] flex items-center justify-between">
        <div class="text-[10px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">文章列表 / ARTICLE LIST</div>
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
            @permanent-remove="handlePermanentRemove"
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
                <div class="flex flex-col py-1">
                  <el-link
                    type="primary"
                    @click="handleEdit(row.id)"
                  >
                    {{ row.title }}
                  </el-link>
                  <div class="flex items-center gap-6 mt-2 text-[11px] text-[var(--fsusblog-text-muted)]">
                    <span class="flex items-center gap-1 tabular-nums">
                      <el-icon><View /></el-icon> {{ row.views }} 阅读
                    </span>
                    <span class="flex items-center gap-1 tabular-nums">
                      <el-icon><Calendar /></el-icon>
                      {{ row.createdAtText }}
                    </span>
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
                  <el-button link type="primary" @click="handleEdit(row.id)">编辑</el-button>
                  <el-divider direction="vertical" />
                  <el-dropdown>
                    <el-button link type="primary">
                      更多 <span class="ml-0.5 inline-flex"><el-icon><ArrowDown /></el-icon></span>
                    </el-button>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item icon="Monitor" @click="handleViewArticle(row)">前台预览</el-dropdown-item>
                        <el-dropdown-item icon="Box" @click="handleMoveToTrash(row)">移入回收站</el-dropdown-item>
                        <el-dropdown-item icon="Warning" @click="handlePermanentRemove(row)">永久抹除</el-dropdown-item>
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
          @size-change="handleSearch"
          @current-change="loadDataWithDebounce"
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

type ArticleListViewItem = ArticleListItemResponse & {
  createdAtText: string
  categoryName: string
  statusText: string
  statusTagType: 'success' | 'warning' | 'info' | 'danger'
}
const {
  router,
  loading,
  isBusy,
  articleListView,
  total,
  totalText,
  pageSizeOptions,
  statusFilters,
  queryParam,
  setStatusFilter,
  loadDataWithDebounce,
  handleSearch,
  resetQuery,
  handleEdit,
  handleMoreCommand
} = useAdminArticleList()

const getArticleRowKey = (row: ArticleListViewItem): string => String(row.id)
const isCompactPagination = useMediaQuery('(max-width: 639px)')
const handleStatusFilterChange = (value: string | number | boolean): void => {
  setStatusFilter(typeof value === 'number' ? value as Parameters<typeof setStatusFilter>[0] : undefined)
}
const goToWriteArticle = async (): Promise<void> => {
  await router.push({ path: '/user/manage/article/write' })
}
const handleViewArticle = (row: ArticleListViewItem): void => handleMoreCommand('view', row)
const handleMoveToTrash = (row: ArticleListViewItem): void => handleMoreCommand('delete', row)
const handlePermanentRemove = (row: ArticleListViewItem): void => handleMoreCommand('permanent', row)
</script>

<style scoped>

.article-list-wrapper {
  animation: slide-up var(--fsus-motion-panel) var(--fsus-motion-standard);
}

@keyframes slide-up {
  from { opacity: 0; transform: translateY(15px); }
  to { opacity: 1; transform: translateY(0); }
}

.tabular-nums {
  font-variant-numeric: tabular-nums;
}

@media (max-width: 639px) {
  .article-list-pagination {
    align-items: flex-start;
    flex-direction: column;
    gap: 1rem;
  }
}
</style>
