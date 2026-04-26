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
          <button
            type="button"
            class="rounded-[8px] text-[10px] font-bold text-[#8E8E93] hover:text-[#2A599C] uppercase outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]"
            @click="$emit('reply', { id: thread.id, rootId: thread.rootId, userName: thread.userName, depth: 0 })"
          >
            回复
          </button>
          <button
            v-if="thread.canDelete"
            aria-label="删除评论"
            :class="commentDetailTokens.articleList.deleteButton"
            @click="$emit('delete', { id: thread.id, rootId: thread.rootId, parentId: null })"
          >
            [删除]
          </button>
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

      <section v-if="thread.replies.length > 0 || thread.hasMoreReplies" class="mt-5 border-l border-[#E4E4E7] pl-4 sm:pl-5 space-y-4">
        <div
          v-for="reply in thread.replies"
          :key="reply.id"
          class="space-y-1"
        >
          <div class="flex items-center gap-2 text-[11px] text-[#8E8E93]">
            <strong class="text-[#27272A]">{{ reply.userName }}</strong>
            <span v-if="reply.replyToUserName">回复 @{{ reply.replyToUserName }}</span>
            <span>{{ reply.time.relativeTimeText }}</span>
            <button
              type="button"
              class="rounded-[8px] font-bold text-[#8E8E93] hover:text-[#2A599C] uppercase outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]"
              @click="$emit('reply', { id: reply.id, rootId: thread.rootId, userName: reply.userName, depth: 1 })"
            >
              回复
            </button>
            <button
              v-if="reply.canDelete"
              type="button"
              class="rounded-[8px] font-bold text-red-400 hover:text-red-600 uppercase outline-none focus-visible:ring-2 focus-visible:ring-[#E5484D]"
              @click="$emit('delete', { id: reply.id, rootId: thread.rootId, parentId: thread.id })"
            >
              删除
            </button>
          </div>
          <p class="text-sm text-[#71717A] leading-relaxed whitespace-pre-wrap break-words">{{ reply.content }}</p>
        </div>

        <button
          v-if="thread.hasMoreReplies"
          type="button"
          class="rounded-[8px] text-[11px] font-bold text-[#8E8E93] hover:text-[#2A599C] uppercase outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]"
          :disabled="isThreadRepliesLoading(thread.rootId)"
          @click="$emit('load-more-replies', thread.rootId)"
        >
          {{ isThreadRepliesLoading(thread.rootId) ? '加载中...' : '展开更多回复' }}
        </button>
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
