<template>
  <div class="space-y-8">
    <FsusUiSettingsSection
      title="反爬虫系统"
      :description="overview ? `快照：${overview.policy.snapshotId}` : ''"
      id="security-crawler-title"
    >
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="loadCrawler">刷新</el-button>
      </template>

      <AdminStatusMatrix :items="metrics" density="compact" aria-label="反爬虫指标" />
    </FsusUiSettingsSection>

    <section class="grid gap-8 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <div
        class="blog-motion-task-region border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]"
        :class="{
          'blog-motion-task-region--pending': saving,
          'blog-motion-task-region--settled': isTaskHighlighted('security-crawler-options')
        }"
      >
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--fsusblog-panel-border)] p-5">
          <div>
            <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">运行策略</div>
            <div class="mt-2 text-lg font-bold text-[var(--fsusblog-text-primary)]">反爬虫运行模式</div>
          </div>
          <div class="flex gap-2">
            <el-button :loading="saving" @click="rollbackOptions">回滚</el-button>
            <el-button type="primary" :loading="saving" @click="saveOptions">保存</el-button>
          </div>
        </div>

        <div class="grid gap-3 md:grid-cols-2">
          <label class="bg-[var(--fsusblog-page-bg)] p-5">
            <span class="text-[12px] font-bold text-[var(--fsusblog-text-muted)]">运行模式</span>
            <el-select v-model="draft.mode" class="mt-2 w-full" aria-label="反爬虫运行模式">
              <el-option v-for="mode in modes" :key="mode" :label="formatSecurityMode(mode)" :value="mode" />
            </el-select>
          </label>

          <label class="bg-[var(--fsusblog-page-bg)] p-5">
            <span class="text-[12px] font-bold text-[var(--fsusblog-text-muted)]">CIDR 更新间隔（分钟）</span>
            <el-input-number v-model="draft.cidrUpdateIntervalMinutes" class="mt-2 w-full" :min="draft.cidrMinUpdateIntervalMinutes" :max="1440" controls-position="right" />
          </label>

          <div v-for="toggle in toggles" :key="toggle.key" class="flex items-center justify-between gap-4 bg-[var(--fsusblog-page-bg)] p-5">
            <div>
              <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ toggle.label }}</div>
              <div class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ toggle.caption }}</div>
            </div>
            <el-switch v-model="draft[toggle.key]" />
          </div>
        </div>
      </div>

      <div
        class="blog-motion-task-region border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]"
        :class="{
          'blog-motion-task-region--pending': syncing,
          'blog-motion-task-region--settled': isTaskHighlighted('security-crawler-ranges')
        }"
      >
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--fsusblog-panel-border)] p-5">
          <div>
            <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">CIDR 来源</div>
            <div class="mt-2 text-lg font-bold text-[var(--fsusblog-text-primary)]">{{ ranges?.source ?? '-' }}</div>
          </div>
          <el-button type="primary" :loading="syncing" @click="syncRanges">手动同步</el-button>
        </div>
        <AdminStatusMatrix :items="rangeRows" density="compact" aria-label="CIDR 来源状态" />
      </div>
    </section>

    <section class="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">风险事件</div>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full min-w-full md:min-w-[52rem] text-left text-[12px]">
            <thead class="text-[11px] uppercase text-[var(--fsusblog-text-muted)]">
              <tr class="border-b border-[var(--fsusblog-panel-border)]">
                <th class="px-5 py-3">时间</th>
                <th class="px-5 py-3">来源</th>
                <th class="px-5 py-3">原因</th>
                <th class="px-5 py-3">分数</th>
                <th class="px-5 py-3">路径</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="event in eventRows" :key="event.id" class="border-b border-[var(--fsusblog-panel-border)]">
                <td class="px-5 py-3">{{ event.formattedOccurredAt }}</td>
                <td class="px-5 py-3">{{ event.source }}</td>
                <td class="px-5 py-3">{{ event.reason }}</td>
                <td class="px-5 py-3 tabular-nums">{{ event.scoreDelta }} / {{ event.totalScore }}</td>
                <td class="px-5 py-3">{{ event.path }}</td>
              </tr>
              <tr v-if="eventRows.length === 0">
                <td colspan="5" class="px-5 py-10 text-center text-[var(--fsusblog-text-muted)]">暂无风险事件</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">风险快照</div>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <div
            v-for="snapshot in snapshots"
            :key="snapshot.subject"
            class="blog-motion-task-region flex items-center justify-between gap-3 p-5"
            :class="{ 'blog-motion-task-region--settled': isTaskHighlighted(`risk:${snapshot.subject}`) }"
          >
            <div class="min-w-0">
              <div class="break-all text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ snapshot.subject }}</div>
              <div class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ snapshot.lastSource }} / {{ snapshot.lastReason }}</div>
            </div>
            <div class="flex shrink-0 items-center gap-3">
              <el-tag :type="snapshot.score >= (overview?.policy.options.requireChallengeScore ?? 50) ? 'warning' : 'info'">{{ snapshot.score }}</el-tag>
              <el-button link @click="resetRisk(snapshot.subject)">重置</el-button>
            </div>
          </div>
          <div v-if="snapshots.length === 0" class="p-8 text-center text-[12px] text-[var(--fsusblog-text-muted)]">暂无风险快照</div>
        </div>
      </div>
    </section>

    <section class="grid gap-8 xl:grid-cols-2">
      <div v-for="list in listPanels" :key="list.type" class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--fsusblog-panel-border)] p-5">
          <div>
            <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ list.title }}</div>
          </div>
          <el-button @click="addListEntry(list.type)">新增</el-button>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <div v-for="entry in list.items" :key="entry.id" class="flex items-center justify-between gap-3 p-5">
            <div>
              <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ entry.value }}</div>
              <div class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ entry.scope }} / {{ entry.reason ?? '-' }}</div>
            </div>
            <el-button link @click="deleteListEntry(list.type, entry.id)">删除</el-button>
          </div>
          <div v-if="list.items.length === 0" class="p-8 text-center text-[12px] text-[var(--fsusblog-text-muted)]">暂无条目</div>
        </div>
      </div>
    </section>

    <section class="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,0.72fr)]">
      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">规则</div>
          <el-button @click="addRule">新增规则</el-button>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <div v-for="rule in rules" :key="rule.id" class="flex flex-wrap items-center justify-between gap-3 p-5">
            <div>
              <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ rule.name }}</div>
              <div class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ formatRuleMatchType(rule.matchType) }} / {{ rule.pattern }} / {{ formatRuleAction(rule.action) }} / +{{ rule.score }}</div>
            </div>
            <el-button link @click="deleteRuleItem(rule.id)">删除</el-button>
          </div>
        </div>
      </div>

      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">策略模拟器</div>
        </div>
        <div class="space-y-4 p-5">
          <el-input v-model="simulation.ip" placeholder="IP" />
          <el-input v-model="simulation.path" placeholder="请求路径" />
          <el-input v-model="simulation.userAgent" type="textarea" :rows="3" placeholder="User-Agent" />
          <el-input-number v-model="simulation.currentRiskScore" class="w-full" :min="0" :max="500" controls-position="right" />
          <el-button type="primary" :loading="simulating" @click="runSimulation">模拟</el-button>
          <div v-if="simulationResult" class="border-t border-[var(--fsusblog-panel-border)] pt-5 text-[12px] leading-6 text-[var(--fsusblog-text-secondary)]">
            <div class="font-bold text-[var(--fsusblog-text-primary)]">{{ formatRuleAction(simulationResult.finalAction) }} / 风险分 {{ simulationResult.resultingRiskScore }}</div>
            <div>需要挑战：{{ formatBoolean(simulationResult.wouldRequireChallenge) }} / 拦截：{{ formatBoolean(simulationResult.wouldBlock) }}</div>
            <div>命中规则：{{ simulationResult.matchedRules.join(', ') || '-' }}</div>
            <div>命中列表：{{ simulationResult.matchedLists.join(', ') || '-' }}</div>
            <div>挑战引用：{{ simulationResult.securityChallengeReference }}</div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef } from 'vue'
