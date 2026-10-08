<template>
    <section aria-label="Vault 同步计划审查">
        <p
            role="status"
            aria-live="polite"
        >
            当前计划验证与执行命令尚不可用。此审查不能确认、执行或恢复同步。
        </p>
        <p v-if="!plan">未提供 exact immutable plan；状态未知。</p>
        <template v-else-if="presentation">
            <h2>{{ presentation.directionLabel }}</h2>
            <dl>
                <dt>站点 / Vault / 设备</dt>
                <dd>{{ plan.siteIdentity }} / {{ plan.vaultIdentity }} / {{ plan.deviceIdentity }}</dd>
                <dt>计划 digest</dt>
                <dd>{{ plan.contentSha256 }}</dd>
                <dt>Root manifest digest</dt>
                <dd>{{ plan.rootManifestSha256 }}</dd>
                <dt>有效期（Unix 毫秒）</dt>
                <dd>{{ plan.createdAtUnixMs }} → {{ plan.expiresAtUnixMs }}</dd>
                <dt>计划报告状态</dt>
                <dd>{{ plan.status }}（未经 current verification）</dd>
                <dt>取消边界</dt>
                <dd>仅执行前可取消；已提交服务端记录不能在此撤销。</dd>
            </dl>
            <p>文章 {{ presentation.articleCount }} · 依赖 {{ presentation.dependencyCount }} · 冲突 {{ presentation.conflictCount }}</p>
            <ul aria-label="计划效果计数">
                <li
                    v-for="count in presentation.counts"
                    :key="count.decision"
                >{{ count.label }}：{{ count.count }}</li>
            </ul>
            <p>权限、生命周期、依赖物化与磁盘范围必须经 machine authority 重新验证；当前 DTO 不提供完整 scope 或 confirmation policy。</p>
            <p
                v-if="!presentation.orderAvailable"
                role="alert"
            >Operation order 缺失、重复或错配；不能展示可执行顺序。</p>
            <label>
                筛选 article / operation identity
                <ElInput
                    v-model="query"
                    aria-label="筛选 article 或 operation identity"
                />
            </label>
            <ol aria-label="计划条目（canonical operation order）">
                <li
                    v-for="item in visibleItems"
                    :key="item.operationIdentity"
                >
                    <p>{{ item.portableArticleIdentity }} · {{ vaultPlanDecisionLabel(item.decision) }}</p>
                    <dl>
                        <dt>Group / operation / server article</dt>
                        <dd>{{ item.groupIdentity }} / {{ item.operationIdentity }} / {{ item.serverArticleIdentity ?? '未绑定' }}</dd>
                        <dt>Base / local / server revision</dt>
                        <dd>{{ item.base.serverRevision ?? '缺失' }} / {{ item.local.serverRevision ?? '缺失' }} / {{ item.server.serverRevision ?? '缺失' }}</dd>
                        <dt>Base / local / server coordinate digest</dt>
                        <dd>{{ item.base.contentSha256 }} / {{ item.local.contentSha256 }} / {{ item.server.contentSha256 }}</dd>
                        <dt>Expected server revision / permission / lifecycle</dt>
                        <dd>{{ item.preconditions.expectedServerRevision ?? '缺失' }} / {{ item.preconditions.expectedPermissionSha256 ?? '缺失' }} / {{ item.preconditions.expectedLifecycle ?? '缺失' }}</dd>
                        <dt>依赖 operation</dt>
                        <dd>{{ item.dependsOnOperationIdentities.join(' / ') || '无' }}</dd>
                    </dl>
                </li>
            </ol>
            <ul aria-label="精确冲突原因">
                <li
                    v-for="conflict in plan.conflicts"
                    :key="`${conflict.groupIdentity}:${conflict.portableArticleIdentity}:${conflict.reasonCode}`"
                >
                    {{ conflict.groupIdentity }} / {{ conflict.portableArticleIdentity }}：{{ conflict.reasonCode }}
                    （实际 conflict/recovery 目标尚未注册）
                </li>
            </ul>
        </template>
    </section>
</template>

<script setup lang="ts">
import { ElInput } from '@ozwasyd/element-plus';
import { computed, ref } from 'vue';

import {
    filterVaultPlanItems,
    presentVaultPlan,
    vaultPlanDecisionLabel,
    type VaultPlanReviewDocument
} from '@/services/articleVault/planReview';

const props = defineProps<{ plan: VaultPlanReviewDocument | null; }>();
const query = ref('');
const presentation = computed(() => props.plan ? presentVaultPlan(props.plan) : null);
const visibleItems = computed(() => filterVaultPlanItems(presentation.value?.items ?? [], query.value));
</script>
