<template>
    <ElPopover
        :visible="visible"
        :persistent="false"
        placement="bottom-start"
        width="min(22rem, calc(100vw - 2rem))"
        role="dialog"
        title="内部链接预览"
        @update:visible="handleVisibility"
    >
        <template #reference>
            <ElButton
                text
                native-type="button"
                :disabled="targetKey === null"
                :aria-expanded="visible"
                aria-haspopup="dialog"
                data-internal-link-preview-request
                @pointerenter="requestHover"
                @focus="requestPreview('focus')"
                @click="requestPreview('action')"
                @keydown.esc.stop.prevent="dismiss('escape')"
            >预览内部链接</ElButton>
        </template>

        <section
            v-if="visible"
            class="article-internal-link-preview"
            data-internal-link-preview
            :aria-labelledby="titleId"
            :aria-busy="display?.state === 'loading'"
            @keydown.esc.stop.prevent="dismiss('escape')"
        >
            <h2
                :id="titleId"
                dir="auto"
            >{{ content?.title || '内部链接预览' }}</h2>
            <template v-if="content">
                <p dir="auto">{{ content.excerpt ?? '摘要不可用。' }}</p>
                <dl>
                    <div>
                        <dt>状态</dt>
                        <dd dir="auto">{{ content.statusText ?? '不可用' }}</dd>
                    </div>
                    <div>
                        <dt>目标章节</dt>
                        <dd dir="auto">{{ content.sectionText ?? '不可用' }}</dd>
                    </div>
                </dl>
            </template>
            <p
                v-else
                role="status"
                aria-live="polite"
            >{{ statusText }}</p>
            <div class="article-internal-link-preview__actions">
                <ElButton
                    native-type="button"
                    :disabled="!content?.openInNewTab"
                    data-internal-link-preview-open
                    @click="openTarget"
                >在新标签页打开</ElButton>
                <ElButton
                    text
                    native-type="button"
                    data-internal-link-preview-dismiss
                    @click="dismiss('action')"
                >关闭预览</ElButton>
            </div>
        </section>
    </ElPopover>
</template>

<script setup lang="ts">
import { ElButton, ElPopover } from '@ozwasyd/element-plus';
import { computed, onBeforeUnmount, shallowRef, useId, watch } from 'vue';

import type {
    ArticleInternalLinkPreviewPresentation,
    ArticleInternalLinkPreviewRequest
} from './ArticleInternalLinkPreview.types';

export type {
    ArticleInternalLinkPreviewContent,
    ArticleInternalLinkPreviewPresentation,
    ArticleInternalLinkPreviewRequest
} from './ArticleInternalLinkPreview.types';

const props = defineProps<{
    targetKey: string | null;
    request: ArticleInternalLinkPreviewRequest | null;
    /** Null clears content and withdraws an already presented token. Retry with
     * a fresh object; provide loading/ready together with the new request.
     */
    presentation: ArticleInternalLinkPreviewPresentation | null;
}>();

const emit = defineEmits<{
    request: [intent: Readonly<{ targetKey: string; trigger: 'hover' | 'focus' | 'action'; }>];
    dismiss: [intent: Readonly<{
        request: ArticleInternalLinkPreviewRequest;
        reason: 'escape' | 'action' | 'outside';
    }>];
    /** Notification after the supplied action; do not open the target again. */
    open: [request: ArticleInternalLinkPreviewRequest];
}>();

const titleId = `article-internal-link-preview-${useId()}`;
// Retain only the current displayed presentation, never hidden target content.
const display = shallowRef<ArticleInternalLinkPreviewPresentation | null>(null);
const aborted = shallowRef(false);
const dismissedRequest = shallowRef<ArticleInternalLinkPreviewRequest | null>(null);
const presentedRequest = shallowRef<ArticleInternalLinkPreviewRequest | null>(null);
const withdrawnRequest = shallowRef<ArticleInternalLinkPreviewRequest | null>(null);
let removeAbortListener: (() => void) | undefined;

