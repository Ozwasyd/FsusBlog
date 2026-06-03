<template>
  <div class="account-page cache-diagnostics-page account-motion-enter w-full">
    <AccountPageHeader
      eyebrow="管理 / CACHE"
      title="缓存诊断"
      description="查看 AOT、PublicHotRead、search、sitemap/feed 与评论缓存状态。"
      compact
    />

    <WorkbenchPanel class="mb-8" title="公开读链路" eyebrow="STATUS" title-id="cache-status-title">
      <template #actions>
        <div class="flex flex-wrap items-center justify-end gap-2">
          <el-input v-model="articleId" class="w-[10rem]" placeholder="文章 ID" aria-label="文章 ID" />
          <el-button :icon="Search" :loading="loading" @click="loadDiagnostics">诊断</el-button>
          <el-button :icon="Refresh" :loading="loading" @click="loadDiagnostics">刷新</el-button>
        </div>
      </template>

      <div v-if="diagnostics" class="grid gap-4 md:grid-cols-4">
        <div class="cache-kv">
          <span>AOT</span>
          <el-tag :type="statusType(diagnostics.aot.status)">{{ diagnostics.aot.status }}</el-tag>
        </div>
        <div class="cache-kv">
          <span>search</span>
          <el-tag :type="statusType(diagnostics.search.status)">{{ diagnostics.search.status }}</el-tag>
        </div>
        <div class="cache-kv">
          <span>sitemap</span>
          <strong>{{ diagnostics.distribution.sitemapUrlCount }}</strong>
        </div>
        <div class="cache-kv">
          <span>feed</span>
          <strong>{{ diagnostics.distribution.feedItemCount }}</strong>
        </div>
      </div>
    </WorkbenchPanel>

    <section class="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
      <div class="space-y-8">
        <WorkbenchPanel title="AOT / PublicHotRead" eyebrow="AOT" title-id="cache-aot-title">
          <el-descriptions v-if="diagnostics" :column="1" border>
            <el-descriptions-item label="version">{{ diagnostics.aot.version }}</el-descriptions-item>
            <el-descriptions-item label="lastBuildAt">{{ formatTime(diagnostics.aot.lastBuildAt) }}</el-descriptions-item>
            <el-descriptions-item label="lastBuildStatus">{{ diagnostics.aot.lastBuildStatus ?? '-' }}</el-descriptions-item>
            <el-descriptions-item label="stale">{{ diagnostics.aot.stalePageCount }}</el-descriptions-item>
            <el-descriptions-item label="lastError">{{ diagnostics.aot.lastError ?? '-' }}</el-descriptions-item>
          </el-descriptions>
        </WorkbenchPanel>

        <WorkbenchPanel title="搜索索引" eyebrow="SEARCH" title-id="cache-search-title">
          <el-descriptions v-if="diagnostics" :column="1" border>
            <el-descriptions-item label="version">{{ diagnostics.search.version ?? '-' }}</el-descriptions-item>
            <el-descriptions-item label="schema">{{ diagnostics.search.schemaVersion }}</el-descriptions-item>
            <el-descriptions-item label="shards">{{ diagnostics.search.shardCount }}</el-descriptions-item>
            <el-descriptions-item label="updated">{{ formatTime(diagnostics.search.lastUpdatedAt) }}</el-descriptions-item>
            <el-descriptions-item label="manifest">
              <span class="break-all">{{ diagnostics.search.manifestPath }}</span>
            </el-descriptions-item>
          </el-descriptions>
        </WorkbenchPanel>

        <WorkbenchPanel v-if="diagnostics?.article" title="单文章诊断" eyebrow="ARTICLE" title-id="cache-article-title">
          <el-descriptions :column="1" border>
            <el-descriptions-item label="articleId">{{ diagnostics.article.articleId }}</el-descriptions-item>
            <el-descriptions-item label="public">{{ boolText(diagnostics.article.publiclyVisible) }}</el-descriptions-item>
            <el-descriptions-item label="article frame">{{ boolText(diagnostics.article.articleFrameReady) }}</el-descriptions-item>
            <el-descriptions-item label="html frame">{{ boolText(diagnostics.article.htmlFrameReady) }}</el-descriptions-item>
            <el-descriptions-item label="search">{{ boolText(diagnostics.article.searchEligible) }}</el-descriptions-item>
            <el-descriptions-item label="sitemap">{{ boolText(diagnostics.article.sitemapEligible) }}</el-descriptions-item>
          </el-descriptions>
        </WorkbenchPanel>
      </div>

      <div class="space-y-8">
        <WorkbenchPanel title="维护动作" eyebrow="ACTIONS" title-id="cache-actions-title">
          <div class="grid gap-3">
            <el-button :icon="Refresh" :loading="actionLoading === 'aot-rebuild'" @click="runAction('aot-rebuild')">重建 AOT/PublicHotRead</el-button>
            <el-button :icon="Refresh" :loading="actionLoading === 'search-rebuild'" @click="runAction('search-rebuild')">重建搜索索引</el-button>
            <el-button :icon="Delete" :loading="actionLoading === 'output-cache-clear'" @click="runAction('output-cache-clear')">清理 output cache</el-button>
            <el-button :icon="Refresh" :loading="actionLoading === 'sitemap-feed-refresh'" @click="runAction('sitemap-feed-refresh')">刷新 sitemap/feed</el-button>
          </div>
          <div v-if="lastAction" class="mt-5 border-t border-[var(--fsusblog-panel-border)] pt-4 text-xs leading-6">
            <el-tag :type="statusType(lastAction.status)">{{ lastAction.status }}</el-tag>
            <span class="ml-2">{{ lastAction.detail }}</span>
          </div>
        </WorkbenchPanel>

        <WorkbenchPanel title="评论缓存失效" eyebrow="COMMENTS" title-id="cache-comments-title">
          <el-descriptions v-if="diagnostics" :column="1" border>
            <el-descriptions-item label="comment">{{ diagnostics.commentCache.commentMutationCount }}</el-descriptions-item>
            <el-descriptions-item label="stats">{{ diagnostics.commentCache.statsCount }}</el-descriptions-item>
            <el-descriptions-item label="last">{{ diagnostics.commentCache.lastKind ?? '-' }} / {{ diagnostics.commentCache.lastDetail ?? '-' }}</el-descriptions-item>
          </el-descriptions>
        </WorkbenchPanel>

        <WorkbenchPanel title="PublicHotRead 计数" eyebrow="COUNTERS" title-id="cache-counters-title">
          <el-descriptions v-if="diagnostics" :column="1" border>
            <el-descriptions-item label="article hit/miss">{{ diagnostics.publicHotReadCounters.articleHit }} / {{ diagnostics.publicHotReadCounters.articleMiss }}</el-descriptions-item>
            <el-descriptions-item label="list hit/miss">{{ diagnostics.publicHotReadCounters.listHit }} / {{ diagnostics.publicHotReadCounters.listMiss }}</el-descriptions-item>
            <el-descriptions-item label="html hit/miss">{{ diagnostics.publicHotReadCounters.htmlHit }} / {{ diagnostics.publicHotReadCounters.htmlMiss }}</el-descriptions-item>
            <el-descriptions-item label="bytes">{{ diagnostics.publicHotReadCounters.bytes }}</el-descriptions-item>
          </el-descriptions>
        </WorkbenchPanel>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, shallowRef } from 'vue'
