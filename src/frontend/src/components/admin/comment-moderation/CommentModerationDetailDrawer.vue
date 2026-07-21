<template>
    <ElDrawer
        :model-value="visible"
        direction="rtl"
        size="min(92vw, 34rem)"
        @update:model-value="emit('update:visible', $event)"
    >
        <template #header>
            <div
                v-if="item"
                class="min-w-0"
            >
                <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">评论详情</div>
                <div class="mt-2 truncate text-xl font-bold text-[var(--fsusblog-text-primary)]">#{{ item.id }}</div>
            </div>
        </template>

        <div
            v-if="item"
            class="space-y-8"
        >
            <section>
                <div class="flex flex-wrap items-center gap-2">
                    <span
                        class="text-xs font-medium normal-case tracking-normal"
                        :class="item.statusClass"
                    >{{ item.statusLabel }}</span>
                    <SemanticTime
                        :value="item.createTime"
                        :text="item.createTimeText"
                        class="text-xs font-medium tabular-nums text-[var(--fsusblog-text-muted)]"
                    />
                </div>
                <p class="mt-5 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--fsusblog-text-secondary)]">
                    {{ item.content }}
                </p>
                <div class="mt-5 recommendation-strip">
                    <span>{{ item.recommendedActionLabel }}</span>
                    <span>原因：{{ item.recommendedActionReason }}</span>
                </div>
            </section>

            <section class="grid grid-cols-1 gap-3 border-y border-[var(--fsusblog-panel-border)]">
                <div class="bg-[var(--fsusblog-page-bg)] p-5">
                    <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">文章</div>
                    <div class="mt-2 break-words text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ item.articleLabel }}</div>
                </div>
                <div class="bg-[var(--fsusblog-page-bg)] p-5">
                    <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">用户</div>
                    <div class="mt-2 break-words text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ item.userLabel }}</div>
                </div>
            </section>

            <section class="border-y border-[var(--fsusblog-panel-border)]">
                <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
                    <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">内容修订</div>
                </div>
                <div
                    v-if="revisionsLoading"
                    class="p-5 text-[12px] text-[var(--fsusblog-text-muted)]"
                >正在读取修订历史…</div>
                <div
                    v-else-if="revisionsError"
                    class="p-5 text-[12px] text-[var(--fsusblog-color-danger)]"
                >{{ revisionsError }}</div>
                <div
                    v-else
                    class="divide-y divide-[var(--fsusblog-panel-border)]"
                >
                    <article
                        v-for="(revision, index) in revisions"
                        :key="revision.version"
                        class="p-5"
                    >
                        <div class="flex flex-wrap items-center gap-2 text-[12px] text-[var(--fsusblog-text-muted)]">
                            <strong class="text-[var(--fsusblog-text-primary)]">v{{ revision.version }}</strong>
                            <span>{{ revision.operation }}</span>
                            <SemanticTime
                                :value="revision.createdAtUtc"
                                :text="revision.createdAtUtc"
                            />
                            <span>{{ revisionDiffSummary(index) }}</span>
                        </div>
                        <pre class="mt-3 whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed text-[var(--fsusblog-text-secondary)]">{{ revision.content }}</pre>
                    </article>
                    <div
                        v-if="revisions.length === 0"
                        class="p-5 text-[12px] text-[var(--fsusblog-text-muted)]"
                    >暂无修订记录</div>
                </div>
            </section>

            <section class="border-y border-[var(--fsusblog-panel-border)]">
                <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
                    <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">匿名治理摘要</div>
                </div>
                <div class="grid grid-cols-1 gap-3">
                    <div class="bg-[var(--fsusblog-page-bg)] p-5">
                        <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">身份与治理状态</div>
                        <div class="mt-2 break-words text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ item.authorModeLabel }} / {{ item.nullifierStatusLabel }}</div>
                        <div class="mt-2 break-words text-[12px] text-[var(--fsusblog-text-muted)]">
                            {{ item.rateClassLabel }} / {{ item.moderationRequirementLabel }}
                        </div>
                    </div>
                </div>
            </section>

            <section>
                <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">命中原因</div>
                <div class="mt-3 flex flex-wrap gap-2">
                    <ElTag
                        v-for="reason in item.hitReasonLabels"
                        :key="reason"
                        type="info"
                    >
                        {{ reason }}
                    </ElTag>
                    <ElTag
                        v-if="item.hitReasonLabels.length === 0"
                        type="info"
                    >未命中</ElTag>
                </div>
            </section>

            <section class="border-y border-[var(--fsusblog-panel-border)]">
                <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
                    <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">地区策略</div>
                </div>
                <div class="grid grid-cols-1 gap-3">
                    <div class="bg-[var(--fsusblog-page-bg)] p-5">
                        <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">提交地区</div>
                        <div class="mt-2 text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ item.regionSummary }}</div>
                        <div class="mt-2 text-[12px] font-bold text-[var(--fsusblog-text-muted)]">{{ item.regionConfidenceLabel }}</div>
                    </div>
                    <div class="bg-[var(--fsusblog-page-bg)] p-5">
                        <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">屏蔽地区</div>
                        <div class="mt-2 break-words text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ item.blockedRegionLabel }}</div>
                    </div>
                    <div class="bg-[var(--fsusblog-page-bg)] p-5">
                        <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">策略版本</div>
                        <div class="mt-2 break-words text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ item.regionPolicyLabel }}</div>
                    </div>
                    <div class="bg-[var(--fsusblog-page-bg)] p-5">
                        <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">复核状态</div>
                        <div class="mt-2 text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ item.regionReviewLabel }}</div>
                        <div class="mt-2 text-[12px] font-bold text-[var(--fsusblog-text-muted)]">可通过：{{ item.regionCanApprove ? '是' : '否' }}</div>
                        <div class="mt-2 break-words text-[12px] text-[var(--fsusblog-text-muted)]">原因：{{ item.regionDecisionReason || '--' }}</div>
                    </div>
                </div>
            </section>

            <section class="border-y border-[var(--fsusblog-panel-border)]">
                <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
                    <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">模型风险信号</div>
                    <p class="mt-2 text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">
                        模型输出仅作为风险信号；地区策略结果与人工审核状态独立决定最终动作。
                    </p>
                </div>
                <div class="grid grid-cols-1 gap-3">
                    <div class="bg-[var(--fsusblog-page-bg)] p-5">
                        <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">风险标签</div>
                        <div class="mt-2 text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ item.modelSignalLabel }}</div>
                        <div class="mt-2 text-[12px] font-bold text-[var(--fsusblog-text-muted)]">{{ item.modelConfidenceLabel }}</div>
                    </div>
                    <div class="bg-[var(--fsusblog-page-bg)] p-5">
                        <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">模型运行时</div>
                        <div class="mt-2 break-words text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ item.modelProviderLabel }}</div>
                        <div class="mt-2 text-[12px] font-bold text-[var(--fsusblog-text-muted)]">{{ item.modelSeverityLabel }}</div>
                    </div>
                    <div class="bg-[var(--fsusblog-page-bg)] p-5">
                        <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">原因</div>
                        <div class="mt-2 break-words text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ item.modelReasonLabel }}</div>
                        <div class="mt-2 break-words text-[12px] text-[var(--fsusblog-text-muted)]">
                            {{ item.modelCategoriesLabel }}
                        </div>
                        <div class="mt-2 break-words text-[12px] text-[var(--fsusblog-text-muted)]">
                            {{ item.modelProfileLabel }} / {{ item.modelStatusLabel }} / {{ item.modelLatencyLabel }}
                        </div>
                    </div>
                </div>
            </section>

            <section class="border-y border-[var(--fsusblog-panel-border)]">
                <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
                    <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">审核历史</div>
                </div>
                <div class="divide-y divide-[var(--fsusblog-panel-border)]">
                    <div
                        v-for="event in item.auditEvents"
                        :key="event"
                        class="p-5 text-[12px] font-bold text-[var(--fsusblog-text-secondary)]"
                    >
                        {{ event }}
                    </div>
                </div>
            </section>

            <section class="border-y border-[var(--fsusblog-panel-border)]">
                <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
                    <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">审计事件</div>
                </div>
                <div class="p-5 text-[12px] leading-relaxed text-[var(--fsusblog-text-secondary)]">
                    <div class="font-bold">状态：{{ item.statusLabel }}</div>
                    <div class="mt-2 break-words">原因：{{ item.reason || '--' }}</div>
                    <div class="mt-2 tabular-nums">审核人：{{ item.moderatedByAdminPrincipalId ?? '--' }}</div>
                </div>
            </section>

            <section>
                <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">审核操作</div>
                <div class="mt-4 flex flex-wrap gap-3">
                    <ElButton
                        :icon="Check"
                        type="success"
                        :disabled="!item.regionCanApprove"
                        :loading="processing"
                        @click="emit('apply', item, CommentModerationStatus.Approved)"
                    >通过评论</ElButton>
                    <ElButton
                        :icon="Hide"
                        :loading="processing"
                        @click="emit('apply', item, CommentModerationStatus.Hidden)"
                    >隐藏评论</ElButton>
                    <ElButton
                        :icon="Close"
                        type="danger"
                        :loading="processing"
                        @click="emit('apply', item, CommentModerationStatus.Rejected)"
                    >拒绝评论</ElButton>
                </div>
            </section>
        </div>
    </ElDrawer>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';

