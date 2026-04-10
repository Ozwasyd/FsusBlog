<template>
  <div class="article-trash-wrapper">
    <el-card shadow="never" class="action-card mb-5 border-none rounded-xl">
      <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 px-2">
        <div class="header-info">
          <h2 class="text-xl font-bold text-zinc-800 tracking-tight flex items-center gap-2">
            回收站
            <el-tag size="small" type="warning" effect="dark" class="rounded-full px-3 border-none tabular-nums">
              {{ pendingCountText }}
            </el-tag>
          </h2>
          <p class="text-[12px] text-zinc-400 mt-1 italic font-medium flex items-center gap-1">
            <el-icon><InfoFilled /></el-icon>
            安全提示：恢复文章将重新发布并同步搜索索引。物理抹除后数据将不可找回。
          </p>
        </div>
        <el-button 
          @click="goToArticleList" 
          :disabled="!canBackToList"
          plain 
          class="rounded-xl border-zinc-200 hover:bg-zinc-50 transition-all active:scale-95"
        >
          <el-icon class="mr-1"><Back /></el-icon>返回正常列表
        </el-button>
      </div>
    </el-card>

    <el-card shadow="never" class="list-card border-none rounded-xl shadow-sm overflow-hidden">
      <el-table 
        v-loading="loading" 
        :data="trashListView" 
        :row-key="getTrashRowKey"
        stripe 
        table-layout="fixed"
        class="trash-table w-full"
      >
        <!-- 使用响应式标准类名统一显示策略 -->
        <el-table-column prop="id" label="ID" width="100" align="center" class-name="font-mono text-zinc-300 hidden-sm-and-down" />
        
        <el-table-column label="已下线博文标题" min-width="320">
          <template #default="{ row }: { row: ArticleTrashViewItem }">
            <div class="flex flex-col py-1">
              <span class="text-zinc-500 font-bold text-[15px] line-through decoration-zinc-300 opacity-60 truncate">
                {{ row.title }}
              </span>
              <div class="flex items-center gap-4 mt-2 text-[11px] text-zinc-400">
                <span class="flex items-center gap-1 tabular-nums">
                  <el-icon><Calendar /></el-icon> 
                  创作于: {{ row.createdAtText }}
                </span>
                <el-tag size="small" type="info" effect="plain" class="rounded border-zinc-200 scale-90 origin-left" disable-transitions>
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

      <div class="flex justify-between items-center mt-6 px-4 pb-2">
        <span class="text-[10px] text-zinc-300 font-mono tracking-widest uppercase select-none">
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
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { InfoFilled, Calendar, Back, RefreshLeft, DeleteFilled } from '@element-plus/icons-vue'
import { type ArticleListItem } from '@/api/article'
import { useAdminArticleTrash } from '@/composables/useAdminArticleTrash'

type ArticleTrashViewItem = ArticleListItem & {
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
const goToArticleList = (): Promise<void> => router.push({ path: '/admin/article/list' })
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
  --el-table-header-bg-color: #fafafa;
  --el-table-header-text-color: #94a3b8;
}

:deep(.el-table__row) {
  height: 72px;
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
