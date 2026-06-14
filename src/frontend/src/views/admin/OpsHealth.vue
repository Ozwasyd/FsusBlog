<template>
  <div class="account-page ops-health-page account-motion-enter w-full">
    <header class="account-page-header account-page-header--compact">
      <h1 class="account-page-title">运维健康</h1>
      <p class="account-page-description">核心依赖、后台任务、备份与队列状态。</p>
    </header>

    <WorkbenchPanel
      class="mb-8"
      title="站点状态"
      :caption="health ? `检查时间：${formatTime(health.checkedAt)}` : ''"
      title-id="ops-runtime-title"
    >
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="loadHealth">刷新</el-button>
      </template>

      <div v-if="health" class="grid gap-4 md:grid-cols-4">
        <div class="ops-kv">
          <span>状态</span>
          <el-tag :type="statusType(health.status)">{{ statusLabel(health.status) }}</el-tag>
        </div>
        <div class="ops-kv">
          <span>环境</span>
          <strong>{{ health.environment }}</strong>
        </div>
        <div class="ops-kv">
          <span>提交</span>
          <strong class="truncate">{{ health.commit }}</strong>
        </div>
        <div class="ops-kv">
          <span>队列</span>
          <strong>{{ health.queueBacklog.articleMutationPending }} / {{ health.queueBacklog.auditQueued }}</strong>
        </div>
      </div>
    </WorkbenchPanel>

    <section class="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
      <div class="space-y-8">
        <WorkbenchPanel title="核心服务" title-id="ops-services-title">
          <el-table v-loading="loading" :data="health?.services ?? []" row-key="key">
            <el-table-column label="服务" min-width="160">
              <template #default="{ row }: { row: AdminServiceStatusResponse }">
                <div class="font-semibold text-[var(--fsusblog-text-primary)]">{{ row.label }}</div>
                <div class="text-[11px] text-[var(--fsusblog-text-muted)]">{{ row.key }}</div>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="130">
              <template #default="{ row }: { row: AdminServiceStatusResponse }">
                <el-tag :type="statusType(row.status)">{{ statusLabel(row.status) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="更新时间" width="190">
              <template #default="{ row }: { row: AdminServiceStatusResponse }">
                {{ formatTime(row.updatedAt) }}
              </template>
            </el-table-column>
            <el-table-column label="详情" min-width="240">
              <template #default="{ row }: { row: AdminServiceStatusResponse }">
                <div class="break-words text-xs text-[var(--fsusblog-text-secondary)]">
                  {{ row.detail ?? '-' }}
                </div>
              </template>
            </el-table-column>
            <template #empty>
              <AdminInlineEmptyState
                :title="health ? '核心服务状态未返回' : '尚未加载服务状态'"
                :description="health ? '服务端未返回核心依赖状态，请刷新运维健康。' : '刷新后显示数据库、缓存与对象存储等核心依赖状态。'"
              />
            </template>
          </el-table>
        </WorkbenchPanel>

        <WorkbenchPanel title="后台 worker" title-id="ops-workers-title">
          <el-table v-loading="loading" :data="health?.workers ?? []" row-key="key">
            <el-table-column label="任务" min-width="200" prop="label" />
            <el-table-column label="状态" width="130">
              <template #default="{ row }: { row: AdminServiceStatusResponse }">
                <el-tag :type="statusType(row.status)">{{ statusLabel(row.status) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="更新时间" width="190">
              <template #default="{ row }: { row: AdminServiceStatusResponse }">
                {{ formatTime(row.updatedAt) }}
              </template>
            </el-table-column>
            <el-table-column label="详情" min-width="220" prop="detail" />
            <template #empty>
              <AdminInlineEmptyState
                :title="health ? '后台 worker 状态未返回' : '尚未加载 worker 状态'"
                :description="health ? '服务端未返回后台任务状态，请刷新运维健康。' : '刷新后显示后台任务最近心跳与运行详情。'"
              />
            </template>
          </el-table>
        </WorkbenchPanel>
      </div>

      <div class="space-y-8">
        <WorkbenchPanel title="最近备份" title-id="ops-backup-title">
          <div class="space-y-4">
            <div class="ops-kv">
              <span>状态</span>
              <el-tag :type="statusType(health?.backup.status ?? 'unknown')">{{ statusLabel(health?.backup.status) }}</el-tag>
            </div>
            <div class="break-words text-xs text-[var(--fsusblog-text-muted)]">{{ health?.backup.backupRoot ?? '-' }}</div>
            <div class="space-y-3">
              <div
                v-for="artifact in health?.backup.artifacts ?? []"
                :key="artifact.kind"
                class="border-t border-[var(--fsusblog-panel-border)] pt-3"
              >
                <div class="flex items-center justify-between gap-3">
                  <span class="text-xs font-semibold">{{ backupArtifactKindLabel(artifact.kind) }}</span>
                  <el-tag :type="statusType(artifact.status)">{{ statusLabel(artifact.status) }}</el-tag>
                </div>
                <div class="mt-1 break-words text-[11px] text-[var(--fsusblog-text-muted)]">
                  {{ backupArtifactDetail(artifact) }}
                </div>
              </div>
            </div>
          </div>
        </WorkbenchPanel>

        <WorkbenchPanel title="最近错误" title-id="ops-errors-title">
          <ul v-if="opsRecentErrors.length" class="ops-error-list">
            <li
              v-for="error in opsRecentErrors"
              :key="opsErrorKey(error)"
              class="ops-error-item"
            >
              <div class="flex min-w-0 items-start justify-between gap-3">
                <div class="min-w-0">
                  <strong class="block break-words text-[13px] text-[var(--fsusblog-text-primary)]">{{ error.action }}</strong>
                  <p class="mt-1 break-words text-sm font-semibold leading-6 text-[var(--fsusblog-text-secondary)]">
                    {{ error.message }}
                  </p>
                </div>
                <el-tag class="shrink-0" :type="statusType(error.severity)">{{ statusLabel(error.severity) }}</el-tag>
              </div>

              <p class="ops-error-meta">
                {{ statusLabel(error.severity) }} · {{ formatOpsErrorTime(error.occurredAt) }} · {{ formatOpsErrorCount(error.count) }}
              </p>

              <div class="mt-3 flex flex-wrap items-start gap-3">
                <details v-if="error.detail" class="ops-error-detail">
                  <summary>详情</summary>
                  <code>{{ error.detail }}</code>
                </details>
                <el-button link size="small" :icon="CopyDocument" @click="copyOpsErrorDetail(error)">复制详情</el-button>
              </div>
            </li>
          </ul>
          <AdminInlineEmptyState v-else title="暂无错误记录" />
        </WorkbenchPanel>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, shallowRef } from 'vue'
import {
  getOpsHealth,
  type AdminServiceStatusResponse,
  type BackupArtifactResponse,
  type OpsHealthResponse,
  type RecentOpsErrorResponse
} from '@/api/authoring'
import { AdminInlineEmptyState } from '@/components/admin/AdminCollectionPrimitives'
import WorkbenchPanel from '@/components/account/WorkbenchPanel.vue'
import { CopyDocument, Refresh } from '@/fsusui/icons'
import { toast } from '@/fsusui/feedback'
import { showErrorToast, showWarningToast } from '@/utils/errorPresentation'

const loading = shallowRef(false)
const health = shallowRef<OpsHealthResponse | null>(null)
const opsRecentErrors = computed(() => health.value?.recentErrors ?? [])

const loadHealth = async (): Promise<void> => {
  loading.value = true
  try {
    health.value = await getOpsHealth()
  } catch (error) {
    showErrorToast(error, '运维健康加载失败')
  } finally {
    loading.value = false
  }
}

const statusType = (status: string): 'success' | 'warning' | 'danger' | 'info' => {
  if (status === 'ok' || status === 'ready') return 'success'
  if (status === 'failed' || status === 'missing' || status === 'not_ready' || status === 'error' || status === 'critical') return 'danger'
  if (status === 'degraded' || status === 'warning') return 'warning'
  return 'info'
}

const statusLabel = (status: string | null | undefined): string => {
  const labels: Record<string, string> = {
    ok: '正常',
    ready: '就绪',
    failed: '失败',
    missing: '缺失',
    not_ready: '未就绪',
    degraded: '降级',
    warning: '警告',
    error: '错误',
    critical: '严重',
    unknown: '未知'
  }
  return status ? labels[status] ?? status : '-'
}

const backupArtifactKindLabel = (kind: string): string => {
  const labels: Record<string, string> = {
    database: '数据库',
    uploads: '上传文件',
    'data-protection-keyring': '数据保护密钥',
    config: '配置文件',
    'site-package': '站点包',
    'restore-drill': '恢复演练'
  }
  return labels[kind] ?? kind
}

const backupArtifactDetailLabel = (detail: string): string => {
  const labels: Record<string, string> = {
    latest: '最新备份',
    'latest-report': '最新报告',
    not_found: '未找到',
    not_run: '未运行',
    'live-keyring-not-yet-packaged': '密钥环未打包'
  }
  return labels[detail] ?? detail
}

const backupArtifactDetail = (artifact: BackupArtifactResponse): string =>
  artifact.path ?? (artifact.detail ? backupArtifactDetailLabel(artifact.detail) : '-')

const formatTime = (value: string | null | undefined): string => {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString()
}

const formatOpsErrorTime = (value: string | null | undefined): string => formatTime(value)

const formatOpsErrorCount = (count: number): string => `${Math.max(1, count)} 次`

const opsErrorKey = (error: RecentOpsErrorResponse): string =>
  `${error.action}:${error.message}:${error.occurredAt}:${error.count}`

const copyOpsErrorDetail = async (error: RecentOpsErrorResponse): Promise<void> => {
  const text = [
    `动作：${error.action}`,
    `级别：${statusLabel(error.severity)}`,
    `时间：${formatOpsErrorTime(error.occurredAt)}`,
    `次数：${formatOpsErrorCount(error.count)}`,
    `摘要：${error.message}`,
    error.detail ? `详情：${error.detail}` : ''
  ].filter(Boolean).join('\n')

  if (!navigator.clipboard?.writeText) {
    showWarningToast('当前浏览器不允许复制，请展开详情手动复制', '当前浏览器不允许复制，请展开详情手动复制')
    return
  }

  try {
    await navigator.clipboard.writeText(text)
    toast.success('错误详情已复制')
  } catch (error) {
    showWarningToast(error, '复制失败，请展开详情手动复制')
  }
}

onMounted(loadHealth)
</script>

<style scoped>
.ops-kv {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  border-top: 1px solid var(--fsusblog-panel-border);
  padding: 0.875rem 0;
  font-size: 0.75rem;
}

.ops-kv span {
  color: var(--fsusblog-text-muted);
}

.ops-kv strong {
  min-width: 0;
  font-weight: 700;
}

.ops-error-list {
  display: grid;
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

.ops-error-item {
  min-width: 0;
  border-top: 1px solid var(--fsusblog-panel-border);
  padding: 1rem 0;
}

.ops-error-item:first-child {
  border-top: 0;
  padding-top: 0;
}

.ops-error-meta {
  margin: 0.5rem 0 0;
  color: var(--fsusblog-text-muted);
  font-size: 0.75rem;
  line-height: 1.5;
}

.ops-error-detail {
  min-width: min(100%, 16rem);
  max-width: 100%;
  color: var(--fsusblog-text-muted);
  font-size: 0.75rem;
}

.ops-error-detail summary {
  cursor: pointer;
  color: var(--fsusblog-text-secondary);
  font-weight: 700;
}

.ops-error-detail code {
  display: block;
  max-height: 12rem;
  overflow: auto;
  margin-top: 0.5rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  border-radius: 6px;
  background: var(--fsusblog-panel-bg-soft);
  padding: 0.75rem;
  color: var(--fsusblog-text-secondary);
}
</style>
