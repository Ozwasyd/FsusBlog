<template>
  <div class="account-page article-trash-wrapper account-motion-enter w-full">
    <header class="account-page-header account-page-header--compact">
      <h1 class="account-page-title">回收站</h1>
      <p class="account-page-description">
        恢复下线文章或执行永久删除。
      </p>
    </header>

    <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)] mb-8" aria-label="回收站状态">
      <AdminCollectionSummary :title="trashStateText" description="恢复后重新公开；永久删除不可找回。">
        <template #actions>
          <el-button
            @click="goToArticleList"
            :disabled="!canBackToList"
            :icon="Back"
          >
            返回文章列表
          </el-button>
        </template>
      </AdminCollectionSummary>
    </section>

    <section class="border-t border-[var(--fsusblog-panel-border)]" aria-labelledby="article-trash-title">
      <AdminCollectionSummary id="article-trash-title" title="下线稿件" :meta="trashResultText" />
      <div
        v-if="isCompact"
        v-loading="loading"
        class="trash-card-list divide-y divide-[var(--fsusblog-panel-border)]"
        role="list"
        aria-label="回收站内容"
      >
        <article
          v-for="row in trashListView"
          :key="row.id"
          class="trash-card bg-[var(--fsusblog-page-bg)] px-4 py-5"
          role="listitem"
        >
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <h3 class="truncate text-[15px] font-bold text-[var(--fsusblog-text-muted)] line-through decoration-[var(--fsusblog-panel-border-strong)] opacity-70">
                {{ row.title }}
              </h3>
              <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-[var(--fsusblog-text-muted)]">
                <SemanticTime :value="row.createTime" :text="row.createdAtText" class="tabular-nums" />
                <el-tag size="small" type="info">{{ row.categoryName }}</el-tag>
              </div>
            </div>
            <span class="shrink-0 tabular-nums text-[12px] font-bold text-[var(--fsusblog-text-subtle)]">#{{ row.id }}</span>
          </div>
          <div class="mt-5 grid grid-cols-2 gap-2">
            <el-button
              type="success"
              :loading="isRowSubmitting(row.id)"
              @click="handleRestore(row)"
            >
              {{ row.restoreActionText }}
            </el-button>
            <el-button
              type="danger"
              :loading="isRowSubmitting(row.id)"
              @click="handlePermanentDelete(row)"
            >
              永久删除
            </el-button>
          </div>
        </article>
        <AdminInlineEmptyState
          v-if="!loading && trashListView.length === 0"
          title="回收站暂无下线稿件"
          description="删除或归档的文章会显示在这里。"
        >
          <template #actions>
            <el-button class="article-trash-empty-action" link type="primary" :disabled="!canBackToList" @click="goToArticleList">返回文章列表</el-button>
          </template>
        </AdminInlineEmptyState>
      </div>
      <div v-else class="blog-scroll-x-safe">
        <div class="min-w-full sm:min-w-[44rem]">
          <el-table
            v-loading="loading"
            :data="trashListView"
            :row-key="getTrashRowKey"
          >
            <el-table-column v-if="!isCompact" prop="id" label="ID" width="100" align="center">
              <template #default="{ row }: { row: ArticleTrashViewItem }">
                <span class="tabular-nums">{{ row.id }}</span>
              </template>
            </el-table-column>

            <el-table-column label="已下线博文标题" min-width="320">
              <template #default="{ row }: { row: ArticleTrashViewItem }">
                <div class="flex flex-col py-1">
                  <span class="text-[var(--fsusblog-text-muted)] font-bold text-[15px] line-through decoration-[var(--fsusblog-panel-border-strong)] opacity-60 truncate">
                    {{ row.title }}
                  </span>
                  <div class="flex items-center gap-6 mt-2 text-[12px] text-[var(--fsusblog-text-muted)]">
                    <span class="flex items-center gap-1 tabular-nums">
                      <el-icon aria-hidden="true"><Calendar /></el-icon>
                      <SemanticTime :value="row.createTime" :text="row.createdAtText" />
                    </span>
                    <el-tag size="small" type="info">
                      {{ row.categoryName }}
                    </el-tag>
                  </div>
                </div>
              </template>
            </el-table-column>

            <el-table-column label="操作" width="200" align="right" fixed="right">
              <template #default="{ row }: { row: ArticleTrashViewItem }">
                <div class="flex justify-end items-center gap-2 pr-2">
                  <el-button
                    link
                    type="success"
                    :loading="isRowSubmitting(row.id)"
                    @click="handleRestore(row)"
                  >
                    {{ row.restoreActionText }}
                  </el-button>
                  <el-divider direction="vertical" />
                  <el-button
                    link
                    type="danger"
                    :loading="isRowSubmitting(row.id)"
                    @click="handlePermanentDelete(row)"
                  >
                    永久删除
                  </el-button>
                </div>
              </template>
            </el-table-column>

            <template #empty>
              <AdminInlineEmptyState title="回收站暂无下线稿件" description="删除或归档的文章会显示在这里。">
                <template #actions>
                  <el-button class="article-trash-empty-action" link type="primary" :disabled="!canBackToList" @click="goToArticleList">返回文章列表</el-button>
                </template>
              </AdminInlineEmptyState>
            </template>
          </el-table>
        </div>
      </div>

      <div class="px-4 py-4 border-t border-[var(--fsusblog-panel-border)] flex items-center justify-between">
        <span class="text-[11px] text-[var(--fsusblog-text-subtle)] tabular-nums normal-case select-none">
          永久删除不可撤销。
        </span>
        <el-pagination
          v-model:current-page="queryParam.page"
          v-model:page-size="queryParam.size"
          layout="prev, pager, next"
          :total="total"
          :disabled="loading"
          @current-change="loadData"
        />
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Calendar, Back } from '@/fsusui/icons'
import { type ArticleListItemResponse } from '@/api/article'
import { useAdminArticleTrash } from '@/composables/useAdminArticleTrash'
import { useMediaQuery } from '@/composables/useMediaQuery'
import AdminCollectionSummary from '@/components/admin/AdminCollectionSummary.vue'
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue'
import SemanticTime from '@/components/ui/SemanticTime.vue'

type ArticleTrashViewItem = ArticleListItemResponse & {
  createdAtText: string
  categoryName: string
  restoreActionText: string
}

const {
  router,
  loading,
  trashListView,
  total,
  canBackToList,
  isRowSubmitting,
  queryParam,
  loadData,
  handleRestore,
  handlePermanentDelete
} = useAdminArticleTrash()

const getTrashRowKey = (row: ArticleTrashViewItem): string => String(row.id)
const isCompact = useMediaQuery('(max-width: 767px)')
const trashStateText = computed(() => `回收站 · ${total.value} 篇下线稿件`)
const trashResultText = computed(() => `${total.value} 条记录`)
const goToArticleList = async (): Promise<void> => {
  await router.push({ path: '/user/manage/article/list' })
}
</script>

<style scoped>

.blog-scroll-x-safe {
  max-width: 100%;
  min-width: 0;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

.line-through {
  text-decoration: line-through;
  text-decoration-color: var(--fsusblog-panel-border-strong);
}

.tabular-nums {
  font-variant-numeric: tabular-nums;
}

:deep(.article-trash-empty-action.el-button) {
  min-height: 40px;
  align-items: center;
}

</style>