import {
  createAntiCrawlerEntry,
  createAntiCrawlerRule,
  deleteAntiCrawlerEntry,
  deleteAntiCrawlerRule,
  getAntiCrawlerOverview,
  listSecurityRiskSnapshots,
  resetSecurityRisk,
  rollbackAntiCrawlerOptions,
  simulateAntiCrawlerPolicy,
  syncCrawlerRanges,
  updateAntiCrawlerOptions,
  type AntiCrawlerListEntryResponse,
  type AntiCrawlerOverviewResponse,
  type AntiCrawlerPolicyOptions,
  type AntiCrawlerRiskEventResponse,
  type AntiCrawlerRuleResponse,
  type AntiCrawlerSimulationResult,
  type CrawlerRangesAdminStatus,
  type SecurityMode,
  type SecurityRiskSnapshotResponse
} from '@/api/security'
import AdminStatusMatrix, { type AdminStatusMatrixItem } from '@/components/admin/AdminStatusMatrix.vue'
import { useAdminSensitiveProof } from '@/composables/useAdminSensitiveProof'
import { FsusUiSettingsSection } from '@/fsusui'
import { Refresh } from '@/fsusui/icons'
import { promptText, toast } from '@/fsusui/feedback'
import { showErrorToast } from '@/utils/errorPresentation'
import { useAdminTaskFeedback } from '@/composables/useAdminTaskFeedback'

