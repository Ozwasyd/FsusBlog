<template>
    <nav
        class="article-library-content"
        aria-label="文章库"
        @keydown.esc.stop.prevent="emit('close')"
    >
        <ul
            class="article-library-content__groups"
            aria-label="文章分组"
        >
            <li
                v-for="item in articleLibraryGroups"
                :key="item.key"
            >
                <ElButton
                    ref="groupButtons"
                    text
                    :data-library-group="item.key"
                    :aria-pressed="group === item.key"
                    @click="emit('group', item.key)"
                    @keydown="handleGroupKeydown($event, item.key)"
                >{{ item.label }}</ElButton>
            </li>
        </ul>
        <p
            v-if="statusText"
            role="status"
            class="article-library-content__status"
        >{{ statusText }}</p>
        <ul
            v-else
            class="article-library-content__articles"
            aria-label="分组中的文章"
            :aria-busy="presentation.state === 'loading'"
        >
            <li
                v-for="entry in entries"
                :key="entry.id"
                class="article-library-content__entry"
                :class="{ 'article-library-content__entry--current': entry.id === currentArticleId }"
            >
                <ElButton
                    ref="rowButtons"
                    text
                    :data-article-id="entry.id"
                    :aria-current="entry.id === currentArticleId ? 'page' : undefined"
                    :aria-label="entry.title || '未命名文章'"
                    :tabindex="entry.id === focusedId ? 0 : -1"
                    @focus="focusedId = entry.id"
                    @click="emit('openArticle', entry.id)"
                    @keydown="handleRowKeydown($event, entry.id)"
                >
                    <span
                        class="article-library-content__title"
                        :title="entry.title"
                    >{{ entry.title || '未命名文章' }}</span>
                </ElButton>
                <span
                    v-if="group === 'recent'"
                    class="article-library-content__metadata"
                >{{ articleLibraryStatusLabel(entry.status) }}</span>
                <time
                    v-if="displayTime(entry.updatedAt)"
                    :datetime="entry.updatedAt ?? undefined"
                    class="article-library-content__metadata"
                >
                    {{ displayTime(entry.updatedAt) }}
                </time>
            </li>
        </ul>
        <ElButton
            v-if="currentArticleId !== null && page && !currentOnPage"
            ref="revealButton"
            text
            data-library-action="reveal-current"
            @click="emit('revealCurrent', currentArticleId)"
        >定位当前文章</ElButton>
        <div
            v-if="page"
            class="article-library-content__pagination"
            aria-label="文章分页"
        >
            <ElButton
                ref="previousButton"
                text
                data-library-action="previous"
                :disabled="!page.hasPrevious"
                @click="emit('page', 'previous')"
            >上一页</ElButton>
            <ElButton
                ref="nextButton"
                text
                data-library-action="next"
                :disabled="!page.hasNext"
                @click="emit('page', 'next')"
            >下一页</ElButton>
        </div>
    </nav>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { FsusUiButton as ElButton } from '@/fsusui/button';
import { TimeUtils } from '@/utils/time';

import {
    articleLibraryGroups,
    articleLibraryStatusLabel,
    isArticleLibraryPageValid
} from './articleLibraryPresentation';

import type {
    ArticleLibraryGroup,
    ArticleLibraryPresentation,
    ArticleLibraryButtonHandle,
    ArticleLibraryContentHandle
} from './articleLibraryPresentation';

const props = defineProps<{
    group: ArticleLibraryGroup;
    presentation: ArticleLibraryPresentation;
    currentArticleId: number | null;
    active: boolean;
}>();
const emit = defineEmits<{
    group: [group: ArticleLibraryGroup];
    page: [direction: 'previous' | 'next'];
    openArticle: [articleId: number];
    revealCurrent: [articleId: number];
    close: [];
}>();

const rowButtons = ref<ArticleLibraryButtonHandle[]>([]);
const groupButtons = ref<ArticleLibraryButtonHandle[]>([]);
const previousButton = ref<ArticleLibraryButtonHandle>();
const nextButton = ref<ArticleLibraryButtonHandle>();
const revealButton = ref<ArticleLibraryButtonHandle>();
const focusedId = ref<number | null>(null);
type ArticleLibraryAction = 'previous' | 'next' | 'reveal-current';
interface ArticleLibraryFocusIntent {
    origin: HTMLButtonElement;
    originGroup: ArticleLibraryGroup;
    group: ArticleLibraryGroup;
    action: ArticleLibraryAction | null;
    anchor: HTMLButtonElement | null;
}
let focusIntent: ArticleLibraryFocusIntent | null = null;
let applyingFocusIntent = false;
let focusDocument: Document | null = null;
let mountedActive = true;
const page = computed(() => props.presentation.group === props.group
    && isArticleLibraryPageValid(props.presentation) && props.presentation.state === 'ready'
    ? props.presentation : null);
