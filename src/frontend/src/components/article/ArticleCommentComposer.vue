<template>
    <div
        v-if="isLoggedIn"
        ref="composerShell"
        :class="commentDetailTokens.composer.loggedInShell"
        data-fsus-surface="reading"
    >
        <div
            v-if="replyTarget"
            class="mb-3 flex items-center justify-between border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg)] px-3 py-2 text-xs text-[var(--fsusblog-text-tertiary)]"
        >
            <span>正在回复 @{{ replyTarget.author.displayName }}</span>
            <ElButton
                link
                @click="$emit('cancel-reply')"
            >
                取消
            </ElButton>
        </div>

        <p
            v-if="!publicCommentsEnabled && !anonymousCommentsEnabled"
            class="comment-composer-feedback"
            aria-live="polite"
        >
            当前文章或讨论串已暂停新评论，已有评论仍可阅读。
        </p>

        <div class="comment-identity-panel">
            <div class="comment-identity-summary">
                <div class="comment-identity-copy">
                    <div class="comment-identity-heading">
                        <span class="comment-identity-label">评论身份</span>
                        <span
                            v-if="effectiveAnonymousCommentsEnabled"
                            class="comment-identity-badge comment-identity-badge--ready"
                        >
                            {{ anonymousStatusText }}
                        </span>
                        <span
                            v-else
                            class="comment-identity-badge comment-identity-badge--muted"
                        >
                            仅署名
                        </span>
                    </div>
                    <p
                        v-if="anonymousUnavailableMessage"
                        class="comment-identity-hint"
                    >
                        强匿名发布暂不可用，评论不会自动降级发送；你仍可明确选择公开署名。
                    </p>
                    <p
                        v-if="publicIdentityModel"
                        class="comment-identity-hint"
                    >
                        公开发布后，其他人会看到你的公开名称。
                    </p>
                    <p
                        v-else-if="effectiveAnonymousCommentsEnabled"
                        class="comment-identity-hint"
                    >
                        {{ anonymousQuotaHint }}删除或审核拒绝不会返还额度；凭据更新后按新周期重新计算。
                    </p>
                </div>
                <ElCheckbox
                    v-model="publicIdentityModel"
                    :disabled="publicIdentityDisabled"
                >
                    公开显示我的名称
                </ElCheckbox>
            </div>
        </div>

        <div
            v-if="restoredDraftVisible && localDraft"
            class="comment-composer-draft"
            aria-live="polite"
        >
            <span v-if="draftNeedsReview">
                评论策略已更新。请先审查草稿，发布身份不会自动恢复。
            </span>
            <span v-else>已恢复公开草稿{{ draftSavedAtText ? ` ${draftSavedAtText}` : '' }}</span>
            <span class="comment-composer-draft__actions">
                <ElButton
                    v-if="draftNeedsReview"
                    link
                    @click="reviewCommentDraft"
                >审查草稿</ElButton>
                <ElButton
                    link
                    @click="discardCommentDraft"
                >丢弃</ElButton>
            </span>
        </div>

        <p
            v-if="draftPrivacyBlocked"
            class="comment-composer-feedback"
            aria-live="assertive"
        >
            无法确认旧草稿已从浏览器存储清除；强匿名发布已暂停。你可以继续公开发布，或先清理站点数据。
        </p>

        <div class="comment-composer-editor">
            <div class="comment-composer-toolbar">
                <ElTabs
                    class="comment-composer-tabs"
                    :model-value="`inline-${commentComposerMode}`"
                    aria-label="评论编辑模式"
                    @update:model-value="commentComposerMode = $event === 'inline-preview' ? 'preview' : 'write'"
                >
                    <ElTabPane
                        :name="`inline-${commentComposerModeOptions[0].value}`"
                        :label="commentComposerModeOptions[0].label"
                    >
                        <ElInput
                            v-if="commentComposerMode === 'write'"
                            ref="editorInputRef"
                            v-model="contentModel"
                            :csp-safe="true"
                            type="textarea"
                            :rows="3"
                            :autosize="{ minRows: 3, maxRows: 8 }"
                            resize="none"
                            aria-label="发表评论"
                            :placeholder="placeholderText"
                            :disabled="composerInputDisabled"
                            @focus="notifyPrivacyIntent"
                            @keydown.ctrl.enter="requestSubmit"
                            @keydown.meta.enter="requestSubmit"
                        />
                    </ElTabPane>
                    <ElTabPane
                        :name="`inline-${commentComposerModeOptions[1].value}`"
                        :label="commentComposerModeOptions[1].label"
                    >
                        <div
                            v-if="commentComposerMode === 'preview'"
                            class="comment-composer-preview"
                            :class="{ 'is-empty': !contentModel.trim() }"
                        >
                            <CommentMarkdownRenderer
                                v-if="contentModel.trim()"
                                :content="contentModel"
                                :collapsible="false"
                            />
                            <span v-else>暂无内容</span>
                        </div>
                    </ElTabPane>
                </ElTabs>
                <ElButton
                    class="comment-composer-focus"
                    text
                    :disabled="composerInputDisabled"
                    @click="openFocusMode"
                >
                    扩展编辑
                </ElButton>
            </div>

            <p
                v-if="markdownFeedbackText"
                class="comment-composer-feedback"
                aria-live="polite"
            >
                {{ markdownFeedbackText }}
            </p>
            <div
                class="comment-composer-metrics"
                :class="{ 'is-warning': commentLimitWarning }"
                aria-live="polite"
            >
                <span>{{ commentCharCount }} / {{ commentPolicy.maxChars }} 字</span>
                <span>{{ commentUtf8Bytes }} / {{ commentPolicy.maxUtf8Bytes }} bytes</span>
            </div>
        </div>
        <div :class="commentDetailTokens.composer.submitWrap">
            <ElButton
                type="primary"
                @click="requestSubmit"
                :disabled="submitDisabled"
                :aria-disabled="submitDisabled"
            >
                {{ composerUi.submitBusyText }}
            </ElButton>
        </div>

        <FsusDialog
            v-model="focusModeVisible"
            class="comment-composer-focus-dialog"
            title="扩展编辑评论"
            width="min(92vw, 48rem)"
            @closed="closeFocusMode"
        >
            <div class="comment-composer-focus__body">
                <div class="comment-composer-toolbar">
                    <ElTabs
                        class="comment-composer-tabs"
                        :model-value="`focus-${commentComposerMode}`"
                        aria-label="扩展编辑模式"
                        @update:model-value="commentComposerMode = $event === 'focus-preview' ? 'preview' : 'write'"
                    >
                        <ElTabPane
                            :name="`focus-${commentComposerModeOptions[0].value}`"
                            :label="commentComposerModeOptions[0].label"
                        >
                            <ElInput
                                v-if="commentComposerMode === 'write'"
                                ref="focusEditorInputRef"
                                v-model="contentModel"
                                :csp-safe="true"
                                type="textarea"
                                :rows="12"
                                resize="none"
                                aria-label="专注撰写评论"
                                :placeholder="placeholderText"
                                :disabled="composerInputDisabled"
                                @focus="notifyPrivacyIntent"
                                @keydown.ctrl.enter="requestSubmit"
                                @keydown.meta.enter="requestSubmit"
                            />
                        </ElTabPane>
                        <ElTabPane
                            :name="`focus-${commentComposerModeOptions[1].value}`"
                            :label="commentComposerModeOptions[1].label"
                        >
                            <div
                                v-if="commentComposerMode === 'preview'"
                                class="comment-composer-preview comment-composer-focus__preview"
                                :class="{ 'is-empty': !contentModel.trim() }"
                            >
                                <CommentMarkdownRenderer
                                    v-if="contentModel.trim()"
                                    :content="contentModel"
                                    :collapsible="false"
                                />
                                <span v-else>暂无内容</span>
                            </div>
                        </ElTabPane>
                    </ElTabs>
                </div>
            </div>
            <template #footer>
                <div class="comment-composer-focus__footer">
                    <div
                        class="comment-composer-metrics"
                        :class="{ 'is-warning': commentLimitWarning }"
                    >
                        <span>{{ commentCharCount }} / {{ commentPolicy.maxChars }} 字</span>
                        <span>{{ commentUtf8Bytes }} / {{ commentPolicy.maxUtf8Bytes }} bytes</span>
                    </div>
                    <div class="comment-composer-focus__actions">
                        <ElButton
                            class="comment-composer-focus__action"
                            @click="focusModeVisible = false"
                        >收起</ElButton>
                        <ElButton
                            class="comment-composer-focus__action"
                            type="primary"
                            :disabled="submitDisabled"
                            @click="requestSubmit"
                        >
                            {{ composerUi.submitBusyText }}
                        </ElButton>
                    </div>
                </div>
            </template>
        </FsusDialog>
    </div>

    <section
        v-else
        :class="commentDetailTokens.composer.guestShell"
        data-fsus-surface="reading"
        aria-label="评论登录提示"
    >
        <span :class="commentDetailTokens.composer.guestText">{{ composerUi.guestText }}</span>
        <RouterLink
            :to="composerUi.guestLoginRoute"
            :class="commentDetailTokens.composer.guestLink"
        >
            {{ composerUi.guestActionText }}
        </RouterLink>
    </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import type { CommentAuthorMode, CommentAuthorView, CommentDisplayLanguage } from '@/api/comment';
