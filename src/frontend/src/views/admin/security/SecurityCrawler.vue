<template>
  <div class="space-y-8">
    <WorkbenchPanel
      eyebrow="ANTI-CRAWLER"
      title="反爬虫系统"
      :caption="overview ? `snapshot ${overview.policy.snapshotId}` : ''"
      title-id="security-crawler-title"
    >
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="loadCrawler">刷新</el-button>
      </template>

      <div class="grid gap-px bg-[var(--fsusblog-panel-bg-soft)] md:grid-cols-5">
        <div v-for="metric in metrics" :key="metric.label" class="bg-[var(--fsusblog-page-bg)] p-5">
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ metric.label }}</div>
          <div class="mt-3 break-words text-2xl font-bold tabular-nums text-[var(--fsusblog-text-primary)]">{{ metric.value }}</div>
        </div>
      </div>
    </WorkbenchPanel>

    <section class="grid gap-8 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--fsusblog-panel-border)] p-5">
          <div>
            <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">运行策略</div>
            <div class="mt-2 text-lg font-bold text-[var(--fsusblog-text-primary)]">AntiCrawler mode</div>
          </div>
          <div class="flex gap-2">
            <el-button :loading="saving" @click="rollbackOptions">回滚</el-button>
            <el-button type="primary" :loading="saving" @click="saveOptions">保存</el-button>
          </div>
        </div>

        <div class="grid gap-px bg-[var(--fsusblog-panel-bg-soft)] md:grid-cols-2">
          <label class="bg-[var(--fsusblog-page-bg)] p-5">
            <span class="text-[12px] font-bold text-[var(--fsusblog-text-muted)]">Mode</span>
            <el-select v-model="draft.mode" class="mt-2 w-full" aria-label="anti crawler mode">
              <el-option v-for="mode in modes" :key="mode" :label="mode" :value="mode" />
            </el-select>
          </label>

          <label class="bg-[var(--fsusblog-page-bg)] p-5">
            <span class="text-[12px] font-bold text-[var(--fsusblog-text-muted)]">CIDR interval / minutes</span>
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

      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--fsusblog-panel-border)] p-5">
          <div>
            <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">Crawler ranges</div>
            <div class="mt-2 text-lg font-bold text-[var(--fsusblog-text-primary)]">{{ ranges?.source ?? '-' }}</div>
          </div>
          <el-button type="primary" :loading="syncing" @click="syncRanges">手动同步</el-button>
        </div>
        <div class="grid gap-px bg-[var(--fsusblog-panel-bg-soft)] md:grid-cols-2">
          <div v-for="row in rangeRows" :key="row.label" class="bg-[var(--fsusblog-page-bg)] p-5">
            <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ row.label }}</div>
            <div class="mt-2 break-words text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ row.value }}</div>
          </div>
        </div>
      </div>
    </section>

    <section class="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">风险事件</div>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full min-w-[52rem] text-left text-[12px]">
            <thead class="text-[11px] uppercase text-[var(--fsusblog-text-muted)]">
              <tr class="border-b border-[var(--fsusblog-panel-border)]">
                <th class="px-5 py-3">Time</th>
                <th class="px-5 py-3">Source</th>
                <th class="px-5 py-3">Reason</th>
                <th class="px-5 py-3">Score</th>
                <th class="px-5 py-3">Path</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="event in events" :key="event.id" class="border-b border-[var(--fsusblog-panel-border)]">
                <td class="px-5 py-3">{{ formatTime(event.occurredAtUtc) }}</td>
                <td class="px-5 py-3">{{ event.source }}</td>
                <td class="px-5 py-3">{{ event.reason }}</td>
                <td class="px-5 py-3 tabular-nums">{{ event.scoreDelta }} / {{ event.totalScore }}</td>
                <td class="px-5 py-3">{{ event.path }}</td>
              </tr>
              <tr v-if="events.length === 0">
                <td colspan="5" class="px-5 py-10 text-center text-[var(--fsusblog-text-muted)]">暂无风险事件</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">风险快照</div>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <div v-for="snapshot in snapshots" :key="snapshot.subject" class="flex items-center justify-between gap-3 p-5">
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
            <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ list.title }}</div>
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
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">规则</div>
          <el-button @click="addRule">新增规则</el-button>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <div v-for="rule in rules" :key="rule.id" class="flex flex-wrap items-center justify-between gap-3 p-5">
            <div>
              <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ rule.name }}</div>
              <div class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">{{ rule.matchType }} / {{ rule.pattern }} / {{ rule.action }} / +{{ rule.score }}</div>
            </div>
            <el-button link @click="deleteRuleItem(rule.id)">删除</el-button>
          </div>
        </div>
      </div>

      <div class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">策略模拟器</div>
        </div>
        <div class="space-y-4 p-5">
          <el-input v-model="simulation.ip" placeholder="IP" />
          <el-input v-model="simulation.path" placeholder="Path" />
          <el-input v-model="simulation.userAgent" type="textarea" :rows="3" placeholder="User-Agent" />
          <el-input-number v-model="simulation.currentRiskScore" class="w-full" :min="0" :max="500" controls-position="right" />
          <el-button type="primary" :loading="simulating" @click="runSimulation">模拟</el-button>
          <div v-if="simulationResult" class="border-t border-[var(--fsusblog-panel-border)] pt-5 text-[12px] leading-6 text-[var(--fsusblog-text-secondary)]">
            <div class="font-bold text-[var(--fsusblog-text-primary)]">{{ simulationResult.finalAction }} / score {{ simulationResult.resultingRiskScore }}</div>
            <div>challenge: {{ simulationResult.wouldRequireChallenge ? 'yes' : 'no' }} / block: {{ simulationResult.wouldBlock ? 'yes' : 'no' }}</div>
            <div>rules: {{ simulationResult.matchedRules.join(', ') || '-' }}</div>
            <div>lists: {{ simulationResult.matchedLists.join(', ') || '-' }}</div>
            <div>challenge reference: {{ simulationResult.securityChallengeReference }}</div>
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
import { startMfaChallenge, verifyMfaChallenge } from '@/api/auth'
import WorkbenchPanel from '@/components/account/WorkbenchPanel.vue'
import { Refresh } from '@/fsusui/icons'
import { promptText, toast } from '@/fsusui/feedback'
import { showErrorToast } from '@/utils/errorPresentation'