import { Check, Close, Hide } from '@/fsusui/icons';
import { CommentModerationStatus, type CommentModerationStatus as CommentModerationStatusValue } from '@/api/authoring';
import { getCommentRevisions } from '@/api/commentRevision';
import type { CommentRevisionResult } from '@/contracts/binaryApi';
import SemanticTime from '@/components/ui/SemanticTime.vue';
import type { CommentModerationViewItem } from '@/composables/useCommentModerationQueue';

const props = defineProps<{
    visible: boolean;
    item: CommentModerationViewItem | null;
    processing: boolean;
}>();

const emit = defineEmits<{
    'update:visible': [value: boolean];
    apply: [item: CommentModerationViewItem, status: CommentModerationStatusValue];
}>();

const revisions = ref<CommentRevisionResult[]>([]);
const revisionsLoading = ref(false);
const revisionsError = ref('');
let revisionRequest: AbortController | null = null;

watch(
    () => [props.visible, props.item?.id] as const,
    ([visible, commentId]) =>
    {
        revisionRequest?.abort();
        revisions.value = [];
        revisionsError.value = '';
        revisionsLoading.value = false;
        if (!visible || !commentId)
        {
            return;
        }

        const controller = new AbortController();
        revisionRequest = controller;
        revisionsLoading.value = true;
        void getCommentRevisions(commentId, { signal: controller.signal })
            .then((result) =>
            {
                if (!controller.signal.aborted)
                {
                    revisions.value = result;
                }
            })
            .catch(() =>
            {
                if (!controller.signal.aborted)
                {
                    revisionsError.value = '修订历史读取失败';
                }
            })
            .finally(() =>
            {
                if (!controller.signal.aborted)
                {
                    revisionsLoading.value = false;
                }
            });
    },
    { immediate: true }
);

