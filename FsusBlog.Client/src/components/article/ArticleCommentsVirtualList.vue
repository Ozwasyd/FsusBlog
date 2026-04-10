<template>
  <div
    v-for="comment in commentItems"
    :key="comment.id"
    :class="commentDetailTokens.articleList.itemRoot"
  >
    <div :class="commentDetailTokens.articleList.headerRoot">
      <div :class="commentDetailTokens.articleList.headerMeta">
        <span :class="commentDetailTokens.articleList.authorName">{{ comment.userName }}</span>
        <button
          v-if="comment.canDelete"
          aria-label="删除评论"
          :class="commentDetailTokens.articleList.deleteButton"
          @click="$emit('delete', comment.id)"
        >
          [删除]
        </button>
      </div>
      <span
        :class="commentDetailTokens.articleList.timeText"
        :title="comment.time.fullLocalTimeText"
        :datetime="comment.time.isoTime"
      >
        {{ comment.time.relativeTimeText }}
      </span>
    </div>
    <p :class="commentDetailTokens.articleList.content">
      {{ comment.content }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { CommentItem } from '@/api/comment';
import {
  commentDetailTokens,
  createArticleCommentViewContract,
  type CommentThreadItemContract
} from '@/view-contracts/commentDetail'

const props = defineProps<{
  comments: CommentItem[];
  isAdmin: boolean;
  isLoggedIn: boolean;
  currentUsername: string | null;
}>();

defineEmits<{
  (e: 'delete', id: string): void;
}>();

const commentItems = computed<CommentThreadItemContract[]>(() =>
  props.comments.map((comment) =>
    createArticleCommentViewContract(comment, props.isAdmin || (props.isLoggedIn && String(comment.userName) === String(props.currentUsername ?? '')))
  )
)
</script>
