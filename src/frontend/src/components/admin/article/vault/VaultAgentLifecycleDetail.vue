<template>
    <section
        class="space-y-4"
        :aria-labelledby="titleId"
    >
        <h2 :id="titleId">Agent lifecycle 只读报告</h2>
        <p>状态与回执链尚未验证；running、installed 或 removed 报告不证明当前运行、安装信任或解绑完成。</p>
        <p
            v-if="presentation.availability === 'scope-mismatch'"
            role="status"
        >Lifecycle 报告范围不一致，已隐藏全部报告详情。</p>
        <p
            v-else-if="presentation.availability === 'unavailable'"
            role="status"
        >缺少可展示的 lifecycle 报告，当前详情不可用。</p>
        <dl
            v-else
            class="space-y-3"
            aria-label="未验证的 agent lifecycle 报告详情"
        >
            <div
                v-for="row in presentation.rows"
                :key="row.label"
            >
                <dt>{{ row.label }}</dt>
                <dd class="break-all">{{ row.value }}</dd>
            </div>
        </dl>
        <p>原生 rescan 验证与同步状态未知；安装、更新、回滚和重连命令当前不可用。</p>
    </section>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue';

import type { VaultAgentLeaseScope } from '@/services/articleVault/agentLeasePresentation';
import {
    presentVaultAgentLifecycle,
    type VaultAgentLifecycleReport
} from '@/services/articleVault/agentLifecyclePresentation';

const props = defineProps<{
    report: VaultAgentLifecycleReport | null;
    expectedScope: VaultAgentLeaseScope | null;
}>();
const titleId = useId();
const presentation = computed(() => presentVaultAgentLifecycle(props.report, props.expectedScope));
</script>
