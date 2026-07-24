<template>
    <div
        class="ui-article-list"
        :class="themeTokens.articleList.container"
        :data-public-article-presentation="presentation"
        data-fsus-surface="reading"
    >
        <article
            v-for="(item, index) in items"
            :key="item.id"
            v-memo="[item.id, item.title, item.summary, item.meta.displayTime, item.meta.categoryName]"
            :class="themeTokens.articleList.card"
            :data-fsus-motion-index="index"
            :data-article-id="item.id"
            data-fsus-motion-surface="article-card"
        >
            <div :class="themeTokens.articleList.metaRow">
                <time
                    :datetime="item.meta.isoTime"
                    :title="item.meta.fullTime"
                    class="tabular-nums"
                >
                    {{ item.meta.displayTime }}
                </time>
                <span
                    :class="themeTokens.articleList.metaSeparator"
                    aria-hidden="true"
                >{{ publicPeriodMotif.metadata.glyph }}</span>
                <a
                    v-if="item.meta.categoryHref"
                    :href="item.meta.categoryHref"
                    :class="themeTokens.articleList.metaCategory"
                    data-public-link="category"
                    @click="handleNavigate($event, item.meta.categoryHref)"
                >
                    {{ item.meta.categoryName }}
                </a>
                <span
                    v-else
                    :class="themeTokens.articleList.metaCategory"
                >{{ item.meta.categoryName }}</span>
                <span
                    v-if="item.tags.length"
                    :class="`${themeTokens.articleList.metaSeparator} hidden sm:inline`"
                    aria-hidden="true"
                >{{ publicPeriodMotif.metadata.glyph }}</span>
                <span
                    v-for="tag in item.tags"
                    :key="tag.label"
                    :class="tag.hiddenOnMobile ? 'hidden sm:inline-flex' : 'inline-flex'"
                >
                    <a
                        :href="tag.href"
                        class="public-article-tag el-tag el-tag--small el-tag--light inline-flex min-h-[32px] items-center px-2"
                        :class="themeTokens.focusRing"
                        data-public-link="tag"
                        @click="handleNavigate($event, tag.href)"
                    >
                        {{ tag.label }}
                    </a>
                </span>
            </div>

            <h2 :class="themeTokens.articleList.title">
                <a
                    :href="item.href"
                    :class="themeTokens.articleList.titleLink"
                    data-public-link="article"
                    @click="handleNavigate($event, item.href)"
                >
                    {{ item.title }}
                </a>
            </h2>

            <p :class="themeTokens.articleList.summary">
                {{ item.summary }}
            </p>

            <a
                v-if="showReadCta"
                :href="item.href"
                :class="themeTokens.articleList.readLink"
                :aria-label="`阅读全文：${item.title}`"
                data-public-link="article"
                @click="handleNavigate($event, item.href)"
            >
                阅读<ElIcon aria-hidden="true"><ArrowRight /></ElIcon>
            </a>
        </article>
    </div>

    <nav
        v-if="showPagination"
        :class="themeTokens.articleList.pagination"
        aria-label="文章分页"
    >
        <a
            v-if="!pagination.previous.disabled"
            :href="pagination.previous.href"
            :class="paginationButtonClass"
            data-aot-action="page-prev"
            :data-aot-value="pagination.previous.action?.value"
            @click="handlePrev"
        >
            {{ pagination.previous.label }}
        </a>
        <span
            v-else
            :class="paginationButtonClass"
            aria-disabled="true"
        >{{ pagination.previous.label }}</span>
        <span :class="themeTokens.articleList.paginationIndicator">{{ pagination.indicator }}</span>
        <a
            v-if="!pagination.next.disabled"
            :href="pagination.next.href"
            :class="paginationButtonClass"
            data-aot-action="page-next"
            :data-aot-value="pagination.next.action?.value"
            @click="handleNext"
        >
            {{ pagination.next.label }}
        </a>
        <span
            v-else
            :class="paginationButtonClass"
            aria-disabled="true"
        >{{ pagination.next.label }}</span>
    </nav>
</template>

<script setup lang="ts">
import { ArrowRight } from '@/fsusui/icons';
import type { PaginationContract } from '@/ui-contracts/primitives';
import { publicPeriodMotif } from '@/ui-contracts/publicPeriodMotif';
import { themeTokens } from '@/ui-tokens/themeTokens';
import type { ArticleListCardViewContract } from '@/view-contracts/articleList';

const props = withDefaults(defineProps<{
    spaNavigation?: boolean;
    showReadCta?: boolean;
    presentation?: 'default' | 'home-feed';
    items: readonly ArticleListCardViewContract[];
    pagination: PaginationContract;
    showPagination: boolean;
}>(), {
    spaNavigation: false,
    showReadCta: true,
    presentation: 'default'
});

const emit = defineEmits<{
    (event: 'navigate', href: string): void;
    (event: 'page-prev'): void;
    (event: 'page-next'): void;
}>();

const paginationButtonClass = [
    'inline-flex min-h-10 items-center justify-center rounded-[var(--fsusblog-radius-control)] px-0 text-sm font-bold tracking-normal text-[var(--fsusblog-color-primary)] outline-none transition-fsus transition-fsus-fast hover:text-[var(--fsusblog-text-primary)] aria-disabled:cursor-not-allowed aria-disabled:text-[var(--fsusblog-text-muted)]',
    themeTokens.focusRing
].join(' ');

function handleNavigate(event: MouseEvent, href?: string): void
{
    if (!href)
    {
        return;
    }

    if (!props.spaNavigation)
    {
        return;
    }

    event.preventDefault();
    emit('navigate', href);
}

function handlePrev(event: MouseEvent): void
{
    if (!props.spaNavigation || props.pagination.previous.disabled)
    {
        return;
    }

    event.preventDefault();
    emit('page-prev');
}

function handleNext(event: MouseEvent): void
{
    if (!props.spaNavigation || props.pagination.next.disabled)
    {
        return;
    }

    event.preventDefault();
    emit('page-next');
}
</script>

<style scoped>
.ui-article-list[data-public-article-presentation='home-feed']
 {
    gap: 40px;
}

.ui-article-list[data-public-article-presentation='home-feed'] .ui-article-card
 {
    gap: 16px;
}

.ui-article-list[data-public-article-presentation='home-feed'] .ui-article-meta
 {
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    font-weight: 500;
    line-height: 1.5;
}

.ui-article-list[data-public-article-presentation='home-feed'] .ui-article-title
 {
    color: var(--fsusblog-text-heading);
    font-size: 18px;
    font-weight: 700;
    line-height: 1.25;
}

.ui-article-list[data-public-article-presentation='home-feed'] .ui-article-summary
 {
    margin-top: 8px;
    color: var(--fsusblog-text-secondary);
    font-size: 14px;
    font-weight: 400;
    line-height: 1.6;
}

.public-article-tag
 {
    min-height: 32px;
    padding-inline: 8px;
}

.public-article-tag:focus-visible
 {
    box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
    outline: none;
}
</style>
