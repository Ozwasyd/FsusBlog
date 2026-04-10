<template>
  <div :class="commentDetailTokens.userList.root">
    <transition-group name="list-fade" tag="div" class="relative">
      <article
        v-for="item in list"
        :key="item.id"
        :class="commentDetailTokens.userList.itemRoot"
      >
        <div :class="commentDetailTokens.userList.headerRoot">
          <div :class="commentDetailTokens.userList.headerMeta">
            <span :class="commentDetailTokens.userList.articleLabel">回复文章</span>
            <router-link
              v-if="item.article"
              :to="item.article.route"
              :aria-label="item.article.ariaLabel"
              :class="commentDetailTokens.userList.articleLink"
            >
              {{ item.article.title }}
            </router-link>
          </div>
          <time
            :datetime="item.time.isoTime"
            :title="item.time.fullLocalTimeText"
            :class="commentDetailTokens.userList.timeText"
          >
            {{ item.time.relativeTimeText }}
          </time>
        </div>

        <p :class="commentDetailTokens.userList.content">
          {{ item.content }}
        </p>

        <div :class="commentDetailTokens.userList.deleteWrap">
          <button
            type="button"
            aria-label="删除此评论"
            :class="commentDetailTokens.userList.deleteButton"
            @click="$emit('delete', item.id)"
          >
            删除
          </button>
        </div>
      </article>
    </transition-group>

    <div :class="commentDetailTokens.userList.pageRoot">
      <button
        v-if="showLoadMoreButton"
        type="button"
        :disabled="loading"
        :class="commentDetailTokens.userList.loadMoreButton"
        @click="$emit('load-more')"
      >
        <span :class="{ [commentDetailTokens.userList.loadMoreLoading]: loading }">{{ loadMoreButtonText }}</span>
      </button>
      <span v-else-if="showEndHint" :class="commentDetailTokens.userList.endHint">
        {{ endHintText }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { CommentThreadItemContract } from '@/view-contracts/commentDetail'
import { commentDetailTokens } from '@/view-contracts/commentDetail'

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
.list-fade-enter-active,
.list-fade-leave-active {
  transition: all 0.5s cubic-bezier(0.16, 1, 0.3, 1);
  will-change: transform, opacity;
}

.list-fade-enter-from {
  opacity: 0;
  transform: translateY(20px);
}

.list-fade-leave-to {
  opacity: 0;
  transform: translateX(30px);
}

.list-fade-leave-active {
  position: absolute;
  width: 100%;
}

@media (max-width: 640px) {
  .list-fade-leave-active {
    width: calc(100% - 3rem);
  }
}

</style>