const modes: SecurityMode[] = ['disabled', 'observe', 'enforce', 'strict']

const formatSecurityMode = (mode: SecurityMode | string | null | undefined): string => {
  const labels: Record<string, string> = {
    disabled: '已关闭',
    observe: '观察',
    enforce: '执行',
    strict: '严格'
  }
  return mode ? labels[mode] ?? mode : '-'
}

const formatBoolean = (value: boolean): string => value ? '是' : '否'

const formatEnabled = (value: boolean | null | undefined): string =>
  value === undefined || value === null ? '-' : value ? '已启用' : '已关闭'

const formatRuleAction = (value: string): string => {
  const labels: Record<string, string> = {
    allow: '放行',
    challenge: '挑战',
    block: '拦截',
    observe: '观察'
  }
  return labels[value] ?? value
}

const formatRuleMatchType = (value: string): string => {
  const labels: Record<string, string> = {
    ip: 'IP',
    path: '路径',
    'user-agent': 'User-Agent',
    header: '请求头',
    method: '方法'
  }
  return labels[value] ?? value
}

const formatListType = (type: 'allowlist' | 'blocklist'): string =>
  type === 'allowlist' ? '放行列表' : '拦截列表'

const loading = shallowRef(false)
const saving = shallowRef(false)
const syncing = shallowRef(false)
const simulating = shallowRef(false)
const overview = shallowRef<AntiCrawlerOverviewResponse | null>(null)
const snapshots = shallowRef<SecurityRiskSnapshotResponse[]>([])
const simulationResult = shallowRef<AntiCrawlerSimulationResult | null>(null)
const taskFeedback = useAdminTaskFeedback()
const {
  isHighlighted: isTaskHighlighted
} = taskFeedback

const draft = reactive<AntiCrawlerPolicyOptions>({
  mode: 'enforce',
  publicReadChallengeEnabled: true,
  searchCrawlerVerificationEnabled: true,
  socialPreviewGuardEnabled: true,
  riskScoringEnabled: true,
  eventPersistenceEnabled: true,
  dashboardAggregationEnabled: true,
  cidrAutoUpdateEnabled: true,
  illegalPathHardAbortEnabled: true,
  requireChallengeScore: 50,
  blockScore: 100,
  maxRiskScore: 200,
  defaultRiskTtlSeconds: 600,
  zeroRiskCacheTtlSeconds: 3,
  fixedIpPermitLimit: 100,
  fixedIpQueueLimit: 2,
  verifiedCrawlerFixedIpPermitLimit: 1000,
  publicReadPermitLimit: 120,
  publicReadQueueLimit: 2,
  verifiedCrawlerPublicReadPermitLimit: 1000,
  socialPreviewPublicReadPermitLimit: 30,
  readProofPermitLimit: 30,
  cidrUpdateIntervalMinutes: 1440,
  cidrInitialDelaySeconds: 0,
  cidrMinUpdateIntervalMinutes: 30,
  googleCrawlerRangesUrl: '',
  bingCrawlerRangesUrl: '',
  snapshotPath: null,
  socialPreviewAllowedPathPrefixes: [],
  blockedUserAgentKeywords: [],
  securityChallengeReference: 'security.pow'
})