function revisionDiffSummary(index: number): string
{
    const current = revisions.value[index]?.content ?? '';
    const previous = revisions.value[index + 1]?.content ?? '';
    if (!previous)
    {
        return '初始版本';
    }
    let prefix = 0;
    while (prefix < current.length && prefix < previous.length && current[prefix] === previous[prefix])
    {
        prefix += 1;
    }
    let suffix = 0;
    while (suffix < current.length - prefix && suffix < previous.length - prefix
        && current[current.length - 1 - suffix] === previous[previous.length - 1 - suffix])
    {
        suffix += 1;
    }
    const added = Math.max(0, current.length - prefix - suffix);
    const removed = Math.max(0, previous.length - prefix - suffix);
    return `+${added} / -${removed} 字符`;
}
</script>

<style scoped>
.tabular-nums
 {
    font-variant-numeric: tabular-nums;
}

.recommendation-strip
 {
    display: grid;
    gap: var(--fsus-space-1);
    border-left: 2px solid var(--fsusblog-color-primary);
    background: var(--fsusblog-page-bg-soft);
    padding: var(--fsus-space-3) var(--fsus-space-4);
    color: var(--fsusblog-text-secondary);
    font-size: 12px;
    font-weight: 700;
    line-height: 1.45;
}
</style>
