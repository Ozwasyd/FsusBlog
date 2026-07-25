<template>
  <div class="account-page cache-diagnostics-page account-motion-enter w-full">
    <FsusUiTaskPageHeader
      title="缓存与索引"
      description="查看 AOT、PublicHotRead、search、sitemap/feed 与评论缓存状态。"
      class="account-task-page-header"
      density="compact"
    />

    <FsusUiSettingsSection class="mb-8" title="公开读链路" id="cache-status-title">
      <template #actions>
        <div class="cache-public-read-actions">
          <el-input
            v-model="articleId"
            class="cache-public-read-actions__input"
            placeholder="文章 ID"
            aria-label="文章 ID"
          />
          <el-button :icon="Search" :loading="loading" @click="loadDiagnostics">检查</el-button>
          <el-button :icon="Refresh" :loading="loading" @click="loadDiagnostics">刷新</el-button>
        </div>
      </template>

      <FsusUiKeyValueGrid v-if="diagnostics" class="grid gap-4 md:grid-cols-4">
        <FsusUiKeyValueItem label="AOT" :tone="kvTone(diagnostics.aot.status)">
          <el-tag :type="toFsusUiTagType(adminStatusTone[toAdminSystemStatus(diagnostics.aot.status)])">
            {{ adminStatusLabel[toAdminSystemStatus(diagnostics.aot.status)] }}
          </el-tag>
        </FsusUiKeyValueItem>
        <FsusUiKeyValueItem label="搜索" :tone="kvTone(diagnostics.search.status)">
          <el-tag :type="toFsusUiTagType(adminStatusTone[toAdminSystemStatus(diagnostics.search.status)])">
            {{ adminStatusLabel[toAdminSystemStatus(diagnostics.search.status)] }}
          </el-tag>
        </FsusUiKeyValueItem>
        <FsusUiKeyValueItem label="站点地图">
          {{ diagnostics.distribution.sitemapUrlCount }}
        </FsusUiKeyValueItem>
        <FsusUiKeyValueItem label="订阅条目">
          {{ diagnostics.distribution.feedItemCount }}
        </FsusUiKeyValueItem>
      </FsusUiKeyValueGrid>
    </FsusUiSettingsSection>

    <section class="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
      <div class="space-y-8">
        <FsusUiSettingsSection title="AOT / PublicHotRead" id="cache-aot-title">
          <el-descriptions v-if="diagnostics" :column="1" border>
            <el-descriptions-item label="版本">{{ diagnostics.aot.version }}</el-descriptions-item>
            <el-descriptions-item label="最近构建">{{ formatTime(diagnostics.aot.lastBuildAt) }}</el-descriptions-item>
            <el-descriptions-item label="构建状态">
              {{ diagnostics.aot.lastBuildStatus ? adminStatusLabel[toAdminSystemStatus(diagnostics.aot.lastBuildStatus)] : '-' }}
            </el-descriptions-item>
            <el-descriptions-item label="过期页面">{{ diagnostics.aot.stalePageCount }}</el-descriptions-item>
            <el-descriptions-item label="最近错误">{{ diagnostics.aot.lastError ?? '-' }}</el-descriptions-item>
          </el-descriptions>
        </FsusUiSettingsSection>

        <FsusUiSettingsSection title="首页焦点" id="cache-home-spotlight-title">
          <el-descriptions :column="1" border>
            <el-descriptions-item label="状态">
              <el-tag :type="toFsusUiTagType(adminStatusTone[toAdminSystemStatus(spotlightHealthStatus)])">
                {{ adminStatusLabel[toAdminSystemStatus(spotlightHealthStatus)] }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="候选数">{{ spotlightCandidateCountText }}</el-descriptions-item>
            <el-descriptions-item label="说明">{{ spotlightHealthDetail }}</el-descriptions-item>
          </el-descriptions>
        </FsusUiSettingsSection>

        <FsusUiSettingsSection title="搜索索引" id="cache-search-title">
          <el-descriptions v-if="diagnostics" :column="1" border>
            <el-descriptions-item label="版本">{{ diagnostics.search.version ?? '-' }}</el-descriptions-item>
            <el-descriptions-item label="Schema">{{ diagnostics.search.schemaVersion }}</el-descriptions-item>
            <el-descriptions-item label="分片">{{ diagnostics.search.shardCount }}</el-descriptions-item>
            <el-descriptions-item label="更新时间">{{ formatTime(diagnostics.search.lastUpdatedAt) }}</el-descriptions-item>
            <el-descriptions-item label="Manifest">
              <span class="break-all">{{ diagnostics.search.manifestPath }}</span>
            </el-descriptions-item>
          </el-descriptions>
        </FsusUiSettingsSection>

        <FsusUiSettingsSection v-if="diagnostics?.article" title="单文章状态" id="cache-article-title">
          <el-descriptions :column="1" border>
            <el-descriptions-item label="文章 ID">{{ diagnostics.article.articleId }}</el-descriptions-item>
            <el-descriptions-item label="公开可见">{{ boolText(diagnostics.article.publiclyVisible) }}</el-descriptions-item>
            <el-descriptions-item label="文章帧">{{ boolText(diagnostics.article.articleFrameReady) }}</el-descriptions-item>
            <el-descriptions-item label="HTML 帧">{{ boolText(diagnostics.article.htmlFrameReady) }}</el-descriptions-item>
            <el-descriptions-item label="搜索收录">{{ boolText(diagnostics.article.searchEligible) }}</el-descriptions-item>
            <el-descriptions-item label="Sitemap 收录">{{ boolText(diagnostics.article.sitemapEligible) }}</el-descriptions-item>
          </el-descriptions>
        </FsusUiSettingsSection>
      </div>

      <div class="space-y-8">
        <FsusUiSettingsSection title="维护动作" id="cache-actions-title">
          <div class="grid gap-3">
            <el-button :icon="Refresh" :loading="actionLoading === 'aot-rebuild'" @click="runAction('aot-rebuild')">重建 AOT/PublicHotRead</el-button>
            <el-button :icon="Refresh" :loading="actionLoading === 'search-rebuild'" @click="runAction('search-rebuild')">重建搜索索引</el-button>
            <el-button :icon="Delete" :loading="actionLoading === 'output-cache-clear'" @click="runAction('output-cache-clear')">清理 output cache</el-button>
            <el-button :icon="Refresh" :loading="actionLoading === 'sitemap-feed-refresh'" @click="runAction('sitemap-feed-refresh')">刷新 sitemap/feed</el-button>
          </div>
          <div v-if="lastAction" class="mt-5 border-t border-[var(--fsusblog-panel-border)] pt-4 text-xs leading-6">
            <el-tag :type="toFsusUiTagType(adminStatusTone[toAdminSystemStatus(lastAction.status)])">
              {{ adminStatusLabel[toAdminSystemStatus(lastAction.status)] }}
            </el-tag>
            <span class="ml-2">{{ lastAction.detail }}</span>
          </div>
        </FsusUiSettingsSection>

        <FsusUiSettingsSection title="评论缓存失效" id="cache-comments-title">
          <el-descriptions v-if="diagnostics" :column="1" border>
            <el-descriptions-item label="评论变更">{{ diagnostics.commentCache.commentMutationCount }}</el-descriptions-item>
            <el-descriptions-item label="统计记录">{{ diagnostics.commentCache.statsCount }}</el-descriptions-item>
            <el-descriptions-item label="最近事件">{{ diagnostics.commentCache.lastKind ?? '-' }} / {{ diagnostics.commentCache.lastDetail ?? '-' }}</el-descriptions-item>
          </el-descriptions>
        </FsusUiSettingsSection>

        <FsusUiSettingsSection title="热榜 / 统计合并" id="cache-hot-stats-title">
          <el-descriptions v-if="diagnostics" :column="1" border>
            <el-descriptions-item label="热榜版本">{{ diagnostics.hotStatsInvalidation.hotArticlesVersion }}</el-descriptions-item>
            <el-descriptions-item label="热榜待刷写/已刷写">{{ diagnostics.hotStatsInvalidation.hotArticlesDirtyCount }} / {{ diagnostics.hotStatsInvalidation.hotArticlesFlushCount }}</el-descriptions-item>
            <el-descriptions-item label="热榜已合并">{{ diagnostics.hotStatsInvalidation.hotArticlesCoalescedDirtyCount }}</el-descriptions-item>
            <el-descriptions-item label="统计待刷写/已刷写">{{ diagnostics.hotStatsInvalidation.statsDirtyCount }} / {{ diagnostics.hotStatsInvalidation.statsFlushCount }}</el-descriptions-item>
            <el-descriptions-item label="统计已合并">{{ diagnostics.hotStatsInvalidation.statsCoalescedDirtyCount }}</el-descriptions-item>
            <el-descriptions-item label="待处理">{{ boolText(diagnostics.hotStatsInvalidation.hotArticlesDirty || diagnostics.hotStatsInvalidation.statsDirty) }}</el-descriptions-item>
            <el-descriptions-item label="最近原因">{{ diagnostics.hotStatsInvalidation.lastFlushReason ?? diagnostics.hotStatsInvalidation.lastDirtyReason ?? '-' }}</el-descriptions-item>
          </el-descriptions>
        </FsusUiSettingsSection>

        <FsusUiSettingsSection title="PublicHotRead 计数" id="cache-counters-title">
          <el-descriptions v-if="diagnostics" :column="1" border>
            <el-descriptions-item label="文章命中/未命中">{{ diagnostics.publicHotReadCounters.articleHit }} / {{ diagnostics.publicHotReadCounters.articleMiss }}</el-descriptions-item>
            <el-descriptions-item label="列表命中/未命中">{{ diagnostics.publicHotReadCounters.listHit }} / {{ diagnostics.publicHotReadCounters.listMiss }}</el-descriptions-item>
            <el-descriptions-item label="HTML 命中/未命中">{{ diagnostics.publicHotReadCounters.htmlHit }} / {{ diagnostics.publicHotReadCounters.htmlMiss }}</el-descriptions-item>
            <el-descriptions-item label="字节数">{{ diagnostics.publicHotReadCounters.bytes }}</el-descriptions-item>
          </el-descriptions>
        </FsusUiSettingsSection>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue'
import { getFeaturedArticles } from '@/api/article'
import {
  getCacheDiagnostics,
  runCacheAction,
  type AdminCacheActionResponse,
  type CacheDiagnosticsResponse
} from '@/api/authoring'
import {
  FsusUiKeyValueGrid,
  FsusUiKeyValueItem,
  FsusUiTaskPageHeader,
  FsusUiSettingsSection
} from '@/fsusui'
import { Delete, Refresh, Search } from '@/fsusui/icons'
import { toFsusUiTagType } from '@/fsusui/primitiveAdapters'
import { showErrorToast } from '@/utils/errorPresentation'
import { toast } from '@/fsusui/feedback'
import {
  adminStatusLabel,
  adminStatusTone,
  type AdminStatusTone,
  type AdminSystemStatus
} from '@/view-contracts/adminStatus'

const loading = ref(false)
const actionLoading = ref('')
const articleId = ref('')
const diagnostics = shallowRef<CacheDiagnosticsResponse | null>(null)
const lastAction = shallowRef<AdminCacheActionResponse | null>(null)
const spotlightCandidateCount = ref<number | null>(null)
const spotlightDiagnosticsError = ref('')

const spotlightHealthStatus = computed<AdminSystemStatus>(() => {
  if (spotlightDiagnosticsError.value) return 'degraded'
  if (spotlightCandidateCount.value === null) return 'unknown'
  return spotlightCandidateCount.value > 0 ? 'ok' : 'missing'
})
const spotlightCandidateCountText = computed(() =>
  spotlightCandidateCount.value === null ? '-' : String(spotlightCandidateCount.value))
const spotlightHealthDetail = computed(() => {
  if (spotlightDiagnosticsError.value) {
    return spotlightDiagnosticsError.value
  }

  if (spotlightCandidateCount.value === null) {
    return '等待检查'
  }

  return spotlightCandidateCount.value > 0
    ? '当前存在可展示的已发布有头图文章'
    : '当前没有可展示的聚焦文章；请为热门文章设置头图、手动调整热度，或关闭首页聚焦区'
})

const parseArticleId = (): number | null => {
  const parsed = Number.parseInt(articleId.value.trim(), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

const loadDiagnostics = async (): Promise<void> => {
  loading.value = true
  try {
    const [cacheDiagnostics, spotlightCandidates] = await Promise.allSettled([
      getCacheDiagnostics(parseArticleId()),
      getFeaturedArticles(3)
    ])

    if (cacheDiagnostics.status !== 'fulfilled') {
      throw cacheDiagnostics.reason
    }

    diagnostics.value = cacheDiagnostics.value
    if (spotlightCandidates.status === 'fulfilled') {
      spotlightCandidateCount.value = spotlightCandidates.value
        .filter((article) => article.coverImageUrl.trim().length > 0)
        .length
      spotlightDiagnosticsError.value = ''
    } else {
      spotlightCandidateCount.value = null
      spotlightDiagnosticsError.value = 'Spotlight 候选状态加载失败'
    }
  } catch (error) {
    showErrorToast(error, '缓存与索引加载失败')
  } finally {
    loading.value = false
  }
}

const runAction = async (action: string): Promise<void> => {
  actionLoading.value = action
  try {
    lastAction.value = await runCacheAction({ action, articleId: parseArticleId() })
    toast.success('维护动作已提交')
    await loadDiagnostics()
  } catch (error) {
    showErrorToast(error, '维护动作失败')
  } finally {
    actionLoading.value = ''
  }
}

const toAdminSystemStatus = (status: string | null | undefined): AdminSystemStatus =>
  status && status in adminStatusTone ? status as AdminSystemStatus : 'unknown'

const kvTone = (status: string | null | undefined): AdminStatusTone =>
  adminStatusTone[toAdminSystemStatus(status)]

const formatTime = (value: string | null | undefined): string => value ? new Date(value).toLocaleString() : '-'
const boolText = (value: boolean): string => value ? '是' : '否'

onMounted(loadDiagnostics)
</script>

<style scoped>
.cache-public-read-actions {
  display: flex;
  width: clamp(24rem, 38vw, 31rem);
  max-width: 100%;
  align-items: center;
  justify-content: flex-end;
  gap: var(--fsus-space-3);
  white-space: nowrap;
}

.cache-public-read-actions__input {
  flex: 1 1 12rem;
  min-width: 12rem;
}

.cache-public-read-actions > * + * {
  margin-left: 0;
}

@media (max-width: 639px) {
  .cache-public-read-actions {
    width: 100%;
    flex-wrap: wrap;
    justify-content: stretch;
    white-space: normal;
  }

  .cache-public-read-actions__input {
    flex-basis: 100%;
    min-width: 0;
  }

  .cache-public-read-actions > * {
    flex: 1 1 0;
  }
}
</style>
