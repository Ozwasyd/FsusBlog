<template>
    <FsusUiDialog
        :model-value="modelValue"
        title="链接到文章"
        :width="fsusDialogWidths.longForm"
        :close-on-click-modal="false"
        append-to-body
        align-center
        destroy-on-close
        @update:model-value="value => { if (!value) dismiss(); }"
        @opened="searchInput?.focus()"
        @closed="emit('closed')"
    >
        <div class="internal-link-picker">
            <ElInput
                ref="searchInput"
                :model-value="query"
                aria-label="搜索文章"
                :aria-controls="`${instanceId}-results`"
                :disabled="finishing"
                placeholder="搜索标题、slug、分类或标签"
                @update:model-value="requestSearch"
                @keydown="navigate"
            />
            <p
                v-if="selectionUnavailableText !== null"
                role="status"
            >{{ selectionUnavailableText }}</p>
            <div
                v-if="activeArticle"
                class="internal-link-picker__context"
            >
                <ElButton @click="back">返回文章</ElButton>
                <bdi class="internal-link-picker__title">{{ activeArticle.title }}</bdi>
                <ElButton
                    :disabled="!selectionAvailable || !hasAction(activeArticle.selectAction)"
                    @click="selectTarget(activeArticle)"
                >选择整篇文章</ElButton>
            </div>
            <div
                :id="`${instanceId}-results`"
                ref="resultList"
                class="internal-link-picker__results"
                :aria-label="activeArticle ? '文章章节' : '文章结果'"
                :aria-busy="state === 'loading'"
                tabindex="-1"
                @keydown="navigate"
            >
                <p
                    v-if="state === 'loading'"
                    role="status"
                >{{ message ?? '加载中…' }}</p>
                <p
                    v-else-if="state === 'error'"
                    role="alert"
                >{{ message ?? '结果不可用' }}</p>
                <p
                    v-else-if="state === 'cancelled'"
                    role="status"
                >{{ message ?? '请求已取消' }}</p>
                <p
                    v-else-if="activeArticle ? headings.length === 0 : articles.length === 0"
                    role="status"
                >
                    {{ activeArticle ? '没有可用章节' : '没有匹配文章' }}
                </p>
                <ul
                    v-else
                    class="internal-link-picker__list"
                >
                    <template v-if="activeArticle">
                        <li
                            v-for="heading in headings"
                            :key="heading.id"
                            class="internal-link-picker__row"
                        >
                            <ElButton
                                class="internal-link-picker__target"
                                data-picker-target
                                :disabled="!selectionAvailable || heading.unavailableText !== null || !hasAction(heading.selectAction)"
                                @click="selectTarget(activeArticle, heading)"
                            ><bdi class="internal-link-picker__title">{{ heading.title }}</bdi></ElButton>
                            <p v-if="heading.unavailableText !== null">{{ heading.unavailableText }}</p>
                        </li>
                    </template>
                    <template v-else>
                        <li
                            v-for="article in articles"
                            :key="article.id"
                            class="internal-link-picker__row"
                        >
                            <ElButton
                                class="internal-link-picker__target"
                                data-picker-target
                                :disabled="!canEnter(article)"
                                @click="enterArticle(article)"
                            ><bdi class="internal-link-picker__title">{{ article.title }}</bdi></ElButton>
                            <p class="internal-link-picker__metadata">
                                <bdi v-if="article.statusText !== null">{{ article.statusText }}</bdi>
                                <bdi v-if="article.updatedText !== null">{{ article.updatedText }}</bdi>
                                <bdi v-if="article.unavailableText !== null">{{ article.unavailableText }}</bdi>
                            </p>
                        </li>
                    </template>
                </ul>
            </div>
        </div>
        <template #footer>
            <ElButton @click="dismiss">取消</ElButton>
        </template>
    </FsusUiDialog>
</template>

<script setup lang="ts">
import { ElButton, ElInput } from '@ozwasyd/element-plus';
import { computed, nextTick, ref, useId, watch } from 'vue';

import { FsusUiDialog, fsusDialogWidths } from '@/fsusui/dialog';

/** Presentation only: the host admits labels and identities and owns each opaque action.
 * Null or undefined actions remain unavailable. These types are not a transport DTO.
 */
export interface InternalLinkPickerArticle {
    id: string;
    revision: string;
    title: string;
    statusText: string | null;
    updatedText: string | null;
    unavailableText: string | null;
    selectAction: unknown;
    headingsAction: unknown;
}

/** Heading IDs and revisions are supplied by the owner, never derived from labels. */
export interface InternalLinkPickerHeading {
    id: string;
    revision: string;
    title: string;
    unavailableText: string | null;
    selectAction: unknown;
}

export type InternalLinkPickerState = 'loading' | 'ready' | 'error' | 'cancelled';

