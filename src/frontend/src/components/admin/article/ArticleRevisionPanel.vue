<template>
    <section
        v-if="isEdit"
        class="article-revision-panel border-t border-[var(--fsusblog-panel-border)]"
        aria-labelledby="article-revision-title"
    >
        <header class="px-4 py-3 bg-[var(--fsusblog-page-bg-soft)] border-b border-[var(--fsusblog-panel-border)]">
            <div class="flex items-center justify-between gap-3">
                <div>
                    <div
                        id="article-revision-title"
                        class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]"
                    >修订历史</div>
                    <p
                        class="mt-1 text-xs text-[var(--fsusblog-text-tertiary)]"
                        aria-live="polite"
                    >{{ statusText }}</p>
                </div>
                <ElButton
                    circle
                    :icon="Refresh"
                    :loading="loading"
                    :disabled="loading || rollbacking"
                    aria-label="刷新修订历史"
                    @click="$emit('refresh')"
                />
            </div>
        </header>

        <div class="space-y-4 p-4 bg-[var(--fsusblog-page-bg)]">
            <p
                v-if="!loading && revisions.length === 0"
                class="text-xs text-[var(--fsusblog-text-tertiary)]"
            >
                暂无修订记录。发布或更新文章后会自动写入历史版本。
            </p>

            <div
                v-else
                class="revision-list"
                aria-label="历史版本列表"
            >
                <button
                    v-for="revision in revisions"
                    :key="revision.id"
                    type="button"
                    class="revision-row"
                    :class="{ 'revision-row--active': selectedRevision?.id === revision.id }"
                    :disabled="loading || rollbacking"
                    :aria-current="selectedRevision?.id === revision.id ? 'true' : undefined"
                    @click="$emit('select-revision', revision)"
                >
                    <span class="revision-row__main">
                        <span class="revision-row__title">版本 {{ revision.revisionNo }} · {{ revision.title }}</span>
                        <span class="revision-row__meta">
                            {{ revision.diffSummary }} · <SemanticTime :value="revision.createdAt" />
                        </span>
                    </span>
                    <span class="revision-row__actor">Admin #{{ revision.createdByAdminPrincipalId }}</span>
                </button>
            </div>

            <div
                v-if="selectedRevision"
                class="revision-compare border-t border-[var(--fsusblog-panel-border)] pt-4"
            >
                <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                        <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ selectedLabel }}</div>
                        <p class="mt-1 text-xs text-[var(--fsusblog-text-secondary)]">仅展示服务端验证的比较结果；选择精确基准后开始比较。</p>
                    </div>
                    <ElButton
                        type="primary"
                        :icon="RefreshLeft"
                        :loading="rollbacking"
                        :disabled="loading || rollbacking || !selectedRevision.packageComplete || rollbackReason.trim().length < 8"
                        aria-label="从此版本创建新版本"
                        @click="$emit('rollback', { targetStatus: rollbackStatus, reason: rollbackReason.trim() })"
                    >
                        创建回滚版本
                    </ElButton>
                </div>
                <section
                    class="revision-source-comparison"
                    aria-label="修订比较"
                >
                    <label for="revision-compare-base">基准来源</label>
                    <ElSelect
                        id="revision-compare-base"
                        v-model="sourceCompare.baseSelection.value"
                        aria-label="基准来源"
                    >
                        <ElOption
                            label="当前已保存草稿"
                            value="draft"
                            :disabled="!currentDraftKey"
                        />
                        <ElOption
                            label="当前文章修订（精确 ID）"
                            value="current"
                            :disabled="!currentRevisionId"
                        />
                        <ElOption
                            v-for="revision in revisions"
                            :key="revision.id"
                            :label="`历史版本 ${revision.revisionNo} · ${revision.createdAt}`"
                            :value="revision.id"
                        />
                    </ElSelect>
                    <p class="revision-source-note">比较来源：{{ selectedLabel }} · {{ selectedRevision.id }}；基准：{{ baseIdentityLabel }}</p>
                    <div class="revision-source-toolbar">
                        <ElButton
                            :disabled="!sourceCompare.canCompare.value || sourceCompare.status.value === 'loading'"
                            @click="sourceCompare.compare"
                        >比较正文</ElButton>
                        <ElButton
                            :aria-pressed="sourceCompare.mode.value === 0"
                            :disabled="sourceCompare.status.value === 'loading'"
                            @click="sourceCompare.setMode(0)"
                        >统一视图</ElButton>
                        <ElButton
                            :aria-pressed="sourceCompare.mode.value === 1"
                            :disabled="!canSplit || sourceCompare.status.value === 'loading'"
                            @click="sourceCompare.setMode(1)"
                        >并列视图</ElButton>
                        <ElButton
                            v-if="sourceCompare.status.value === 'loading'"
                            @click="sourceCompare.cancel"
                        >取消比较</ElButton>
                    </div>
                    <p
                        role="status"
                        aria-live="polite"
                        class="revision-source-note"
                    >{{ sourceStatusText }}</p>
                    <div
                        v-if="sourceCompare.result.value"
                        class="revision-source-toolbar"
                        aria-label="比较内容"
                    >
                        <ElButton
                            :aria-pressed="comparisonTab === 'source'"
                            @click="comparisonTab = 'source'"
                        >正文差异</ElButton>
                        <ElButton
                            :aria-pressed="comparisonTab === 'metadata'"
                            @click="comparisonTab = 'metadata'"
                        >元数据差异</ElButton>
                    </div>
                    <ArticleRevisionSourceDiffView
                        v-if="sourceCompare.result.value"
                        v-show="comparisonTab === 'source'"
                        :presentation="sourceCompare.result.value"
                        :split="canSplit && sourceCompare.mode.value === 1"
                    />
                    <div
                        v-if="sourceCompare.result.value"
                        v-show="comparisonTab === 'metadata'"
                    >
                        <ArticleRevisionMetadataDiffView
                            v-if="sourceCompare.result.value.response.metadataDiff"
                            :metadata="sourceCompare.result.value.response.metadataDiff"
                        />
                        <p
                            v-else
                            class="revision-source-note"
                        >未取得服务端元数据结果；不能判定字段未变化。</p>
                    </div>
                    <p class="revision-source-note">以下是原版本快照；字段变化以服务端元数据 receipt 为准。</p>
                </section>
                <dl class="revision-fields">
                    <div>
                        <dt>标题</dt>
                        <dd>{{ selectedRevision.title }}</dd>
                    </div>
                    <div>
                        <dt>正文</dt>
                        <dd>{{ selectedRevision.content.length }} 字符</dd>
                    </div>
                    <div>
                        <dt>标签</dt>
                        <dd>{{ selectedRevision.tagIds.length }} 个</dd>
                    </div>
                    <div>
                        <dt>版权快照</dt>
                        <dd>{{ selectedRevision.rights?.licenseType ?? '缺失（不可回滚）' }}</dd>
                    </div>
                    <div>
                        <dt>责任快照</dt>
                        <dd>{{ selectedRevision.responsibility ? `${selectedRevision.responsibility.authors.length} 位作者` : '缺失（不可回滚）' }}</dd>
                    </div>
                    <div>
                        <dt>历史发布</dt>
                        <dd>{{ selectedRevision.release ? `发布 #${selectedRevision.release.publicationNo}` : '未公开版本' }}</dd>
                    </div>
                </dl>
                <div
                    class="revision-rollback-form"
                    aria-label="回滚设置"
                >
                    <label for="revision-rollback-status">新版本状态</label>
                    <ElSelect
                        id="revision-rollback-status"
                        v-model="rollbackStatus"
                        :disabled="loading || rollbacking"
                    >
                        <ElOption
                            label="草稿"
                            :value="0"
                        />
                        <ElOption
                            label="已发布"
                            :value="2"
                        />
                        <ElOption
                            label="已归档"
                            :value="3"
                        />
                    </ElSelect>
                    <label for="revision-rollback-reason">回滚原因</label>
                    <ElInput
                        id="revision-rollback-reason"
                        v-model="rollbackReason"
                        type="textarea"
                        :csp-safe="true"
                        :rows="2"
                        maxlength="500"
                        show-word-limit
                        placeholder="说明为何需要从此历史版本创建新版本（至少 8 个字符）"
                        :disabled="loading || rollbacking"
                    />
                    <p class="revision-rollback-hint">回滚会复制所选版本的内容、版权与责任快照，并创建新的修订和发布记录；历史记录不会被修改。</p>
                </div>
            </div>
        </div>
    </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { ArticleRevisionDetailResponse, ArticleRevisionSummaryResponse } from '@/api/authoring';
