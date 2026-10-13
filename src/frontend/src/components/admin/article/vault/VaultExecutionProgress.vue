<template>
    <section aria-label="Vault 服务端执行回执">
        <p
            role="status"
            aria-live="polite"
        >本地物化、base 更新与 recovery checkpoint 未验证；同步状态未知。</p>
        <p v-if="!result">指定操作的回执尚不可用；不能恢复进度。</p>
        <p
            v-else-if="!presentation"
            role="alert"
        >回执与当前站点、Vault 或计划引用不匹配。</p>
        <template v-else>
            <p>以下为服务端结果记录，尚未验证是否仍然有效。</p>
            <dl>
                <dt>Result / plan reference</dt>
                <dd>{{ result.resultReference }} / {{ result.planReference }}</dd>
                <dt>服务端报告结果 / 原因</dt>
                <dd>{{ result.outcome }} / {{ result.reasonCode ?? '无' }}</dd>
                <dt>Receipt digest / 完成时间（Unix 毫秒）</dt>
                <dd>{{ result.contentSha256 }} / {{ result.completedAtUnixMs }}</dd>
            </dl>
            <p>Operation {{ presentation.operationCount }} · 已提交 group {{ presentation.committedGroupCount }} · 失败 operation {{ presentation.failedOperationCount }}</p>
            <ol aria-label="服务端 group 与 operation 回执">
                <li
                    v-for="group in result.groups"
                    :key="group.groupIdentity"
                >
                    <p>{{ group.groupIdentity }} · committed={{ group.committed }} · {{ group.reasonCode ?? '无失败原因' }}</p>
                    <ul>
                        <li
                            v-for="operation in group.operations"
                            :key="operation.operationIdentity"
                        >
                            {{ operation.portableArticleIdentity }} / {{ operation.operationIdentity }}：{{ operation.outcome }}；
                            revision {{ operation.beforeRevision ?? '缺失' }} → {{ operation.afterRevision ?? '缺失' }}；
                            {{ operation.reasonCode ?? '无失败原因' }}；digest {{ operation.contentSha256 }}
                        </li>
                    </ul>
                </li>
            </ol>
            <p>取消与恢复命令尚不可用。已提交的服务端 revision/history 保留；必须取得对应物化与恢复日志回执后继续。</p>
        </template>
    </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import {
    presentVaultServerExecution,
    type VaultServerExecutionDocument
} from '@/services/articleVault/executionProgress';

const props = defineProps<{
    result: VaultServerExecutionDocument | null;
    expected: Readonly<{ siteIdentity: string; vaultIdentity: string; planReference: string; planSha256: string; }>;
}>();
const presentation = computed(() => props.result
    ? presentVaultServerExecution(props.result, props.expected) : null);
</script>
