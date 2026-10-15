<template>
    <section
        class="article-quick-capture"
        aria-label="快速捕获"
        :aria-describedby="statusId"
    >
        <p class="article-quick-capture__destination">保存到收件箱，稍后整理。</p>
        <ElForm
            label-position="top"
            @submit.prevent
        >
            <ElFormItem
                label="标题"
                :for="titleId"
            >
                <ElInput
                    :id="titleId"
                    :model-value="visibleInput.title"
                    :disabled="!scopeCurrent"
                    :readonly="!editable"
                    :aria-describedby="statusId"
                    autocomplete="off"
                    @update:model-value="updateTitle"
                />
            </ElFormItem>
            <ElFormItem
                label="Markdown 正文"
                :for="bodyId"
            >
                <ElInput
                    :id="bodyId"
                    :model-value="visibleInput.markdownContent"
                    type="textarea"
                    :rows="6"
                    resize="vertical"
                    :disabled="!scopeCurrent"
                    :readonly="!editable"
                    :aria-describedby="statusId"
                    @update:model-value="updateBody"
                />
            </ElFormItem>
            <ElFormItem label="来源链接">
                <ElInput
                    type="url"
                    model-value=""
                    disabled
                    aria-label="来源链接，暂不可用"
                    :aria-describedby="optionalId"
                />
            </ElFormItem>
            <div class="article-quick-capture__template">
                <span>模板：未选择</span>
                <ElButton
                    native-type="button"
                    disabled
                    :aria-describedby="optionalId"
                >选择模板</ElButton>
            </div>
            <p
                :id="optionalId"
                class="article-quick-capture__note"
            >链接保存和模板选择暂不可用；不会抓取网页。</p>
            <p
                v-if="lowProtection"
                class="article-quick-capture__note"
                role="status"
            >未确认窗口不受本地保护。</p>
            <p
                :id="statusId"
                class="article-quick-capture__note"
                role="status"
                aria-live="polite"
                aria-atomic="true"
            >{{ statusText }}</p>
            <div
                v-if="pendingDiscovery"
                class="article-quick-capture__actions"
                aria-label="未确认捕获"
            >
                <ElButton
                    native-type="button"
                    disabled
                >恢复</ElButton>
                <ElButton
                    native-type="button"
                    disabled
                >重试</ElButton>
                <ElButton
                    native-type="button"
                    disabled
                >丢弃未确认输入</ElButton>
            </div>
            <div class="article-quick-capture__actions">
                <!-- No enable flag or success callback can bypass missing original route/context/receipt admission. -->
                <ElButton
                    type="primary"
                    native-type="button"
                    disabled
                    :aria-describedby="statusId"
                >保存到收件箱</ElButton>
                <ElButton
                    native-type="button"
                    disabled
                    :aria-describedby="statusId"
                >保存并打开</ElButton>
                <ElButton
                    native-type="button"
                    @click="requestClose"
                >{{ attempted || pendingDiscovery ? '关闭' : '取消' }}</ElButton>
            </div>
        </ElForm>
    </section>
</template>

<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';

import { FsusUiButton as ElButton } from '@/fsusui/button';
import { FsusUiForm as ElForm, FsusUiFormItem as ElFormItem, FsusUiInput as ElInput } from '@/fsusui/form';
import {
    describeArticleCaptureRequest,
    type ArticleCaptureDiscoveryResult,
    type ArticleCaptureInboxInput,
    type ArticleCaptureRecoveryScope,
    type ArticleCaptureRequestIdentity,
    type ArticleCaptureStageResult
} from '@/services/articleCaptureRecovery';

/** Unactivated product leaf over real capture/recovery input types; it cannot create, open or restore an article. */
const props = defineProps<{
    modelValue: ArticleCaptureInboxInput;
    currentScope: ArticleCaptureRecoveryScope | null;
    captureId: string | null;
    requestIdentity: ArticleCaptureRequestIdentity | null;
    stageResult: ArticleCaptureStageResult | null;
    discoveryResult: ArticleCaptureDiscoveryResult | null;
}>();

const emit = defineEmits<{
    'update:modelValue': [value: ArticleCaptureInboxInput];
    'request-close': [];
}>();

const ids = useId();
const titleId = `${ids}-title`;
const bodyId = `${ids}-body`;
const statusId = `${ids}-status`;
const optionalId = `${ids}-optional`;
const openedScope = props.currentScope === null ? null : Object.freeze({
    owner: props.currentScope.owner,
    adminPrincipalId: props.currentScope.adminPrincipalId,
    siteScope: props.currentScope.siteScope
});
const openedCaptureId = props.captureId;
const scopeRetired = ref(false);
const attempted = ref(false);

// A stage observation cannot be undone by clearing its prop; the original request stays bound.
watch(
    () => props.stageResult !== null,
    observed =>
    {
        if (observed)
        {
            attempted.value = true;
        }
    },
    { immediate: true, flush: 'sync' }
);