import CommentMarkdownRenderer from '@/components/article/CommentMarkdownRenderer.vue';
import FsusDialog from '@/components/ui/FsusDialog.vue';
import {
    registerCommentPrivacyCredentialPurgeHandler,
    type CommentPrivacyCredentialPurgeReason
} from '@/privacy/commentPrivacyCredentialLifecycle';
import type { CommentPrivacyUiState } from '@/privacy/commentPrivacyTypes';
import {
    clearAllCommentDraftStorage,
    createCommentPublicDraftStorageKey,
    prepareCommentPublicDraftStorage,
    readCommentPublicDraft,
    removeCommentPublicDraft,
    writeCommentPublicDraft,
    type PersistedPublicCommentDraft
} from '@/privacy/commentPublicDraftStorage';
import {
    getCommentUtf8ByteLength,
    inspectCommentMarkdownContent,
    normalizeCommentContentPolicy,
    validateCommentContent
} from '@/utils/contentFilter';
import {
    commentDetailTokens,
    createCommentComposerUiContract
} from '@/view-contracts/commentDetail';

interface ReplyTargetView {
    id: string;
    rootId: string;
    author: CommentAuthorView;
    depth: number;
}

type CommentComposerMode = 'write' | 'preview';
interface ElInputExpose {
    focus?: () => void;
}
type CommentDraftSnapshot = PersistedPublicCommentDraft;

