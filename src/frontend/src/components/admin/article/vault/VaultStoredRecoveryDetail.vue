<template>
    <section
        class="space-y-4"
        :aria-labelledby="titleId"
    >
        <h2 :id="titleId">已保存的 proposal 与 operation checkpoint</h2>
        <p>以下是指定历史引用的只读展示，不是 recovery journal；当前同步、恢复授权和 base 状态仍未知。</p>
        <p
            v-if="!presentation"
            role="status"
        >缺少精确 proposal/checkpoint 引用或范围不一致，详情不可用。</p>
        <template v-else>
            <p>Proposal 报告状态：{{ presentation.proposalState }}（不授权继续执行）。</p>
            <dl class="space-y-3">
                <div
                    v-for="row in presentation.rows"
                    :key="row.label"
                >
                    <dt>{{ row.label }}</dt>
                    <dd class="break-all">{{ row.value }}</dd>
                </div>
            </dl>
            <ol aria-label="指定 operation 的历史 checkpoints">
                <li
                    v-for="checkpoint in presentation.checkpoints"
                    :key="checkpoint.contentSha256"
                    class="break-all"
                >
                    Sequence {{ checkpoint.sequence }}：{{ checkpoint.state }}；server commit={{ checkpoint.serverCommit }}；
                    {{ checkpoint.reasonCode ?? '无报告原因' }}；SHA-256 {{ checkpoint.contentSha256 }}；
                    server result {{ checkpoint.serverResultReference ?? '无引用' }}；
                    materialization {{ checkpoint.materializationReference ?? '无引用' }}。
                </li>
            </ol>
            <ul aria-label="Producer 报告的能力缺口">
                <li
                    v-for="(capability, index) in presentation.missingCapabilities"
                    :key="index"
                >{{ capability }}</li>
            </ul>
        </template>
        <p>历史 accepted/synced 不证明当前已同步；读取 accepted source 也不授权提交 base。当前读取与恢复命令入口尚未接入已授权 transport。</p>
    </section>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue';

import {
    presentVaultStoredRecovery,
    type VaultStoredRecoveryDisplayScope,
    type VaultStoredRecoverySnapshot,
    type VaultStoredResolutionProposal
} from '@/services/articleVault/storedRecoveryPresentation';

const props = defineProps<{
    proposal: VaultStoredResolutionProposal | null;
    snapshot: VaultStoredRecoverySnapshot | null;
    expected: VaultStoredRecoveryDisplayScope | null;
}>();
const titleId = useId();
const presentation = computed(() => presentVaultStoredRecovery(props.proposal, props.snapshot, props.expected));
</script>
