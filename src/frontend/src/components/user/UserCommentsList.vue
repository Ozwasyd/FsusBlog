<template>
  <transition name="fade-fast" appear>
    <div :class="themeTokens.userComments.list">
      <transition-group name="list-fade" tag="div" class="relative">
      <article
        v-for="item in list"
        :key="item.id"
        :class="themeTokens.userComments.item"
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
            aria-label="删除此评论"
            @click="$emit('delete', item.id)"
          >
            删除
          </el-button>
        </div>
      </article>
    </transition-group>

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
  </transition>
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
  .fade-fast-enter-active,
  .fade-fast-leave-active {
  transition: opacity var(--fsus-motion-control) var(--fsus-motion-standard);
  }

.fade-fast-enter-from,
.fade-fast-leave-to {
  opacity: 0;
}

.list-fade-enter-active,
.list-fade-leave-active {
  transition: opacity var(--fsus-motion-control-fast) var(--fsus-motion-standard),
    transform var(--fsus-motion-control-fast) var(--fsus-motion-standard);
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

@media (prefers-reduced-motion: reduce) {
  .fade-fast-enter-active,
  .fade-fast-leave-active,
  .list-fade-enter-active,
  .list-fade-leave-active {
    transition: none;
  }
}
</style>
