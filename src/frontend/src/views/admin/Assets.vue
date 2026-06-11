<template>
  <div class="account-page asset-library-page account-motion-enter w-full">
    <AccountPageHeader
      eyebrow="管理 / MEDIA"
      title="资产库"
      description="查看上传资产、引用计数与孤儿文件，清理动作需要明确确认。"
    />

    <WorkbenchPanel
      class="mb-12"
      eyebrow="媒体资产 / ASSETS"
      title="资产库存"
      caption="资产库独立承载列表、文章引用重建、孤儿资产清理和物理删除。"
      title-id="asset-library-title"
    >
      <template #title>
        资产库存
        <span class="text-[var(--fsusblog-text-primary)] tabular-nums">{{ assets.length }}</span>
      </template>
      <template #actions>
        <div class="flex flex-wrap items-center justify-end gap-2">
          <el-button :icon="Refresh" :loading="loading" @click="loadAssets">刷新</el-button>
          <el-button type="danger" :icon="Delete" :loading="processing" @click="confirmCleanupOrphans">清理孤儿资产</el-button>
        </div>
      </template>
    </WorkbenchPanel>

    <section class="admin-data-surface">
      <div class="admin-data-surface__toolbar admin-data-surface__toolbar--stacked">
        <div class="admin-data-surface__toolbar-row">
          <div class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">资产列表 / MEDIA LIBRARY</div>
          <div class="flex flex-wrap items-center gap-2">
            <el-input
              v-model="keyword"
              class="asset-filter-input"
              clearable
              placeholder="搜索 URL / SHA"
              aria-label="搜索资产"
              :prefix-icon="Search"
            />
            <el-checkbox v-model="orphanOnly">仅孤儿资产</el-checkbox>
          </div>
        </div>

        <el-form class="admin-data-surface__action-row asset-reindex-form" inline @submit.prevent="reindexCurrentArticle">
          <el-form-item label="文章 ID">
            <el-input v-model="reindexArticleId" class="article-id-input" placeholder="输入文章 ID" />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :icon="Refresh" :loading="processing" @click="reindexCurrentArticle">
              重建文章引用
            </el-button>
          </el-form-item>
        </el-form>
      </div>

      <el-table v-loading="loading" :data="filteredAssets" row-key="id">
        <el-table-column prop="id" label="ID" width="96" align="center">
          <template #default="{ row }: { row: AssetLibraryItemResponse }">
            <span class="tabular-nums">{{ row.id }}</span>
          </template>
        </el-table-column>

        <el-table-column label="文件" min-width="280">
          <template #default="{ row }: { row: AssetLibraryItemResponse }">
            <div class="min-w-0">
              <a class="asset-url" :href="row.url" target="_blank" rel="noreferrer">{{ row.url }}</a>
              <p class="mt-1 text-[11px] text-[var(--fsusblog-text-muted)]">
                {{ row.sha256 || '无 SHA256' }}
              </p>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="引用" width="120" align="center" sortable prop="referenceCount">
          <template #default="{ row }: { row: AssetLibraryItemResponse }">
            <el-tag :type="row.referenceCount > 0 ? 'success' : 'warning'">
              {{ row.referenceCount }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="来源文章" width="130" align="center">
          <template #default="{ row }: { row: AssetLibraryItemResponse }">
            <span class="tabular-nums">{{ row.sourceArticleId ?? '-' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="更新时间" width="190">
          <template #default="{ row }: { row: AssetLibraryItemResponse }">
            <time :datetime="row.updatedAt">{{ formatTime(row.updatedAt) }}</time>
          </template>
        </el-table-column>

        <el-table-column label="管理" width="150" align="right" fixed="right">
          <template #default="{ row }: { row: AssetLibraryItemResponse }">
            <el-button link type="danger" :disabled="processing" @click="confirmDeleteAsset(row)">
              删除文件
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue'
import {
  cleanupOrphanAssets,
  listAssetLibrary,
  reindexArticleAssets,
  type AssetLibraryItemResponse
} from '@/api/authoring'
import { deleteImage } from '@/api/system'
import AccountPageHeader from '@/components/account/AccountPageHeader.vue'
import WorkbenchPanel from '@/components/account/WorkbenchPanel.vue'
import { Delete, Refresh, Search } from '@/fsusui/icons'
import { showErrorToast, showWarningToast } from '@/utils/errorPresentation'
import { confirmDanger, toast } from '@/fsusui/feedback'

const assets = shallowRef<AssetLibraryItemResponse[]>([])
const loading = ref(false)
const processing = ref(false)
const keyword = ref('')
const orphanOnly = ref(false)
const reindexArticleId = ref('')

const filteredAssets = computed(() => {
  const text = keyword.value.trim().toLowerCase()
  return assets.value.filter((asset) => {
    if (orphanOnly.value && asset.referenceCount > 0) {
      return false
    }

    return !text || asset.url.toLowerCase().includes(text) || (asset.sha256 ?? '').toLowerCase().includes(text)
  })
})

const loadAssets = async (): Promise<void> => {
  loading.value = true
  try {
    assets.value = await listAssetLibrary()
  } catch (error) {
    showErrorToast(error, '资产库同步失败')
  } finally {
    loading.value = false
  }
}

const parseArticleId = (): number | null => {
  const parsed = Number.parseInt(reindexArticleId.value.trim(), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

const reindexCurrentArticle = async (): Promise<void> => {
  const articleId = parseArticleId()
  if (!articleId) {
    showWarningToast('请输入有效文章 ID', '请输入有效文章 ID')
    return
  }

  processing.value = true
  try {
    await reindexArticleAssets(articleId)
    toast.success('文章资产引用已重建')
    await loadAssets()
  } catch (error) {
    showErrorToast(error, '资产引用重建失败')
  } finally {
    processing.value = false
  }
}

const confirmCleanupOrphans = async (): Promise<void> => {
  const confirmed = await confirmDanger('确认清理所有引用计数为 0 的孤儿资产？该操作会删除服务器文件。', '清理孤儿资产', {
    confirmButtonText: '确认清理',
    cancelButtonText: '取消'
  })
  if (!confirmed) {
    return
  }

  processing.value = true
  try {
    const deleted = await cleanupOrphanAssets()
    toast.success(`已清理 ${deleted} 个孤儿资产`)
    await loadAssets()
  } catch (error) {
    showErrorToast(error, '孤儿资产清理失败')
  } finally {
    processing.value = false
  }
}

const confirmDeleteAsset = async (asset: AssetLibraryItemResponse): Promise<void> => {
  const warning = asset.referenceCount > 0
    ? `该文件仍有 ${asset.referenceCount} 个引用。确认删除服务器文件？`
    : '确认删除该孤儿文件？'
  const confirmed = await confirmDanger(warning, '删除服务器文件', {
    confirmButtonText: '确认删除',
    cancelButtonText: '取消'
  })
  if (!confirmed) {
    return
  }

  processing.value = true
  try {
    await deleteImage(asset.url)
    toast.success('服务器文件已删除')
    await loadAssets()
  } catch (error) {
    showErrorToast(error, '服务器文件删除失败')
  } finally {
    processing.value = false
  }
}

const formatTime = (input: string): string => {
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) return input
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

onMounted(() => {
  void loadAssets()
})
</script>

<style scoped>
.asset-filter-input {
  width: min(18rem, 100%);
}

.article-id-input {
  width: 12rem;
}

.asset-url {
  display: inline-block;
  max-width: 100%;
  overflow-wrap: anywhere;
  color: var(--fsusblog-color-primary);
  font-size: 0.8125rem;
  font-weight: 700;
}

.tabular-nums {
  font-variant-numeric: tabular-nums;
}

.asset-reindex-form :deep(.el-form-item) {
  margin-bottom: 0;
}
</style>
