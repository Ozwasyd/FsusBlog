<template>
    <div
        class="comment-moderation-bulk-actions"
        aria-label="评论批量审核"
    >
        <p class="comment-moderation-bulk-actions__count">已选择 {{ selectedCount }} 条</p>
        <div class="comment-moderation-bulk-actions__commands">
            <ElButton
                class="comment-moderation-bulk-actions__command"
                :icon="Check"
                size="small"
                type="success"
                :disabled="disabled"
                :loading="loading"
                @click="openPreview(CommentModerationStatus.Approved)"
            >批量通过</ElButton>
            <ElButton
                class="comment-moderation-bulk-actions__command"
                :icon="Hide"
                size="small"
                :disabled="disabled"
                :loading="loading"
                @click="openPreview(CommentModerationStatus.Hidden)"
            >批量隐藏</ElButton>
            <ElButton
                class="comment-moderation-bulk-actions__command"
                :icon="Close"
                size="small"
                type="danger"
                :disabled="disabled"
                :loading="loading"
                @click="openPreview(CommentModerationStatus.Rejected)"
            >批量拒绝</ElButton>
            <ElButton
                class="comment-moderation-bulk-actions__command"
                size="small"
                :disabled="loading"
                @click="emit('clear')"
            >清空选择</ElButton>
        </div>

        <FsusDialog
            v-model="previewVisible"
            title="批量审核预演"
            width="min(92vw, 28rem)"
            :close-on-click-modal="false"
        >
            <p class="text-sm leading-6 text-[var(--fsusblog-text-secondary)]">
                将{{ previewActionText }} {{ selectedCount }} 条评论。该操作会写入审核日志。
            </p>
            <div class="comment-moderation-bulk-actions__preview-fields">
                <ElInput
                    :model-value="reason"
                    maxlength="120"
                    show-word-limit
                    placeholder="审核原因，会写入评论审核审计"
                    aria-label="评论审核原因"
                    :disabled="loading"
                    @update:model-value="emit('update:reason', String($event))"
                />
                <ElCheckbox
                    :model-value="banUsers"
                    :disabled="loading"
                    @update:model-value="emit('update:banUsers', Boolean($event))"
                >联动封禁用户</ElCheckbox>
            </div>
            <template #footer>
                <div class="grid grid-cols-2 gap-4">
                    <ElButton
                        :disabled="loading"
                        @click="previewVisible = false"
                    >返回调整</ElButton>
                    <ElButton
                        type="primary"
                        :loading="loading"
                        @click="confirmPreview"
                    >{{ previewConfirmText }}</ElButton>
                </div>
            </template>
        </FsusDialog>
    </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import { CommentModerationStatus, type CommentModerationStatus as CommentModerationStatusValue } from '@/api/authoring';
import FsusDialog from '@/components/ui/FsusDialog.vue';
import { Check, Close, Hide } from '@/fsusui/icons';

const props = defineProps<{
    selectedCount: number;
    reason: string;
    banUsers: boolean;
    loading: boolean;
}>();
const emit = defineEmits<{
    apply: [status: CommentModerationStatusValue];
    clear: [];
    'update:reason': [value: string];
    'update:banUsers': [value: boolean];
}>();
const disabled = computed(() => props.loading || props.selectedCount === 0);
const previewVisible = ref(false);
const previewStatus = ref<CommentModerationStatusValue | null>(null);
const previewActionText = computed(() =>
{
    if (previewStatus.value === CommentModerationStatus.Approved)
    {
        return '通过';
    }
    if (previewStatus.value === CommentModerationStatus.Hidden)
    {
        return '隐藏';
    }
    if (previewStatus.value === CommentModerationStatus.Rejected)
    {
        return '拒绝';
    }
    return '处理';
});
const previewConfirmText = computed(() =>
{
    if (previewStatus.value === CommentModerationStatus.Approved)
    {
        return '通过评论';
    }
    if (previewStatus.value === CommentModerationStatus.Hidden)
    {
        return '隐藏评论';
    }
    if (previewStatus.value === CommentModerationStatus.Rejected)
    {
        return '拒绝评论';
    }
    return '执行审核';
});

function openPreview(status: CommentModerationStatusValue): void
{
    previewStatus.value = status;
    previewVisible.value = true;
}

function confirmPreview(): void
{
    if (previewStatus.value === null)
    {
        return;
    }
    const status = previewStatus.value;
    previewVisible.value = false;
    emit('apply', status);
}
</script>

<style scoped>
.comment-moderation-bulk-actions
 {
    display: flex;
    width: 100%;
    min-width: 0;
    align-items: center;
    justify-content: space-between;
    gap: var(--fsus-space-2);
}

.comment-moderation-bulk-actions__count
 {
    flex: 0 0 auto;
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    font-weight: 700;
}

.comment-moderation-bulk-actions__commands
 {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: var(--fsus-space-2);
    overflow-x: auto;
}

.comment-moderation-bulk-actions__command + .comment-moderation-bulk-actions__command
 {
    margin-left: 0;
}

.comment-moderation-bulk-actions__preview-fields
 {
    display: grid;
    gap: var(--fsus-space-4);
    margin-top: var(--fsus-space-4);
}
</style>
