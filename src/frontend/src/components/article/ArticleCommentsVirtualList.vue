<template>
  <div class="space-y-8">
    <article
      v-for="thread in threadItems"
      :key="thread.id"
      :class="commentDetailTokens.articleList.itemRoot"
    >
      <div :class="commentDetailTokens.articleList.headerRoot">
        <div :class="commentDetailTokens.articleList.headerMeta">
          <span :class="commentDetailTokens.articleList.authorName">{{ thread.userName }}</span>
          <el-button
            link
            @click="$emit('reply', { id: thread.id, rootId: thread.rootId, userName: thread.userName, depth: 0 })"
          >
            回复
          </el-button>
          <el-button
            v-if="thread.canDelete"
            link
            type="danger"
            aria-label="删除评论"
            @click="$emit('delete', { id: thread.id, rootId: thread.rootId, parentId: null })"
          >
            删除
          </el-button>
        </div>
        <span
          :class="commentDetailTokens.articleList.timeText"
          :title="thread.time.fullLocalTimeText"
          :datetime="thread.time.isoTime"
        >
          {{ thread.time.relativeTimeText }}
        </span>
      </div>
      <p :class="commentDetailTokens.articleList.content">{{ thread.content }}</p>

      <section v-if="thread.replies.length > 0 || thread.hasMoreReplies" class="mt-5 border-l border-[var(--fsusblog-panel-border)] pl-4 sm:pl-5 space-y-4">
        <div
          v-for="reply in thread.replies"
          :key="reply.id"
          class="space-y-1"
        >
          <div class="flex items-center gap-2 text-[11px] text-[var(--fsusblog-text-muted)]">
            <strong class="text-[var(--fsusblog-text-secondary)]">{{ reply.userName }}</strong>
            <span v-if="reply.replyToUserName">回复 @{{ reply.replyToUserName }}</span>
            <span>{{ reply.time.relativeTimeText }}</span>
            <el-button
              link
              @click="$emit('reply', { id: reply.id, rootId: thread.rootId, userName: reply.userName, depth: 1 })"
            >
              回复
            </el-button>
            <el-button
              v-if="reply.canDelete"
              link
              type="danger"
              @click="$emit('delete', { id: reply.id, rootId: thread.rootId, parentId: thread.id })"
            >
              删除
            </el-button>
          </div>
          <p class="text-sm text-[var(--fsusblog-text-tertiary)] leading-relaxed whitespace-pre-wrap break-words">{{ reply.content }}</p>
        </div>

        <el-button
          v-if="thread.hasMoreReplies"
          link
          :disabled="isThreadRepliesLoading(thread.rootId)"
          :loading="isThreadRepliesLoading(thread.rootId)"
          @click="$emit('load-more-replies', thread.rootId)"
        >
          {{ isThreadRepliesLoading(thread.rootId) ? '加载中...' : '展开更多回复' }}
        </el-button>
      </section>
    </article>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { CommentReplyPreviewItem, CommentThreadItem } from '@/api/comment'
import { commentDetailTokens, type CommentTimeContract } from '@/view-contracts/commentDetail'
import { TimeUtils } from '@/utils/time'

type ReplyTargetPayload = {
  id: string
  rootId: string
  userName: string
  depth: number
}

type DeletePayload = {
  id: string
  rootId: string
  parentId: string | null
}

const props = defineProps<{
  threads: CommentThreadItem[]
  isAdmin: boolean
  isLoggedIn: boolean
  currentUsername: string | null
  loadingReplies: Record<string, boolean>
}>()

defineEmits<{
  (e: 'delete', payload: DeletePayload): void
  (e: 'reply', payload: ReplyTargetPayload): void
  (e: 'load-more-replies', rootId: string): void
}>()

const canDeleteForUser = (userName: string): boolean =>
  props.isAdmin || (props.isLoggedIn && String(userName) === String(props.currentUsername ?? ''))

const buildTime = (iso: string): CommentTimeContract => ({
  isoTime: iso,
  relativeTimeText: TimeUtils.toRelative(iso),
  fullLocalTimeText: TimeUtils.toFullLocalString(iso)
})

const threadItems = computed(() => props.threads.map((thread) => ({
  ...thread,
  canDelete: canDeleteForUser(thread.userName),
  time: buildTime(thread.createTime),
  replies: thread.repliesPreview.map((reply: CommentReplyPreviewItem) => ({
    ...reply,
    canDelete: canDeleteForUser(reply.userName),
    time: buildTime(reply.createTime)
  }))
})))

const isThreadRepliesLoading = (rootId: string): boolean => props.loadingReplies[rootId] === true
</script>
