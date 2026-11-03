<template>
    <section aria-label="Vault 计划依赖范围">
        <p role="status">依赖范围尚未验证是否仍然有效；不能据此执行同步或发布。</p>
        <p v-if="!extension">对应的依赖计划尚不可用。</p>
        <p
            v-else-if="!presentation"
            role="alert"
        >依赖计划与当前站点、Vault、文章或操作顺序不匹配。</p>
        <template v-else>
            <p>依赖计划 digest：{{ extension.contentSha256 }}</p>
            <ol aria-label="按同步操作顺序审查依赖">
                <li
                    v-for="item in presentation.items"
                    :key="item.operationIdentity"
                >
                    <p>{{ item.portableArticleIdentity }} / {{ item.groupIdentity }} / {{ item.operationIdentity }}</p>
                    <dl>
                        <dt>来源坐标</dt>
                        <dd class="break-all">{{ item.manifest.sourceSide }}</dd>
                        <dt>Graph / relation / manifest digest</dt>
                        <dd class="break-all">{{ item.manifest.graphSha256 }} / {{ item.manifest.relationSha256 }} / {{ item.manifest.contentSha256 }}</dd>
                        <dt>依赖执行顺序引用</dt>
                        <dd class="break-all">{{ item.dependencyOrder.join(' / ') || '无' }}</dd>
                    </dl>
                    <ul aria-label="依赖类型与权限范围">
                        <li
                            v-for="(node, index) in item.manifest.nodes"
                            :key="index"
                        >
                            {{ node.kind }} · {{ node.admission.permission }} ·
                            所需权限 {{ node.admission.requiredRights }} / 已记录权限 {{ node.admission.grantedRights }} ·
                            authority digest {{ node.admission.authoritySha256 }}
                        </li>
                    </ul>
                    <ul aria-label="精确依赖边">
                        <li
                            v-for="edge in item.manifest.edges"
                            :key="`${edge.prerequisiteKey}:${edge.dependentKey}:${edge.kind}`"
                        >
                            {{ edge.prerequisiteKey }} → {{ edge.dependentKey }} · {{ edge.kind }}
                        </li>
                    </ul>
                </li>
            </ol>
        </template>
    </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { presentVaultDependencyPlan, type VaultDependencyPlanReviewDocument } from '@/services/articleVault/dependencyPlanPresentation';
import type { VaultPlanReviewDocument } from '@/services/articleVault/planReview';

const props = defineProps<{ extension: VaultDependencyPlanReviewDocument | null; plan: VaultPlanReviewDocument; }>();
const presentation = computed(() => props.extension ? presentVaultDependencyPlan(props.extension, props.plan) : null);
</script>
