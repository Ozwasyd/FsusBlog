<template>
    <section
        class="space-y-4"
        :aria-labelledby="titleId"
    >
        <h2 :id="titleId">审核 Vault 解绑与保留范围</h2>
        <p>服务端文章编辑、保存、发布和恢复仍可使用。</p>
        <section
            class="space-y-3"
            :aria-labelledby="unlinkTitleId"
        >
            <h3 :id="unlinkTitleId">断开连接</h3>
            <p>断开连接的控制范围是本次本地 agent 所持有的授权、writer lease 与 IPC 通道。不会删除本地 Markdown、服务端文章、缓存或其他运行的文件；本地控制和审计记录也会保留。</p>
            <p>以下仅为供审核的报告，回执链与当前性尚未验证。stopped、removed 或 retained-control-state 报告不证明本页面已经完成解绑或撤销。</p>
            <p
                v-if="presentation.availability === 'scope-mismatch'"
                role="status"
            >报告与预期站点、Vault、设备、agent 或会话范围不一致，已隐藏全部范围与回执详情。</p>
            <p
                v-else-if="presentation.availability === 'unavailable'"
                role="status"
            >尚无可展示的确切范围与 lifecycle 报告；不能确认解绑或撤销结果。</p>
            <template v-else>
                <dl
                    class="space-y-3"
                    aria-label="未验证的解绑报告绑定范围"
                >
                    <div
                        v-for="row in scopeRows"
                        :key="row.label"
                    >
                        <dt>{{ row.label }}</dt>
                        <dd class="break-all">{{ row.value }}</dd>
                    </div>
                </dl>
                <dl
                    class="space-y-3"
                    aria-label="未验证的解绑 lifecycle 回执详情"
                >
                    <div
                        v-for="row in presentation.rows"
                        :key="row.label"
                    >
                        <dt>{{ row.label }}</dt>
                        <dd class="break-all">{{ row.value }}</dd>
                    </div>
                </dl>
            </template>
            <p :id="unlinkUnavailableId">当前无法从此页面发起断开连接；阅读报告不会撤销授权或改变连接状态。</p>
            <ElButton
                disabled
                :aria-describedby="unlinkUnavailableId"
            >断开连接（不可用）</ElButton>
        </section>
        <section
            class="space-y-3"
            :aria-labelledby="deleteTitleId"
        >
            <h3 :id="deleteTitleId">删除本地副本</h3>
            <p>这是与断开连接分开的危险操作，必须先审核精确文件、目录与回执范围，并另行明确确认。</p>
            <p :id="deleteUnavailableId">原生条件删除与同步基线提交目前不可用；尚无可执行的精确删除范围。agent 离线、identity 错配或缺少回执时不能删除，也不能报告成功。</p>
            <ElButton
                type="danger"
                disabled
                :aria-describedby="deleteUnavailableId"
            >删除本地副本（不可用）</ElButton>
        </section>
    </section>
</template>

<script setup lang="ts">
import { ElButton } from '@ozwasyd/element-plus';
import { computed, useId } from 'vue';

import type { VaultAgentLeaseScope } from '@/services/articleVault/agentLeasePresentation';
import {
    presentVaultAgentLifecycle,
    type VaultAgentLifecycleReport
} from '@/services/articleVault/agentLifecyclePresentation';

// Native ShutdownAsync(Unlink) retains control/audit state at 5928e10ee.
// No browser-to-host bridge or native conditional-removal capability is supplied.
const props = defineProps<{
    lifecycleReport?: VaultAgentLifecycleReport | null;
    expectedScope?: VaultAgentLeaseScope | null;
}>();

const titleId = useId();
const unlinkTitleId = useId();
const deleteTitleId = useId();
const unlinkUnavailableId = useId();
const deleteUnavailableId = useId();
const presentation = computed(() => presentVaultAgentLifecycle(props.lifecycleReport ?? null, props.expectedScope ?? null));
const scopeRows = computed(() =>
{
    if (presentation.value.availability !== 'reported' || !props.lifecycleReport)
    {
        return [];
    }
    const binding = props.lifecycleReport.binding;
    return [
        { label: '报告站点 identity', value: binding.siteIdentity },
        { label: '报告 Vault identity', value: binding.vaultIdentity },
        { label: '报告设备 identity', value: binding.deviceIdentity },
        { label: '报告 agent instance identity', value: binding.agentInstanceIdentity },
        { label: '报告 Root SHA-256（不含完整路径）', value: binding.rootSha256 },
        { label: '报告 Binary SHA-256', value: binding.binarySha256 },
        { label: '报告 agent 版本', value: binding.agentVersion },
        { label: '报告协议版本', value: String(binding.protocolVersion) }
    ];
});
</script>
