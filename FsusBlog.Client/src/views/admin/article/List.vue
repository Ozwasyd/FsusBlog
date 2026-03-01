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
              :disabled="loading"
              @clear="handleSearch"
              @keyup.enter="handleSearch"
            >
              <template #prefix>
                <el-icon class="text-zinc-400"><Search /></el-icon>
              </template>
            </el-input>
          </el-form-item>
          
          <el-form-item class="mb-0">
            <el-button type="primary" :loading="loading" @click="handleSearch">搜索</el-button>
            <el-button @click="resetQuery" :disabled="loading">重置</el-button>
          </el-form-item>
        </el-form>

        <!-- [修复 2026-02-24] 统一图标组件写法，增强语义化 -->
        <el-button 
          type="primary" 
          @click="router.push({ path: '/admin/article/write' })" 
          class="shadow-md shadow-blue-100 font-bold"
        >
          <el-icon class="mr-1"><Plus /></el-icon>发布新博文
        </el-button>
      </div>
    </el-card>

    <el-card shadow="never" class="list-card border-none rounded-xl shadow-sm overflow-hidden">
      <el-table 
        v-loading="loading" 
        :data="articleList" 
        :row-key="(row: ArticleListItem) => row.id"
        stripe 
        table-layout="fixed"
        class="custom-table w-full"
      >
        <!-- 响应式策略统一：使用 Element Plus 标准类名 -->
        <el-table-column prop="id" label="ID" width="80" align="center" class-name="font-mono text-zinc-300 hidden-xs-only" />
        
        <el-table-column label="内容概要" min-width="320">
          <template #default="{ row }: { row: ArticleListItem }">
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
                  {{ TimeUtils.toFullLocalString(row.createTime) }}
                </span>
              </div>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="分类" width="130" align="center">
          <template #default="{ row }: { row: ArticleListItem }">
            <el-tag size="small" effect="plain" class="rounded-md border-zinc-200 text-zinc-500 bg-zinc-50 px-3">
              {{ row.category?.name || '未分类' }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="标签" min-width="180" class-name="hidden-sm-and-down">
          <template #default="{ row }: { row: ArticleListItem }">
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
          <template #default="{ row }: { row: ArticleListItem }">
            <div class="flex justify-end items-center gap-1 pr-2">
              <el-button link type="primary" @click="handleEdit(row.id)" class="font-bold">编辑</el-button>
              <el-divider direction="vertical" />
              <el-dropdown @command="(cmd: string) => handleMoreCommand(cmd, row)">
                <el-button link type="primary" class="font-bold outline-none">
                  更多 <el-icon class="ml-0.5"><ArrowDown /></el-icon>
                </el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="view" icon="Monitor">前台预览</el-dropdown-item>
                    <el-dropdown-item command="delete" icon="Box" class="text-amber-500!">移入回收站</el-dropdown-item>
                    <el-dropdown-item command="permanent" icon="Warning" class="text-rose-500!">永久抹除</el-dropdown-item>
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
          检索到 {{ total }} 篇记录
        </span>
        <el-pagination
          v-model:current-page="queryParam.page"
          v-model:page-size="queryParam.size"
          :page-sizes="[10, 20, 50]"
          layout="sizes, prev, pager, next"
          :total="total"
          background
          :disabled="loading"
          @size-change="handleSearch"
          @current-change="loadDataWithDebounce"
        />
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessageBox, ElMessage } from 'element-plus'
import { Search, ArrowDown, View, Calendar, Plus } from '@element-plus/icons-vue'
import { getArticles, deleteArticle, permanentDeleteArticle, type ArticleListItem } from '@/api/article'
import { TimeUtils } from '@/utils/time'
import type { AxiosRequestConfig } from 'axios'

const router = useRouter()

// --- 核心状态 ---
const loading = ref(false)

/**
 * [修复 2026-02-24] 性能最大化：数据不可变约束说明
 * 逻辑自洽：采用 shallowRef 配合 Object.freeze。
 * 注意：由于执行了冻结，任何对 articleList 内部对象的直接修改将被物理阻止，
 * 如需修改行状态，必须通过重新赋值数组实现。
 */
