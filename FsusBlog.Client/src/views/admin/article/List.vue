<template>
  <div class="article-list-wrapper">
    <el-card shadow="never" class="filter-card border-none mb-4 rounded-xl shadow-sm">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <el-form :inline="true" :model="queryParam" @submit.prevent="handleSearch" class="search-form-inline">
          <el-form-item class="mb-0">
            <el-input 
              v-model="queryParam.keyword" 
              placeholder="输入博文标题检索..." 
              clearable 
              class="w-64"
              :disabled="isBusy"
              @clear="handleSearch"
              @keyup.enter="handleSearch"
            >
              <template #prefix>
                <el-icon class="text-zinc-400"><Search /></el-icon>
              </template>
            </el-input>
          </el-form-item>
          
          <el-form-item class="mb-0">
            <el-button type="primary" :loading="isBusy" @click="handleSearch">搜索</el-button>
            <el-button @click="resetQuery" :disabled="isBusy">重置</el-button>
          </el-form-item>
        </el-form>

        <!-- [修复 2026-02-24] 统一图标组件写法，增强语义化 -->
        <el-button 
          type="primary" 
          @click="goToWriteArticle" 
          class="shadow-md shadow-blue-100 font-bold"
        >
          <el-icon class="mr-1"><Plus /></el-icon>发布新博文
        </el-button>
      </div>
    </el-card>

    <el-card shadow="never" class="list-card border-none rounded-xl shadow-sm overflow-hidden">
      <el-table 
        v-loading="loading" 
        :data="articleListView" 
        :row-key="getArticleRowKey"
        stripe 
        table-layout="fixed"
        class="custom-table w-full"
      >
        <!-- 响应式策略统一：使用 Element Plus 标准类名 -->
        <el-table-column prop="id" label="ID" width="80" align="center" class-name="font-mono text-zinc-300 hidden-xs-only" />
        
        <el-table-column label="内容概要" min-width="320">
          <template #default="{ row }: { row: ArticleListViewItem }">
            <div class="flex flex-col py-1">
              <el-link 
                type="primary" 
                class="article-title font-bold text-zinc-800 tracking-tight" 
                underline="never" 
                @click="handleEdit(row.id)"
              >
                {{ row.title }}
              </el-link>
              <div class="flex items-center gap-4 mt-2 text-[11px] text-zinc-400">
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
            <el-tag size="small" effect="plain" class="rounded-md border-zinc-200 text-zinc-500 bg-zinc-50 px-3">
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
                class="rounded-full border-none px-2.5 text-[11px] bg-zinc-100 text-zinc-500"
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

      <div class="flex justify-between items-center mt-6 px-4 py-2 bg-zinc-50/50 rounded-lg">
        <span class="text-[12px] text-zinc-400 font-medium tabular-nums">
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
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { Search, ArrowDown, View, Calendar, Plus } from '@element-plus/icons-vue'
import { type ArticleListItem } from '@/api/article'
import { useAdminArticleList } from '@/composables/useAdminArticleList'

type ArticleListViewItem = ArticleListItem & {
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
const goToWriteArticle = (): Promise<void> => router.push({ path: '/admin/article/write' })
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
  --el-table-header-text-color: #475569;
}

:deep(.el-table__row) {
  height: 70px;
}

.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