const entries = computed(() => page.value?.entries ?? []);
const statusText = computed(() =>
{
    if (!isArticleLibraryPageValid(props.presentation))
    {
        return '文章列表输入不可用';
    }
    if (props.presentation.group !== props.group)
    {
        return '正在切换分组…';
    }
    switch (props.presentation.state)
    {
        case 'unconnected': return '文章库数据尚未接入';
        case 'loading': return '正在加载文章…';
        case 'error': return '文章加载失败';
        case 'unavailable': return '此分组暂不可用';
        case 'ready': return entries.value.length === 0 ? '此分组没有文章' : '';
    }
});
const currentOnPage = computed(() => entries.value.some((entry) => entry.id === props.currentArticleId));

function displayTime(value: string | null | undefined): string
{
    return value && Number.isFinite(Date.parse(value)) ? TimeUtils.toSmartTime(value) : '';
}

function focusArticle(articleId: number): void
{
    focusedId.value = articleId;
    const button = rowButtons.value.find((item) => item.ref?.dataset.articleId === String(articleId));
    button?.ref?.focus();
    button?.ref?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
}

function handleRowKeydown(event: KeyboardEvent, articleId: number): void
{
    const index = entries.value.findIndex((entry) => entry.id === articleId);
    let target: number;
    switch (event.key)
    {
        case 'ArrowDown':
            target = Math.min(index + 1, entries.value.length - 1);
            break;
        case 'ArrowUp':
            target = Math.max(index - 1, 0);
            break;
        case 'Home':
            target = 0;
            break;
        case 'End':
            target = entries.value.length - 1;
            break;
        default: return;
    }
    event.preventDefault();
    const entry = entries.value[target];
    if (entry)
    {
        focusArticle(entry.id);
    }
}

function handleGroupKeydown(event: KeyboardEvent, group: ArticleLibraryGroup): void
{
    const index = articleLibraryGroups.findIndex((item) => item.key === group);
    let target: number;
    switch (event.key)
    {
        case 'ArrowDown':
            target = (index + 1) % articleLibraryGroups.length;
            break;
        case 'ArrowUp':
            target = (index + articleLibraryGroups.length - 1) % articleLibraryGroups.length;
            break;
        case 'Home':
            target = 0;
            break;
        case 'End':
            target = articleLibraryGroups.length - 1;
            break;
        default: return;
    }
    event.preventDefault();
    const nextGroup = articleLibraryGroups[target];
    groupButtons.value.find((item) => item.ref?.dataset.libraryGroup === nextGroup?.key)?.ref?.focus();
}

function actionButton(action: ArticleLibraryAction): ArticleLibraryButtonHandle | undefined
{
    switch (action)
    {
        case 'previous': return page.value?.hasPrevious ? previousButton.value : undefined;
        case 'next': return page.value?.hasNext ? nextButton.value : undefined;
        case 'reveal-current': return page.value && props.currentArticleId !== null && !currentOnPage.value
            ? revealButton.value : undefined;
    }
}

function ownsIntentFocus(intent: ArticleLibraryFocusIntent): boolean
{
    const activeElement = document.activeElement;
    return activeElement === intent.origin || activeElement === intent.anchor
        || (intent.anchor === null && activeElement === document.body);
}

function handleFocusChange(event: FocusEvent): void
{
    // DOM removal may leave focus on body without a focusin. A real new focus target cancels ownership.
    if (!applyingFocusIntent && focusIntent && event.target !== focusIntent.origin && event.target !== focusIntent.anchor)
    {
        focusIntent = null;
    }
}

function captureFocusIntent(group: ArticleLibraryGroup, originGroup: ArticleLibraryGroup): void
{
    if (focusIntent && !ownsIntentFocus(focusIntent))
    {
        focusIntent = null;
    }
    if (focusIntent && focusIntent.group !== group)
    {
        const unfinished = focusIntent.anchor === null ? focusIntent : null;
        focusIntent = null;
        // Cancel the old group's restoration; only an unfinished fallback can transfer to the new group.
        if (unfinished)
        {
            focusIntent = { ...unfinished, group, action: null };
        }
    }
    const activeElement = document.activeElement;
    const rowOrigin = rowButtons.value.find((item) => item.ref === activeElement)?.ref;
    const action = previousButton.value?.ref === activeElement ? 'previous'
        : nextButton.value?.ref === activeElement ? 'next'
            : revealButton.value?.ref === activeElement ? 'reveal-current' : null;
    const losesActionFocus = action !== null && (originGroup !== group || !actionButton(action));
    const origin = rowOrigin ?? (losesActionFocus
        ? [previousButton.value, nextButton.value, revealButton.value].find((item) => item?.ref === activeElement)?.ref
        : undefined);
    if (origin)
    {
        // Persist before rendering/await: a later same-group watcher inherits this unfinished handoff.
        focusIntent = { origin, originGroup, group, action: originGroup === group ? action : null, anchor: null };
    }
}

