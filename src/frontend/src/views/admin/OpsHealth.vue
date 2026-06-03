<template>
  <div class="account-page ops-health-page account-motion-enter w-full">
    <AccountPageHeader
      eyebrow="管理 / OPS"
      title="运维健康"
      description="查看核心依赖、后台 worker、备份状态与队列积压。"
      compact
    />

    <WorkbenchPanel
      class="mb-8"
      eyebrow="运行时 / RUNTIME"
      title="站点状态"
      :caption="health ? `checked ${formatTime(health.checkedAt)}` : ''"
      title-id="ops-runtime-title"
    >
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="loadHealth">刷新</el-button>
      </template>

      <div v-if="health" class="grid gap-4 md:grid-cols-4">
        <div class="ops-kv">
          <span>状态</span>
          <el-tag :type="statusType(health.status)">{{ health.status }}</el-tag>
        </div>
        <div class="ops-kv">
          <span>环境</span>
          <strong>{{ health.environment }}</strong>
        </div>
        <div class="ops-kv">
          <span>commit</span>
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
        <WorkbenchPanel title="核心服务" eyebrow="SERVICES" title-id="ops-services-title">
          <el-table v-loading="loading" :data="health?.services ?? []" row-key="key">
            <el-table-column label="服务" min-width="160">
              <template #default="{ row }: { row: AdminServiceStatusResponse }">
                <div class="font-semibold text-[var(--fsusblog-text-primary)]">{{ row.label }}</div>
                <div class="text-[11px] text-[var(--fsusblog-text-muted)]">{{ row.key }}</div>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="130">
              <template #default="{ row }: { row: AdminServiceStatusResponse }">
                <el-tag :type="statusType(row.status)">{{ row.status }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="更新时间" width="190">
              <template #default="{ row }: { row: AdminServiceStatusResponse }">
                {{ formatTime(row.updatedAt) }}
              </template>
            </el-table-column>
            <el-table-column label="详情" min-width="240">
              <template #default="{ row }: { row: AdminServiceStatusResponse }">
                <div class="break-all text-xs text-[var(--fsusblog-text-secondary)]">
                  {{ row.detail ?? '-' }}
                </div>
              </template>
            </el-table-column>
          </el-table>
        </WorkbenchPanel>

        <WorkbenchPanel title="后台 worker" eyebrow="WORKERS" title-id="ops-workers-title">
          <el-table v-loading="loading" :data="health?.workers ?? []" row-key="key">
            <el-table-column label="worker" min-width="200" prop="label" />
            <el-table-column label="状态" width="130">
              <template #default="{ row }: { row: AdminServiceStatusResponse }">
                <el-tag :type="statusType(row.status)">{{ row.status }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="更新时间" width="190">
              <template #default="{ row }: { row: AdminServiceStatusResponse }">
                {{ formatTime(row.updatedAt) }}
              </template>
            </el-table-column>
            <el-table-column label="详情" min-width="220" prop="detail" />
          </el-table>
        </WorkbenchPanel>
      </div>

      <div class="space-y-8">
        <WorkbenchPanel title="最近备份" eyebrow="BACKUP" title-id="ops-backup-title">
          <div class="space-y-4">
            <div class="ops-kv">
              <span>状态</span>
              <el-tag :type="statusType(health?.backup.status ?? 'unknown')">{{ health?.backup.status ?? '-' }}</el-tag>
            </div>
            <div class="break-all text-xs text-[var(--fsusblog-text-muted)]">{{ health?.backup.backupRoot ?? '-' }}</div>
            <div class="space-y-3">
              <div
                v-for="artifact in health?.backup.artifacts ?? []"
                :key="artifact.kind"
                class="border-t border-[var(--fsusblog-panel-border)] pt-3"
              >
                <div class="flex items-center justify-between gap-3">
                  <span class="text-xs font-semibold">{{ artifact.kind }}</span>
                  <el-tag :type="statusType(artifact.status)">{{ artifact.status }}</el-tag>
                </div>
                <div class="mt-1 break-all text-[11px] text-[var(--fsusblog-text-muted)]">
                  {{ artifact.path ?? artifact.detail ?? '-' }}
                </div>
              </div>
            </div>
          </div>
        </WorkbenchPanel>

        <WorkbenchPanel title="最近错误" eyebrow="ERRORS" title-id="ops-errors-title">
          <ul class="space-y-3 text-xs leading-6 text-[var(--fsusblog-text-secondary)]">
            <li v-for="error in health?.recentErrors ?? []" :key="error" class="break-all border-b border-[var(--fsusblog-panel-border)] pb-3">
              {{ error }}
            </li>
            <li v-if="!health?.recentErrors.length" class="text-[var(--fsusblog-text-muted)]">-</li>
          </ul>
        </WorkbenchPanel>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, shallowRef } from 'vue'
import {
  getOpsHealth,
  type AdminServiceStatusResponse,
  type OpsHealthResponse
} from '@/api/authoring'
import AccountPageHeader from '@/components/account/AccountPageHeader.vue'
import WorkbenchPanel from '@/components/account/WorkbenchPanel.vue'
import { Refresh } from '@/ui/fsusIcons'
import { showErrorToast } from '@/utils/errorPresentation'

const loading = shallowRef(false)
const health = shallowRef<OpsHealthResponse | null>(null)

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
  if (status === 'failed' || status === 'missing' || status === 'not_ready') return 'danger'
  if (status === 'degraded') return 'warning'
  return 'info'
}

const formatTime = (value: string | null | undefined): string => {
  if (!value) return '-'
  return new Date(value).toLocaleString()
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
</style>
