<template>
    <div data-fsus-surface="reading">
        <h1
            :class="themeTokens.articleDetail.title"
            itemprop="headline"
        >
            {{ view.title }}
        </h1>

        <div
            :class="themeTokens.articleDetail.metaRow"
            data-article-metadata
        >
            <span
                class="article-detail-metadata__group article-detail-metadata__group--dates"
                data-article-metadata-group="dates"
            >
                <span class="article-detail-metadata__unit article-detail-metadata__unit--fixed">
                    <span>{{ messages.article.metadata.publishedAt }}</span>
                    <time
                        :datetime="view.meta.published.isoTime"
                        :title="view.meta.published.fullTime"
                        itemprop="datePublished"
                    >
                        {{ view.meta.published.displayTime }}
                    </time>
                </span>
                <span
                    v-if="view.meta.modified"
                    class="article-detail-metadata__unit article-detail-metadata__unit--fixed"
                >
                    <span
                        :class="themeTokens.articleDetail.metaSeparator"
                        aria-hidden="true"
                    >{{ publicPeriodMotif.metadata.glyph }}</span>
                    <span>{{ messages.article.metadata.updatedAt }}</span>
                    <time
                        :datetime="view.meta.modified.isoTime"
                        :title="view.meta.modified.fullTime"
                        itemprop="dateModified"
                    >
                        {{ view.meta.modified.displayTime }}
                    </time>
                </span>
            </span>

            <span
                class="article-detail-metadata__group article-detail-metadata__group--context"
                data-article-metadata-group="context"
            >
                <component
                    :is="categoryComponent"
                    v-if="view.meta.categoryHref"
                    v-bind="categoryLinkProps"
                    :class="[
                        themeTokens.articleDetail.categoryLink,
                        'article-detail-metadata__unit',
                    ]"
                    data-public-link="filter"
                    itemprop="articleSection"
                >
                    {{ view.meta.categoryName }}
                </component>
                <span
                    v-else
                    :class="[
                        themeTokens.articleDetail.categoryText,
                        'article-detail-metadata__unit',
                    ]"
                    itemprop="articleSection"
                >
                    {{ view.meta.categoryName }}
                </span>

                <span class="article-detail-metadata__unit article-detail-metadata__unit--fixed">
                    <span
                        :class="themeTokens.articleDetail.metaSeparator"
                        aria-hidden="true"
                    >{{ publicPeriodMotif.metadata.glyph }}</span>
                    <span data-visual-dynamic>{{ view.viewsText }}</span>
                </span>
            </span>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { useI18nText } from '@/composables/useI18nText';
import { publicPeriodMotif } from '@/ui-contracts/publicPeriodMotif';
import { themeTokens } from '@/ui-tokens/themeTokens';
import type { ArticleDetailHeaderViewContract } from '@/view-contracts/articleDetail';

const props = withDefaults(defineProps<{
    view: ArticleDetailHeaderViewContract;
    linkMode?: 'router' | 'anchor';
}>(), {
    linkMode: 'router'
});

const { messages } = useI18nText();

const categoryComponent = computed(() => (
    props.linkMode === 'anchor'
        ? 'a'
        : 'RouterLink'
));

const categoryLinkProps = computed(() =>
{
    if (!props.view.meta.categoryHref)
    {
        return {};
    }

    return props.linkMode === 'anchor'
        ? { href: props.view.meta.categoryHref }
        : { to: props.view.meta.categoryHref };
});
</script>

<style scoped>
.article-detail-metadata__group
 {
    display: inline-flex;
    min-width: 0;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
}

.article-detail-metadata__unit
 {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    column-gap: 4px;
}

.article-detail-metadata__unit--fixed
 {
    flex: none;
    white-space: nowrap;
}
</style>
