<template>
  <div class="account-page audit-log-page account-motion-enter w-full">
    <FsusUiPageHeader
      title="审计日志"
      content="查询结构化安全事件、后台操作和防篡改证据。"
      class="account-page-header--compact"
    />

    <FsusUiSettingsSection
      class="mb-8"
      title="写入状态"
      description="队列、失败与降级写入指标来自服务端审计状态快照。"
      id="audit-runtime-title"
    >
      <template #title>
        写入状态
        <span class="text-[var(--fsusblog-text-primary)] tabular-nums">{{ summary?.total ?? total }}</span>
      </template>
      <template #actions>
        <div class="flex flex-wrap items-center justify-end gap-2">
          <el-tag type="info">队列 {{ runtime.queuedCount }}</el-tag>
          <el-tag :type="runtime.droppedCount > 0 ? 'danger' : 'success'">丢弃 {{ runtime.droppedCount }}</el-tag>
          <el-tag :type="runtime.writeFailureCount > 0 ? 'warning' : 'success'">失败 {{ runtime.writeFailureCount }}</el-tag>
          <el-tag :type="runtime.fallbackWriteCount > 0 ? 'warning' : 'info'">降级写入 {{ runtime.fallbackWriteCount }}</el-tag>
          <el-button :icon="Refresh" :loading="loading" @click="loadAudit">刷新</el-button>
        </div>
      </template>
    </FsusUiSettingsSection>

    <section class="border-t border-[var(--fsusblog-panel-border)]">
      <div class="audit-filter-grid grid gap-3 border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] px-4 py-4 lg:grid-cols-6">
        <el-input v-model="filters.actor" clearable placeholder="操作者" aria-label="操作者" :prefix-icon="User" />
        <el-input v-model="filters.action" clearable placeholder="动作代码" aria-label="动作代码" :prefix-icon="Operation" />
        <el-input v-model="filters.targetType" clearable placeholder="目标类型" aria-label="目标类型" :prefix-icon="Aim" />
        <el-input v-model="filters.targetId" clearable placeholder="目标 ID" aria-label="目标 ID" />
        <el-select v-model="filters.outcome" clearable placeholder="结果" aria-label="结果">
          <el-option label="成功" value="success" />
          <el-option label="失败" value="failure" />
          <el-option label="已拒绝" value="denied" />
          <el-option label="未知" value="unknown" />
        </el-select>
        <el-select v-model="filters.severity" clearable placeholder="严重度" aria-label="严重度">
          <el-option label="信息" value="info" />
          <el-option label="警告" value="warning" />
          <el-option label="错误" value="error" />
          <el-option label="严重" value="critical" />
        </el-select>
        <el-input v-model="filters.source" clearable placeholder="来源" aria-label="来源" />
        <el-input v-model="filters.type" clearable placeholder="类型" aria-label="类型" />
        <el-date-picker
          v-model="dateRange"
          class="lg:col-span-2"
          type="datetimerange"
          start-placeholder="起始时间"
          end-placeholder="结束时间"
          aria-label="时间范围"
        />
        <div class="flex items-center gap-2 lg:col-span-2">
          <el-button type="primary" :icon="Search" :loading="loading" @click="applyFilters">查询</el-button>
          <el-button :icon="RefreshLeft" @click="resetFilters">重置</el-button>
        </div>
      </div>

      <div class="flex flex-wrap gap-2 border-b border-[var(--fsusblog-panel-border)] px-4 py-3">
        <el-tag v-for="facet in summary?.actions ?? []" :key="`action-${facet.value}`" type="info">
          {{ formatAuditAction(facet.value) }} {{ facet.count }}
        </el-tag>
        <el-tag v-for="facet in summary?.outcomes ?? []" :key="`outcome-${facet.value}`" :type="outcomeTagType(facet.value)">
          {{ formatOutcome(facet.value) }} {{ facet.count }}
        </el-tag>
        <el-tag v-for="facet in summary?.severities ?? []" :key="`severity-${facet.value}`" :type="severityTagType(facet.value)">
          {{ formatSeverity(facet.value) }} {{ facet.count }}
        </el-tag>
      </div>

      <p
        v-if="auditRowMotion.summary.value"
        class="blog-motion-summary-enter border-b border-[var(--fsusblog-panel-border)] px-4 py-2 text-[11px] font-bold text-[var(--fsusblog-text-muted)]"
        role="status"
        aria-live="polite"
      >
        {{ auditRowMotion.summary.value }}
      </p>

      <el-table v-loading="loading" :data="items" row-key="id" :row-class-name="auditRowClassName">
        <el-table-column label="时间" width="190">
          <template #default="{ row }: { row: AuditLogItemResponse }">
            <time :datetime="row.occurredAtUtc">{{ formatTime(row.occurredAtUtc) }}</time>
          </template>
        </el-table-column>

        <el-table-column label="动作" min-width="250">
          <template #default="{ row }: { row: AuditLogItemResponse }">
            <div class="min-w-0">
              <div class="font-semibold text-[var(--fsusblog-text-primary)]">{{ formatAuditAction(row.action) }}</div>
              <p class="mt-1 truncate text-[11px] text-[var(--fsusblog-text-muted)]">{{ row.eventInfo }}</p>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="操作者" width="160">
          <template #default="{ row }: { row: AuditLogItemResponse }">
            <div class="text-xs">
              <div>{{ row.actorType ?? '-' }}</div>
              <div class="text-[var(--fsusblog-text-muted)]">{{ row.actorId ?? row.actorRole ?? '-' }}</div>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="目标" width="190">
          <template #default="{ row }: { row: AuditLogItemResponse }">
            <div class="text-xs">
              <div>{{ row.targetType ?? '-' }}</div>
              <div class="text-[var(--fsusblog-text-muted)]">{{ row.targetId ?? '-' }}</div>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="结果" width="150" align="center">
          <template #default="{ row }: { row: AuditLogItemResponse }">
            <div class="flex flex-col items-center gap-1">
              <el-tag :type="outcomeTagType(row.outcome)">{{ formatOutcome(row.outcome) }}</el-tag>
              <el-tag :type="severityTagType(row.severity)">{{ formatSeverity(row.severity) }}</el-tag>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="证据" width="110" align="center">
          <template #default="{ row }: { row: AuditLogItemResponse }">
            <el-tooltip content="校验防篡改证据">
              <el-button :icon="Lock" circle :loading="verifyingId === row.id" @click="verifyRow(row)" />
            </el-tooltip>
          </template>
        </el-table-column>

        <el-table-column label="详情" width="110" align="right" fixed="right">
          <template #default="{ row }: { row: AuditLogItemResponse }">
            <el-button link type="primary" :icon="View" @click="openDetail(row)">查看</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <AdminInlineEmptyState :title="auditEmptyTitle" :content="auditEmptyDescription">
            <template #actions>
              <el-button v-if="hasAuditFilters" link type="primary" @click="resetFilters">清除筛选</el-button>
              <el-button v-else link type="primary" :loading="loading" @click="loadAudit">刷新审计日志</el-button>
            </template>
          </AdminInlineEmptyState>
        </template>
      </el-table>

      <div class="flex justify-end border-t border-[var(--fsusblog-panel-border)] px-4 py-4">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :total="total"
          :page-sizes="[25, 50, 100, 200]"
          layout="total, sizes, prev, pager, next"
          @current-change="loadAudit"
          @size-change="handleSizeChange"
        />
      </div>
    </section>

    <el-drawer v-model="detailVisible" size="min(720px, 100vw)" title="审计详情">
      <div v-if="detail" class="space-y-5">
        <el-descriptions :column="1" border>
          <el-descriptions-item label="ID">{{ detail.item.id }}</el-descriptions-item>
          <el-descriptions-item label="动作代码">{{ detail.item.action }}</el-descriptions-item>
          <el-descriptions-item label="操作者">{{ detail.item.actorType ?? '-' }} / {{ detail.item.actorId ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="目标">{{ detail.item.targetType ?? '-' }} / {{ detail.item.targetId ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="Trace ID">{{ detail.item.traceId ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="隐私哈希">
            <div class="break-all text-xs leading-6">
              ip={{ detail.item.ipHash ?? '-' }}<br>
              ua={{ detail.item.userAgentHash ?? '-' }}<br>
              session={{ detail.item.sessionIdHash ?? '-' }}<br>
              fp={{ detail.item.deviceFingerprintHash ?? '-' }}
            </div>
          </el-descriptions-item>
          <el-descriptions-item label="防篡改">
            <el-tag :type="detail.tamperEvidenceValid ? 'success' : 'danger'">
              {{ detail.tamperEvidenceValid ? '有效' : '无效' }}
            </el-tag>
            <div class="mt-2 break-all text-xs text-[var(--fsusblog-text-muted)]">
              hash={{ detail.item.recordHash ?? '-' }}<br>
              mac={{ detail.item.recordMac ?? '-' }}
            </div>
          </el-descriptions-item>
        </el-descriptions>
        <pre class="max-h-[360px] overflow-auto border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] p-3 text-xs leading-6">{{ formattedContext }}</pre>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, shallowRef } from 'vue'
import { useRoute } from 'vue-router'
import {
  getAuditLogDetail,
  getAuditLogSummary,
  listAuditLogs,
  verifyAuditLog,
  type AuditLogDetailResponse,
  type AuditLogItemResponse,
  type AuditLogQueryParams,
  type AuditLogRuntimeResponse,
  type AuditLogSummaryResponse
} from '@/api/authoring'
import { FsusUiPageHeader } from "@/fsusui"
import { FsusUiSettingsSection } from '@/fsusui'
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue'
import { useRowStateMotion } from '@/composables/useRowStateMotion'
import { Aim, Lock, Operation, Refresh, RefreshLeft, Search, User, View } from '@/fsusui/icons'
import { showErrorToast, showWarningToast } from '@/utils/errorPresentation'
import { toast } from '@/fsusui/feedback'

type AuditDateRange = [Date, Date] | null

const route = useRoute()

const emptyRuntime: AuditLogRuntimeResponse = {
  queuedCount: 0,
  droppedCount: 0,
  writeSuccessCount: 0,
  writeFailureCount: 0,
  fallbackWriteCount: 0,
  lastWriteSuccessUtc: null,
  lastWriteFailureUtc: null,
  lastFallbackWriteUtc: null
}

const filters = reactive({
  source: '',
  type: '',
  actor: '',
  action: '',
  targetType: '',
  targetId: '',
  outcome: '',
  severity: ''
})
const dateRange = ref<AuditDateRange>(null)
const items = shallowRef<AuditLogItemResponse[]>([])
const summary = shallowRef<AuditLogSummaryResponse | null>(null)
const detail = shallowRef<AuditLogDetailResponse | null>(null)
const page = ref(1)
const pageSize = ref(50)
const total = ref(0)
const loading = ref(false)
const verifyingId = ref<number | null>(null)
const detailVisible = ref(false)
const auditRowMotion = useRowStateMotion({ visibleLimit: 20 })

const runtime = computed(() => summary.value?.runtime ?? emptyRuntime)
const hasAuditFilters = computed(() =>
  filters.source.trim() !== ''
  || filters.type.trim() !== ''
  || filters.actor.trim() !== ''
  || filters.action.trim() !== ''
  || filters.targetType.trim() !== ''
  || filters.targetId.trim() !== ''
  || Boolean(filters.outcome)
  || Boolean(filters.severity)
  || Boolean(dateRange.value)
)
const auditEmptyTitle = computed(() => hasAuditFilters.value ? '没有匹配的审计事件' : '暂无审计日志')
const auditEmptyDescription = computed(() =>
  hasAuditFilters.value
    ? '调整操作者、动作、目标、结果或时间范围后再查询。'
    : '后台操作、安全事件和防篡改证据写入后会显示在这里。'
)
const formattedContext = computed(() => {
  if (!detail.value?.contextJson) {
    return '{}'
  }

  try {
    return JSON.stringify(JSON.parse(detail.value.contextJson), null, 2)
  } catch {
    return detail.value.contextJson
  }
})

const buildQuery = (): AuditLogQueryParams => ({
  page: page.value,
  pageSize: pageSize.value,
  source: filters.source.trim() || null,
  type: filters.type.trim() || null,
  actor: filters.actor.trim() || null,
  action: filters.action.trim() || null,
  targetType: filters.targetType.trim() || null,
  targetId: filters.targetId.trim() || null,
  outcome: filters.outcome || null,
  severity: filters.severity || null,
  fromUtc: dateRange.value?.[0]?.toISOString() ?? null,
  toUtc: dateRange.value?.[1]?.toISOString() ?? null
})

const loadAudit = async (): Promise<void> => {
  loading.value = true
  try {
    const query = buildQuery()
    const [list, facets] = await Promise.all([
      listAuditLogs(query),
      getAuditLogSummary(query)
    ])
    items.value = list.items
    total.value = list.total
    summary.value = facets
    auditRowMotion.markUpdated(list.items.slice(0, 20).map((item) => item.id), `审计日志已刷新：${list.items.length} 条可见记录`)
  } catch (error) {
    showErrorToast(error, '审计日志加载失败')
  } finally {
    loading.value = false
  }
}

const applyFilters = async (): Promise<void> => {
  page.value = 1
  await loadAudit()
}

const resetFilters = async (): Promise<void> => {
  filters.source = ''
  filters.type = ''
  filters.actor = ''
  filters.action = ''
  filters.targetType = ''
  filters.targetId = ''
  filters.outcome = ''
  filters.severity = ''
  dateRange.value = null
  await applyFilters()
}

const handleSizeChange = async (): Promise<void> => {
  page.value = 1
  await loadAudit()
}

const openDetail = async (row: AuditLogItemResponse): Promise<void> => {
  try {
    detail.value = await getAuditLogDetail(row.id)
    detailVisible.value = true
  } catch (error) {
    showErrorToast(error, '审计详情加载失败')
  }
}

const verifyRow = async (row: AuditLogItemResponse): Promise<void> => {
  verifyingId.value = row.id
  auditRowMotion.markPending(row.id, '正在校验证据')
  try {
    const result = await verifyAuditLog(row.id)
    if (result.valid) {
      auditRowMotion.markUpdated(row.id, '防篡改证据有效')
      toast.success('防篡改证据有效')
    } else {
      auditRowMotion.markError(row.id, '防篡改证据无效')
      showWarningToast('防篡改证据无效', '防篡改证据无效')
    }
  } catch (error) {
    auditRowMotion.markError(row.id, '防篡改校验失败')
    showErrorToast(error, '防篡改校验失败')
  } finally {
    verifyingId.value = null
  }
}

const formatTime = (value: string): string => new Date(value).toLocaleString()
const auditRowClassName = ({ row }: { row: AuditLogItemResponse }): string => auditRowMotion.classFor(row.id)

const formatOutcome = (value: string | null | undefined): string => {
  const labels: Record<string, string> = {
    success: '成功',
    failure: '失败',
    denied: '已拒绝',
    unknown: '未知'
  }
  return value ? labels[value] ?? `结果：${value}` : '-'
}

const formatSeverity = (value: string | null | undefined): string => {
  const labels: Record<string, string> = {
    info: '信息',
    warning: '警告',
    error: '错误',
    critical: '严重'
  }
  return value ? labels[value] ?? `严重度：${value}` : '-'
}

const formatAuditAction = (value: string | null | undefined): string => {
  if (!value) return '-'
  const labels: Record<string, string> = {
    dictionary_loaded: '词库已载入',
    dictionary_reload_failed: '词库重新载入失败',
    dictionary_checksum_changed: '词库校验值变化',
    region_policy_loaded: '地区策略已载入',
    region_policy_reload_failed: '地区策略重新载入失败',
    region_policy_replay_started: '地区策略回放开始',
    region_policy_replay_completed: '地区策略回放完成',
    model_moderation_scored: '模型风险评分完成',
    region_moderation_rejected: '地区策略拒绝发布',
    region_moderation_geo_blocked: '地区策略按地区拦截'
  }
  return labels[value] ?? `动作代码：${value}`
}

const outcomeTagType = (value: string): 'success' | 'danger' | 'warning' | 'info' => {
  if (value === 'success') return 'success'
  if (value === 'failure') return 'danger'
  if (value === 'denied') return 'warning'
  return 'info'
}

const severityTagType = (value: string): 'success' | 'danger' | 'warning' | 'info' => {
  if (value === 'critical' || value === 'error') return 'danger'
  if (value === 'warning') return 'warning'
  return 'info'
}

const applyRouteQueryFilters = (): void => {
  filters.action = typeof route.query.action === 'string' ? route.query.action : ''
  filters.source = typeof route.query.source === 'string' ? route.query.source : filters.source
  filters.type = typeof route.query.type === 'string' ? route.query.type : filters.type
  filters.targetType = typeof route.query.targetType === 'string' ? route.query.targetType : filters.targetType
}

onMounted(() => {
  applyRouteQueryFilters()
  void loadAudit()
})
</script>

<style scoped>
.audit-filter-grid {
  grid-template-columns: minmax(0, 1fr);
}

.audit-filter-grid > * {
  min-width: 0;
}

:deep(.audit-filter-grid .el-input),
:deep(.audit-filter-grid .el-select),
:deep(.audit-filter-grid .el-date-editor) {
  width: 100%;
  max-width: 100%;
}

@media (min-width: 1024px) {
  .audit-filter-grid {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }
}
</style>