const AdminSensitiveAction = 'admin-sensitive'
const modes: SecurityMode[] = ['disabled', 'observe', 'enforce', 'strict']

const loading = shallowRef(false)
const saving = shallowRef(false)
const syncing = shallowRef(false)
const simulating = shallowRef(false)
const overview = shallowRef<AntiCrawlerOverviewResponse | null>(null)
const snapshots = shallowRef<SecurityRiskSnapshotResponse[]>([])
const simulationResult = shallowRef<AntiCrawlerSimulationResult | null>(null)

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
  { key: 'publicReadChallengeEnabled', label: 'Public read challenge', caption: '统一风险分触发安全 challenge。' },
  { key: 'searchCrawlerVerificationEnabled', label: 'Search crawler verification', caption: 'Google/Bing CIDR 与 Baidu/Sogou DNS 验身。' },
  { key: 'socialPreviewGuardEnabled', label: 'Social preview guard', caption: '限制社交预览 bot 访问范围。' },
  { key: 'riskScoringEnabled', label: 'Crawler risk scoring', caption: '写入 crawler 类风险分。' },
  { key: 'eventPersistenceEnabled', label: 'Crawler events', caption: '保留运行时事件 ring buffer。' },
  { key: 'dashboardAggregationEnabled', label: 'Dashboard aggregation', caption: '保留后台风险快照聚合。' },
  { key: 'cidrAutoUpdateEnabled', label: 'CIDR auto update', caption: '自动同步搜索引擎 CIDR。' },
  { key: 'illegalPathHardAbortEnabled', label: 'Illegal path hard abort', caption: '路径穿越等基础安全硬拦截。' }
] as const

const metrics = computed(() => [
  { label: 'Mode', value: overview.value?.summary.mode ?? '-' },
  { label: 'Events / 1h', value: overview.value?.summary.eventsLastHour ?? '-' },
  { label: 'Fake crawler', value: overview.value?.summary.fakeCrawlerEvents ?? '-' },
  { label: 'Unknown bot', value: overview.value?.summary.unknownBotEvents ?? '-' },
  { label: 'Risk snapshots', value: overview.value?.summary.riskSnapshotCount ?? '-' }
])

const ranges = computed<CrawlerRangesAdminStatus | null>(() => overview.value?.crawlerRanges ?? null)
const events = computed<AntiCrawlerRiskEventResponse[]>(() => overview.value?.recentEvents ?? [])
const rules = computed<AntiCrawlerRuleResponse[]>(() => overview.value?.rules ?? [])
const allowlist = computed<AntiCrawlerListEntryResponse[]>(() => overview.value?.allowlist ?? [])
const blocklist = computed<AntiCrawlerListEntryResponse[]>(() => overview.value?.blocklist ?? [])

const rangeRows = computed(() => [
  { label: 'Auto update', value: ranges.value?.autoUpdateEnabled ? 'enabled' : 'disabled' },
  { label: 'Interval', value: `${ranges.value?.updateIntervalMinutes ?? '-'} min` },
  { label: 'Next sync', value: formatTime(ranges.value?.nextSyncAt) },
  { label: 'Last success', value: formatTime(ranges.value?.lastSuccessAt) },
  { label: 'Google ranges', value: ranges.value?.googleRanges ?? '-' },
  { label: 'Bing ranges', value: ranges.value?.bingRanges ?? '-' },
  { label: 'Outcome', value: ranges.value?.lastOutcome ?? '-' },
  { label: 'Last error', value: ranges.value?.lastError ?? '-' }
])

