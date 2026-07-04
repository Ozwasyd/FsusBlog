<template>
  <div class="account-page integrity-proof-console account-motion-enter w-full">
    <FsusUiPageHeader
      title="Integrity Proof"
      content="查看发布证明、签名、透明日志、checkpoint 与 key 状态。"
      class="account-page-header--compact"
    />

    <FsusUiSettingsSection class="mb-8" title="查询" id="integrity-proof-query-title">
      <template #actions>
        <div class="flex flex-wrap items-center justify-end gap-2">
          <el-button :icon="Refresh" :loading="loading" @click="loadConsole">刷新</el-button>
        </div>
      </template>

      <div class="integrity-proof-console__filters">
        <el-input v-model="filters.articleId" placeholder="Article ID" aria-label="Article ID" />
        <el-input v-model="filters.articleRevisionId" placeholder="Revision ID" aria-label="Article revision ID" />
        <el-input v-model="filters.revisionNo" placeholder="Revision No" aria-label="Revision No" />
        <el-button type="primary" :icon="Search" :loading="loading" @click="loadConsole">查询</el-button>
      </div>
    </FsusUiSettingsSection>

    <FsusUiSettingsSection class="mb-8" title="状态总览" id="integrity-proof-status-title">
      <FsusUiKeyValueGrid v-if="consoleState" class="grid gap-4 md:grid-cols-4">
        <FsusUiKeyValueItem label="Proof">
          {{ consoleState.proofs.ready }} / {{ consoleState.proofs.total }}
        </FsusUiKeyValueItem>
        <FsusUiKeyValueItem label="失败">
          {{ consoleState.proofs.failed }}
        </FsusUiKeyValueItem>
        <FsusUiKeyValueItem label="透明日志" :tone="statusTone(consoleState.transparencyLog.status)">
          {{ formatStatus(consoleState.transparencyLog.status) }}
        </FsusUiKeyValueItem>
        <FsusUiKeyValueItem label="Checkpoint" :tone="statusTone(consoleState.checkpoint.status)">
          {{ formatStatus(consoleState.checkpoint.status) }}
        </FsusUiKeyValueItem>
      </FsusUiKeyValueGrid>
      <AdminInlineEmptyState
        v-else
        title="暂无 proof"
        content="加载后显示 proof、log、checkpoint 和 signing key 状态。"
      />
    </FsusUiSettingsSection>

    <section class="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
      <FsusUiSettingsSection title="最近 proof" id="integrity-proof-list-title">
        <el-table v-loading="loading" :data="consoleState?.recentProofs ?? []" row-key="proofId">
          <el-table-column label="Proof" min-width="210">
            <template #default="{ row }: { row: IntegrityAdminProofRowResponse }">
              <div class="font-semibold text-[var(--fsusblog-text-primary)]">#{{ row.proofId }} · Article {{ row.articleId }}</div>
              <div class="text-[11px] text-[var(--fsusblog-text-muted)]">revision {{ row.revisionNo }} / {{ row.articleRevisionId }}</div>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="120">
            <template #default="{ row }: { row: IntegrityAdminProofRowResponse }">
              <el-tag :type="tagType(row.proofStatus)">{{ formatStatus(row.proofStatus) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="签名" min-width="150">
            <template #default="{ row }: { row: IntegrityAdminProofRowResponse }">
              {{ formatStatus(row.signatureStatus) }}
            </template>
          </el-table-column>
          <el-table-column label="Log" width="120">
            <template #default="{ row }: { row: IntegrityAdminProofRowResponse }">
              {{ formatStatus(row.transparencyLogStatus) }}
            </template>
          </el-table-column>
          <el-table-column label="操作" width="110" align="right">
            <template #default="{ row }: { row: IntegrityAdminProofRowResponse }">
              <el-button
                link
                :disabled="!row.retryAvailable"
                :loading="retryingProofId === row.proofId"
                @click="retryProof(row)"
              >
                重试
              </el-button>
            </template>
          </el-table-column>
          <template #empty>
            <AdminInlineEmptyState title="暂无 proof" content="当前查询没有发布证明记录。" />
          </template>
        </el-table>
      </FsusUiSettingsSection>

      <div class="space-y-8">
        <FsusUiSettingsSection title="失败 / 重试中" id="integrity-proof-failed-title">
          <div v-if="consoleState?.failedOrRetryingProofs.length" class="integrity-proof-console__failed-list">
            <div
              v-for="proof in consoleState.failedOrRetryingProofs"
              :key="proof.proofId"
              class="integrity-proof-console__failed-item"
            >
              <div>
                <div class="font-semibold">#{{ proof.proofId }} · {{ formatStatus(proof.proofStatus) }}</div>
                <div class="mt-1 text-xs text-[var(--fsusblog-text-muted)]">{{ proof.failureCode || '无失败摘要' }}</div>
              </div>
              <el-button
                link
                :disabled="!proof.retryAvailable"
                :loading="retryingProofId === proof.proofId"
                @click="retryProof(proof)"
              >
                重试
              </el-button>
            </div>
          </div>
          <AdminInlineEmptyState v-else title="暂无失败 proof" content="没有 failed 或 retrying 状态记录。" />
        </FsusUiSettingsSection>

        <FsusUiSettingsSection title="Signing Keys" id="integrity-proof-keys-title">
          <div v-if="consoleState?.keyRegistry.keys.length" class="integrity-proof-console__key-list">
            <div v-for="key in consoleState.keyRegistry.keys" :key="key.keyId" class="integrity-proof-console__key-row">
              <div class="min-w-0">
                <div class="truncate font-semibold">{{ key.keyId }}</div>
                <div class="text-xs text-[var(--fsusblog-text-muted)]">{{ key.algorithm }} / v{{ key.version ?? '-' }}</div>
              </div>
              <span class="integrity-proof-console__status-dot" :data-status="key.status" />
              <span>{{ formatStatus(key.status) }}</span>
            </div>
          </div>
          <AdminInlineEmptyState v-else title="暂无 signing key" content="未配置可展示的 signing key registry。" />
        </FsusUiSettingsSection>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref, shallowRef } from 'vue'
import {
  getIntegrityAdminConsole,
  retryIntegrityProof,
  type IntegrityAdminConsoleResponse,
  type IntegrityAdminProofRowResponse
} from '@/api/integrityConsole'
import { useAdminSensitiveProof } from '@/composables/useAdminSensitiveProof'
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue'
import {
  FsusUiKeyValueGrid,
  FsusUiKeyValueItem,
  FsusUiPageHeader,
  FsusUiSettingsSection
} from '@/fsusui'
import { Refresh, Search } from '@/fsusui/icons'
import { showErrorToast } from '@/utils/errorPresentation'
import { toast } from '@/fsusui/feedback'
import { toFsusUiTagType } from '@/fsusui/primitiveAdapters'
import type { AdminStatusTone } from '@/view-contracts/adminStatus'

const loading = ref(false)
const retryingProofId = ref<number | null>(null)
const consoleState = shallowRef<IntegrityAdminConsoleResponse | null>(null)
const { ensureAdminSensitiveProof } = useAdminSensitiveProof()

const filters = reactive({
  articleId: '',
  articleRevisionId: '',
  revisionNo: ''
})

function optionalNumber(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

async function loadConsole(): Promise<void> {
  loading.value = true
  try {
    consoleState.value = await getIntegrityAdminConsole({
      articleId: optionalNumber(filters.articleId),
      articleRevisionId: optionalNumber(filters.articleRevisionId),
      revisionNo: optionalNumber(filters.revisionNo)
    })
  } catch (error) {
    showErrorToast(error)
  } finally {
    loading.value = false
  }
}

async function retryProof(row: IntegrityAdminProofRowResponse): Promise<void> {
  retryingProofId.value = row.proofId
  try {
    const proof = await ensureAdminSensitiveProof()
    await retryIntegrityProof(row.proofId, proof)
    toast.success('已提交 proof 重试')
    await loadConsole()
  } catch (error) {
    showErrorToast(error)
  } finally {
    retryingProofId.value = null
  }
}

function formatStatus(status: string): string {
  const map: Record<string, string> = {
    pending: '等待中',
    ready: '已就绪',
    failed: '失败',
    retrying: '重试中',
    superseded: '已替代',
    'not-public': '非公开',
    'chain-broken': '日志断链',
    missing: '缺失',
    stale: '过期',
    blocked: '阻塞',
    logged: '已入日志',
    'signature-valid': '签名有效',
    'signature-invalid': '签名异常',
    'signature-missing': '缺少签名',
    'key-revoked': 'key 已撤销',
    'key-compromised': 'key 已泄露',
    active: '当前',
    old: '旧 key',
    revoked: '已撤销',
    compromised: '已泄露'
  }
  return map[status] ?? status
}

function statusTone(status: string): AdminStatusTone {
  if (['ready', 'active', 'signature-valid', 'logged'].includes(status)) return 'ok'
  if (['pending', 'retrying', 'old', 'stale'].includes(status)) return 'warning'
  if (['failed', 'chain-broken', 'missing', 'blocked', 'signature-invalid', 'key-revoked', 'key-compromised', 'revoked', 'compromised'].includes(status)) return 'danger'
  return 'neutral'
}

function tagType(status: string) {
  return toFsusUiTagType(statusTone(status))
}

onMounted(() => {
  void loadConsole()
})
</script>

<style scoped>
.integrity-proof-console__filters {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.integrity-proof-console__failed-list,
.integrity-proof-console__key-list {
  display: grid;
  gap: 12px;
}

.integrity-proof-console__failed-item,
.integrity-proof-console__key-row {
  align-items: center;
  border-top: 1px solid var(--fsusblog-panel-border);
  display: flex;
  gap: 12px;
  justify-content: space-between;
  padding-top: 12px;
}

.integrity-proof-console__status-dot {
  background: var(--fsusblog-text-muted);
  border-radius: 999px;
  display: inline-block;
  height: 8px;
  width: 8px;
}

.integrity-proof-console__status-dot[data-status='active'] {
  background: var(--fsusblog-admin-status-success);
}

.integrity-proof-console__status-dot[data-status='old'] {
  background: var(--fsusblog-admin-status-warning);
}

.integrity-proof-console__status-dot[data-status='revoked'],
.integrity-proof-console__status-dot[data-status='compromised'] {
  background: var(--fsusblog-admin-status-danger);
}

@media (max-width: 900px) {
  .integrity-proof-console__filters {
    grid-template-columns: 1fr;
  }
}
</style>