const simulation = reactive({
  method: 'GET',
  path: '/article/example',
  userAgent: 'Mozilla/5.0',
  ip: '203.0.113.10',
  referer: null as string | null,
  currentRiskScore: 0
})

const toggles = [
  { key: 'publicReadChallengeEnabled', label: '公开读取挑战', caption: '统一风险分触发安全挑战。' },
  { key: 'searchCrawlerVerificationEnabled', label: '搜索爬虫校验', caption: 'Google/Bing CIDR 与 Baidu/Sogou DNS 验身。' },
  { key: 'socialPreviewGuardEnabled', label: '社交预览保护', caption: '限制社交预览机器人访问范围。' },
  { key: 'riskScoringEnabled', label: '爬虫风险计分', caption: '写入爬虫类风险分。' },
  { key: 'eventPersistenceEnabled', label: '爬虫事件', caption: '保留运行时事件缓冲区。' },
  { key: 'dashboardAggregationEnabled', label: '后台聚合', caption: '保留后台风险快照聚合。' },
  { key: 'cidrAutoUpdateEnabled', label: 'CIDR 自动更新', caption: '自动同步搜索引擎 CIDR。' },
  { key: 'illegalPathHardAbortEnabled', label: '非法路径硬拦截', caption: '路径穿越等基础安全硬拦截。' }
] as const

const metrics = computed<AdminStatusMatrixItem[]>(() => [
  { label: '运行模式', value: formatSecurityMode(overview.value?.summary.mode) },
  { label: '1 小时事件', value: overview.value?.summary.eventsLastHour ?? '-' },
  { label: '伪造爬虫', value: overview.value?.summary.fakeCrawlerEvents ?? '-' },
  { label: '未识别爬虫', value: overview.value?.summary.unknownBotEvents ?? '-' },
  { label: '风险快照', value: overview.value?.summary.riskSnapshotCount ?? '-' }
])

const ranges = computed<CrawlerRangesAdminStatus | null>(() => overview.value?.crawlerRanges ?? null)
const events = computed<AntiCrawlerRiskEventResponse[]>(() => overview.value?.recentEvents ?? [])
const rules = computed<AntiCrawlerRuleResponse[]>(() => overview.value?.rules ?? [])
const allowlist = computed<AntiCrawlerListEntryResponse[]>(() => overview.value?.allowlist ?? [])
const blocklist = computed<AntiCrawlerListEntryResponse[]>(() => overview.value?.blocklist ?? [])

const formatTime = (value: string | null | undefined): string => value ? new Date(value).toLocaleString() : '-'

const rangeRows = computed<AdminStatusMatrixItem[]>(() => [
  { label: '自动更新', value: formatEnabled(ranges.value?.autoUpdateEnabled) },
  { label: '更新间隔', value: `${ranges.value?.updateIntervalMinutes ?? '-'} 分钟` },
  { label: '下次同步', value: formatTime(ranges.value?.nextSyncAt) },
  { label: '最近成功', value: formatTime(ranges.value?.lastSuccessAt) },
  { label: 'Google CIDR', value: ranges.value?.googleRanges ?? '-' },
  { label: 'Bing CIDR', value: ranges.value?.bingRanges ?? '-' },
  { label: '结果', value: ranges.value?.lastOutcome ?? '-' },
  { label: '最近错误', value: ranges.value?.lastError ?? '-' }
])

const listPanels = computed(() => [
  { type: 'allowlist' as const, title: '放行列表', items: allowlist.value },
  { type: 'blocklist' as const, title: '拦截列表', items: blocklist.value }
])

