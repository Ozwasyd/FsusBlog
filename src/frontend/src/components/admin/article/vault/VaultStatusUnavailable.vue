<template>
    <details aria-label="Vault 状态与命令可用性">
        <summary>Vault：状态未知</summary>
        <p role="status">当前无法取得已验证的 Vault 状态与操作授权。</p>
        <p>服务端文章编辑、保存、发布和恢复仍可使用。Vault 本地变更是否已同步尚未验证。</p>
        <VaultAgentLifecycleDetail
            v-if="lifecycleReport"
            :report="lifecycleReport"
            :expected-scope="lifecycleScope ?? null"
        />
        <VaultAgentLeaseDetail
            v-if="leaseReport"
            :report="leaseReport"
            :expected-scope="leaseScope ?? null"
        />
        <VaultRecoveryCheckpointDetail
            v-if="recoveryJournal && recoveryScope"
            :journal="recoveryJournal"
            :expected="recoveryScope"
        />
        <VaultStoredRecoveryDetail
            v-if="storedProposal || storedSnapshot"
            :proposal="storedProposal ?? null"
            :snapshot="storedSnapshot ?? null"
            :expected="storedRecoveryScope ?? null"
        />
        <ul aria-label="尚不可用的 Vault 命令">
            <li>同步现在 / 仅拉取计划 / 仅推送计划：当前无法获取已验证同步计划。</li>
            <li>暂停 / 恢复 / 重连：尚未取得当前允许操作与授权回执。</li>
            <li>连接设置 / 解绑：尚未取得对应生命周期与撤销回执。</li>
            <li>Conflict / recovery：当前无法进入对应冲突与恢复记录。</li>
        </ul>
    </details>
</template>

<script setup lang="ts">
import VaultAgentLeaseDetail from '@/components/admin/article/vault/VaultAgentLeaseDetail.vue';
import VaultAgentLifecycleDetail from '@/components/admin/article/vault/VaultAgentLifecycleDetail.vue';
import VaultRecoveryCheckpointDetail from '@/components/admin/article/vault/VaultRecoveryCheckpointDetail.vue';
import VaultStoredRecoveryDetail from '@/components/admin/article/vault/VaultStoredRecoveryDetail.vue';
import type { VaultAgentLeaseReport, VaultAgentLeaseScope } from '@/services/articleVault/agentLeasePresentation';
import type { VaultAgentLifecycleReport } from '@/services/articleVault/agentLifecyclePresentation';
import type { VaultRecoveryCheckpointDisplayScope, VaultRecoveryCheckpointDocument } from '@/services/articleVault/recoveryCheckpointPresentation';
import type { VaultStoredRecoveryDisplayScope, VaultStoredRecoverySnapshot, VaultStoredResolutionProposal } from '@/services/articleVault/storedRecoveryPresentation';

// Supplied reports stay unverified; no connection, lifecycle or recovery state is derived here.
defineProps<{
    lifecycleReport?: VaultAgentLifecycleReport | null;
    lifecycleScope?: VaultAgentLeaseScope | null;
    leaseReport?: VaultAgentLeaseReport | null;
    leaseScope?: VaultAgentLeaseScope | null;
    recoveryJournal?: VaultRecoveryCheckpointDocument | null;
    recoveryScope?: VaultRecoveryCheckpointDisplayScope | null;
    storedProposal?: VaultStoredResolutionProposal | null;
    storedSnapshot?: VaultStoredRecoverySnapshot | null;
    storedRecoveryScope?: VaultStoredRecoveryDisplayScope | null;
}>();
</script>
