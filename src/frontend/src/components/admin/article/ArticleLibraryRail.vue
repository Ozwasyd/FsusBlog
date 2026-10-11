<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { ElButton, ElDrawer } from '@ozwasyd/element-plus';
import type { ButtonInstance } from '@ozwasyd/element-plus';

import { useMediaQuery } from '@/composables/useMediaQuery';

import ArticleLibraryRailContent from './ArticleLibraryRailContent.vue';
import type { ArticleLibraryGroup, ArticleLibraryPresentation } from './articleLibraryPresentation';

const props = withDefaults(defineProps<{
    presentation?: ArticleLibraryPresentation;
    currentArticleId?: number | null;
    activeGroup?: ArticleLibraryGroup;
}>(), {
    presentation: () => ({ state: 'unconnected', group: 'recent' }),
    currentArticleId: null,
    activeGroup: 'recent'
});
const emit = defineEmits<{
    group: [group: ArticleLibraryGroup];
    page: [group: ArticleLibraryGroup, direction: 'previous' | 'next'];
    openArticle: [articleId: number];
    revealCurrent: [articleId: number];
    expanded: [expanded: boolean];
}>();

const expanded = ref(false);
const isMobile = useMediaQuery('(max-width: 767px)');
const trigger = ref<ButtonInstance>();
const content = ref<InstanceType<typeof ArticleLibraryRailContent>>();

function requestCurrent(): void
{
    const alreadyVisible = props.presentation.state === 'ready'
        && props.presentation.group === props.activeGroup
        && props.presentation.entries.some((entry) => entry.id === props.currentArticleId);
    if (props.currentArticleId !== null && !alreadyVisible) emit('revealCurrent', props.currentArticleId);
}

async function open(): Promise<void>
{
    expanded.value = true;
    requestCurrent();
    await nextTick();
    if (!isMobile.value) content.value?.focusInitial();
}

async function close(): Promise<void>
{
    expanded.value = false;
    await nextTick();
    if (!isMobile.value) trigger.value?.ref?.focus();
}

function selectGroup(nextGroup: ArticleLibraryGroup): void
{
    if (props.activeGroup === nextGroup) return;
    emit('group', nextGroup);
}

watch(expanded, (value) => emit('expanded', value));
watch(() => props.currentArticleId, () =>
{
    if (expanded.value) requestCurrent();
});
watch(isMobile, () =>
{
    // Close before changing presentation; do not leave two active navigation surfaces.
    void close();
});

onBeforeUnmount(() =>
{
    if (expanded.value) emit('expanded', false);
});

defineExpose({ close });
</script>

<template>
    <div class="article-library-rail" data-article-library-rail>
        <ElButton ref="trigger" text :aria-expanded="expanded" aria-label="文章库" @click="expanded ? close() : open()">
            文章库
        </ElButton>
        <ElDrawer
            v-if="isMobile"
            v-model="expanded"
            title="文章库"
            direction="ltr"
            size="min(22rem, 100%)"
            append-to-body
            destroy-on-close
            @opened="content?.focusInitial()"
            @closed="trigger?.ref?.focus()"
        >
            <ArticleLibraryRailContent
                ref="content"
                :group="activeGroup"
                :presentation="presentation"
                :current-article-id="currentArticleId"
                @group="selectGroup"
                @page="emit('page', activeGroup, $event)"
                @open-article="emit('openArticle', $event)"
                @reveal-current="emit('revealCurrent', $event)"
                @close="close"
            />
        </ElDrawer>
        <aside v-else-if="expanded" class="article-library-rail__panel" aria-label="文章库">
            <ElButton text @click="close">收起文章库</ElButton>
            <ArticleLibraryRailContent
                ref="content"
                :group="activeGroup"
                :presentation="presentation"
                :current-article-id="currentArticleId"
                @group="selectGroup"
                @page="emit('page', activeGroup, $event)"
                @open-article="emit('openArticle', $event)"
                @reveal-current="emit('revealCurrent', $event)"
                @close="close"
            />
        </aside>
    </div>
</template>

<style scoped lang="scss">
.article-library-rail {
    position: relative;
}

.article-library-rail__panel {
    position: absolute;
    inset-inline-start: 0;
    inset-block-start: 100%;
    inline-size: min(18rem, calc(100vw - 2rem));
    max-block-size: calc(100vh - 8rem);
    overflow: auto;
    background: var(--fsus-paper);
    border: 1px solid var(--fsus-border);
    padding: var(--fsus-space-2);
}
</style>