const eventRows = computed(() => events.value.map((event) => ({
  ...event,
  formattedOccurredAt: formatTime(event.occurredAtUtc)
})))

const assignDraft = (options: AntiCrawlerPolicyOptions): void => {
  Object.assign(draft, options)
}

const loadCrawler = async (): Promise<void> => {
  loading.value = true
  try {
    const [overviewResponse, snapshotResponse] = await Promise.all([
      getAntiCrawlerOverview(),
      listSecurityRiskSnapshots(50)
    ])
    overview.value = overviewResponse
    snapshots.value = snapshotResponse
    assignDraft(overviewResponse.policy.options)
  } catch (error) {
    showErrorToast(error, '反爬虫系统加载失败')
  } finally {
    loading.value = false
  }
}

const { ensureAdminSensitiveProof } = useAdminSensitiveProof()

const saveOptions = async (): Promise<void> => {
  saving.value = true
  try {
    const reason = await promptText('变更原因', '保存反爬虫策略', {
      confirmButtonText: '保存',
      cancelButtonText: '取消',
      inputPlaceholder: 'reason',
      inputValidator: (value: string) => value.trim().length > 0 || '请输入变更原因'
    })
    if (!reason) return
    taskFeedback.begin('正在保存反爬虫策略', reason, 'security-crawler-options')
    const mfaProofToken = await ensureAdminSensitiveProof()
    const snapshot = await updateAntiCrawlerOptions({ ...draft, reason }, { mfaProofToken })
    assignDraft(snapshot.options)
    taskFeedback.succeed('反爬虫策略已更新', `运行模式：${formatSecurityMode(snapshot.options.mode)}`, 'security-crawler-options')
    toast.success('反爬虫策略已更新')
    await loadCrawler()
  } catch (error) {
    taskFeedback.fail('反爬虫策略保存失败', error, '反爬虫策略保存失败', 'security-crawler-options')
    showErrorToast(error, '反爬虫策略保存失败')
  } finally {
    saving.value = false
  }
}

const rollbackOptions = async (): Promise<void> => {
  saving.value = true
  taskFeedback.begin('正在回滚反爬虫策略', '需要管理员二次验证', 'security-crawler-options')
  try {
    const mfaProofToken = await ensureAdminSensitiveProof()
    const snapshot = await rollbackAntiCrawlerOptions({ mfaProofToken })
    assignDraft(snapshot.options)
    taskFeedback.succeed('反爬虫策略已回滚', `运行模式：${formatSecurityMode(snapshot.options.mode)}`, 'security-crawler-options')
    toast.success('反爬虫策略已回滚')
    await loadCrawler()
  } catch (error) {
    taskFeedback.fail('反爬虫策略回滚失败', error, '反爬虫策略回滚失败', 'security-crawler-options')
    showErrorToast(error, '反爬虫策略回滚失败')
  } finally {
    saving.value = false
  }
}

const syncRanges = async (): Promise<void> => {
  syncing.value = true
  taskFeedback.begin('正在同步 CIDR 来源', '同步 Google/Bing CIDR 来源', 'security-crawler-ranges')
  try {
    const mfaProofToken = await ensureAdminSensitiveProof()
    await syncCrawlerRanges({ mfaProofToken })
    taskFeedback.succeed('CIDR 同步已完成', 'CIDR 来源已刷新', 'security-crawler-ranges')
    toast.success('CIDR 同步已完成')
    await loadCrawler()
  } catch (error) {
    taskFeedback.fail('CIDR 同步失败', error, 'CIDR 同步失败', 'security-crawler-ranges')
    showErrorToast(error, 'CIDR 同步失败')
  } finally {
    syncing.value = false
  }
}

const resetRisk = async (subject: string): Promise<void> => {
  taskFeedback.begin('正在重置风险分', subject, `risk:${subject}`)
  try {
    const mfaProofToken = await ensureAdminSensitiveProof()
    await resetSecurityRisk({ subject, reason: 'admin_reset_from_security_console' }, { mfaProofToken })
    taskFeedback.succeed('风险分已重置', subject, `risk:${subject}`)
    toast.success('风险分已重置')
    await loadCrawler()
  } catch (error) {
    taskFeedback.fail('风险分重置失败', error, '风险分重置失败', `risk:${subject}`)
    showErrorToast(error, '风险分重置失败')
  }
}

