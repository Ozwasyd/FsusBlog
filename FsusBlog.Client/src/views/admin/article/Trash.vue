<template>
  <div class="article-trash-wrapper">
    <el-card shadow="never" class="action-card mb-5 border-none rounded-xl">
      <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 px-2">
        <div class="header-info">
          <h2 class="text-xl font-bold text-zinc-800 tracking-tight flex items-center gap-2">
            回收站
            <el-tag size="small" type="warning" effect="dark" class="rounded-full px-3 border-none">
              {{ total }} 篇待处理
            </el-tag>
          </h2>
          <p class="text-[12px] text-zinc-400 mt-1 italic font-medium flex items-center gap-1">
            <el-icon><InfoFilled /></el-icon>
            安全模式：恢复文章将重新发布并同步搜索索引。物理抹除后数据将不可找回。
          </p>
        </div>
        <el-button 
          @click="router.push('/admin/article/list')" 
          plain 
          icon="Back"
          class="rounded-xl border-zinc-200 hover:bg-zinc-50 transition-all active:scale-95"
        >
          返回正常列表
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
        <el-table-column prop="id" label="ID" width="100" align="center" class-name="font-mono text-zinc-300 hidden-xs" />
        
        <el-table-column label="已下线博文标题" min-width="320">
          <template #default="{ row }: { row: ArticleListItem }">
            <div class="flex flex-col py-1">
              <span class="text-zinc-500 font-bold text-[15px] line-through decoration-zinc-300 opacity-60 truncate">
                {{ row.title }}
              </span>
              <div class="flex items-center gap-4 mt-2 text-[11px] text-zinc-400">
                <span class="flex items-center gap-1">
                  <el-icon><Calendar /></el-icon> 创作于: {{ formatDateTime(row.createTime) }}
                </span>
                <el-tag size="small" type="info" effect="plain" class="rounded border-zinc-200 scale-90 origin-left" disable-transitions>
                  {{ row.categoryName }}
                </el-tag>
              </div>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="危险管理" width="200" align="right" fixed="right">
          <template #default="{ row }: { row: ArticleListItem }">
            <div class="flex justify-end items-center gap-2 pr-2">
              <el-button 
                link 
                type="success" 
                icon="RefreshLeft" 
                :loading="submitting"
                @click="handleRestore(row)"
                class="font-bold hover:opacity-80"
              >
                恢复
              </el-button>
              <el-divider direction="vertical" />
              <el-button 
                link 
                type="danger" 
                icon="DeleteFilled" 
                :loading="submitting"
                @click="handlePermanentDelete(row)"
                class="font-bold hover:opacity-80"
              >
                彻底抹除
              </el-button>
            </div>
          </template>
        </el-table-column>

        <template #empty>
          <el-empty description="回收站内暂无下线稿件" :image-size="120" />
        </template>
      </el-table>

      <div class="flex justify-between items-center mt-6 px-4 pb-2">
        <span class="text-[10px] text-zinc-300 font-mono tracking-widest uppercase">
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
import { ref, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { InfoFilled, Calendar } from '@element-plus/icons-vue'
import { getArticles, restoreArticle, permanentDeleteArticle, type ArticleListItem } from '@/api/article'
import dayjs from 'dayjs'

const router = useRouter()

// --- 状态与并发锁 ---
const loading = ref(false)
const submitting = ref(false) // 🌟 并发操作锁
const trashList = ref<ArticleListItem[]>([])
const total = ref(0)

const queryParam = reactive({
  page: 1,
  size: 10,
  isDeleted: true // 🌟 必须显式请求已删除数据
})

/**
 * 同步回收站资源
 */
const loadData = async () => {
  if (loading.value) return
  loading.value = true
  try {
    const res = await getArticles(queryParam)
    trashList.value = res.items
    total.value = res.total
  } catch (err) {
    // 权限或网络异常已由 axios 拦截器处理
  } finally {
    loading.value = false
  }
}

/**
 * 恢复文章逻辑
 */
const handleRestore = (row: ArticleListItem) => {
  if (submitting.value) return
  
  ElMessageBox.confirm(
    `博文恢复确认：确定要恢复《${row.title}》吗？\n恢复后，读者将重新在首页及搜索中看到此文章。`,
    '恢复确认',
    {
      confirmButtonText: '立即恢复',
      cancelButtonText: '取消',
      type: 'success',
      roundButton: true,
      center: true
    }
  ).then(async () => {
    submitting.value = true
    try {
      await restoreArticle(row.id)
      ElMessage.success('恢复成功：数据已重返发布列表')
      await loadData()
    } catch (err) {
      ElMessage.error('恢复指令执行异常')
    } finally {
      submitting.value = false
    }
  }).catch(() => {})
}

/**
 * 物理抹除逻辑：极度危险
 */
const handlePermanentDelete = (row: ArticleListItem) => {
  if (submitting.value) return

  ElMessageBox.confirm(
    '【不可逆操作】确定要物理销毁该博文及其关联磁盘资源吗？抹除后数据将无法找回。',
    '物理销毁警示',
    {
      confirmButtonText: '确定抹除',
      cancelButtonText: '保留数据',
      confirmButtonClass: 'el-button--danger shadow-lg shadow-red-100',
      type: 'error',
      roundButton: true,
      center: true
    }
  ).then(async () => {
    submitting.value = true
    try {
      await permanentDeleteArticle(row.id)
      ElMessage.warning('文章及物理资源已彻底销毁')
      await loadData()
    } catch (err) {
      // 错误由拦截器捕获
    } finally {
      submitting.value = false
    }
  }).catch(() => {})
}

const formatDateTime = (dateStr: string) => dayjs(dateStr).format('YYYY-MM-DD HH:mm')

onMounted(loadData)
</script>

<style scoped>
.article-trash-wrapper {
  animation: slide-up 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes slide-up {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}

.line-through {
  text-decoration: line-through;
  text-decoration-color: #f4f4f5;
}

:deep(.trash-table) {
  --el-table-header-bg-color: #fafafa;
  --el-table-header-text-color: #d4d4d8;
}

:deep(.el-table__row) {
  height: 72px;
}

@media (max-width: 640px) {
  .hidden-xs { display: none !important; }
}

.el-button:active {
  transform: scale(0.96);
}

/* 分页器背景透明化，符合 Zinc 审美 */
:deep(.el-pagination.is-background .el-pager li:not(.is-active)) {
  background-color: transparent;
}
</style>