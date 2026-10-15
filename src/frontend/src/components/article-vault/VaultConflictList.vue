<template>
    <section
        class="vault-conflict-list"
        :aria-labelledby="headingId"
        data-vault-conflict-list
    >
        <h2
            :id="headingId"
            ref="heading"
            tabindex="-1"
        >冲突审阅</h2>
        <p role="status">{{ evidence.length }} 篇文章 · 第 {{ page }} / {{ pages }} 页</p>
        <p v-if="evidence.length === 0">没有可显示的冲突。</p>
        <ol
            v-else
            class="vault-conflict-list__articles"
            :start="(page - 1) * pageSize + 1"
        >
            <li
                v-for="entry in visible"
                :key="conflictEvidenceKey(entry)"
                class="vault-conflict-list__article"
                :data-evidence-sha256="entry.contentSha256"
            >
                <template v-if="conflictEvidenceDisplayCompatible(entry, schema)">
                    <h3>文章 {{ entry.binding.portableArticleIdentity }}</h3>
                    <details>
                        <summary>三方坐标与计划引用</summary>
                        <dl class="vault-conflict-list__references">
                            <dt>操作</dt>
                            <dd>{{ entry.binding.operationIdentity }}</dd>
                            <dt>原始计划摘要</dt>
                            <dd>{{ entry.binding.planSha256 }}</dd>
                            <dt>冲突证据摘要</dt>
                            <dd>{{ entry.contentSha256 }}</dd>
                        </dl>
                        <section
                            v-for="side in sides"
                            :key="side.key"
                            :aria-label="side.label"
                        >
                            <h4>{{ side.label }}</h4>
                            <dl class="vault-conflict-list__references">
                                <dt>存在 / 已删除</dt>
                                <dd>{{ entry.binding.coordinates[side.key].present ? '是' : '否' }} / {{ entry.binding.coordinates[side.key].deleted ? '是' : '否' }}</dd>
                                <dt>服务端修订</dt>
                                <dd>{{ entry.binding.coordinates[side.key].serverRevision ?? '无' }}</dd>
                                <dt>生命周期</dt>
                                <dd>{{ entry.binding.coordinates[side.key].lifecycle ?? '无' }}</dd>
                                <dt>正文摘要</dt>
                                <dd>{{ entry.binding.coordinates[side.key].source?.sha256 ?? '无' }}</dd>
                                <dt>元数据摘要</dt>
                                <dd>{{ entry.binding.coordinates[side.key].metadataManifestSha256 ?? '无' }}</dd>
                                <dt>依赖摘要</dt>
                                <dd>{{ entry.binding.coordinates[side.key].dependencySha256 ?? '无' }}</dd>
                                <dt>权限摘要</dt>
                                <dd>{{ entry.binding.coordinates[side.key].permissionSha256 ?? '无' }}</dd>
                                <dt>坐标摘要</dt>
                                <dd>{{ entry.binding.coordinates[side.key].contentSha256 }}</dd>
                            </dl>
                        </section>
                    </details>
                    <ol class="vault-conflict-list__items">
                        <li
                            v-for="item in entry.items"
                            :key="`${entry.contentSha256}:${item.type}`"
                            :data-conflict-type="item.type"
                        >
                            <h4>{{ conflictTypeLabel(item.type, schema) }}</h4>
                            <p>{{ conflictDispositionLabel(item.disposition, schema) }}</p>
                            <p v-if="conflictAuthorityExplanation(item)">{{ conflictAuthorityExplanation(item) }}</p>
                            <details v-if="item.observation.source || item.observation.metadata">
                                <summary>影响范围与字段</summary>
                                <template v-if="item.observation.source">
                                    <template
                                        v-for="side in ['local', 'server'] as const"
                                        :key="side"
                                    >
                                        <p>{{ side === 'local' ? '本地' : '服务端' }}更改（共同基线字节范围）</p>
                                        <ul>
                                            <li
                                                v-for="(range, index) in item.observation.source[side === 'local' ? 'localChanges' : 'serverChanges'].slice(0, contextLimit)"
                                                :key="index"
                                            >[{{ range.start }}, {{ range.end }}) · {{ range.semanticNodeIdentity }}</li>
                                        </ul>
                                        <p v-if="item.observation.source[side === 'local' ? 'localChanges' : 'serverChanges'].length > contextLimit">显示前 {{ contextLimit }} 个范围；完整范围需按需审阅。</p>
                                    </template>
                                </template>
                                <ul v-if="item.observation.metadata">
                                    <li
                                        v-for="(change, index) in item.observation.metadata.changes.slice(0, contextLimit)"
                                        :key="index"
                                    >{{ change.field }} · {{ change.entityIdentity ?? '文章字段' }}</li>
                                </ul>
                                <p v-if="item.observation.metadata && item.observation.metadata.changes.length > contextLimit">显示前 {{ contextLimit }} 个字段；完整字段需按需审阅。</p>
                            </details>
                            <div
                                class="vault-conflict-list__actions"
                                role="group"
                                :aria-label="`${conflictTypeLabel(item.type, schema)}：逐项操作请求`"
                            >
                                <FsusUiButton
                                    v-for="action in item.allowedActions"
                                    :key="action"
                                    @click="requestAction(entry, item, action)"
                                >{{ conflictActionLabel(action, schema) }}</FsusUiButton>
                            </div>
                        </li>
                    </ol>
                </template>
                <p v-else>冲突证据版本或类型不兼容，请重新加载。</p>
            </li>
        </ol>
        <FsusUiPagination
            v-if="evidence.length > pageSize"
            :current-page="page"
            :page-size="pageSize"
            :total="evidence.length"
            layout="prev, pager, next"
            responsive="auto"
            aria-label="冲突文章分页"
            @update:current-page="changePage"
        />
    </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';

