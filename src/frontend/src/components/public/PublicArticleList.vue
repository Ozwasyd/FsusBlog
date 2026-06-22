<template>
  <div :class="themeTokens.articleList.container" data-fsus-surface="reading">
    <article
      v-for="(item, index) in items"
      :key="item.id"
      v-memo="[item.id, item.title, item.summary, item.meta.displayTime, item.meta.categoryName]"
      :class="themeTokens.articleList.card"
      :data-fsus-motion-index="index"
      data-fsus-motion-surface="article-card"
    >
      <div :class="themeTokens.articleList.metaRow">
        <time :datetime="item.meta.isoTime" :title="item.meta.fullTime" class="tabular-nums">
          {{ item.meta.displayTime }}
        </time>
        <span :class="themeTokens.articleList.metaSeparator" aria-hidden="true">/</span>
        <span :class="themeTokens.articleList.metaCategory">{{ item.meta.categoryName }}</span>
        <span
          v-if="item.tags.length"
          :class="`${themeTokens.articleList.metaSeparator} hidden sm:inline`"
          aria-hidden="true"
        >/</span>
        <span
          v-for="tag in item.tags"
          :key="tag.label"
          :class="tag.hiddenOnMobile ? 'hidden sm:inline-flex' : 'inline-flex'"
        >
          <span class="public-article-tag el-tag el-tag--small el-tag--light">
            {{ tag.label }}
          </span>
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
        :href="item.href"
        :class="themeTokens.articleList.readLink"
        :aria-label="`阅读全文：${item.title}`"
        data-public-link="article"
        @click="handleNavigate($event, item.href)"
      >
        阅读<el-icon aria-hidden="true"><ArrowRight /></el-icon>
      </a>
    </article>
  </div>

  <nav v-if="showPagination" :class="themeTokens.articleList.pagination" aria-label="文章分页">
    <button
      type="button"
      :class="paginationButtonClass"
      :disabled="pagination.previous.disabled"
      data-aot-action="page-prev"
      :data-aot-value="pagination.previous.action?.value"
      @click="handlePrev"
    >
      {{ pagination.previous.label }}
    </button>
    <span :class="themeTokens.articleList.paginationIndicator">{{ pagination.indicator }}</span>
    <button
      type="button"
      :class="paginationButtonClass"
      :disabled="pagination.next.disabled"
      data-aot-action="page-next"
      :data-aot-value="pagination.next.action?.value"
      @click="handleNext"
    >
      {{ pagination.next.label }}
    </button>
  </nav>
</template>

<script setup lang="ts">
import { themeTokens } from '@/ui-tokens/themeTokens';
import { ArrowRight } from '@/fsusui/icons';
import type { ArticleListCardViewContract } from '@/view-contracts/articleList';
import type { PaginationContract } from '@/ui-contracts/primitives';

const props = withDefaults(defineProps<{
  spaNavigation?: boolean;
  items: readonly ArticleListCardViewContract[];
  pagination: PaginationContract;
  showPagination: boolean;
}>(), {
  spaNavigation: false
});

const emit = defineEmits<{
  (event: 'navigate', href: string): void;
  (event: 'page-prev'): void;
  (event: 'page-next'): void;
}>();

const paginationButtonClass = [
  'inline-flex min-h-10 items-center justify-center rounded-[var(--fsusblog-reading-radius-control)] px-0 text-sm font-bold tracking-normal text-[var(--fsusblog-color-primary)] outline-none transition-colors duration-[var(--fsus-motion-control-fast)] hover:text-[var(--fsusblog-text-primary)] disabled:cursor-not-allowed disabled:text-[var(--fsusblog-text-subtle)]',
  themeTokens.focusRing
].join(' ');

function handleNavigate(event: MouseEvent, href: string): void {
  if (!props.spaNavigation) {
    return;
  }

  event.preventDefault();
  emit('navigate', href);
}

function handlePrev(event: MouseEvent): void {
  if (!props.spaNavigation || props.pagination.previous.disabled) {
    return;
  }

  event.preventDefault();
  emit('page-prev');
}

function handleNext(event: MouseEvent): void {
  if (!props.spaNavigation || props.pagination.next.disabled) {
    return;
  }

  event.preventDefault();
  emit('page-next');
}
</script>