function settleFocusIntent(group: ArticleLibraryGroup): boolean
{
    const intent = focusIntent;
    if (!intent)
    {
        return false;
    }
    if (intent.group !== group || !ownsIntentFocus(intent))
    {
        focusIntent = null;
        return false;
    }
    if (page.value)
    {
        focusIntent = null;
        const button = intent.action ? actionButton(intent.action)?.ref : undefined;
        if (button)
        {
            button.focus();
        }
        else
        {
            focusInitial();
        }
    }
    else if (intent.anchor === null)
    {
        applyingFocusIntent = true;
        try
        {
            focusInitial();
        }
        finally
        {
            applyingFocusIntent = false;
        }
        const anchor = groupButtons.value.find((item) => item.ref?.dataset.libraryGroup === group)?.ref;
        if (intent.originGroup === group && anchor && document.activeElement === anchor)
        {
            intent.anchor = anchor;
        }
        else
        {
            // Cross-group focus uses fallback only; it cannot become an action restoration record.
            focusIntent = null;
        }
    }
    return true;
}

watch([page, () => props.currentArticleId, () => props.active, () => props.group], async (values, oldValues, onCleanup) =>
{
    const group = values[3];
    // Exposed button refs still belong to the previous render during this pre-flush watcher.
    const originGroup = oldValues[3] ?? group;
    let focusWorkCurrent = true;
    onCleanup(() =>
    {
        focusWorkCurrent = false;
    });
    if (!props.active || typeof document === 'undefined')
    {
        focusIntent = null;
        return;
    }
    captureFocusIntent(group, originGroup);
    focusedId.value = currentOnPage.value ? props.currentArticleId : entries.value[0]?.id ?? null;
    await nextTick();
    if (!focusWorkCurrent || !mountedActive || !props.active || props.group !== group)
    {
        return;
    }
    if (settleFocusIntent(group))
    {
        return;
    }
    if (currentOnPage.value)
    {
        rowButtons.value.find((item) => item.ref?.dataset.articleId === String(props.currentArticleId))
            ?.ref?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }
}, { immediate: true, flush: 'pre' });

/** Drawer lazy content calls this after open; desktop opening calls it after mount. */
function focusInitial(): void
{
    if (!props.active || !mountedActive)
    {
        return;
    }
    if (focusedId.value !== null)
    {
        focusArticle(focusedId.value);
    }
    else
    {
        groupButtons.value.find((item) => item.ref?.dataset.libraryGroup === props.group)?.ref?.focus();
    }
}

onMounted(() =>
{
    focusDocument = typeof document === 'undefined' ? null : document;
    focusDocument?.addEventListener('focusin', handleFocusChange, true);
});

onBeforeUnmount(() =>
{
    mountedActive = false;
    focusIntent = null;
    focusDocument?.removeEventListener('focusin', handleFocusChange, true);
    focusDocument = null;
});

defineExpose({ focusInitial } satisfies ArticleLibraryContentHandle);
</script>

<style scoped lang="scss">
.article-library-content
{
    display: flex;
    flex-direction: column;
    gap: var(--fsus-space-2);
    min-inline-size: 0;
    overflow: auto;
    max-block-size: 100%;
}

.article-library-content__groups,
.article-library-content__articles
{
    list-style: none;
    margin: 0;
    padding: 0;
}

.article-library-content__groups,
.article-library-content__pagination
{
    display: flex;
    flex-wrap: wrap;
}

.article-library-content__entry
{
    border-inline-start: 2px solid transparent;
    min-inline-size: 0;
}

.article-library-content__entry--current
{
    border-inline-start-color: var(--fsus-scholarly-blue);
}

.article-library-content__title
{
    display: block;
    max-inline-size: 14rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.article-library-content__status
{
    margin: 0;
    color: var(--fsus-color-text-quiet);
}

.article-library-content__metadata
{
    display: block;
    padding-inline-start: var(--fsus-space-3);
    color: var(--fsus-color-text-quiet);
    font-size: var(--el-font-size-extra-small);
}
</style>