const addListEntry = async (type: 'allowlist' | 'blocklist'): Promise<void> => {
  try {
    const value = await promptText('条目值', `新增${formatListType(type)}条目`, {
      confirmButtonText: '新增',
      cancelButtonText: '取消',
      inputPlaceholder: 'IP / UA / Path',
      inputValidator: (input: string) => input.trim().length > 0 || '请输入条目值'
    })
    if (!value) return
    taskFeedback.begin('正在新增反爬虫列表条目', `${formatListType(type)}：${value}`, 'security-crawler-options')
    const mfaProofToken = await ensureAdminSensitiveProof()
    await createAntiCrawlerEntry(type, { value, scope: 'ip', reason: 'admin_list_entry', enabled: true }, { mfaProofToken })
    taskFeedback.succeed('反爬虫列表条目已新增', `${formatListType(type)}：${value}`, 'security-crawler-options')
    await loadCrawler()
  } catch (error) {
    taskFeedback.fail('列表条目新增失败', error, '列表条目新增失败', 'security-crawler-options')
    showErrorToast(error, '列表条目新增失败')
  }
}

const deleteListEntry = async (type: 'allowlist' | 'blocklist', id: string): Promise<void> => {
  taskFeedback.begin('正在删除反爬虫列表条目', `${formatListType(type)}：${id}`, 'security-crawler-options')
  try {
    const mfaProofToken = await ensureAdminSensitiveProof()
    await deleteAntiCrawlerEntry(type, id, { mfaProofToken })
    taskFeedback.succeed('反爬虫列表条目已删除', `${formatListType(type)}：${id}`, 'security-crawler-options')
    await loadCrawler()
  } catch (error) {
    taskFeedback.fail('列表条目删除失败', error, '列表条目删除失败', 'security-crawler-options')
    showErrorToast(error, '列表条目删除失败')
  }
}

const addRule = async (): Promise<void> => {
  try {
    const pattern = await promptText('匹配表达式', '新增反爬虫规则', {
      confirmButtonText: '新增',
      cancelButtonText: '取消',
      inputPlaceholder: 'bot|crawler',
      inputValidator: (value: string) => value.trim().length > 0 || '请输入匹配表达式'
    })
    if (!pattern) return
    taskFeedback.begin('正在新增反爬虫规则', pattern, 'security-crawler-options')
    const mfaProofToken = await ensureAdminSensitiveProof()
    await createAntiCrawlerRule({
      name: `custom:${pattern.slice(0, 24)}`,
      enabled: true,
      matchType: 'user-agent',
      pattern,
      action: 'block',
      score: 10,
      notes: 'admin_custom_rule'
    }, { mfaProofToken })
    taskFeedback.succeed('反爬虫规则已新增', pattern, 'security-crawler-options')
    await loadCrawler()
  } catch (error) {
    taskFeedback.fail('规则新增失败', error, '规则新增失败', 'security-crawler-options')
    showErrorToast(error, '规则新增失败')
  }
}

const deleteRuleItem = async (id: string): Promise<void> => {
  taskFeedback.begin('正在删除反爬虫规则', id, 'security-crawler-options')
  try {
    const mfaProofToken = await ensureAdminSensitiveProof()
    await deleteAntiCrawlerRule(id, { mfaProofToken })
    taskFeedback.succeed('反爬虫规则已删除', id, 'security-crawler-options')
    await loadCrawler()
  } catch (error) {
    taskFeedback.fail('规则删除失败', error, '规则删除失败', 'security-crawler-options')
    showErrorToast(error, '规则删除失败')
  }
}

const runSimulation = async (): Promise<void> => {
  simulating.value = true
  try {
    simulationResult.value = await simulateAntiCrawlerPolicy({ ...simulation })
  } catch (error) {
    showErrorToast(error, '策略模拟失败')
  } finally {
    simulating.value = false
  }
}

onMounted(() => {
  void loadCrawler()
})
</script>
