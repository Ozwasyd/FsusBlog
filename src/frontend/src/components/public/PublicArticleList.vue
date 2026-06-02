<template>
  <div :class="themeTokens.articleList.container">
    <article
      v-for="item in items"
      :key="item.id"
      v-memo="[item.id, item.title, item.summary, item.meta.displayTime, item.meta.categoryName]"
      :class="themeTokens.articleList.card"
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
        <UiTag
          v-for="tag in item.tags"
          :key="tag.label"
          :label="tag.label"
          :hidden-on-mobile="tag.hiddenOnMobile"
        />
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
    <el-button
      link
      type="primary"
      :disabled="pagination.previous.disabled"
      data-aot-action="page-prev"
      :data-aot-value="pagination.previous.action?.value"
      @click="handlePrev"
    >
      {{ pagination.previous.label }}
    </el-button>
    <span :class="themeTokens.articleList.paginationIndicator">{{ pagination.indicator }}</span>
    <el-button
      link
      type="primary"
      :disabled="pagination.next.disabled"
      data-aot-action="page-next"
      :data-aot-value="pagination.next.action?.value"
      @click="handleNext"
    >
      {{ pagination.next.label }}
    </el-button>
  </nav>
</template>

<script setup lang="ts">
import { UiTag } from '@/components/ui';
import { themeTokens } from '@/ui-tokens/themeTokens';
import { ArrowRight } from '@/ui/fsusIcons';
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
