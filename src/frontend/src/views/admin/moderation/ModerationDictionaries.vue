<template>
  <div class="space-y-8">
    <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
      <div class="flex flex-col gap-5 border-b border-[var(--fsusblog-panel-border)] p-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">词库管理 / DICTIONARIES</div>
          <h2 class="mt-2 text-xl font-bold text-[var(--fsusblog-text-primary)]">运行时词库 metadata</h2>
          <p class="mt-2 text-[12px] text-[var(--fsusblog-text-muted)]">高风险词库只展示 metadata、checksum、term count 和 evidence policy。</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <el-tag v-if="snapshot?.lastError" type="danger">load error</el-tag>
          <el-tag v-else type="success">loaded</el-tag>
          <el-button :icon="Refresh" :loading="loading" @click="loadSnapshot">刷新</el-button>
          <el-button :icon="RefreshRight" type="warning" :loading="reloading" @click="reloadSnapshot">手动 reload</el-button>
        </div>
      </div>

      <div class="grid gap-3 border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] p-4 md:grid-cols-6">
        <el-select v-model="filters.scope" clearable placeholder="scope" aria-label="scope">
          <el-option label="global" value="global" />
          <el-option label="regional" value="regional" />
        </el-select>
        <el-input v-model="filters.dictionaryId" clearable placeholder="dictionary id" aria-label="dictionary id" />
        <el-select v-model="filters.region" clearable placeholder="region" aria-label="region">
          <el-option v-for="region in regionOptions" :key="region" :label="region" :value="region" />
        </el-select>
        <el-select v-model="filters.category" clearable placeholder="category" aria-label="category">
          <el-option v-for="category in categoryOptions" :key="category" :label="category" :value="category" />
        </el-select>
        <el-input v-model="filters.status" clearable placeholder="status" aria-label="status" />
        <div class="flex items-center gap-2">
          <span class="text-[12px] font-bold text-[var(--fsusblog-text-muted)]">high risk</span>
          <el-switch v-model="filters.highRiskOnly" />
        </div>
      </div>

      <el-table v-loading="loading" :data="filteredDictionaries" row-key="dictionaryId">
        <el-table-column label="Dictionary ID" min-width="230">
          <template #default="{ row }: { row: ModerationDictionaryRuntimeItem }">
            <div class="font-semibold text-[var(--fsusblog-text-primary)]">{{ row.dictionaryId }}</div>
            <div class="mt-1 text-[11px] text-[var(--fsusblog-text-muted)]">{{ row.source }} / {{ row.reviewedBy }}</div>
          </template>
        </el-table-column>
        <el-table-column label="Scope" width="110" prop="scope" />
        <el-table-column label="Region" width="130">
          <template #default="{ row }: { row: ModerationDictionaryRuntimeItem }">{{ row.region ?? 'GLOBAL' }}</template>
        </el-table-column>
        <el-table-column label="Category" min-width="170" prop="category" />
        <el-table-column label="Version" width="140" prop="version" />
        <el-table-column label="Evidence" width="150">
          <template #default="{ row }: { row: ModerationDictionaryRuntimeItem }">
            <el-tag :type="evidenceType(row.evidencePolicy)">{{ row.evidencePolicy }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="Terms" width="90" align="right" prop="termCount" />
        <el-table-column label="Status" width="110">
          <template #default="{ row }: { row: ModerationDictionaryRuntimeItem }">
            <el-tag :type="dictionaryStatusType(row)">{{ dictionaryStatus(row) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="Checksum" min-width="180">
          <template #default="{ row }: { row: ModerationDictionaryRuntimeItem }">
            <code class="block truncate text-[11px]">{{ row.checksum }}</code>
          </template>
        </el-table-column>
        <el-table-column label="Updated" width="170">
          <template #default="{ row }: { row: ModerationDictionaryRuntimeItem }">{{ formatTime(row.updatedAtUtc) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="190" align="right" fixed="right">
          <template #default="{ row }: { row: ModerationDictionaryRuntimeItem }">
            <el-button link type="primary" :icon="View" @click="openDetail(row)">详情</el-button>
            <el-button link :icon="CopyDocument" @click="copyChecksum(row)">checksum</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <el-drawer v-model="detailVisible" title="词库 metadata" size="min(92vw, 32rem)">
      <div v-if="detail" class="space-y-5">
        <div class="border-l-4 border-[var(--el-color-warning)] px-4 py-3 text-[12px] leading-6 text-[var(--fsusblog-text-secondary)]">
          raw terms 默认不可见；evidence_policy=redact 时不会在管理台、toast 或日志中展示敏感词明文。
        </div>
        <dl class="grid grid-cols-1 gap-px bg-[var(--fsusblog-panel-bg-soft)]">
          <div v-for="item in detailRows" :key="item.label" class="bg-[var(--fsusblog-page-bg)] p-4">
            <dt class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ item.label }}</dt>
            <dd class="mt-2 break-all text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ item.value }}</dd>
          </div>
        </dl>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef } from 'vue'
import {
  getModerationDictionarySnapshot,
  reloadModerationDictionaries,
  type ModerationDictionaryRuntimeItem,
  type ModerationDictionaryRuntimeSnapshot
} from '@/api/authoring'
import { startMfaChallenge, verifyMfaChallenge } from '@/api/auth'
import { CopyDocument, Refresh, RefreshRight, View } from '@/fsusui/icons'
import { promptText, toast } from '@/fsusui/feedback'
import { showErrorToast } from '@/utils/errorPresentation'

