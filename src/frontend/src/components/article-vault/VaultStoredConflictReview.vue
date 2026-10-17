<template>
    <section
        :aria-labelledby="sectionId"
        data-vault-stored-review
    >
        <h2 :id="sectionId">指定冲突提案审阅</h2>
        <p
            v-if="loading"
            role="status"
            aria-live="polite"
        >正在读取指定引用；之前的校验结果暂不显示。</p>
        <p
            v-else-if="readFailureReason"
            role="status"
        >指定引用读取失败 · {{ readFailureReason }}</p>
        <p v-else-if="!response">尚未读取指定提案。</p>
        <p
            v-else-if="!presentation"
            role="status"
        >响应不属于当前用户、会话、站点、文章或指定引用，请重新读取。</p>
        <template v-else-if="checkRequest">
            <nav aria-label="冲突审阅位置">
                <a :href="`#${conflictId}`">查看逐项冲突</a>
                <a :href="`#${proposalId}`">查看提案与检查点</a>
            </nav>
            <section
                :id="conflictId"
                tabindex="-1"
                aria-label="指定文章的逐项冲突"
            >
                <VaultConflictList
                    v-if="presentation.currentEvidence"
                    :evidence="[presentation.currentEvidence]"
                    :schema="schema"
                    @request-action="requestAction"
                />
                <p v-else>当前证据未通过 canonical 校验；历史提案可审阅，逐项决策暂不可用。</p>
            </section>
            <section
                :id="proposalId"
                tabindex="-1"
                aria-label="指定提案与 operation 检查点"
            >
                <VaultResolutionStatus
                    :plan="presentation.proposal"
                    :schema="schema"
                    :checkpoint="null"
                    :journal="null"
                    :plan-validation="{ requested: checkRequest, result: presentation.currentValidation }"
                    :execution-admission="{ requested: checkRequest, result: presentation.executionAdmission }"
                    :history-validation="null"
                    :recovery-admission="null"
                    @request-current-check="requestRead"
                />
                <template v-if="tip">
                    <h3>指定 operation 检查点</h3>
                    <p role="status">{{ storedOperationStateLabel(tip.state) }} · sequence {{ tip.sequence }}</p>
                    <dl>
                        <dt>Operation identity / digest</dt>
                        <dd>{{ tip.operationIdentity }} / {{ tip.identitySha256 }}</dd>
                        <dt>检查点摘要</dt>
                        <dd>{{ tip.contentSha256 }}</dd>
                        <dt>服务端提交记录</dt>
                        <dd>{{ tip.serverCommit }} · {{ tip.serverResult?.reference ?? '无' }} / {{ tip.serverResult?.contentSha256 ?? '无' }}</dd>
                        <dt>本地物化 receipt 引用</dt>
                        <dd>{{ tip.materializationReceipt?.reference ?? '无' }} / {{ tip.materializationReceipt?.contentSha256 ?? '无' }}</dd>
                        <dt>取消请求记录</dt>
                        <dd>{{ tip.cancellationRequested ? '已记录请求' : '未记录请求' }}</dd>
                        <dt>原因</dt>
                        <dd>{{ tip.reasonCode ?? '无' }}</dd>
                    </dl>
                    <p>这是 operation 检查点历史，不是 recovery journal 或当前本地物化证明。服务端接受不代表当前已同步。</p>
                    <ul aria-label="Canonical reader 尚缺能力">
                        <li
                            v-for="reason in presentation.checkpoint?.missingCapabilities.slice(0, 20)"
                            :key="reason"
                        >{{ reason }}</li>
                    </ul>
                </template>
            </section>
        </template>
        <p :id="commandGapId">取消与恢复的 canonical 命令尚未发布；不会把 agent stop / unlink 当作解决操作取消或恢复。</p>
        <FsusUiButton
            disabled
            :aria-describedby="commandGapId"
        >取消解决操作</FsusUiButton>
        <FsusUiButton
            disabled
            :aria-describedby="commandGapId"
        >恢复本地状态</FsusUiButton>
        <FsusUiButton
            :disabled="loading"
            @click="requestRead"
        >读取指定提案与检查点</FsusUiButton>
        <FsusUiButton @click="emit('request-return', context, reference, requestIdentity)">返回当前工作区</FsusUiButton>
    </section>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue';

import { FsusUiButton } from '@/fsusui/button';

import { conflictActionIntent } from './conflictEvidencePresentation';
import { vaultCurrentCheckIntent } from './resolutionStatusPresentation';
import { presentStoredConflictReview, storedOperationStateLabel } from './storedConflictReviewPresentation';
import VaultConflictList from './VaultConflictList.vue';
import VaultResolutionStatus from './VaultResolutionStatus.vue';

import type { ConflictActionIntent, ConflictDisplaySchema } from './conflictEvidencePresentation';
import type { VaultReviewDisplayContext, VaultStoredReviewReference, VaultStoredReviewResponse } from './storedConflictReviewPresentation';

const props = defineProps<{
    context: VaultReviewDisplayContext;
    reference: VaultStoredReviewReference;
    response: VaultStoredReviewResponse | null;
    requestIdentity: string;
    schema: ConflictDisplaySchema;
    loading: boolean;
    readFailureReason: string | null;
}>();
const emit = defineEmits<{
    'request-read': [context: VaultReviewDisplayContext, reference: VaultStoredReviewReference, requestIdentity: string];
    'request-return': [context: VaultReviewDisplayContext, reference: VaultStoredReviewReference, requestIdentity: string];
    'request-action': [intent: ConflictActionIntent, requestIdentity: string, context: VaultReviewDisplayContext, reference: VaultStoredReviewReference];
}>();
const sectionId = useId();
const conflictId = useId();
const proposalId = useId();
const commandGapId = useId();
const presentation = computed(() => !props.loading && !props.readFailureReason && props.response
    ? presentStoredConflictReview(props.response, props.reference, props.context, props.requestIdentity) : null);
const tip = computed(() => presentation.value?.checkpoint?.checkpoints.at(-1) ?? null);
const checkRequest = computed(() => presentation.value ? vaultCurrentCheckIntent(presentation.value.proposal, null) : null);

function requestRead(): void
{
    if (!props.loading)
    {
        emit('request-read', props.context, props.reference, props.requestIdentity);
    }
}
function requestAction(intent: ConflictActionIntent): void
{
    const evidence = presentation.value?.currentEvidence;
    const item = evidence?.items.find(candidate => candidate.type === intent.type);
    const bound = evidence && item ? conflictActionIntent(evidence, item, intent.action, props.schema) : null;
    if (bound?.evidenceSha256 === intent.evidenceSha256 && bound.operationIdentity === intent.operationIdentity
        && bound.portableArticleIdentity === intent.portableArticleIdentity)
    {
        emit('request-action', bound, props.requestIdentity, props.context, props.reference);
    }
}
</script>

<style scoped>
[data-vault-stored-review] :is(dd, p, li)
 {
    overflow-wrap: anywhere;
}

[data-vault-stored-review] nav
 {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fsus-space-4);
}
</style>