import ArticleRevisionMetadataDiffView from '@/components/admin/article/ArticleRevisionMetadataDiffView.vue';
import ArticleRevisionSourceDiffView from '@/components/admin/article/ArticleRevisionSourceDiffView.vue';
import SemanticTime from '@/components/ui/SemanticTime.vue';
import { useArticleRevisionCompare } from '@/composables/useArticleRevisionCompare';
import { useMediaQuery } from '@/composables/useMediaQuery';
import { Refresh, RefreshLeft } from '@/fsusui/icons';

const props = defineProps<{
    isEdit: boolean;
    revisions: ArticleRevisionSummaryResponse[];
    selectedRevision: ArticleRevisionDetailResponse | null;
    selectedLabel: string;
    loading: boolean;
    rollbacking: boolean;
    statusText: string;
    compareText: string;
    currentRevisionId?: string | null;
    currentDraftKey?: string | null;
    currentDraftRevision?: number | null;
    currentContent?: string;
    contextIdentity?: string;
    active?: boolean;
}>();

defineEmits<{
    (e: 'refresh'): void;
    (e: 'select-revision', revision: ArticleRevisionSummaryResponse): void;
    (e: 'rollback', selection: { targetStatus: 0 | 2 | 3; reason: string; }): void;
}>();

const sourceCompare = useArticleRevisionCompare(() => ({
    articleId: props.selectedRevision?.articleId ?? null,
    compareRevisionId: props.selectedRevision?.id ?? null,
    currentRevisionId: props.currentRevisionId ?? null,
    draftKey: props.currentDraftKey ?? null,
    serverDraftRevision: props.currentDraftRevision ?? null,
    currentContent: props.currentContent ?? '',
    contextIdentity: props.contextIdentity ?? ''
}));
const comparisonTab = ref<'source' | 'metadata'>('source');
watch(() => props.active, (active) =>
{
    if (active === false && sourceCompare.status.value === 'loading')
    {
        sourceCompare.cancel();
    }
});
const canSplit = useMediaQuery('(min-width: 1366px)', false);
const baseIdentityLabel = computed(() => sourceCompare.baseSelection.value === 'draft'
    ? `已保存草稿 ${props.currentDraftKey ?? '不可用'} · server revision ${props.currentDraftRevision ?? '不可用'}`
    : sourceCompare.baseSelection.value === 'current' ? `当前修订 ${props.currentRevisionId ?? '不可用'}` : `历史修订 ${sourceCompare.baseSelection.value}`);