const listPanels = computed(() => [
  { type: 'allowlist' as const, title: 'Allowlist', items: allowlist.value },
  { type: 'blocklist' as const, title: 'Blocklist', items: blocklist.value }
])

const formatTime = (value: string | null | undefined): string => value ? new Date(value).toLocaleString() : '-'

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

const ensureAdminSensitiveProof = async (): Promise<string> => {
  const challenge = await startMfaChallenge(AdminSensitiveAction)
  if (challenge.verified && challenge.proofToken) return challenge.proofToken
  const challengeToken = challenge.proofToken
  if (!challengeToken) throw new Error('MFA_CHALLENGE_REQUIRED')

  const code = await promptText('输入 MFA 验证码或恢复码', '安全系统验证', {
    confirmButtonText: '确认',
    cancelButtonText: '取消',
    inputPlaceholder: '验证码或恢复码',
    inputValidator: (value: string) => value.trim().length > 0 || '请输入验证码或恢复码'
  })
  if (!code) throw new Error('MFA_CHALLENGE_CANCELLED')

  const proof = await verifyMfaChallenge({ challengeToken, code, action: AdminSensitiveAction })
  if (!proof.verified || !proof.proofToken) throw new Error('MFA_PROOF_REQUIRED')
  return proof.proofToken
}

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
    const mfaProofToken = await ensureAdminSensitiveProof()
    const snapshot = await updateAntiCrawlerOptions({ ...draft, reason }, { mfaProofToken })
    assignDraft(snapshot.options)
    toast.success('反爬虫策略已更新')
    await loadCrawler()
  } catch (error) {
    showErrorToast(error, '反爬虫策略保存失败')
  } finally {
    saving.value = false
  }
}

const rollbackOptions = async (): Promise<void> => {
  saving.value = true
  try {
    const mfaProofToken = await ensureAdminSensitiveProof()
    const snapshot = await rollbackAntiCrawlerOptions({ mfaProofToken })
    assignDraft(snapshot.options)
    toast.success('反爬虫策略已回滚')
    await loadCrawler()
  } catch (error) {
    showErrorToast(error, '反爬虫策略回滚失败')
  } finally {
    saving.value = false
  }
}

const syncRanges = async (): Promise<void> => {
  syncing.value = true
  try {
    const mfaProofToken = await ensureAdminSensitiveProof()
    await syncCrawlerRanges({ mfaProofToken })
    toast.success('CIDR 同步已完成')
    await loadCrawler()
  } catch (error) {
    showErrorToast(error, 'CIDR 同步失败')
  } finally {
    syncing.value = false
  }
}

const resetRisk = async (subject: string): Promise<void> => {
  try {
    const mfaProofToken = await ensureAdminSensitiveProof()
    await resetSecurityRisk({ subject, reason: 'admin_reset_from_security_console' }, { mfaProofToken })
    toast.success('风险分已重置')
    await loadCrawler()
  } catch (error) {
    showErrorToast(error, '风险分重置失败')
  }
}

const addListEntry = async (type: 'allowlist' | 'blocklist'): Promise<void> => {
  try {
    const value = await promptText('条目值', type === 'allowlist' ? '新增 Allowlist' : '新增 Blocklist', {
      confirmButtonText: '新增',
      cancelButtonText: '取消',
      inputPlaceholder: 'IP / UA / Path',
      inputValidator: (input: string) => input.trim().length > 0 || '请输入条目值'
    })
    if (!value) return
    const mfaProofToken = await ensureAdminSensitiveProof()
    await createAntiCrawlerEntry(type, { value, scope: 'ip', reason: 'admin_list_entry', enabled: true }, { mfaProofToken })
    await loadCrawler()
  } catch (error) {
    showErrorToast(error, 'List 条目新增失败')
  }
}

const deleteListEntry = async (type: 'allowlist' | 'blocklist', id: string): Promise<void> => {
  try {
    const mfaProofToken = await ensureAdminSensitiveProof()
    await deleteAntiCrawlerEntry(type, id, { mfaProofToken })
    await loadCrawler()
  } catch (error) {
    showErrorToast(error, 'List 条目删除失败')
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
    await loadCrawler()
  } catch (error) {
    showErrorToast(error, '规则新增失败')
  }
}

const deleteRuleItem = async (id: string): Promise<void> => {
  try {
    const mfaProofToken = await ensureAdminSensitiveProof()
    await deleteAntiCrawlerRule(id, { mfaProofToken })
    await loadCrawler()
  } catch (error) {
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
