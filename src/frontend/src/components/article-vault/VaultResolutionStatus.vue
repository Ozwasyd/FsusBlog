<template>
    <section
        class="vault-resolution-status"
        :aria-labelledby="headingId"
        data-vault-resolution-status
    >
        <h2 :id="headingId">解决提案与检查点</h2>
        <p v-if="!plan">尚未加载解决提案。</p>
        <p v-else-if="!compatible">提案版本或操作不兼容，请重新加载。</p>
        <template v-else-if="plan">
            <p role="status">{{ resolutionStateLabel(plan.state) }} · {{ articleCount }} 篇文章 · {{ plan.decisions.length }} 项操作</p>
            <dl class="vault-resolution-status__references">
                <dt>解决操作</dt>
                <dd>{{ plan.resolutionOperationIdentity }}</dd>
                <dt>提案摘要</dt>
                <dd>{{ plan.contentSha256 }}</dd>
                <dt>冲突证据摘要</dt>
                <dd>{{ plan.evidenceSha256 }}</dd>
                <dt>Git 事实摘要</dt>
                <dd>{{ plan.gitFactsSha256 }}</dd>
                <dt>有效期截止（Unix 毫秒）</dt>
                <dd>{{ plan.expiresAtUnixMs }}</dd>
            </dl>
            <ol>
                <li
                    v-for="decision in plan.decisions"
                    :key="`${plan.contentSha256}:${decision.type}`"
                >
                    {{ conflictTypeLabel(decision.type, schema) }} · {{ conflictActionLabel(decision.action, schema) }}
                    <span> · {{ decision.provenance }} · {{ decision.resultCandidateSha256 ?? '无结果候选' }}</span>
                </li>
            </ol>
            <details v-if="plan.expectedOutput">
                <summary>预期服务端与本地结果引用</summary>
                <dl class="vault-resolution-status__references">
                    <dt>预期服务端修订前置</dt>
                    <dd>{{ plan.expectedOutput.expectedServerRevision ?? '无' }}</dd>
                    <dt>正文摘要</dt>
                    <dd>{{ plan.expectedOutput.sourceSha256 }}</dd>
                    <dt>元数据摘要</dt>
                    <dd>{{ plan.expectedOutput.metadataManifestSha256 }}</dd>
                    <dt>依赖摘要</dt>
                    <dd>{{ plan.expectedOutput.dependencySha256 }}</dd>
                </dl>
            </details>
            <details>
                <summary>计划绑定的三方坐标与权限、依赖引用</summary>
                <section
                    v-for="coordinate in coordinateOrder"
                    :key="coordinate.key"
                    :aria-label="coordinate.label"
                >
                    <h3>{{ coordinate.label }}</h3>
                    <dl class="vault-resolution-status__references">
                        <dt>存在 / 已删除</dt>
                        <dd>{{ plan.binding.coordinates[coordinate.key].present }} / {{ plan.binding.coordinates[coordinate.key].deleted }}</dd>
                        <dt>修订 / 生命周期</dt>
                        <dd>{{ plan.binding.coordinates[coordinate.key].serverRevision ?? '无' }} / {{ plan.binding.coordinates[coordinate.key].lifecycle ?? '无' }}</dd>
                        <dt>正文摘要</dt>
                        <dd>{{ plan.binding.coordinates[coordinate.key].source?.sha256 ?? '无' }}</dd>
                        <dt>元数据摘要</dt>
                        <dd>{{ plan.binding.coordinates[coordinate.key].metadataManifestSha256 ?? '无' }}</dd>
                        <dt>权限摘要</dt>
                        <dd>{{ plan.binding.coordinates[coordinate.key].permissionSha256 ?? '无' }}</dd>
                        <dt>依赖摘要</dt>
                        <dd>{{ plan.binding.coordinates[coordinate.key].dependencySha256 ?? '无' }}</dd>
                    </dl>
                </section>
            </details>
            <details>
                <summary>原子组与依赖约束</summary>
                <ul>
                    <li
                        v-for="group in plan.groups.slice(0, contextLimit)"
                        :key="group.groupIdentity"
                    >
                        {{ group.groupIdentity }} · {{ group.portableArticleIdentities.length }} 篇文章 · {{ group.allOrNothing ? '全部或无' : '非原子组' }}
                        <ul>
                            <li
                                v-for="(dependency, index) in group.dependencies.slice(0, contextLimit)"
                                :key="index"
                            >{{ dependency.prerequisitePortableArticleIdentity }} → {{ dependency.dependentPortableArticleIdentity }}</li>
                        </ul>
                        <p v-if="group.dependencies.length > contextLimit">显示前 {{ contextLimit }} 项依赖。</p>
                    </li>
                </ul>
                <p v-if="plan.groups.length > contextLimit">显示前 {{ contextLimit }} 个原子组。</p>
            </details>
            <dl class="vault-resolution-status__references">
                <template
                    v-for="check in checks"
                    :key="check.label"
                >
                    <dt>{{ check.label }}</dt>
                    <dd>{{ check.stale ? '校验结果不属于当前引用' : !check.result ? '尚无机器校验结果' : check.result.isValid ? '通过' : '已拒绝' }}<span v-if="check.result?.reasonCode"> · {{ check.result.reasonCode }}</span></dd>
                </template>
            </dl>
            <template v-if="matchingJournal && checkpoint">
                <h3>检查点 {{ matchingJournal.sequence }}</h3>
                <p role="status">{{ recoveryStateLabel(matchingJournal.state) }}</p>
                <dl class="vault-resolution-status__references">
                    <dt>精确检查点</dt>
                    <dd>{{ checkpoint.identity }} · {{ checkpoint.contentSha256 }}</dd>
                    <dt>前序检查点摘要</dt>
                    <dd>{{ matchingJournal.previousCheckpointSha256 ?? '无' }}</dd>
                    <dt>服务端结果引用</dt>
                    <dd>{{ matchingJournal.serverResult?.identity ?? '无' }} · {{ matchingJournal.serverResult?.contentSha256 ?? '无' }}</dd>
                    <dt>本地落盘引用</dt>
                    <dd>{{ matchingJournal.localMaterialization?.identity ?? '无' }} · {{ matchingJournal.localMaterialization?.contentSha256 ?? '无' }}</dd>
                    <dt>基线提交引用</dt>
                    <dd>{{ matchingJournal.baseCommit?.identity ?? '无' }} · {{ matchingJournal.baseCommit?.contentSha256 ?? '无' }}</dd>
                    <dt>先前 / 后续基线摘要</dt>
                    <dd>{{ matchingJournal.beforeBaseSha256 }} / {{ matchingJournal.afterBaseSha256 ?? '无' }}</dd>
                </dl>
                <details>
                    <summary>备份策略要求</summary>
                    <p>{{ matchingJournal.backupPolicy.encryptionRequired ? '要求加密' : '未要求加密' }} · 容量上限 {{ matchingJournal.backupPolicy.maxBytes }} 字节 · 删除期限 {{ matchingJournal.backupPolicy.deleteAfterUnixMs }}（Unix 毫秒）</p>
                    <p>检查点引用与策略要求不代表备份、落盘或清理已完成。</p>
                </details>
            </template>
            <p v-else-if="journal || checkpoint">操作、计划或精确检查点引用不匹配，请重新加载。</p>
            <p v-else>尚未加载精确检查点。</p>
            <FsusUiButton @click="requestCurrentCheck">重新校验当前引用</FsusUiButton>
        </template>
    </section>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue';