const visible = computed(() =>
{
    const request = props.request;
    if (!request)
    {
        return false;
    }
    if (request.targetKey !== props.targetKey)
    {
        return false;
    }
    return !request.signal.aborted && !aborted.value && dismissedRequest.value !== request;
});
const content = computed(() => visible.value && display.value?.state === 'ready'
    ? display.value.content
    : null);
const statusText = computed(() =>
{
    switch (display.value?.state)
    {
        case 'loading': return '正在加载预览…';
        case 'error': return '预览暂时不可用。';
        case 'empty': return '暂无可用预览。';
        case 'aborted': return '预览请求已取消。';
        case 'stale': return '预览已失效，请重新请求。';
        default: return '预览不可用。';
    }
});

watch([() => props.request, () => props.targetKey], () =>
{
    removeAbortListener?.();
    display.value = null;
    aborted.value = props.request?.signal.aborted ?? false;
    const request = props.request;
    if (!request)
    {
        return;
    }
    const onAbort = () =>
    {
        aborted.value = true;
        display.value = null;
    };
    request.signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => request.signal.removeEventListener('abort', onAbort);
}, { immediate: true, flush: 'sync' });

watch([() => props.presentation, () => props.request, () => props.targetKey], () =>
{
    if (!props.presentation)
    {
        // Props arrive individually. An initially absent presentation cannot
        // revoke a new token that has never supplied a matching presentation.
        if (props.request && presentedRequest.value === props.request)
        {
            withdrawnRequest.value = props.request;
        }
        display.value = null;
        return;
    }
    if (!visible.value)
    {
        display.value = null;
        return;
    }
    // A late response cannot replace the newer currently displayed admission.
    if (props.presentation.request === props.request && withdrawnRequest.value !== props.request)
    {
        display.value = props.presentation;
        presentedRequest.value = props.request;
    }
}, { immediate: true, flush: 'sync' });

function requestPreview(trigger: 'hover' | 'focus' | 'action'): void
{
    if (props.targetKey !== null && !visible.value)
    {
        emit('request', { targetKey: props.targetKey, trigger });
    }
}

function requestHover(event: PointerEvent): void
{
    if (event.pointerType === 'mouse')
    {
        requestPreview('hover');
    }
}

function dismiss(reason: 'escape' | 'action' | 'outside'): void
{
    if (!visible.value || !props.request)
    {
        return;
    }
    const request = props.request;
    dismissedRequest.value = request;
    display.value = null;
    emit('dismiss', { request, reason });
}

function handleVisibility(nextVisible: boolean): void
{
    if (!nextVisible)
    {
        dismiss('outside');
    }
}

function openTarget(): void
{
    const action = content.value?.openInNewTab;
    const request = props.request;
    if (!action || !request || request.signal.aborted)
    {
        return;
    }
    action();
    emit('open', request);
}

onBeforeUnmount(() =>
{
    removeAbortListener?.();
    display.value = null;
});
</script>

<style scoped>
.article-internal-link-preview
{
    min-inline-size: 0;
    max-block-size: 60vh;
    overflow: auto;
    overflow-wrap: anywhere;
    color: var(--el-text-color-primary);
}

.article-internal-link-preview h2
{
    margin: 0;
    font-size: var(--el-font-size-base);
    font-weight: 600;
}

.article-internal-link-preview p,
.article-internal-link-preview dl
{
    margin-block: var(--fsus-space-3);
}

.article-internal-link-preview dl > div
{
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--fsus-space-2);
}

.article-internal-link-preview dt
{
    color: var(--el-text-color-secondary);
}

.article-internal-link-preview dd
{
    margin: 0;
}

.article-internal-link-preview__actions
{
    display: flex;
    flex-wrap: wrap;
    gap: var(--fsus-space-2);
}
</style>