import {
  getCacheDiagnostics,
  runCacheAction,
  type AdminCacheActionResponse,
  type CacheDiagnosticsResponse
} from '@/api/authoring'
import AccountPageHeader from '@/components/account/AccountPageHeader.vue'
import WorkbenchPanel from '@/components/account/WorkbenchPanel.vue'
import { Delete, Refresh, Search } from '@/fsusui/icons'
import { showErrorToast } from '@/utils/errorPresentation'
import { toast } from '@/fsusui/feedback'

const loading = ref(false)
const actionLoading = ref('')
const articleId = ref('')
const diagnostics = shallowRef<CacheDiagnosticsResponse | null>(null)
const lastAction = shallowRef<AdminCacheActionResponse | null>(null)

const parseArticleId = (): number | null => {
  const parsed = Number.parseInt(articleId.value.trim(), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

const loadDiagnostics = async (): Promise<void> => {
  loading.value = true
  try {
    diagnostics.value = await getCacheDiagnostics(parseArticleId())
  } catch (error) {
    showErrorToast(error, '缓存诊断加载失败')
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

const statusType = (status: string): 'success' | 'warning' | 'danger' | 'info' => {
  if (status === 'ok' || status === 'queued') return 'success'
  if (status === 'failed' || status === 'missing' || status === 'unsupported') return 'danger'
  if (status === 'degraded') return 'warning'
  return 'info'
}

const formatTime = (value: string | null | undefined): string => value ? new Date(value).toLocaleString() : '-'
const boolText = (value: boolean): string => value ? 'yes' : 'no'

onMounted(loadDiagnostics)
</script>

<style scoped>
.cache-kv {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  border-top: 1px solid var(--fsusblog-panel-border);
  padding: 0.875rem 0;
  font-size: 0.75rem;
}

.cache-kv span {
  color: var(--fsusblog-text-muted);
}
</style>
