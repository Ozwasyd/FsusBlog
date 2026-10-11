<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { ElButton } from '@ozwasyd/element-plus';
import type { ButtonInstance } from '@ozwasyd/element-plus';

import { TimeUtils } from '@/utils/time';

import {
    articleLibraryGroups,
    articleLibraryStatusLabel,
    isArticleLibraryPageValid
} from './articleLibraryPresentation';
import type {
    ArticleLibraryGroup,
    ArticleLibraryPresentation
} from './articleLibraryPresentation';

const props = defineProps<{
    group: ArticleLibraryGroup;
    presentation: ArticleLibraryPresentation;
    currentArticleId: number | null;
}>();
const emit = defineEmits<{
    group: [group: ArticleLibraryGroup];
    page: [direction: 'previous' | 'next'];
    openArticle: [articleId: number];
    revealCurrent: [articleId: number];
    close: [];
}>();

const rowButtons = ref<ButtonInstance[]>([]);
const groupButtons = ref<ButtonInstance[]>([]);
const focusedId = ref<number | null>(null);
const page = computed(() => props.presentation.group === props.group
    && isArticleLibraryPageValid(props.presentation) && props.presentation.state === 'ready'
    ? props.presentation : null);
const entries = computed(() => page.value?.entries ?? []);
const statusText = computed(() =>
{
    if (!isArticleLibraryPageValid(props.presentation)) return '文章列表输入不可用';
    if (props.presentation.group !== props.group) return '正在切换分组…';
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
    let target = index;
    switch (event.key)
    {
        case 'ArrowDown': target = Math.min(index + 1, entries.value.length - 1); break;
        case 'ArrowUp': target = Math.max(index - 1, 0); break;
        case 'Home': target = 0; break;
        case 'End': target = entries.value.length - 1; break;
        default: return;
    }
    event.preventDefault();
    const entry = entries.value[target];
    if (entry) focusArticle(entry.id);
}

function handleGroupKeydown(event: KeyboardEvent, group: ArticleLibraryGroup): void
{
    const index = articleLibraryGroups.findIndex((item) => item.key === group);
    let target = index;
    switch (event.key)
    {
        case 'ArrowDown': target = (index + 1) % articleLibraryGroups.length; break;
        case 'ArrowUp': target = (index + articleLibraryGroups.length - 1) % articleLibraryGroups.length; break;
        case 'Home': target = 0; break;
        case 'End': target = articleLibraryGroups.length - 1; break;
        default: return;
    }
    event.preventDefault();
    const nextGroup = articleLibraryGroups[target];
    groupButtons.value.find((item) => item.ref?.dataset.libraryGroup === nextGroup?.key)?.ref?.focus();
}

watch([entries, () => props.currentArticleId], async () =>
{
    const hadRowFocus = typeof document !== 'undefined'
        && rowButtons.value.some((item) => item.ref === document.activeElement);
    focusedId.value = currentOnPage.value ? props.currentArticleId : entries.value[0]?.id ?? null;
    await nextTick();
    if (hadRowFocus && focusedId.value !== null) focusArticle(focusedId.value);
    else if (hadRowFocus) focusInitial();
    else if (currentOnPage.value)
    {
        rowButtons.value.find((item) => item.ref?.dataset.articleId === String(props.currentArticleId))
            ?.ref?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }
}, { immediate: true, flush: 'pre' });

/** Drawer lazy content calls this after open; desktop opening calls it after mount. */
function focusInitial(): void
{
    if (focusedId.value !== null) focusArticle(focusedId.value);
    else groupButtons.value.find((item) => item.ref?.dataset.libraryGroup === props.group)?.ref?.focus();
}

defineExpose({ focusInitial });
</script>

<template>
    <nav class="article-library-content" aria-label="文章库" @keydown.esc.stop.prevent="emit('close')">
        <ul class="article-library-content__groups" aria-label="文章分组">
            <li v-for="item in articleLibraryGroups" :key="item.key">
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
        <p v-if="statusText" role="status" class="article-library-content__status">{{ statusText }}</p>
        <ul v-else class="article-library-content__articles" aria-label="分组中的文章" :aria-busy="presentation.state === 'loading'">
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
                    <span class="article-library-content__title" :title="entry.title">{{ entry.title || '未命名文章' }}</span>
                </ElButton>
                <span v-if="group === 'recent'" class="article-library-content__metadata">{{ articleLibraryStatusLabel(entry.status) }}</span>
                <time v-if="displayTime(entry.updatedAt)" :datetime="entry.updatedAt ?? undefined" class="article-library-content__metadata">
                    {{ displayTime(entry.updatedAt) }}
                </time>
            </li>
        </ul>
        <ElButton
            v-if="currentArticleId !== null && page && !currentOnPage"
            text
            @click="emit('revealCurrent', currentArticleId)"
        >定位当前文章</ElButton>
        <div v-if="page" class="article-library-content__pagination" aria-label="文章分页">
            <ElButton text :disabled="!page.hasPrevious" @click="emit('page', 'previous')">上一页</ElButton>
            <ElButton text :disabled="!page.hasNext" @click="emit('page', 'next')">下一页</ElButton>
        </div>
    </nav>
</template>

<style scoped lang="scss">
.article-library-content {
    display: flex;
    flex-direction: column;
    gap: var(--fsus-space-2);
    min-inline-size: 0;
    overflow: auto;
    max-block-size: 100%;
}

.article-library-content__groups,
.article-library-content__articles {
    list-style: none;
    margin: 0;
    padding: 0;
}

.article-library-content__groups,
.article-library-content__pagination {
    display: flex;
    flex-wrap: wrap;
}

.article-library-content__entry {
    border-inline-start: 2px solid transparent;
    min-inline-size: 0;
}

.article-library-content__entry--current {
    border-inline-start-color: var(--fsus-scholarly-blue);
}

.article-library-content__title {
    display: block;
    max-inline-size: 14rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.article-library-content__status {
    margin: 0;
    color: var(--fsus-color-text-quiet);
}

.article-library-content__metadata {
    display: block;
    padding-inline-start: var(--fsus-space-3);
    color: var(--fsus-color-text-quiet);
    font-size: var(--el-font-size-extra-small);
}
</style>
