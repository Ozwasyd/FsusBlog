<template>
    <div class="blog-page-shell flex flex-col lg:flex-row gap-16 lg:gap-24 xl:gap-32">
        <div class="grow lg:w-2/3">
            <FilterHeader :view="view.header" />

            <div
                v-if="showSearchSort"
                class="search-result-meta mb-5 border-b border-[var(--fsusblog-panel-border)] pb-5 text-xs font-medium leading-6 text-[var(--fsusblog-text-muted)]"
                aria-live="polite"
            >
                <span>范围：文章、标签、关键词</span>
                <span>结果：{{ searchResultStateText }}</span>
            </div>

            <div
                v-if="showSearchSort"
                class="filter-stack mb-8 inline-flex max-w-full items-center gap-6"
                data-fsus-motion-surface="search-panel"
            >
                <span class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">排序</span>
                <ElRadioGroup
                    :model-value="searchSortMode"
                    class="fsus-radio-group--touch"
                    size="small"
                    aria-label="搜索排序"
                    @change="handleSortChange"
                >
                    <ElRadioButton
                        v-for="mode in searchSortOptions"
                        :key="mode.value"
                        :value="mode.value"
                    >
                        {{ mode.label }}
                    </ElRadioButton>
                </ElRadioGroup>
            </div>

            <FilterArticleLoadingState
                v-if="isLoadingState"
                :view="view.loading"
            />

            <PublicArticleList
                v-else-if="view.articles.length > 0 && !invalidTarget"
                :spa-navigation="spaNavigation"
                :items="view.articles"
                :pagination="paginationContract"
                :show-pagination="view.pagination.totalPages > 1"
                @navigate="emit('navigate', $event)"
                @page-prev="emit('page-prev')"
                @page-next="emit('page-next')"
            />

            <PublicContentState
                v-else
                class="py-12 sm:py-14 md:py-16"
                :title="view.empty.title"
                :description="view.empty.description"
                :tone="view.empty.hasError ? 'error' : 'neutral'"
                :role="view.empty.hasError ? 'alert' : 'status'"
                size="page"
                :aria-live="view.empty.hasError ? 'assertive' : 'polite'"
            >
                <a
                    :href="PUBLIC_FIXED_PATHS.home"
                    class="inline-flex min-h-11 items-center gap-2 rounded-[var(--fsusblog-radius-control)] border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg)] px-4 text-sm font-bold text-[var(--fsusblog-text-primary)] outline-none transition-colors hover:border-[var(--fsusblog-color-primary)] hover:text-[var(--fsusblog-color-primary)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--fsusblog-color-focus-ring)]"
                    @click="handleEmptyAction"
                >
                    <ElIcon aria-hidden="true"><Back /></ElIcon>
                    {{ view.empty.actionText }}
                </a>
            </PublicContentState>
        </div>

        <aside class="hidden lg:block lg:w-64 shrink-0">
            <div class="sticky top-[calc(var(--fsusblog-public-header-height-current,4rem)+1.5rem)]">
                <a
                    :href="PUBLIC_FIXED_PATHS.home"
                    class="group inline-flex min-h-8 items-center gap-6 rounded-[var(--fsusblog-radius-control)] px-1 text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)] outline-none transition-colors hover:text-[var(--fsusblog-color-primary)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--fsusblog-color-focus-ring)]"
                >
                    <ElIcon
                        class="transition-fsus transition-fsus-fast group-hover:opacity-70"
                        aria-hidden="true"
                    ><Back /></ElIcon> 回到主页
                </a>
            </div>
        </aside>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import FilterArticleLoadingState from '@/components/filter/FilterArticleLoadingState.vue';
import FilterHeader from '@/components/filter/FilterHeader.vue';
import PublicArticleList from '@/components/public/PublicArticleList.vue';
import PublicContentState from '@/components/public/PublicContentState.vue';
import { Back } from '@/fsusui/icons';
import { PUBLIC_FIXED_PATHS } from '@/public-renderers/publicRoutePaths';
import type { SearchSortMode } from '@/services/localSearch';
import type { PaginationContract } from '@/ui-contracts/primitives';
import type { FilterPageViewContract } from '@/view-contracts/filterView';

const props = defineProps<{
    view: FilterPageViewContract;
    invalidTarget: boolean;
    isLoadingState: boolean;
    spaNavigation?: boolean;
    showSearchSort?: boolean;
    searchSortMode?: SearchSortMode;
    searchSortOptions?: readonly {
        value: SearchSortMode;
        label: string;
    }[];
}>();

const emit = defineEmits<{
    (event: 'navigate', href: string): void;
    (event: 'page-prev'): void;
    (event: 'page-next'): void;
    (event: 'sort-change', mode: SearchSortMode): void;
}>();

const handleSortChange = (value: string | number | boolean | undefined): void =>
{
    if (value === 'relevance' || value === 'latest' || value === 'hot')
    {
        emit('sort-change', value);
    }
};

const handleEmptyAction = (event: MouseEvent): void =>
{
    if (!props.spaNavigation)
    {
        return;
    }

    event.preventDefault();
    emit('navigate', PUBLIC_FIXED_PATHS.home);
};

const paginationContract = computed<PaginationContract>(() => ({
    previous: {
        label: '上一页',
        href: props.view.pagination.previousHref,
        disabled: !props.view.pagination.canGoPrev,
        action: { action: 'page-prev' }
    },
    next: {
        label: '下一页',
        href: props.view.pagination.nextHref,
        disabled: !props.view.pagination.canGoNext,
        action: { action: 'page-next' }
    },
    indicator: props.view.pagination.pageIndicatorText
}));

const searchResultStateText = computed(() =>
{
    if (props.isLoadingState)
    {
        return '正在检索';
    }

    if (props.invalidTarget)
    {
        return '搜索目标不可用';
    }

    if (props.view.articles.length === 0)
    {
        return '0';
    }

    return `${props.view.articles.length} / ${props.view.pagination.pageIndicatorText}`;
});
</script>

<style scoped>
.search-result-meta
 {
    display: flex;
    min-width: 0;
    flex-wrap: wrap;
    gap: 0.75rem 1.5rem;
}

.filter-stack
 {
    display: inline-flex;
    min-width: 0;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
}

@media (width <= 640px)
 {
    .filter-stack
 {
        width: 100%;
        align-items: stretch;
        flex-direction: column;
    }

    .filter-stack > *
 {
        min-width: 0;
    }
}

</style>
