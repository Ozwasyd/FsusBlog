<template>
  <div class="account-page audit-log-page account-motion-enter w-full">
    <AccountPageHeader
      eyebrow="管理 / AUDIT"
      title="审计日志"
      description="查询结构化安全事件、后台操作和防篡改证据。"
      compact
    />

    <WorkbenchPanel
      class="mb-8"
      eyebrow="审计运行时 / RUNTIME"
      title="写入状态"
      caption="队列、失败与 fallback 指标来自服务端审计 runtime snapshot。"
      title-id="audit-runtime-title"
    >
      <template #title>
        写入状态
        <span class="text-[var(--fsusblog-text-primary)] tabular-nums">{{ summary?.total ?? total }}</span>
      </template>
      <template #actions>
        <div class="flex flex-wrap items-center justify-end gap-2">
          <el-tag type="info">queued {{ runtime.queuedCount }}</el-tag>
          <el-tag :type="runtime.droppedCount > 0 ? 'danger' : 'success'">dropped {{ runtime.droppedCount }}</el-tag>
          <el-tag :type="runtime.writeFailureCount > 0 ? 'warning' : 'success'">failed {{ runtime.writeFailureCount }}</el-tag>
          <el-tag :type="runtime.fallbackWriteCount > 0 ? 'warning' : 'info'">fallback {{ runtime.fallbackWriteCount }}</el-tag>
          <el-button :icon="Refresh" :loading="loading" @click="loadAudit">刷新</el-button>
        </div>
      </template>
    </WorkbenchPanel>

    <section class="border-t border-[var(--fsusblog-panel-border)]">
      <div class="grid gap-3 border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] px-4 py-4 lg:grid-cols-6">
        <el-input v-model="filters.actor" clearable placeholder="actor" aria-label="actor" :prefix-icon="User" />
        <el-input v-model="filters.action" clearable placeholder="action" aria-label="action" :prefix-icon="Operation" />
        <el-input v-model="filters.targetType" clearable placeholder="target type" aria-label="target type" :prefix-icon="Aim" />
        <el-input v-model="filters.targetId" clearable placeholder="target id" aria-label="target id" />
        <el-select v-model="filters.outcome" clearable placeholder="outcome" aria-label="outcome">
          <el-option label="success" value="success" />
          <el-option label="failure" value="failure" />
          <el-option label="denied" value="denied" />
          <el-option label="unknown" value="unknown" />
        </el-select>
        <el-select v-model="filters.severity" clearable placeholder="severity" aria-label="severity">
          <el-option label="info" value="info" />
          <el-option label="warning" value="warning" />
          <el-option label="error" value="error" />
          <el-option label="critical" value="critical" />
        </el-select>
        <el-input v-model="filters.source" clearable placeholder="source" aria-label="source" />
        <el-input v-model="filters.type" clearable placeholder="type" aria-label="type" />
        <el-date-picker
          v-model="dateRange"
          class="lg:col-span-2"
          type="datetimerange"
          start-placeholder="from"
          end-placeholder="to"
          aria-label="time range"
        />
        <div class="flex items-center gap-2 lg:col-span-2">
          <el-button type="primary" :icon="Search" :loading="loading" @click="applyFilters">查询</el-button>
          <el-button :icon="RefreshLeft" @click="resetFilters">重置</el-button>
        </div>
      </div>

      <div class="flex flex-wrap gap-2 border-b border-[var(--fsusblog-panel-border)] px-4 py-3">
        <el-tag v-for="facet in summary?.actions ?? []" :key="`action-${facet.value}`" type="info">
          {{ facet.value }} {{ facet.count }}
        </el-tag>
        <el-tag v-for="facet in summary?.outcomes ?? []" :key="`outcome-${facet.value}`" :type="outcomeTagType(facet.value)">
          {{ facet.value }} {{ facet.count }}
        </el-tag>
        <el-tag v-for="facet in summary?.severities ?? []" :key="`severity-${facet.value}`" :type="severityTagType(facet.value)">
          {{ facet.value }} {{ facet.count }}
        </el-tag>
      </div>

      <el-table v-loading="loading" :data="items" row-key="id">
        <el-table-column label="时间" width="190">
          <template #default="{ row }: { row: AuditLogItemResponse }">
            <time :datetime="row.occurredAtUtc">{{ formatTime(row.occurredAtUtc) }}</time>
          </template>
        </el-table-column>

        <el-table-column label="动作" min-width="250">
          <template #default="{ row }: { row: AuditLogItemResponse }">
            <div class="min-w-0">
              <div class="font-semibold text-[var(--fsusblog-text-primary)]">{{ row.action }}</div>
              <p class="mt-1 truncate text-[11px] text-[var(--fsusblog-text-muted)]">{{ row.eventInfo }}</p>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="Actor" width="160">
          <template #default="{ row }: { row: AuditLogItemResponse }">
            <div class="text-xs">
              <div>{{ row.actorType ?? '-' }}</div>
              <div class="text-[var(--fsusblog-text-muted)]">{{ row.actorId ?? row.actorRole ?? '-' }}</div>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="Target" width="190">
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
              <el-tag :type="outcomeTagType(row.outcome)">{{ row.outcome }}</el-tag>
              <el-tag :type="severityTagType(row.severity)">{{ row.severity }}</el-tag>
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
          <el-descriptions-item label="Action">{{ detail.item.action }}</el-descriptions-item>
          <el-descriptions-item label="Actor">{{ detail.item.actorType ?? '-' }} / {{ detail.item.actorId ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="Target">{{ detail.item.targetType ?? '-' }} / {{ detail.item.targetId ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="Trace">{{ detail.item.traceId ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="Privacy Hash">
            <div class="break-all text-xs leading-6">
              ip={{ detail.item.ipHash ?? '-' }}<br>
              ua={{ detail.item.userAgentHash ?? '-' }}<br>
              session={{ detail.item.sessionIdHash ?? '-' }}<br>
              fp={{ detail.item.deviceFingerprintHash ?? '-' }}
            </div>
          </el-descriptions-item>
          <el-descriptions-item label="Tamper">
            <el-tag :type="detail.tamperEvidenceValid ? 'success' : 'danger'">
              {{ detail.tamperEvidenceValid ? 'valid' : 'invalid' }}
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
import AccountPageHeader from '@/components/account/AccountPageHeader.vue'
import WorkbenchPanel from '@/components/account/WorkbenchPanel.vue'
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

const runtime = computed(() => summary.value?.runtime ?? emptyRuntime)
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
  try {
    const result = await verifyAuditLog(row.id)
    if (result.valid) {
      toast.success('防篡改证据有效')
    } else {
      showWarningToast('防篡改证据无效', '防篡改证据无效')
    }
  } catch (error) {
    showErrorToast(error, '防篡改校验失败')
  } finally {
    verifyingId.value = null
  }
}

const formatTime = (value: string): string => new Date(value).toLocaleString()

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