export interface InternalLinkPickerSearchResult {
    requestKey: string;
    state: InternalLinkPickerState;
    articles: readonly InternalLinkPickerArticle[];
    /** Only caller-admitted, safe display copy; raw transport errors do not belong here. */
    message: string | null;
}

export interface InternalLinkPickerHeadingResult {
    requestKey: string;
    articleId: string;
    articleRevision: string;
    state: InternalLinkPickerState;
    headings: readonly InternalLinkPickerHeading[];
    message: string | null;
}

const props = defineProps<{
    modelValue: boolean;
    /** Change this when the host's command/selection context is replaced. */
    sessionKey: string;
    searchResult: InternalLinkPickerSearchResult | null;
    headingResult: InternalLinkPickerHeadingResult | null;
    /** Exact owner-provided current-selection diagnostic; null alone means no diagnostic. */
    selectionUnavailableText: string | null;
}>();

const emit = defineEmits<{
    'update:modelValue': [value: boolean];
    'request-search': [request: { sessionKey: string; requestKey: string; query: string; }];
    'request-headings': [request: {
        sessionKey: string;
        requestKey: string;
        articleId: string;
        articleRevision: string;
        action: unknown;
    }];
    select: [selection: {
        sessionKey: string;
        searchRequestKey: string;
        headingRequestKey: string | null;
        articleId: string;
        articleRevision: string;
        headingId: string | null;
        headingRevision: string | null;
        action: unknown;
    }];
    cancel: [cancellation: {
        sessionKey: string;
        scope: 'picker' | 'search' | 'headings';
        reason: 'dismiss' | 'replace-search' | 'back' | 'invalidated' | 'context-changed';
        searchRequestKey: string | null;
        headingRequestKey: string | null;
    }];
    /** Notification only; the public dialog owns DOM focus return, the host owns editor focus. */
    closed: [];
}>();

const instanceId = useId();
const searchInput = ref<{ focus: () => void; }>();
const resultList = ref<HTMLElement>();
const query = ref('');
const searchRequestKey = ref<string | null>(null);
const headingRequestKey = ref<string | null>(null);
const activeArticleIdentity = ref<{ id: string; revision: string; } | null>(null);
const finishing = ref(false);
let sequence = 0;

const currentSearch = computed(() => props.modelValue && !finishing.value
    && searchRequestKey.value !== null && props.searchResult?.requestKey === searchRequestKey.value
    ? props.searchResult : null);
const articles = computed(() => currentSearch.value?.state === 'ready' ? currentSearch.value.articles : []);
const activeArticle = computed(() => articles.value.find((article) =>
    article.id === activeArticleIdentity.value?.id && article.revision === activeArticleIdentity.value.revision
    && article.unavailableText === null && hasAction(article.headingsAction)) ?? null);
const currentHeadings = computed(() => activeArticle.value && headingRequestKey.value !== null
    && props.headingResult?.requestKey === headingRequestKey.value
    && props.headingResult.articleId === activeArticle.value.id
    && props.headingResult.articleRevision === activeArticle.value.revision ? props.headingResult : null);
const headings = computed(() => currentHeadings.value?.state === 'ready' ? currentHeadings.value.headings : []);
const state = computed(() => (activeArticle.value ? currentHeadings.value : currentSearch.value)?.state ?? 'loading');
const message = computed(() => (activeArticle.value ? currentHeadings.value : currentSearch.value)?.message);
const selectionAvailable = computed(() => props.selectionUnavailableText === null && !finishing.value);

function cancelRequests(scope: 'picker' | 'search' | 'headings', reason: 'dismiss' | 'replace-search' | 'back' | 'invalidated' | 'context-changed')
{
    emit('cancel', {
        sessionKey: props.sessionKey,
        scope,
        reason,
        searchRequestKey: searchRequestKey.value,
        headingRequestKey: headingRequestKey.value
    });
}

function clearArticle()
{
    activeArticleIdentity.value = null;
    headingRequestKey.value = null;
}

function requestSearch(value: string)
{
    if (!props.modelValue || finishing.value)
    {
        return;
    }
    if (searchRequestKey.value !== null)
    {
        cancelRequests('search', 'replace-search');
    }
    clearArticle();
    query.value = value;
    searchRequestKey.value = `${instanceId}:search:${++sequence}`;
    emit('request-search', { sessionKey: props.sessionKey, requestKey: searchRequestKey.value, query: value });
}

function hasAction(action: unknown)
{
    return action !== null && action !== undefined;
}

function canEnter(article: InternalLinkPickerArticle)
{
    return selectionAvailable.value && article.unavailableText === null
        && (hasAction(article.headingsAction) || hasAction(article.selectAction));
}