const props = withDefaults(defineProps<{
    modelValue: string;
    isLoggedIn: boolean;
    isBanned: boolean;
    isPowCalculating: boolean;
    isSubmitting: boolean;
    redirectPath: string;
    replyTarget: ReplyTargetView | null;
    authorMode: CommentAuthorMode;
    publicSendConfirmed: boolean;
    anonymousCommentsEnabled: boolean;
    publicCommentsEnabled: boolean;
    zkAnonymousEnabled: boolean;
    articleId: number | null;
    accountId: number | null;
    commentMaxChars: number;
    commentMaxUtf8Bytes: number;
    policySnapshotHash: string;
    privacyState: CommentPrivacyUiState;
    displayLanguage: CommentDisplayLanguage;
    anonymousScope: string;
}>(), {
    authorMode: 'zk_anonymous',
    publicSendConfirmed: false,
    anonymousCommentsEnabled: true,
    publicCommentsEnabled: true,
    zkAnonymousEnabled: false,
    articleId: null,
    accountId: null,
    commentMaxChars: 1000,
    commentMaxUtf8Bytes: 4096,
    policySnapshotHash: '',
    privacyState: 'publicOnly',
    displayLanguage: 'zh-CN',
    anonymousScope: ''
});

const emit = defineEmits<{
    (e: 'update:modelValue', value: string): void;
    (e: 'update:authorMode', value: CommentAuthorMode): void;
    (e: 'update:publicSendConfirmed', value: boolean): void;
    (e: 'update:displayLanguage', value: CommentDisplayLanguage): void;
    (e: 'submit', clientMutationId: string): void;
    (e: 'cancel-reply'): void;
    (e: 'privacy-intent'): void;
}>();

const composerShell = ref<HTMLElement | null>(null);
const editorInputRef = ref<ElInputExpose | null>(null);
const focusEditorInputRef = ref<ElInputExpose | null>(null);
const commentComposerMode = ref<CommentComposerMode>('write');
const focusModeVisible = ref(false);
const localDraft = ref<CommentDraftSnapshot | null>(null);
const restoredDraftVisible = ref(false);
const draftNeedsReview = ref(false);
const draftPrivacyBlocked = ref(false);
const draftStorageKey = ref('');
let draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
let privacyObserver: IntersectionObserver | null = null;
let commentDraftStorage: Storage | null = null;
let commentDraftScopeId = '';
let unregisterDraftPurgeHandler: (() => void) | null = null;
let lastAccountId: number | null = null;

