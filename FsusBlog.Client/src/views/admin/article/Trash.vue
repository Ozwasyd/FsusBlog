<template>
  <div class="article-trash-wrapper">
    <el-card shadow="never" class="action-card mb-5 border-none rounded-xl">
      <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 px-2">
        <div class="header-info">
          <h2 class="text-xl font-bold text-zinc-800 tracking-tight flex items-center gap-2">
            回收站
            <el-tag size="small" type="warning" effect="dark" class="rounded-full px-3 border-none tabular-nums">
              {{ total }} 篇待处理
            </el-tag>
          </h2>
          <p class="text-[12px] text-zinc-400 mt-1 italic font-medium flex items-center gap-1">
            <el-icon><InfoFilled /></el-icon>
            安全提示：恢复文章将重新发布并同步搜索索引。物理抹除后数据将不可找回。
          </p>
        </div>
        <el-button 
          @click="router.push({ path: '/admin/article/list' })" 
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
        :data="trashList" 
        :row-key="(row: ArticleListItem) => row.id"
        stripe 
        table-layout="fixed"
        class="trash-table w-full"
      >
        <!-- 使用响应式标准类名统一显示策略 -->
        <el-table-column prop="id" label="ID" width="100" align="center" class-name="font-mono text-zinc-300 hidden-sm-and-down" />
        
        <el-table-column label="已下线博文标题" min-width="320">
          <template #default="{ row }: { row: ArticleListItem }">
            <div class="flex flex-col py-1">
              <span class="text-zinc-500 font-bold text-[15px] line-through decoration-zinc-300 opacity-60 truncate">
                {{ row.title }}
              </span>
              <div class="flex items-center gap-4 mt-2 text-[11px] text-zinc-400">
                <span class="flex items-center gap-1 tabular-nums">
                  <el-icon><Calendar /></el-icon> 
                  创作于: {{ TimeUtils.toFullLocalString(row.createTime) }}
                </span>
                <el-tag size="small" type="info" effect="plain" class="rounded border-zinc-200 scale-90 origin-left" disable-transitions>
                  {{ row.category?.name || '无分类' }}
                </el-tag>
              </div>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="200" align="right" fixed="right">
          <template #default="{ row }: { row: ArticleListItem }">
            <div class="flex justify-end items-center gap-2 pr-2">
              <!-- [修复 2026-02-24] P1 修复：引入行级提交锁，防止全局锁阻断其他行操作 -->
              <el-button 
                link 
                type="success" 
                :loading="submittingIds.has(row.id)"
                @click="handleRestore(row)"
                class="font-bold hover:opacity-80"
              >
                <el-icon class="mr-1"><RefreshLeft /></el-icon>恢复
              </el-button>
              <el-divider direction="vertical" />
              <el-button 
                link 
                type="danger" 
                :loading="submittingIds.has(row.id)"
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
          FsusBlog Archive Storage / Secured
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
import { ref, reactive, onMounted, onUnmounted, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { InfoFilled, Calendar, Back, RefreshLeft, DeleteFilled } from '@element-plus/icons-vue'
import { getArticles, restoreArticle, permanentDeleteArticle, type ArticleListItem } from '@/api/article'
import { TimeUtils } from '@/utils/time'
import type { AxiosRequestConfig } from 'axios'

const router = useRouter()

// --- 状态管理 ---
const loading = ref(false)

/**
 * [修复 2026-02-24] 数据不可变契约：行数据视为只读模型
 * 逻辑自洽：采用 shallowRef 避免深层追踪。
 */
const trashList = shallowRef<ArticleListItem[]>([])
const total = ref(0)

// [修复 2026-02-24] P1 修复：行级提交锁，支持并发处理不同行的数据
const submittingIds = ref<Set<number>>(new Set())

const queryParam = reactive({
  page: 1,
  size: 10,
  isDeleted: true 
})

// 并发安全：控制器快照
let abortController: AbortController | null = null

/**
 * 数据同步逻辑
 */
const loadData = async () => {
  if (abortController) abortController.abort()
  const currentController = new AbortController()
  abortController = currentController
  const { signal } = currentController

  // 参数快照化
  const paramsSnapshot = { ...queryParam }

  loading.value = true
  try {
    const res = await getArticles(paramsSnapshot, { signal } as AxiosRequestConfig)
    
    if (abortController === currentController) {
      // 执行 Object.freeze 确保数组结构不可变
      trashList.value = Object.freeze(res?.items || []) as ArticleListItem[]
      total.value = Number(res?.total) || 0
    }
  } catch (err: any) {
    if (err.name !== 'AbortError' && abortController === currentController) {
      console.error('[Admin Trash] Sync error:', err)
      ElMessage.error('无法同步回收站数据')
    }
  } finally {
    if (abortController === currentController) {
      loading.value = false
      abortController = null
    }
  }
}

/**
 * 恢复文章
 */
const handleRestore = (row: ArticleListItem) => {
  if (submittingIds.value.has(row.id)) return
  
  ElMessageBox.confirm(
    `确定要恢复文章《${row.title}》吗？`,
    '恢复确认',
    {
      confirmButtonText: '立即恢复',
      cancelButtonText: '取消',
      type: 'success',
      roundButton: true,
      dangerouslyUseHTMLString: false
    }
  ).then(async () => {
    submittingIds.value.add(row.id)
    try {
      await restoreArticle(row.id)
      ElMessage.success('文章已恢复')
      await loadData()
    } catch (err) {
      console.error('[Admin Trash] Restore error:', err)
    } finally {
      submittingIds.value.delete(row.id)
    }
  }).catch(() => {
    // 捕获用户取消动作，无需额外处理
  })
}

/**
 * 彻底抹除
 */
const handlePermanentDelete = (row: ArticleListItem) => {
  if (submittingIds.value.has(row.id)) return

  ElMessageBox.confirm(
    `确定要彻底抹除文章《${row.title}》吗？此操作不可逆。`,
    '物理销毁警示',
    {
      confirmButtonText: '确定抹除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
      type: 'error',
      roundButton: true,
      dangerouslyUseHTMLString: false
    }
  ).then(async () => {
    submittingIds.value.add(row.id)
    try {
      await permanentDeleteArticle(row.id)
      ElMessage.warning('数据已彻底抹除')
      await loadData()
    } catch (err) {
      console.error('[Admin Trash] Delete error:', err)
    } finally {
      submittingIds.value.delete(row.id)
    }
  }).catch(() => {
    // 捕获用户取消动作
  })
}

onMounted(loadData)

onUnmounted(() => {
  if (abortController) abortController.abort()
})
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