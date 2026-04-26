<template>
  <div class="account-page article-trash-wrapper w-full">
    <header class="account-page-header">
      <div class="account-page-eyebrow">管理</div>
      <h1 class="account-page-title">回收站</h1>
      <p class="account-page-description">
        处理已下线稿件的恢复与物理删除。永久抹除后数据不可找回。
      </p>
    </header>

    <section class="admin-page-toolbar mb-6">
      <header class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-6">
        <div>
          <h2 class="text-xl font-bold text-[#27272A] flex items-center gap-2">
            回收站
            <el-tag size="small" type="warning" effect="dark" class="rounded-[var(--fsus-radius-full)] px-3  tabular-nums">
              {{ pendingCountText }}
            </el-tag>
          </h2>
          <p class="text-[12px] text-[#A1A1AA] mt-1 italic font-medium flex items-center gap-1">
            <el-icon><InfoFilled /></el-icon>
            安全提示：恢复文章将重新发布并同步搜索索引。物理抹除后数据将不可找回。
          </p>
        </div>
        <el-button 
          @click="goToArticleList" 
          :disabled="!canBackToList"
          plain 
          class=" border-[#E4E4E7] hover:bg-[#FCFCFC] transition-all active:scale-95"
        >
          <el-icon class="mr-1"><Back /></el-icon>返回正常列表
        </el-button>
      </header>
    </section>

    <section class="admin-table-panel">
      <el-table 
        v-loading="loading" 
        :data="trashListView" 
        :row-key="getTrashRowKey"
        table-layout="fixed"
        class="trash-table w-full"
      >
        <!-- 使用响应式标准类名统一显示策略 -->
        <el-table-column prop="id" label="ID" width="100" align="center" class-name="font-mono text-[#D4D4D8] hidden-sm-and-down" />
        
        <el-table-column label="已下线博文标题" min-width="320">
          <template #default="{ row }: { row: ArticleTrashViewItem }">
            <div class="flex flex-col py-1">
              <span class="text-[#8E8E93] font-bold text-[15px] line-through decoration-[#D4D4D8] opacity-60 truncate">
                {{ row.title }}
              </span>
              <div class="flex items-center gap-6 mt-2 text-[11px] text-[#A1A1AA]">
                <span class="flex items-center gap-1 tabular-nums">
                  <el-icon><Calendar /></el-icon> 
                  创作于: {{ row.createdAtText }}
                </span>
                <el-tag size="small" type="info" effect="plain" class="rounded border-[#E4E4E7] scale-90 origin-left" disable-transitions>
                  {{ row.categoryName }}
                </el-tag>
              </div>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="200" align="right" fixed="right">
          <template #default="{ row }: { row: ArticleTrashViewItem }">
            <div class="flex justify-end items-center gap-2 pr-2">
              <!-- [修复 2026-02-24] P1 修复：引入行级提交锁，防止全局锁阻断其他行操作 -->
              <el-button 
                link 
                type="success" 
                :loading="isRowSubmitting(row.id)"
                @click="handleRestore(row)"
                class="font-bold hover:opacity-80"
              >
                <el-icon class="mr-1"><RefreshLeft /></el-icon>恢复
              </el-button>
              <el-divider direction="vertical" />
              <el-button 
                link 
                type="danger" 
                :loading="isRowSubmitting(row.id)"
                @click="handlePermanentDelete(row)"
                class="font-bold hover:opacity-80"
              >
                <el-icon class="mr-1"><DeleteFilled /></el-icon>彻底抹除
              </el-button>
            </div>
          </template>
        </el-table-column>

        <template #empty>
          <el-empty description="回收站内暂无下线稿件" :image-size="120" />
        </template>
      </el-table>

      <div class="admin-table-footer">
        <span class="text-[10px] text-[#D4D4D8] font-mono uppercase select-none">
          {{ footerWatermark }}
        </span>
        <el-pagination
          v-model:current-page="queryParam.page"
          v-model:page-size="queryParam.size"
          layout="prev, pager, next"
          :total="total"
          background
          :disabled="loading"
          class="custom-pagination"
          @current-change="loadData"
        />
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { InfoFilled, Calendar, Back, RefreshLeft, DeleteFilled } from '@element-plus/icons-vue'
import { type ArticleListItemResponse } from '@/api/article'
import { useAdminArticleTrash } from '@/composables/useAdminArticleTrash'

type ArticleTrashViewItem = ArticleListItemResponse & {
  createdAtText: string
  categoryName: string
}

const {
  router,
  loading,
  trashListView,
  total,
  pendingCountText,
  canBackToList,
  footerWatermark,
  isRowSubmitting,
  queryParam,
  loadData,
  handleRestore,
  handlePermanentDelete
} = useAdminArticleTrash()

const getTrashRowKey = (row: ArticleTrashViewItem): string => row.id
const goToArticleList = (): Promise<void> => router.push({ path: '/user/manage/article/list' })
</script>

<style scoped>

/* 变量抽离与规范化 */
:root {
  --archive-line-through: #f4f4f5;
}

.article-trash-wrapper {
  animation: slide-up 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes slide-up {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}

.line-through {
  text-decoration: line-through;
  text-decoration-color: #e4e4e7;
}

:deep(.trash-table) {
  --el-table-header-bg-color: rgba(252, 252, 252, 0.96);
  --el-table-header-text-color: #A1A1AA;
  --el-table-row-hover-bg-color: rgba(42, 89, 156, 0.04);
}

:deep(.el-table__row) {
  height: 72px;
}

:deep(.trash-table .el-table__header th) {
  font-size: 0.65rem;
  letter-spacing: 0;
  text-transform: uppercase;
}

:deep(.trash-table .el-table__inner-wrapper::before) {
  display: none;
}

.tabular-nums {
  font-variant-numeric: tabular-nums;
}

.el-button:active {
  transform: scale(0.96);
}

:deep(.el-pagination.is-background .el-pager li:not(.is-active)) {
  background-color: transparent;
}
</style>