const commentComposerModeOptions: readonly { value: CommentComposerMode; label: string; }[] = [
    { value: 'write', label: '编写' },
    { value: 'preview', label: '预览' }
];

const contentModel = computed({
    get: () => props.modelValue,
    set: (value: string) => emit('update:modelValue', value)
});

const commentPolicy = computed(() => normalizeCommentContentPolicy({
    maxChars: props.commentMaxChars,
    maxUtf8Bytes: props.commentMaxUtf8Bytes
}));

const commentCharCount = computed(() => contentModel.value.trim().length);
const commentUtf8Bytes = computed(() => getCommentUtf8ByteLength(contentModel.value.trim()));
const commentLimitWarning = computed(() =>
    commentCharCount.value > commentPolicy.value.maxChars ||
    commentUtf8Bytes.value > commentPolicy.value.maxUtf8Bytes ||
    commentCharCount.value / commentPolicy.value.maxChars >= 0.9 ||
    commentUtf8Bytes.value / commentPolicy.value.maxUtf8Bytes >= 0.9
);

const effectiveAnonymousCommentsEnabled = computed(() => props.anonymousCommentsEnabled && props.zkAnonymousEnabled);

const anonymousStatusText = computed(() => '强匿名发布');

const anonymousQuotaHint = computed(() => props.replyTarget
    ? '每份匿名凭据在当前讨论串最多回复 3 条。'
    : '每份匿名凭据在本篇文章最多发布 1 条顶层评论。');

const anonymousUnavailableMessage = computed(() => !effectiveAnonymousCommentsEnabled.value && props.publicCommentsEnabled);

const authorModeModel = computed<CommentAuthorMode>(() =>
{
    if (props.authorMode === 'public')
    {
        return 'public';
    }
    return 'zk_anonymous';
});

const publicIdentityModel = computed({
    get: () => authorModeModel.value === 'public' && props.publicSendConfirmed,
    set: (value: boolean) =>
    {
        if (value && !props.publicCommentsEnabled)
        {
            return;
        }
        if (!value && !clearPersistedCommentDraft())
        {
            draftPrivacyBlocked.value = true;
            return;
        }
        emit('update:authorMode', value ? 'public' : 'zk_anonymous');
        emit('update:publicSendConfirmed', value);
    }
});

const publicIdentityDisabled = computed(() =>
    props.isBanned || props.isPowCalculating || props.isSubmitting || !props.publicCommentsEnabled
);

const composerUi = computed(() =>
    createCommentComposerUiContract(props.redirectPath, {
        isBanned: props.isBanned,
        isPowCalculating: props.isPowCalculating,
        isSubmitting: props.isSubmitting,
        hasContent: Boolean(contentModel.value.trim()),
        authorMode: authorModeModel.value,
        publicSendConfirmed: publicIdentityModel.value,
        anonymousCommentsEnabled: effectiveAnonymousCommentsEnabled.value,
        publicCommentsEnabled: props.publicCommentsEnabled,
        zkAnonymousEnabled: props.zkAnonymousEnabled
    })
);

const markdownInspection = computed(() => inspectCommentMarkdownContent(contentModel.value));
const markdownValidation = computed(() =>
{
    const contentValidation = validateCommentContent(contentModel.value, commentPolicy.value);
    return contentValidation.isValid ? markdownInspection.value : contentValidation;
});
const markdownFeedbackText = computed(() =>
    contentModel.value.trim() && !markdownValidation.value.isValid
        ? markdownValidation.value.message
        : ''
);

const composerInputDisabled = computed(() =>
    props.isBanned ||
    props.isPowCalculating ||
    props.isSubmitting ||
    (authorModeModel.value === 'public' && !props.publicCommentsEnabled) ||
    (authorModeModel.value === 'zk_anonymous' && !props.zkAnonymousEnabled)
);

const submitDisabled = computed(() =>
    composerUi.value.disabled ||
    !markdownValidation.value.isValid ||
    draftNeedsReview.value ||
    (authorModeModel.value === 'zk_anonymous' && draftPrivacyBlocked.value)
);

const requestSubmit = (): void =>
{
    if (!markdownValidation.value.isValid)
    {
        commentComposerMode.value = 'write';
        void focusEditorAfterSubmit();
        return;
    }
    if (!submitDisabled.value)
    {
        flushPublicCommentDraft();
        emit('submit', localDraft.value?.clientMutationId ?? createCommentMutationId());
    }
};