function enterArticle(article: InternalLinkPickerArticle)
{
    if (!canEnter(article) || !articles.value.includes(article))
    {
        return;
    }
    if (!hasAction(article.headingsAction))
    {
        selectTarget(article);
        return;
    }
    activeArticleIdentity.value = { id: article.id, revision: article.revision };
    headingRequestKey.value = `${instanceId}:headings:${++sequence}`;
    emit('request-headings', {
        sessionKey: props.sessionKey,
        requestKey: headingRequestKey.value,
        articleId: article.id,
        articleRevision: article.revision,
        action: article.headingsAction
    });
    void nextTick(() => resultList.value?.focus());
}

function selectTarget(article: InternalLinkPickerArticle, heading?: InternalLinkPickerHeading)
{
    const action = heading ? heading.selectAction : article.selectAction;
    if (!selectionAvailable.value || !searchRequestKey.value || !articles.value.includes(article)
        || article.unavailableText !== null || !hasAction(action))
    {
        return;
    }
    if (heading && (!headings.value.includes(heading) || heading.unavailableText !== null))
    {
        return;
    }
    emit('select', {
        sessionKey: props.sessionKey,
        searchRequestKey: searchRequestKey.value,
        headingRequestKey: headingRequestKey.value,
        articleId: article.id,
        articleRevision: article.revision,
        headingId: heading?.id ?? null,
        headingRevision: heading?.revision ?? null,
        action
    });
    clearArticle();
    finishing.value = true;
    searchRequestKey.value = null;
    emit('update:modelValue', false);
}

function back()
{
    cancelRequests('headings', 'back');
    clearArticle();
    void nextTick(() => searchInput.value?.focus());
}

function dismiss()
{
    if (!props.modelValue || finishing.value)
    {
        return;
    }
    cancelRequests('picker', 'dismiss');
    clearArticle();
    finishing.value = true;
    searchRequestKey.value = null;
    emit('update:modelValue', false);
}

function navigate(event: Event | KeyboardEvent)
{
    if (!(event instanceof KeyboardEvent))
    {
        return;
    }
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
    {
        return;
    }
    if (event.target instanceof HTMLInputElement && !['ArrowDown', 'ArrowUp'].includes(event.key))
    {
        return;
    }
    if (event.key === 'ArrowLeft' && activeArticle.value)
    {
        event.preventDefault();
        back();
        return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))
    {
        return;
    }
    const buttons = Array.from(resultList.value?.querySelectorAll<HTMLButtonElement>('[data-picker-target]:not(:disabled)') ?? []);
    if (!buttons.length)
    {
        return;
    }
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : event.key === 'ArrowDown' ? Math.min(index + 1, buttons.length - 1)
            : index < 0 ? buttons.length - 1 : Math.max(index - 1, 0);
    event.preventDefault();
    buttons[next]?.focus();
}

watch(() => [props.modelValue, props.sessionKey] as const, ([visible, sessionKey], previous) =>
{
    if (previous?.[0] && previous[1] !== sessionKey && !finishing.value)
    {
        emit('cancel', {
            sessionKey: previous[1], scope: 'picker', reason: 'context-changed',
            searchRequestKey: searchRequestKey.value, headingRequestKey: headingRequestKey.value
        });
    }
    else if (!visible && previous?.[0] && !finishing.value)
    {
        cancelRequests('picker', 'dismiss');
    }
    clearArticle();
    searchRequestKey.value = null;
    query.value = '';
    finishing.value = !visible;
    if (visible)
    {
        requestSearch('');
    }
}, { immediate: true });

watch([activeArticle, selectionAvailable], ([article, available]) =>
{
    if (props.modelValue && !finishing.value && activeArticleIdentity.value && (!article || !available))
    {
        cancelRequests('headings', 'invalidated');
        clearArticle();
        void nextTick(() => searchInput.value?.focus());
    }
}, { flush: 'sync' });
</script>

<style scoped>
.internal-link-picker
 {
    display: grid;
    min-width: 0;
    gap: var(--fsus-space-3);
}

.internal-link-picker__context
 {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fsus-space-2);
}

.internal-link-picker__results
 {
    min-width: 0;
    max-block-size: 50vh;
    overflow: auto;
}

.internal-link-picker__list
 {
    margin: 0;
    padding: 0;
    list-style: none;
}

.internal-link-picker__row
 {
    min-width: 0;
    padding-block: var(--fsus-space-2);
    border-block-end: 1px solid var(--el-border-color-lighter);
}

.internal-link-picker__title
 {
    min-width: 0;
    overflow-wrap: anywhere;
    white-space: normal;
    text-align: start;
}

.internal-link-picker__target
 {
    max-inline-size: 100%;
}

.internal-link-picker__metadata
 {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fsus-space-2);
    margin-block: var(--fsus-space-1) 0;
    color: var(--el-text-color-secondary);
    font-size: var(--el-font-size-extra-small);
    overflow-wrap: anywhere;
}
</style>
