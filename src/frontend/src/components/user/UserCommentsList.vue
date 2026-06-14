<template>
  <div :class="themeTokens.userComments.list">
    <div class="relative" role="list" aria-label="评论历史列表">
      <article
        v-for="item in list"
        :key="item.id"
        :class="themeTokens.userComments.item"
        role="listitem"
      >
        <div :class="themeTokens.userComments.itemHeader">
          <div class="space-y-1.5 grow pr-0 sm:pr-8">
            <span :class="themeTokens.userComments.articleLabel">回复文章</span>
            <router-link
              v-if="item.article"
              :to="item.article.route"
              :aria-label="item.article.ariaLabel"
              :class="themeTokens.userComments.articleLink"
            >
              {{ item.article.title }}
            </router-link>
          </div>
          <time
            :datetime="item.time.isoTime"
            :title="item.time.fullLocalTimeText"
            :class="themeTokens.userComments.time"
          >
            {{ item.time.relativeTimeText }}
          </time>
        </div>

        <p :class="themeTokens.userComments.content">
          {{ item.content }}
        </p>

        <div class="flex justify-end">
          <el-button
            link
            type="danger"
            class="user-comment-delete-button"
            aria-label="删除此评论"
            @click="$emit('delete', item.id)"
          >
            删除
          </el-button>
        </div>
      </article>
    </div>

    <div :class="themeTokens.userComments.footer">
      <el-button
        v-if="showLoadMoreButton"
        :disabled="loading"
        :loading="loading"
        @click="$emit('load-more')"
      >
        {{ loadMoreButtonText }}
      </el-button>
      <span v-else-if="showEndHint" :class="themeTokens.userComments.endHint">
        {{ endHintText }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { CommentThreadItemContract } from '@/view-contracts/commentDetail'
import { themeTokens } from '@/ui-tokens'

defineProps<{
  list: CommentThreadItemContract[];
  loading: boolean;
  showLoadMoreButton: boolean;
  showEndHint: boolean;
  loadMoreButtonText: string;
  endHintText: string;
}>()

defineEmits<{
  (e: 'delete', id: string): void;
  (e: 'load-more'): void;
}>()
</script>

<style scoped>
.user-comment-delete-button {
  min-width: 2.75rem;
  min-height: 2.25rem;
  padding-inline: 0.5rem;
}
</style>
