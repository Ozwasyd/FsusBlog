<template>
  <div class="account-page article-list-wrapper w-full">
    <header class="account-page-header account-page-header--compact">
      <div class="account-page-eyebrow">管理</div>
      <h1 class="account-page-title">文章管理</h1>
      <p class="account-page-description">
        搜索、预览和维护已发布文章。常用写作入口保留在当前页，便于从列表直接进入编辑流程。
      </p>
    </header>

    <section class="admin-filter-bar mb-6" aria-label="文章筛选与创建">
      <div class="flex flex-wrap items-center justify-between gap-6">
        <el-form :inline="true" :model="queryParam" @submit.prevent="handleSearch" class="search-form-inline">
          <el-form-item class="mb-0">
            <el-input
              v-model="queryParam.keyword"
              name="articleKeyword"
              aria-label="搜索文章标题"
              placeholder="输入博文标题检索..."
              clearable
              class="w-64"
              :disabled="isBusy"
              @clear="handleSearch"
              @keyup.enter="handleSearch"
            >
              <template #prefix>
                <el-icon class="text-[#A1A1AA]"><Search /></el-icon>
              </template>
            </el-input>
          </el-form-item>

          <el-form-item class="mb-0">
            <el-button type="primary" :loading="isBusy" @click="handleSearch">搜索</el-button>
            <el-button @click="resetQuery" :disabled="isBusy">重置</el-button>
          </el-form-item>
        </el-form>

        <el-button
          type="primary"
          @click="goToWriteArticle"
          class="shadow-[0_32px_64px_rgba(0,0,0,0.08)] font-bold"
        >
          <el-icon class="mr-1"><Plus /></el-icon>发布新博文
        </el-button>
      </div>
    </section>

    <section class="admin-table-panel">
      <el-table
        v-loading="loading"
        :data="articleListView"
        :row-key="getArticleRowKey"
        stripe
        table-layout="fixed"
        class="custom-table w-full"
      >
        <el-table-column prop="id" label="ID" width="80" align="center" class-name="font-mono text-[#D4D4D8] hidden-xs-only" />

        <el-table-column label="内容概要" min-width="320">
          <template #default="{ row }: { row: ArticleListViewItem }">
            <div class="flex flex-col py-1">
              <el-link
                type="primary"
                class="article-title font-bold text-[#27272A] no-underline hover:no-underline"
                @click="handleEdit(row.id)"
              >
                {{ row.title }}
              </el-link>
              <div class="flex items-center gap-6 mt-2 text-[11px] text-[#A1A1AA]">
                <span class="flex items-center gap-1 tabular-nums">
                  <el-icon><View /></el-icon> {{ row.views }} 阅读
                </span>
                <span class="flex items-center gap-1 hidden-sm-and-down tabular-nums">
                  <el-icon><Calendar /></el-icon>
                  {{ row.createdAtText }}
                </span>
              </div>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="分类" width="130" align="center">
          <template #default="{ row }: { row: ArticleListViewItem }">
            <el-tag size="small" effect="plain" class="rounded-[8px] border-[#E4E4E7] text-[#8E8E93] bg-[#FCFCFC] px-3">
              {{ row.categoryName }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="标签" min-width="180" class-name="hidden-sm-and-down">
          <template #default="{ row }: { row: ArticleListViewItem }">
            <div class="flex flex-wrap gap-1.5">
              <el-tag
                v-for="tag in row.tags"
                :key="tag.id"
                size="small"
                type="info"
                effect="light"
                disable-transitions
                class="rounded-[var(--fsus-radius-full)]  px-2.5 text-[11px] bg-[#F4F4F5] text-[#8E8E93]"
              >
                {{ tag.name }}
              </el-tag>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="管理" width="160" fixed="right" align="right">
          <template #default="{ row }: { row: ArticleListViewItem }">
            <div class="flex justify-end items-center gap-1 pr-2">
              <el-button link type="primary" @click="handleEdit(row.id)" class="font-bold">编辑</el-button>
              <el-divider direction="vertical" />
              <el-dropdown>
                <el-button link type="primary" class="font-bold outline-none">
                  更多 <el-icon class="ml-0.5"><ArrowDown /></el-icon>
                </el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item icon="Monitor" @click="handleViewArticle(row)">前台预览</el-dropdown-item>
                    <el-dropdown-item class="text-amber-500!" icon="Box" @click="handleMoveToTrash(row)">移入回收站</el-dropdown-item>
                    <el-dropdown-item class="text-rose-500!" icon="Warning" @click="handlePermanentRemove(row)">永久抹除</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </template>
        </el-table-column>

        <template #empty>
          <el-empty description="没有找到匹配的文章成果" :image-size="100" />
        </template>
      </el-table>

      <div class="admin-table-footer">
        <span class="text-[12px] text-[#A1A1AA] font-medium tabular-nums">
          {{ totalText }}
        </span>
        <el-pagination
          v-model:current-page="queryParam.page"
          v-model:page-size="queryParam.size"
          :page-sizes="pageSizeOptions"
          layout="sizes, prev, pager, next"
          :total="total"
          background
          :disabled="isBusy"
          @size-change="handleSearch"
          @current-change="loadDataWithDebounce"
        />
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { Search, ArrowDown, View, Calendar, Plus } from '@element-plus/icons-vue'
import { type ArticleListItemResponse } from '@/api/article'
import { useAdminArticleList } from '@/composables/useAdminArticleList'

type ArticleListViewItem = ArticleListItemResponse & {
  createdAtText: string
  categoryName: string
}
const {
  router,
  loading,
  isBusy,
  articleListView,
  total,
  totalText,
  pageSizeOptions,
  queryParam,
  loadDataWithDebounce,
  handleSearch,
  resetQuery,
  handleEdit,
  handleMoreCommand
} = useAdminArticleList()

const getArticleRowKey = (row: ArticleListViewItem): string => row.id
const goToWriteArticle = (): Promise<void> => router.push({ path: '/user/manage/article/write' })
const handleViewArticle = (row: ArticleListViewItem): Promise<void> => handleMoreCommand('view', row)
const handleMoveToTrash = (row: ArticleListViewItem): Promise<void> => handleMoreCommand('delete', row)
const handlePermanentRemove = (row: ArticleListViewItem): Promise<void> => handleMoreCommand('permanent', row)
</script>

<style scoped>

.article-list-wrapper {
  animation: slide-up 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes slide-up {
  from { opacity: 0; transform: translateY(15px); }
  to { opacity: 1; transform: translateY(0); }
}

.article-title {
  font-size: 14.5px;
  line-height: 1.5;
}

:deep(.custom-table) {
  --el-table-header-bg-color: #fcfcfc;
  --el-table-header-text-color: #8E8E93;
}

:deep(.el-table__row) {
  height: 70px;
}

.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