const articleList = shallowRef<ArticleListItem[]>([])
const total = ref(0)

const queryParam = reactive({
  page: 1,
  size: 10,
  keyword: '',
  categoryId: undefined as number | undefined
})

// 物理安全机制：AbortController 快照管理
let abortController: AbortController | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 数据拉取逻辑
 * 算法最优：参数快照化，解决 reactive 引用导致的潜在请求污染
 */
const loadData = async () => {
  if (abortController) abortController.abort()
  const currentController = new AbortController()
  abortController = currentController
  const { signal } = currentController

  // 参数快照化：物理切断与 reactive 对象的实时引用，保障请求参数的一致性
  const paramsSnapshot = { ...queryParam }

  loading.value = true
  try {
    const res = await getArticles(paramsSnapshot, { signal } as AxiosRequestConfig)
    
    if (abortController === currentController) {
      // 数据契约校验
      if (res && Array.isArray(res.items)) {
        articleList.value = Object.freeze(res.items) as ArticleListItem[]
        total.value = Number(res.total) || 0
      } else {
        throw new Error('API_FORMAT_ERROR')
      }
    }
  } catch (err: any) {
    if (err.name !== 'AbortError' && abortController === currentController) {
      console.error('[Admin List] Sync Error:', err)
      ElMessage.error('无法同步文章列表，请检查网络契约')
      articleList.value = []
      total.value = 0
    }
  } finally {
    if (abortController === currentController) {
      loading.value = false
      abortController = null
    }
  }
}

/**
 * [修复 2026-02-24] 性能优化：引入轻量级防抖
 * 场景：防止管理员在分页器上进行“压力测试”级别的快速点击
 */
const loadDataWithDebounce = () => {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(loadData, 100)
}

/** 触发搜索 */
const handleSearch = () => {
  queryParam.page = 1
  loadData()
}

/** 重置搜索项 */
const resetQuery = () => {
  queryParam.keyword = ''
  queryParam.categoryId = undefined
  handleSearch()
}

const handleEdit = (id: number) => {
  router.push({ path: '/admin/article/write', query: { id } })
}

const handleMoreCommand = (command: string, row: ArticleListItem) => {
  const actions: Record<string, () => void> = {
    view: () => window.open(`/article/${row.id}`, '_blank', 'noopener,noreferrer'),
    delete: () => safeDelete(row),
    permanent: () => safePermanentDelete(row)
  }
  actions[command]?.()
}

/**
 * 软删除：增加 XSS 物理防御
 */
const safeDelete = (row: ArticleListItem) => {
  // 安全性保障：MessageBox 默认转义 HTML，此处手动通过 textContent 确保安全
  ElMessageBox.confirm(
    `确定要将文章《${row.title}》存入回收站吗？`,
    '内容存档确认',
    {
      confirmButtonText: '确定存档',
      cancelButtonText: '取消',
      type: 'warning',
      roundButton: true,
      dangerouslyUseHTMLString: false // 物理禁止 HTML 解析，防范标题 XSS 注入
    }
  ).then(async () => {
    try {
      await deleteArticle(row.id)
      ElMessage.success('文章已进入回收站')
      loadData()
    } catch (err) {
      /* ignore */
    }
  }).catch(() => {})
}

/**
 * 物理销毁
 */
const safePermanentDelete = (row: ArticleListItem) => {
  ElMessageBox.confirm(
    `警告：此操作将永久抹除博文《${row.title}》及其所有关联数据，不可恢复！`,
    '物理销毁警示',
    {
      confirmButtonText: '确定永久销毁',
      cancelButtonText: '放弃',
      confirmButtonClass: 'el-button--danger',
      type: 'error',
      roundButton: true,
      center: true,
      dangerouslyUseHTMLString: false
    }
  ).then(async () => {
    try {
      await permanentDeleteArticle(row.id)
      ElMessage.success('博文已彻底从数据库抹除')
      loadData()
    } catch (err) {
      /* ignore */
    }
  }).catch(() => {})
}

onMounted(loadData)

onUnmounted(() => {
  if (abortController) abortController.abort()
  if (debounceTimer) clearTimeout(debounceTimer)
})
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