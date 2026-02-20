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
              @clear="handleSearch"
              @keyup.enter="handleSearch"
            >
              <template #prefix><el-icon class="text-zinc-400"><Search /></el-icon></template>
            </el-input>
          </el-form-item>
          
          <el-form-item class="mb-0">
            <el-button type="primary" :loading="loading" @click="handleSearch">搜索</el-button>
            <el-button @click="resetQuery">重置</el-button>
          </el-form-item>
        </el-form>

        <el-button 
          type="primary" 
          icon="Plus" 
          @click="router.push('/admin/article/write')" 
          class="shadow-md shadow-blue-100 font-bold"
        >
          发布新博文
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
        <el-table-column prop="id" label="ID" width="80" align="center" class-name="font-mono text-zinc-300 hidden-xs" />
        
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
                <span class="flex items-center gap-1">
                  <el-icon><View /></el-icon> {{ row.views }} 阅读
                </span>
                <span class="flex items-center gap-1 hidden-sm-and-down">
                  <el-icon><Calendar /></el-icon> {{ formatDateTime(row.createTime) }}
                </span>
              </div>
            </div>
          </template>
        </el-table-column>

        <el-table-column prop="categoryName" label="分类" width="130" align="center">
          <template #default="{ row }: { row: ArticleListItem }">
            <el-tag size="small" effect="plain" class="rounded-md border-zinc-200 text-zinc-500 bg-zinc-50 px-3">
              {{ row.categoryName || '未分类' }}
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
                <el-button link type="primary" class="font-bold">
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
        <span class="text-[12px] text-zinc-400 font-medium">
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
          @current-change="loadData"
        />
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessageBox, ElMessage } from 'element-plus'
import { Search, ArrowDown, View, Calendar } from '@element-plus/icons-vue'
import { getArticles, deleteArticle, permanentDeleteArticle, type ArticleListItem } from '@/api/article'
import dayjs from 'dayjs'

const router = useRouter()

// --- 核心状态 ---
const loading = ref(false)
const articleList = ref<ArticleListItem[]>([])
const total = ref(0)

const queryParam = reactive({
  page: 1,
  size: 10,
  keyword: '',
  categoryId: undefined as number | undefined
})

/**
 * 加载数据：带防抖保护逻辑
 */
const loadData = async () => {
  if (loading.value) return
  loading.value = true
  try {
    const res = await getArticles(queryParam)
    articleList.value = res.items
    total.value = res.total
  } catch (err) {
    ElMessage.error('无法同步全站文章列表，请检查网络')
  } finally {
    loading.value = false
  }
}

/** 触发搜索：原子化重置页码 */
const handleSearch = () => {
  queryParam.page = 1
  loadData()
}

/** 重置所有搜索项 */
const resetQuery = () => {
  queryParam.keyword = ''
  queryParam.categoryId = undefined
  handleSearch()
}

/** 导航至编辑页 */
const handleEdit = (id: number) => {
  router.push(`/admin/article/write?id=${id}`)
}

/** 下拉菜单指令路由 */
const handleMoreCommand = (command: string, row: ArticleListItem) => {
  const actions: Record<string, () => void> = {
    view: () => window.open(`/article/${row.id}`, '_blank'),
    delete: () => safeDelete(row),
    permanent: () => safePermanentDelete(row)
  }
  actions[command]?.()
}

/** 软删除确认 */
const safeDelete = (row: ArticleListItem) => {
  ElMessageBox.confirm(
    `确定要将《${row.title}》存入回收站？该操作会移除前台可见性。`,
    '内容存档确认',
    {
      confirmButtonText: '确定存档',
      cancelButtonText: '取消',
      type: 'warning',
      roundButton: true
    }
  ).then(async () => {
    try {
      await deleteArticle(row.id)
      ElMessage.success('文章已进入回收站')
      loadData()
    } catch (err) {
      ElMessage.error('操作未生效')
    }
  }).catch(() => {})
}

/** 物理销毁确认：高危 */
const safePermanentDelete = (row: ArticleListItem) => {
  ElMessageBox.confirm(
    '警告：此操作将永久抹除博文及其所有关联数据，不可恢复！',
    '物理销毁警示',
    {
      confirmButtonText: '确定永久销毁',
      cancelButtonText: '放弃',
      confirmButtonClass: 'el-button--danger shadow-lg shadow-red-50',
      type: 'error',
      roundButton: true,
      center: true
    }
  ).then(async () => {
    try {
      await permanentDeleteArticle(row.id)
      ElMessage.success('博文已彻底从数据库抹除')
      loadData()
    } catch (err) {
      ElMessage.error('销毁指令执行受阻')
    }
  }).catch(() => {})
}

/** 时间格式化助手 */
const formatDateTime = (dateStr: string) => dateStr ? dayjs(dateStr).format('YYYY-MM-DD HH:mm') : '-'

onMounted(loadData)
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
  transition: all 0.2s;
}

:deep(.custom-table) {
  --el-table-header-bg-color: #fcfcfc;
  --el-table-header-text-color: #475569;
}

:deep(.el-table__row) {
  height: 70px;
}

@media (max-width: 768px) {
  .hidden-xs { display: none !important; }
}

.el-button:active {
  transform: scale(0.97);
}
</style>