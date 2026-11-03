<template>
    <section
        class="space-y-4"
        :aria-labelledby="titleId"
    >
        <h2 :id="titleId">Agent lease 只读报告</h2>
        <p>此报告尚未验证当前性、原生锁所有权、安装或签名信任与 lifecycle；active lease 不代表 agent 正在运行或健康。</p>
        <p
            v-if="presentation.availability === 'scope-mismatch'"
            role="status"
        >报告与当前预期范围不一致，已隐藏全部报告详情。</p>
        <p
            v-else-if="presentation.availability === 'unavailable'"
            role="status"
        >缺少可展示的范围与 lease 报告，当前详情不可用。</p>
        <dl
            v-else
            class="space-y-3"
            aria-label="未验证的 agent lease 报告详情"
        >
            <div
                v-for="row in presentation.rows"
                :key="row.label"
            >
                <dt>{{ row.label }}</dt>
                <dd class="break-all">{{ row.value }}</dd>
            </div>
        </dl>
        <p>安装、启动、停止、更新、回滚与重连当前不可用；尚未提供可验证的 agent 生命周期结果。服务端文章编辑、保存、发布和恢复仍可使用。</p>
    </section>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue';

import {
    presentVaultAgentLease,
    type VaultAgentLeaseReport,
    type VaultAgentLeaseScope
} from '@/services/articleVault/agentLeasePresentation';

const props = defineProps<{
    report: VaultAgentLeaseReport | null;
    expectedScope: VaultAgentLeaseScope | null;
}>();

const titleId = useId();
const presentation = computed(() => presentVaultAgentLease(props.report, props.expectedScope));
</script>