const sourceStatusText = computed(() => ({
    idle: '等待比较；未保存的编辑不会冒充已保存草稿。',
    loading: sourceCompare.phase.value,
    ready: sourceCompare.result.value?.response.metadataDiff?.receipt.status === 1
        ? '正文已验证；元数据仅部分可核验，缺失权威来源仍待补齐。'
        : '授权源码与服务端 receipt 已绑定；仅展示已完成结果。',
    stale: '来源或编辑上下文已变化。请保存草稿或重新选择版本，再比较。',
    cancelled: '比较已取消，未展示部分结果。',
    unavailable: '比较不可用：请检查权限、完整包、工具链和预算；未取得验证结果。'
})[sourceCompare.status.value]);
watch(canSplit, (available) =>
{
    if (!available && sourceCompare.mode.value === 1)
    {
        void sourceCompare.setMode(0);
    }
});
const rollbackStatus = ref<0 | 2 | 3>(2);
const rollbackReason = ref('');

watch(() => props.selectedRevision?.id, () =>
{
    rollbackStatus.value = 2;
    rollbackReason.value = '';
});

</script>

<style scoped>
.revision-source-comparison
 {
    min-width: 0;
    margin-block: var(--fsus-space-4);
}

.revision-source-toolbar
 {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fsus-space-2);
    margin-block: var(--fsus-space-2);
}

.revision-source-note
 {
    overflow-wrap: anywhere;
    margin-block: var(--fsus-space-2);
    color: var(--fsusblog-text-secondary);
    font-size: var(--el-font-size-small);
}

.revision-list
 {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
}

.revision-row
 {
    display: flex;
    width: 100%;
    min-width: 0;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    border: 1px solid var(--fsusblog-panel-border);
    background: var(--fsusblog-page-bg-soft);
    padding: 0.75rem;
    text-align: left;
    transition: border-color var(--fsus-motion-control-fast) var(--fsus-motion-standard),
        background-color var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}

.revision-row:hover,
.revision-row--active
 {
    border-color: var(--fsus-state-focus-border, var(--fsusblog-color-primary));
    background: var(--fsus-state-selected-bg, var(--fsusblog-page-bg));
}

.revision-row__main
 {
    min-width: 0;
}

.revision-row__title,
.revision-row__meta
 {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.revision-row__title
 {
    color: var(--fsusblog-text-primary);
    font-size: 14px;
    font-weight: 700;
}

.revision-row__meta,
.revision-row__actor
 {
    color: var(--fsusblog-text-tertiary);
    font-size: 12px;
}

.revision-fields
 {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.75rem;
    margin-top: 1rem;
}

.revision-rollback-form
 {
    display: grid;
    gap: 0.5rem;
    margin-top: 1rem;
}

.revision-rollback-form label
 {
    color: var(--fsusblog-text-secondary);
    font-size: 12px;
    font-weight: 500;
}

.revision-rollback-hint
 {
    color: var(--fsusblog-text-tertiary);
    font-size: 12px;
    line-height: 1.6;
}

.revision-fields div
 {
    min-width: 0;
}

.revision-fields dt
 {
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    font-weight: 500;
}

.revision-fields dd
 {
    overflow: hidden;
    margin: 0.25rem 0 0;
    color: var(--fsusblog-text-secondary);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
}
</style>