import { FsusUiButton } from '@/fsusui/button';

import { conflictActionLabel, conflictTypeLabel } from './conflictEvidencePresentation';
import {
    recoveryDisplayMatches, recoveryStateLabel, resolutionDisplayCompatible,
    resolutionStateLabel, validationDisplayMatches, vaultCurrentCheckIntent
} from './resolutionStatusPresentation';

import type { ConflictDisplaySchema } from './conflictEvidencePresentation';
import type {
    RecoveryJournalPresentation, RecoveryReferencePresentation, ResolutionPlanPresentation,
    VaultBoundValidationPresentation, VaultCurrentCheckIntent
} from './resolutionStatusPresentation';

const props = defineProps<{
    plan: ResolutionPlanPresentation | null;
    schema: ConflictDisplaySchema;
    /** Exact requested checkpoint and its codec-decoded descriptor, never a latest-selected item. */
    checkpoint: RecoveryReferencePresentation | null;
    journal: RecoveryJournalPresentation | null;
    planValidation: VaultBoundValidationPresentation | null;
    historyValidation: VaultBoundValidationPresentation | null;
    executionAdmission: VaultBoundValidationPresentation | null;
    recoveryAdmission: VaultBoundValidationPresentation | null;
}>();
const emit = defineEmits<{ 'request-current-check': [intent: VaultCurrentCheckIntent]; }>();
const headingId = useId();
const contextLimit = 20;
const coordinateOrder = [
    { key: 'base', label: '共同基线' }, { key: 'local', label: '本地' }, { key: 'server', label: '服务端' }
] as const;
const compatible = computed(() => props.plan && resolutionDisplayCompatible(props.plan, props.schema));
const matchingJournal = computed(() => props.plan && props.journal && props.checkpoint
    && recoveryDisplayMatches(props.plan, props.journal, props.checkpoint) ? props.journal : null);
const articleCount = computed(() => props.plan
    ? new Set(props.plan.groups.flatMap(group => group.portableArticleIdentities)).size : 0);
const checks = computed(() => [
    { label: '当前计划校验', check: props.planValidation, includesHistory: false },
    { label: '检查点历史校验', check: props.historyValidation, includesHistory: true },
    { label: '执行准入', check: props.executionAdmission, includesHistory: false },
    { label: '恢复准入', check: props.recoveryAdmission, includesHistory: true }
].map(check => ({
    label: check.label,
    stale: !!check.check && !!props.plan
        && !validationDisplayMatches(check.check, props.plan, props.checkpoint, check.includesHistory),
    result: check.check && props.plan
        && validationDisplayMatches(check.check, props.plan, props.checkpoint, check.includesHistory)
        ? check.check.result : null
})));

function requestCurrentCheck(): void
{
    if (props.plan && compatible.value)
    {
        emit('request-current-check', vaultCurrentCheckIntent(props.plan, props.checkpoint));
    }
}
</script>

<style scoped>
.vault-resolution-status__references
 {
    display: grid;
    gap: var(--fsus-space-1);
}

.vault-resolution-status__references dd
 {
    margin-inline-start: var(--fsus-space-4);
}

.vault-resolution-status :is(dd, li, p)
 {
    overflow-wrap: anywhere;
}
</style>
