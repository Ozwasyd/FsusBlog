<template>
    <section
        class="space-y-4"
        :aria-labelledby="titleId"
    >
        <h2 :id="titleId">Vault 发布依据</h2>
        <p :id="reasonId">尚无绑定当前正式 server revision 与 Vault 证据的发布准入；当前 Vault 发布动作不可用。</p>
        <p>普通服务端写作入口仍由原 publication authority 管理。这里不执行发布，也不替代其权限、审计或命令拒绝。</p>
        <p v-if="prepublish">普通发布前检查报告：{{ prepublish.canPublish ? '报告可发布' : '报告存在阻断' }}；该结果未绑定 Vault 范围或正式当前 revision，不能授权此动作。</p>
        <p v-else>尚无普通发布前检查结果。</p>
        <ul
            v-if="prepublish"
            aria-label="普通发布前检查报告代码"
        >
            <li
                v-for="(issue, index) in issueCodes"
                :key="index"
            >{{ issue }}</li>
        </ul>
        <VaultExecutionProgress
            :result="serverResult"
            :expected="expected"
        />
        <p>历史 accepted revision 不等于当前可发布 revision；本地文件、候选结果及其他设备回执不能替代正式服务端依据。</p>
        <p>离线本身不证明可以或不可以发布。是否存在未验证本地分叉、依赖或 conflict/recovery 阻断，需要当前 machine policy 裁决。</p>
        <ElButton
            disabled
            :aria-describedby="reasonId"
        >使用 Vault 依据发布（当前不可用）</ElButton>
    </section>
</template>

<script setup lang="ts">
import { ElButton } from '@ozwasyd/element-plus';
import { computed, useId } from 'vue';

import type { PrepublishCheckResponse } from '@/api/authoring';
import VaultExecutionProgress from '@/components/admin/article/vault/VaultExecutionProgress.vue';
import type { VaultServerExecutionDocument } from '@/services/articleVault/executionProgress';

// Ordinary prepublish has only canPublish/issues; never synthesize Vault permission,
// current-revision binding, eligible state, a confirmation override or a command payload.
const props = defineProps<{
    prepublish: PrepublishCheckResponse | null;
    serverResult: VaultServerExecutionDocument | null;
    expected: Readonly<{ siteIdentity: string; vaultIdentity: string; planReference: string; planSha256: string; }>;
}>();
const titleId = useId();
const reasonId = useId();
// Private/free-form messages and extra producer fields are not projected into this scope view.
const issueCodes = computed(() => props.prepublish?.issues.map(issue =>
    /^[A-Za-z0-9_.:-]{1,128}$/u.test(issue.code) && /^[A-Za-z0-9_-]{1,32}$/u.test(issue.severity)
        ? `${issue.severity}: ${issue.code}` : '未识别的检查代码') ?? []);
</script>
