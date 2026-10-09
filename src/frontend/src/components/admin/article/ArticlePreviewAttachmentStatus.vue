<template>
    <p
        role="status"
        aria-label="预览附件检查状态"
        aria-live="polite"
        aria-atomic="true"
        :aria-busy="attachmentState.status === 'checking'"
    >
        {{ statusMessages[attachmentState.status] }}
    </p>
</template>

<script setup lang="ts">
import type { ArticlePreviewAttachmentState } from '@/services/authoring/articlePreviewAttachments';

defineProps<{
    attachmentState: ArticlePreviewAttachmentState;
}>();

// Display only the canonical status. Neither private reasons nor retained
// projections establish current permission, resource availability or cleanup.
const statusMessages: Readonly<Record<ArticlePreviewAttachmentState['status'], string>> = {
    missing: '尚未连接附件校验，无法确认当前附件是否满足预览条件。请在校验可用后重新生成预览。',
    checking: '正在检查当前请求的附件与文档状态，请等待检查和预览生成完成。',
    ready: '附件已通过本次预览请求的检查。此结果仅适用于本次请求；再次生成仍需重新检查，不代表持续可用或发布许可。',
    blocked: '附件或当前文档的校验条件尚未满足，暂时无法生成预览。请确认附件处理与校验连接可用后重试。',
    stale: '之前的附件或文档检查结果已失效，无法确认当前预览条件。请重新生成预览以检查当前状态。',
    canceled: '本次检查或预览已取消，不能沿用上次检查结果。取消不代表附件清理完成；可在允许时重新生成预览。',
    failed: '本次附件检查或预览生成失败，无法确认当前预览条件。请在允许时重新生成预览。'
};
</script>