const AdminSensitiveAction = 'admin-sensitive'

const loading = shallowRef(false)
const reloading = shallowRef(false)
const snapshot = shallowRef<ModerationDictionaryRuntimeSnapshot | null>(null)
const detail = shallowRef<ModerationDictionaryRuntimeItem | null>(null)
const detailVisible = shallowRef(false)

const filters = reactive({
  scope: '',
  dictionaryId: '',
  region: '',
  category: '',
  status: '',
  highRiskOnly: false
})

const dictionaries = computed(() => snapshot.value?.dictionaries ?? [])
const regionOptions = computed(() => [...new Set(dictionaries.value.map((item) => item.region ?? 'GLOBAL'))].sort())
const categoryOptions = computed(() => [...new Set(dictionaries.value.map((item) => item.category))].sort())

const highRiskCategories = new Set([
  'political_sensitive',
  'pornographic',
  'sexual_explicit',
  'national_security_risk',
  'public_order_risk',
  'terrorism_extremism',
  'violence_extreme'
])

const isHighRisk = (item: ModerationDictionaryRuntimeItem): boolean =>
  item.evidencePolicy === 'redact'
  || item.region === 'CN-MAINLAND'
  || highRiskCategories.has(item.category)

const dictionaryStatus = (item: ModerationDictionaryRuntimeItem): string =>
  item.termCount > 0 && item.checksum.length > 0 ? 'loaded' : 'invalid'

const dictionaryStatusType = (item: ModerationDictionaryRuntimeItem): 'success' | 'danger' =>
  dictionaryStatus(item) === 'loaded' ? 'success' : 'danger'

const evidenceType = (policy: string): 'success' | 'warning' | 'danger' | 'info' => {
  if (policy === 'redact') return 'danger'
  if (policy === 'show_category_only') return 'warning'
  if (policy === 'show_full') return 'success'
  return 'info'
}

const filteredDictionaries = computed(() => dictionaries.value.filter((item) => {
  if (filters.scope && item.scope !== filters.scope) return false
  if (filters.dictionaryId && !item.dictionaryId.includes(filters.dictionaryId.trim())) return false
  if (filters.region && (item.region ?? 'GLOBAL') !== filters.region) return false
  if (filters.category && item.category !== filters.category) return false
  if (filters.status && dictionaryStatus(item) !== filters.status.trim()) return false
  if (filters.highRiskOnly && !isHighRisk(item)) return false
  return true
}))

const detailRows = computed(() => {
  if (!detail.value) return []
  const item = detail.value
  return [
    { label: 'Dictionary ID', value: item.dictionaryId },
    { label: 'Scope', value: item.scope },
    { label: 'Region', value: item.region ?? 'GLOBAL' },
    { label: 'Category', value: item.category },
    { label: 'Version', value: item.version },
    { label: 'Checksum', value: item.checksum },
    { label: 'Term Count', value: String(item.termCount) },
    { label: 'Source', value: item.source },
    { label: 'Reviewed By', value: item.reviewedBy },
    { label: 'Updated At', value: formatTime(item.updatedAtUtc) },
    { label: 'Evidence Policy', value: item.evidencePolicy },
    { label: 'Raw Terms', value: 'redacted' }
  ]
})

const loadSnapshot = async (): Promise<void> => {
  loading.value = true
  try {
    snapshot.value = await getModerationDictionarySnapshot()
  } catch (error) {
    showErrorToast(error, '词库 metadata 加载失败')
  } finally {
    loading.value = false
  }
}

const ensureAdminSensitiveProof = async (): Promise<string> => {
  const challenge = await startMfaChallenge(AdminSensitiveAction)
  if (challenge.verified && challenge.proofToken) {
    return challenge.proofToken
  }

  const challengeToken = challenge.proofToken
  if (!challengeToken) {
    throw new Error('MFA_CHALLENGE_REQUIRED')
  }

  const code = await promptText('输入 MFA 验证码或恢复码', '词库 reload 验证', {
    confirmButtonText: '确认',
    cancelButtonText: '取消',
    inputPlaceholder: '验证码或恢复码',
    inputValidator: (value: string) => value.trim().length > 0 || '请输入验证码或恢复码'
  })
  if (!code) {
    throw new Error('MFA_CHALLENGE_CANCELLED')
  }

  const proof = await verifyMfaChallenge({
    challengeToken,
    code,
    action: AdminSensitiveAction
  })
  if (!proof.verified || !proof.proofToken) {
    throw new Error('MFA_PROOF_REQUIRED')
  }

  return proof.proofToken
}

const reloadSnapshot = async (): Promise<void> => {
  reloading.value = true
  try {
    const mfaProofToken = await ensureAdminSensitiveProof()
    const result = await reloadModerationDictionaries({ mfaProofToken })
    toast.success(`词库已重载 ${result.snapshotId}`)
    await loadSnapshot()
  } catch (error) {
    showErrorToast(error, '词库 reload 失败')
  } finally {
    reloading.value = false
  }
}

const openDetail = (item: ModerationDictionaryRuntimeItem): void => {
  detail.value = item
  detailVisible.value = true
}

const copyChecksum = async (item: ModerationDictionaryRuntimeItem): Promise<void> => {
  await navigator.clipboard?.writeText(item.checksum)
  toast.success('checksum 已复制')
}

function formatTime(value: string): string {
  return value ? new Date(value).toLocaleString() : '-'
}

onMounted(() => {
  void loadSnapshot()
})
</script>