// Original recovery retirement is terminal. Observe it synchronously so a later result
// cannot revive this leaf's private input; only the original host can establish a new binding.
watch(
    () => (props.stageResult?.status === 'blocked' && props.stageResult.reason === 'scope-retired')
        || (props.discoveryResult?.status === 'blocked' && props.discoveryResult.reason === 'scope-retired'),
    retired =>
    {
        if (retired)
        {
            scopeRetired.value = true;
        }
    },
    { immediate: true, flush: 'sync' }
);

// A scope change hides private input; it never substitutes a different user's scope or UUID.
const scopeCurrent = computed(() => !scopeRetired.value && openedScope !== null && props.currentScope !== null
    && props.currentScope.owner === openedScope.owner
    && props.currentScope.adminPrincipalId === openedScope.adminPrincipalId
    && props.currentScope.siteScope === openedScope.siteScope
    && props.currentScope.canCreateInbox === true && props.captureId === openedCaptureId);
const blockedObservation = computed(() => props.stageResult?.status === 'blocked');
const editable = computed(() => scopeCurrent.value && !attempted.value);
const boundInput = computed<ArticleCaptureInboxInput | null>(() =>
{
    const result = props.stageResult;
    if (!scopeCurrent.value || props.currentScope === null || props.captureId === null
        || result === null || result.status === 'blocked')
    {
        return null;
    }
    try
    {
        const original = describeArticleCaptureRequest(props.currentScope.adminPrincipalId, props.captureId,
                                                       { requestId: result.request.requestId, clientRevision: result.request.clientRevision }, result.request.input);
        return original.captureId === result.request.captureId && original.inputDigest === result.request.inputDigest
            && original.requestDigest === result.request.requestDigest ? result.request.input : null;
    }
    catch
    {
        return null;
    }
});
const visibleInput = computed<ArticleCaptureInboxInput>(() =>
{
    if (!scopeCurrent.value)
    {
        return { schemaVersion: 1, title: '', markdownContent: '' };
    }
    // A blocked observation carries no request input. Keep the caller's current raw input readable;
    // it does not prove that the original recovery instance has no pinned request.
    if (blockedObservation.value || !attempted.value)
    {
        return props.modelValue;
    }
    return boundInput.value ?? { schemaVersion: 1, title: '', markdownContent: '' };
});
const inputValid = computed(() =>
{
    if (!scopeCurrent.value || props.currentScope === null || props.captureId === null || props.requestIdentity === null)
    {
        return false;
    }
    try
    {
        // Reuse the actual admitted input/digest projection; do not create a second validator or identity.
        describeArticleCaptureRequest(props.currentScope.adminPrincipalId, props.captureId,
                                      props.requestIdentity, props.modelValue);
        return true;
    }
    catch
    {
        return false;
    }
});
const lowProtection = computed(() => scopeCurrent.value && props.stageResult?.status === 'unprotected');
const pendingDiscovery = computed(() => scopeCurrent.value && props.discoveryResult?.status === 'pending'
    && props.discoveryResult.records.length > 0);
const statusText = computed(() =>
{
    if (!scopeCurrent.value)
    {
        return '当前捕获不可用，请关闭后重新进入。';
    }
    if (blockedObservation.value)
    {
        return '捕获暂不可用。当前输入仅供查看和复制；保存结果尚未确认，恢复和重试尚不可用。';
    }
    if (attempted.value && boundInput.value === null)
    {
        return '无法核对已绑定请求的输入。保存结果尚未确认；请关闭后由原捕获流程处理。';
    }
    if (attempted.value || pendingDiscovery.value)
    {
        return '保存结果尚未确认。请保留原输入；恢复和重试尚不可用。';
    }
    if (!inputValid.value && (visibleInput.value.title.length > 0 || visibleInput.value.markdownContent.length > 0))
    {
        return '标题最多 256 字符，正文最多 200000 字符；至少填写一项有效内容。';
    }
    return '输入尚未提交。保存和打开暂不可用。';
});

function updateTitle(value: string): void
{
    if (!editable.value)
    {
        return;
    }
    emit('update:modelValue', Object.freeze({ ...props.modelValue, title: value }));
}

function updateBody(value: string): void
{
    if (!editable.value)
    {
        return;
    }
    emit('update:modelValue', Object.freeze({ ...props.modelValue, markdownContent: value }));
}

// Host owns dismissal, scope retirement, actual journal cleanup and focus return.
// Closing this leaf neither cancels a server operation nor claims a receipt/zero writes.
function requestClose(): void
{
    emit('request-close');
}
</script>

<style scoped>
.article-quick-capture
 {
    min-inline-size: 0;
    color: var(--el-text-color-primary);
}

.article-quick-capture__destination
 {
    margin-block: 0 var(--fsus-space-4);
}

.article-quick-capture__template,
.article-quick-capture__actions
 {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fsus-space-2);
}

.article-quick-capture__note
 {
    margin-block: var(--fsus-space-3);
    color: var(--el-text-color-secondary);
    overflow-wrap: anywhere;
}
</style>