const focusEditorAfterSubmit = async (): Promise<void> =>
{
    await nextTick();
    editorInputRef.value?.focus?.();
};

const focusFocusModeEditor = async (): Promise<void> =>
{
    await nextTick();
    focusEditorInputRef.value?.focus?.();
};

const openFocusMode = (): void =>
{
    commentComposerMode.value = 'write';
    focusModeVisible.value = true;
    void focusFocusModeEditor();
};

const closeFocusMode = (): void =>
{
    focusModeVisible.value = false;
    void focusEditorAfterSubmit();
};

const notifyPrivacyIntent = (): void =>
{
    if (props.isLoggedIn && effectiveAnonymousCommentsEnabled.value)
    {
        emit('privacy-intent');
    }
};

onMounted(() =>
{
    unregisterDraftPurgeHandler = registerCommentPrivacyCredentialPurgeHandler(handleDraftPrivacyPurge);
    initializeCommentDraftStorage();
    if (typeof window !== 'undefined')
    {
        window.addEventListener('pagehide', flushPublicCommentDraft);
    }
    if (typeof IntersectionObserver === 'undefined')
    {
        queueMicrotask(notifyPrivacyIntent);
        return;
    }

    privacyObserver = new IntersectionObserver((entries) =>
    {
        if (entries.some((entry) => entry.isIntersecting))
        {
            notifyPrivacyIntent();
            privacyObserver?.disconnect();
            privacyObserver = null;
        }
    });
    if (composerShell.value)
    {
        privacyObserver.observe(composerShell.value);
    }
});

onBeforeUnmount(() =>
{
    if (draftSaveTimer)
    {
        clearTimeout(draftSaveTimer);
        draftSaveTimer = null;
    }
    if (typeof window !== 'undefined')
    {
        window.removeEventListener('pagehide', flushPublicCommentDraft);
    }
    unregisterDraftPurgeHandler?.();
    unregisterDraftPurgeHandler = null;
    privacyObserver?.disconnect();
    privacyObserver = null;
});

watch(() => props.isSubmitting, (isSubmitting, wasSubmitting) =>
{
    if (wasSubmitting && !isSubmitting)
    {
        commentComposerMode.value = 'write';
        void focusEditorAfterSubmit();
    }
});

const placeholderText = computed(() =>
    props.replyTarget
        ? `回复 @${props.replyTarget.author.displayName} (Ctrl + Enter 发送)`
        : composerUi.value.placeholder
);

