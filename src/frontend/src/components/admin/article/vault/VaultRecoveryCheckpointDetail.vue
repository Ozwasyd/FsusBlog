<template>
    <details
        class="vault-recovery-checkpoint"
        aria-label="Vault 恢复 checkpoint 记录"
    >
        <summary>Vault 恢复记录：当前状态未验证</summary>
        <p
            role="status"
            aria-live="polite"
        >当前坐标、checkpoint 历史与本地物化验证尚不可用；同步状态未知。</p>
        <p v-if="!journal">指定 checkpoint 记录尚不可用。</p>
        <p
            v-else-if="!presentation"
            role="alert"
        >恢复记录与指定站点、Vault、设备、resolution 操作、计划或 checkpoint 不匹配。</p>
        <template v-else>
            <p>以下仅展示指定 checkpoint 的记录字段；引用所指 artifacts 与记录状态是否仍然有效尚未验证。</p>
            <dl>
                <dt>站点 / Vault / 设备</dt>
                <dd class="break-all">{{ presentation.siteIdentity }} / {{ presentation.vaultIdentity }} / {{ presentation.deviceIdentity }}</dd>
                <dt>Resolution 操作 / resolution plan digest</dt>
                <dd class="break-all">{{ presentation.resolutionOperationIdentity }} / {{ presentation.planSha256 }}</dd>
                <dt>Checkpoint identity / digest</dt>
                <dd class="break-all">{{ expected.checkpoint.identity }} / {{ presentation.contentSha256 }}</dd>
                <dt>记录 state / sequence</dt>
                <dd class="break-all">{{ presentation.state }} / {{ presentation.sequence }}</dd>
            </dl>
            <dl aria-label="Checkpoint 中记录的 artifact 引用">
                <dt>Server result identity / digest</dt>
                <dd class="break-all">{{ presentation.serverResult?.identity ?? '未记录' }} / {{ presentation.serverResult?.contentSha256 ?? '未记录' }}</dd>
                <dt>Local materialization identity / digest</dt>
                <dd class="break-all">{{ presentation.localMaterialization?.identity ?? '未记录' }} / {{ presentation.localMaterialization?.contentSha256 ?? '未记录' }}</dd>
                <dt>Base commit identity / digest</dt>
                <dd class="break-all">{{ presentation.baseCommit?.identity ?? '未记录' }} / {{ presentation.baseCommit?.contentSha256 ?? '未记录' }}</dd>
            </dl>
            <p>恢复、roll-forward 与 undo 命令尚不可用。记录中的 complete、recovered 或 rolled-forward 不证明当前同步已完成。</p>
        </template>
    </details>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import {
    presentVaultRecoveryCheckpoint,
    type VaultRecoveryCheckpointDisplayScope,
    type VaultRecoveryCheckpointDocument
} from '@/services/articleVault/recoveryCheckpointPresentation';

const props = defineProps<{
    journal: VaultRecoveryCheckpointDocument | null;
    expected: VaultRecoveryCheckpointDisplayScope;
}>();
const presentation = computed(() => props.journal
    ? presentVaultRecoveryCheckpoint(props.journal, props.expected) : null);
</script>

<style scoped>
.vault-recovery-checkpoint
{
    overflow-wrap: anywhere;
}
</style>