import { FsusUiButton } from '@/fsusui/button';
import { FsusUiPagination } from '@/fsusui/pagination';

import {
    conflictActionIntent,
    conflictActionLabel,
    conflictAuthorityExplanation,
    conflictDispositionLabel,
    conflictEvidenceDisplayCompatible,
    conflictEvidenceKey,
    conflictTypeLabel
} from './conflictEvidencePresentation';

import type {
    ConflictActionIntent,
    ConflictDisplaySchema,
    ConflictEvidencePresentation,
    ConflictItemPresentation
} from './conflictEvidencePresentation';

const props = defineProps<{
    /** Canonical host owns authorization/current binding. This component never qualifies evidence. */
    evidence: readonly ConflictEvidencePresentation[];
    /** Actual shared schema document; the host owns its canonical import. */
    schema: ConflictDisplaySchema;
}>();
const emit = defineEmits<{
    'request-action': [intent: ConflictActionIntent];
}>();
const heading = ref<HTMLElement>();
const headingId = useId();
const page = ref(1);
const pageSize = 10;
const contextLimit = 20;
const pages = computed(() => Math.max(1, Math.ceil(props.evidence.length / pageSize)));
const visible = computed(() => props.evidence.slice((page.value - 1) * pageSize, page.value * pageSize));
const sides = [
    { key: 'base', label: '共同基线' },
    { key: 'local', label: '本地' },
    { key: 'server', label: '服务端' }
] as const;

watch(() => props.evidence, () =>
{
    page.value = 1;
});
watch(pages, value =>
{
    page.value = Math.min(page.value, value);
});

async function changePage(value: number): Promise<void>
{
    page.value = Math.max(1, Math.min(value, pages.value));
    await nextTick();
    heading.value?.focus();
}

function requestAction(evidence: ConflictEvidencePresentation, item: ConflictItemPresentation, action: string): void
{
    const intent = conflictActionIntent(evidence, item, action, props.schema);
    if (intent)
    {
        emit('request-action', intent);
    }
}
</script>

<style scoped>
.vault-conflict-list__articles,
.vault-conflict-list__items
 {
    display: grid;
    gap: var(--fsus-space-4);
    padding-inline-start: var(--fsus-space-6);
}

.vault-conflict-list__article
 {
    border-block-end: 1px solid var(--el-border-color-lighter);
    padding-block-end: var(--fsus-space-4);
    min-inline-size: 0;
}

.vault-conflict-list__references
 {
    display: grid;
    gap: var(--fsus-space-1);
}

.vault-conflict-list__references dd
 {
    margin-inline-start: var(--fsus-space-4);
}

.vault-conflict-list__actions
 {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fsus-space-2);
}

.vault-conflict-list :is(h3, dd, li)
 {
    overflow-wrap: anywhere;
}
</style>