const draftSavedAtText = computed(() =>
{
    const savedAt = localDraft.value?.savedAt;
    return savedAt ? new Date(savedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
});

const initializeCommentDraftStorage = (): void =>
{
    if (typeof window === 'undefined' || props.accountId === null || props.accountId <= 0)
    {
        commentDraftStorage = null;
        commentDraftScopeId = '';
        draftStorageKey.value = '';
        return;
    }

    lastAccountId = props.accountId;
    try
    {
        commentDraftStorage = window.localStorage;
    }
    catch
    {
        commentDraftStorage = null;
        commentDraftScopeId = '';
        draftStorageKey.value = '';
        return;
    }

    const preparation = prepareCommentPublicDraftStorage(commentDraftStorage);
    commentDraftScopeId = preparation.scopeId ?? '';
    draftPrivacyBlocked.value = preparation.persistenceAvailable && !preparation.cleanupComplete;
    refreshCommentDraftStorageKey();
};

const refreshCommentDraftStorageKey = (): void =>
{
    draftStorageKey.value = createCommentPublicDraftStorageKey({
        scopeId: commentDraftScopeId,
        articleId: props.articleId,
        replyId: props.replyTarget?.id ?? null
    });
    restoreCommentDraft();
};

const restoreCommentDraft = (): void =>
{
    const key = draftStorageKey.value;
    if (!key || !commentDraftStorage)
    {
        return;
    }

    const result = readCommentPublicDraft(commentDraftStorage, key);
    if (!result.cleanupComplete)
    {
        draftPrivacyBlocked.value = true;
    }
    if (!result.draft)
    {
        localDraft.value = null;
        restoredDraftVisible.value = false;
        draftNeedsReview.value = false;
        return;
    }

    localDraft.value = result.draft;
    restoredDraftVisible.value = true;
    if (result.draft.policyHash !== props.policySnapshotHash)
    {
        draftNeedsReview.value = true;
        return;
    }

    draftNeedsReview.value = false;
    if (!contentModel.value.trim())
    {
        emit('update:modelValue', result.draft.content);
        emit('update:authorMode', 'public');
        emit('update:publicSendConfirmed', true);
    }
};

const clearPersistedCommentDraft = (): boolean =>
{
    const key = draftStorageKey.value;
    if (!key || !commentDraftStorage)
    {
        localDraft.value = null;
        restoredDraftVisible.value = false;
        draftNeedsReview.value = false;
        return true;
    }

    const removed = removeCommentPublicDraft(commentDraftStorage, key);
    localDraft.value = null;
    restoredDraftVisible.value = false;
    draftNeedsReview.value = false;
    return removed;
};

const saveCommentDraft = (): void =>
{
    const key = draftStorageKey.value;
    if (!key || !commentDraftStorage || draftNeedsReview.value)
    {
        return;
    }

    const content = contentModel.value;
    if (!content.trim())
    {
        clearPersistedCommentDraft();
        return;
    }
    if (authorModeModel.value !== 'public' || !publicIdentityModel.value)
    {
        if (!clearPersistedCommentDraft())
        {
            draftPrivacyBlocked.value = true;
        }
        return;
    }

    const draft: CommentDraftSnapshot = {
        version: 3,
        content,
        savedAt: Date.now(),
        policyHash: props.policySnapshotHash,
        clientMutationId: localDraft.value?.content === content &&
            localDraft.value.policyHash === props.policySnapshotHash
            ? localDraft.value.clientMutationId
            : createCommentMutationId()
    };

    if (writeCommentPublicDraft(commentDraftStorage, key, draft))
    {
        localDraft.value = draft;
    }
};

const scheduleSaveCommentDraft = (): void =>
{
    if (draftSaveTimer)
    {
        clearTimeout(draftSaveTimer);
    }
    draftSaveTimer = setTimeout(() =>
    {
        draftSaveTimer = null;
        saveCommentDraft();
    }, 700);
};

const flushPublicCommentDraft = (): void =>
{
    if (draftSaveTimer)
    {
        clearTimeout(draftSaveTimer);
        draftSaveTimer = null;
    }
    saveCommentDraft();
};

const reviewCommentDraft = (): void =>
{
    const draft = localDraft.value;
    if (!draft)
    {
        return;
    };
    if (!clearPersistedCommentDraft())
    {
        draftPrivacyBlocked.value = true;
    }
    emit('update:modelValue', draft.content);
    emit('update:authorMode', 'zk_anonymous');
    emit('update:publicSendConfirmed', false);
    void focusEditorAfterSubmit();
};

const discardCommentDraft = (): void =>
{
    const draftContent = localDraft.value?.content ?? '';
    if (!clearPersistedCommentDraft())
    {
        draftPrivacyBlocked.value = true;
    }
    if (contentModel.value === draftContent)
    {
        emit('update:modelValue', '');
    }
    void focusEditorAfterSubmit();
};

const identityWideDraftPurgeReasons = new Set<CommentPrivacyCredentialPurgeReason>([
    'logout',
    'session-expired',
    'account-switch',
    'account-deletion',
    'panic',
    'migration-failure',
    'shared-device'
]);

const clearDraftMemory = (): void =>
{
    if (draftSaveTimer)
    {
        clearTimeout(draftSaveTimer);
        draftSaveTimer = null;
    }
    const draftContent = localDraft.value?.content ?? contentModel.value;
    localDraft.value = null;
    restoredDraftVisible.value = false;
    draftNeedsReview.value = false;
    if (draftContent && contentModel.value)
    {
        emit('update:modelValue', '');
    }
};

const handleDraftPrivacyPurge = (reason: CommentPrivacyCredentialPurgeReason): void =>
{
    const identityWide = identityWideDraftPurgeReasons.has(reason);
    if (identityWide && commentDraftStorage && !clearAllCommentDraftStorage(commentDraftStorage))
    {
        draftPrivacyBlocked.value = true;
    }
    if (identityWide || authorModeModel.value === 'zk_anonymous')
    {
        clearDraftMemory();
    }
    if (identityWide)
    {
        commentDraftScopeId = '';
        draftStorageKey.value = '';
    }
};

watch(
    () => [props.articleId, props.replyTarget?.id ?? null] as const,
    () =>
    {
        flushPublicCommentDraft();
        refreshCommentDraftStorageKey();
    }
);

watch(() => props.accountId, (accountId) =>
{
    if (accountId === lastAccountId)
    {
        return;
    };
    if (lastAccountId !== null)
    {
        if (commentDraftStorage && !clearAllCommentDraftStorage(commentDraftStorage))
        {
            draftPrivacyBlocked.value = true;
        }
        clearDraftMemory();
        commentDraftScopeId = '';
        draftStorageKey.value = '';
    }
    lastAccountId = accountId;
    if (accountId !== null)
    {
        initializeCommentDraftStorage();
    }
});

watch(() => props.policySnapshotHash, (policyHash, previousPolicyHash) =>
{
    if (!previousPolicyHash || policyHash === previousPolicyHash || !contentModel.value.trim())
    {
        return;
    };
    localDraft.value = {
        version: 3,
        content: contentModel.value,
        savedAt: Date.now(),
        policyHash: previousPolicyHash,
        clientMutationId: createCommentMutationId()
    };
    restoredDraftVisible.value = true;
    draftNeedsReview.value = true;
    emit('update:modelValue', '');
    emit('update:authorMode', 'zk_anonymous');
    emit('update:publicSendConfirmed', false);
});

watch(() => effectiveAnonymousCommentsEnabled.value, (enabled, wasEnabled) =>
{
    if (wasEnabled && !enabled && authorModeModel.value === 'zk_anonymous')
    {
        handleDraftPrivacyPurge('feature-disabled');
    }
});

watch(
    () => [
        contentModel.value,
        authorModeModel.value,
        publicIdentityModel.value
    ],
    () =>
    {
        if (draftNeedsReview.value)
        {
            return;
        };
        if (authorModeModel.value !== 'public' || !publicIdentityModel.value)
        {
            if (draftSaveTimer)
            {
                clearTimeout(draftSaveTimer);
                draftSaveTimer = null;
            }
            if (!clearPersistedCommentDraft())
            {
                draftPrivacyBlocked.value = true;
            }
            return;
        }
        scheduleSaveCommentDraft();
    }
);

watch(() => contentModel.value, (value) =>
{
    if (!value.trim())
    {
        if (!draftNeedsReview.value && !clearPersistedCommentDraft())
        {
            draftPrivacyBlocked.value = true;
        }
    }
});

function createCommentMutationId(): string
{
    const native = globalThis.crypto?.randomUUID?.();
    if (native)
    {
        return native;
    };

    const bytes = new Uint8Array(16);
    if (globalThis.crypto?.getRandomValues)
    {
        globalThis.crypto.getRandomValues(bytes);
    }
    else
    {
        for (let index = 0; index < bytes.length; index += 1)
        {
            bytes[index] = Math.floor(Math.random() * 256);
        }
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
</script>

<style scoped>
.fsus-comment-login
 {
    display: flex;
    width: 100%;
    box-sizing: border-box;
    flex-wrap: wrap;
    align-items: center;
    gap: 16px;
    padding-block: 16px;
    border-top: 1px solid var(--fsusblog-panel-border);
    background: transparent;
    box-shadow: none;
    text-align: left;
    font-family: var(--fsus-typography-body-family, var(--fsus-font-ui, system-ui, sans-serif));
}

.fsus-comment-login__text
 {
    color: var(--fsusblog-text-quiet);
    font-weight: 400;
    font-size: 14px;
    line-height: 1.6;
}

.fsus-comment-login__btn
 {
    display: inline-flex;
    height: 40px;
    box-sizing: border-box;
    align-items: center;
    justify-content: center;
    padding-inline: 12px;
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: 6px;
    background: transparent;
    box-shadow: none;
    color: var(--fsusblog-text-primary);
    font-size: 14px;
    font-weight: 500;
    text-decoration: none;
    cursor: pointer;
    transition:
        color var(--blog-motion-control) var(--blog-motion-ease),
        border-color var(--blog-motion-control) var(--blog-motion-ease);
}

.fsus-comment-login__btn:visited
 {
    color: var(--fsusblog-text-primary);
}

.fsus-comment-login__btn:hover
 {
    border-color: var(--fsusblog-color-primary);
    background: transparent;
    color: var(--fsusblog-color-primary);
}

.fsus-comment-login__btn:focus-visible
 {
    background: transparent;
    box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
    outline: none;
}

.comment-identity-panel
 {
    margin-bottom: 0.75rem;
    border: 0;
    border-bottom: 1px solid var(--fsusblog-panel-border);
    border-radius: 0;
    background: transparent;
    padding: 0 0 0.75rem;
}

.comment-identity-summary
 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
}

.comment-identity-copy
 {
    min-width: 0;
}

.comment-identity-heading
 {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
}

.comment-identity-label
 {
    color: var(--fsusblog-text-primary);
    font-size: 14px;
    font-weight: 700;
    line-height: 1.35;
}

.comment-identity-badge
 {
    display: inline-flex;
    min-height: 1.375rem;
    align-items: center;
    border: 1px solid transparent;
    border-radius: 999px;
    padding: 0 0.5rem;
    font-size: 12px;
    font-weight: 700;
    line-height: 1rem;
}

.comment-identity-badge--ready
 {
    border-color: color-mix(in srgb, var(--fsusblog-color-primary) 18%, transparent);
    color: var(--fsusblog-color-primary);
    background: color-mix(in srgb, var(--fsusblog-color-primary) 6%, transparent);
}

.comment-identity-badge--muted
 {
    border-color: color-mix(in srgb, var(--fsusblog-text-muted) 20%, transparent);
    color: var(--fsusblog-text-muted);
    background: color-mix(in srgb, var(--fsusblog-text-muted) 7%, transparent);
}

.comment-identity-hint
 {
    margin: 0.25rem 0 0;
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    line-height: 1.5;
}

.comment-composer-editor
 {
    display: grid;
    gap: 0.375rem;
}

.comment-composer-draft
 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
    border: 1px solid color-mix(in srgb, var(--fsusblog-color-primary) 18%, transparent);
    border-radius: var(--fsusblog-radius-control, 6px);
    background: color-mix(in srgb, var(--fsusblog-color-primary) 6%, transparent);
    padding: 0.625rem 0.75rem;
    color: var(--fsusblog-text-secondary);
    font-size: 12px;
    font-weight: 700;
}

.comment-composer-draft__actions
 {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 0.75rem;
}

.comment-composer-toolbar
 {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    min-width: 0;
}

.comment-composer-tabs,
.comment-composer-focus
 {
    grid-area: 1 / 1;
}

.comment-composer-focus
 {
    place-self: start end;
    min-height: 1.875rem;
    font-size: 14px;
    font-weight: 700;
    line-height: 1;
    white-space: nowrap;
}

.comment-composer-preview
 {
    min-height: 4.75rem;
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsusblog-radius-control, 6px);
    background: var(--fsusblog-panel-bg);
    padding: 0.75rem 0.875rem;
}

.comment-composer-preview.is-empty
 {
    display: flex;
    align-items: center;
    color: var(--fsusblog-text-muted);
    font-size: 14px;
    font-weight: 700;
}

.comment-composer-feedback
 {
    margin: 0;
    color: var(--el-color-danger);
    font-size: 14px;
    font-weight: 700;
    line-height: 1.5;
}

.comment-composer-metrics
 {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.5rem 0.875rem;
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    font-weight: 700;
    line-height: 1.4;
}

.comment-composer-metrics.is-warning
 {
    color: var(--el-color-warning);
}

.comment-composer-focus__body
 {
    display: grid;
    gap: 0.75rem;
}

.comment-composer-focus__preview
 {
    min-height: min(52vh, 26rem);
    overflow: auto;
}

.comment-composer-focus__footer
 {
    display: flex;
    width: 100%;
    box-sizing: border-box;
    align-items: center;
    justify-content: flex-end;
    gap: 0.75rem;
}

.comment-composer-focus__footer .comment-composer-metrics
 {
    margin-right: auto;
}

:global(.comment-composer-focus-dialog .fsus-dialog__footer)
 {
    width: 100%;
}

.comment-composer-focus__actions
 {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.75rem;
}

.comment-composer-focus__action
 {
    min-width: 0;
}

@media (width <= 520px)
 {
    .comment-identity-panel
 {
        padding: 0 0 0.625rem;
    }

    .comment-identity-summary
 {
        align-items: flex-start;
        flex-direction: column;
        gap: 0.5rem;
    }

    .comment-composer-focus__footer
 {
        align-items: stretch;
        flex-direction: column;
        gap: 0.75rem;
    }

    .comment-composer-focus__footer .comment-composer-metrics
 {
        justify-content: flex-start;
        margin-right: 0;
    }

    .comment-composer-focus__actions
 {
        display: grid;
        width: 100%;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 0.75rem;
    }

    .comment-composer-focus__action
 {
        width: 100%;
        margin-left: 0;
    }
}
</style>
