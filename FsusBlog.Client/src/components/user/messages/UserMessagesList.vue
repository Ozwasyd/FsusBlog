<template>
  <div class="space-y-10 sm:space-y-12">
    <TransitionGroup name="list-fade" tag="div" class="relative">
      <article
        v-for="item in view.items"
        :key="item.id"
        class="group relative pt-10 border-t border-[#F4F4F5] first:border-t-0 sm:first:border-t transition-all duration-500"
        :class="{ 'opacity-50 grayscale-[0.8]': item.isRead }"
      >
        <div class="flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-start mb-6">
          <div class="flex min-w-0 flex-wrap items-center gap-3 sm:gap-5">
            <div v-if="!item.isRead" :class="tokens.unreadDot" aria-hidden="true" />
            <span
              class="text-[9px] font-bold uppercase tracking-normal px-2 py-0.5 rounded-xs border"
              :class="item.category.badgeClassName"
            >
              {{ item.category.label }}
            </span>
          </div>
          <time
            :datetime="item.time.isoTime"
            :title="item.time.fullText"
            class="text-[10px] font-mono font-bold text-[#D4D4D8] uppercase tracking-normal shrink-0 pt-0.5"
          >
            {{ item.time.smartText }}
          </time>
        </div>

        <div class="space-y-3 pr-0 sm:pr-12">
          <h3 class="text-base sm:text-lg font-bold tracking-normal text-[#0F0F11] leading-snug">
            {{ item.preview.title }}
          </h3>
          <p class="text-[#8E8E93] text-sm leading-relaxed whitespace-pre-wrap wrap-break-word">
            {{ item.preview.content }}
          </p>
        </div>

        <div class="action-row justify-start pt-2 sm:justify-end">
          <button
            v-if="item.actions.canMarkRead"
            type="button"
            class="text-[9px] font-bold uppercase tracking-normal text-[#0F0F11] underline underline-offset-8 decoration-[#E4E4E7] hover:decoration-[#0F0F11] transition-all py-3 outline-none focus-visible:decoration-[#0F0F11]"
            @click="emit('mark-read', item.id)"
          >
            我知道了
          </button>
          <button
            v-if="item.actions.canDelete"
            type="button"
            class="text-[9px] font-bold uppercase tracking-normal text-[#D4D4D8] hover:text-red-500 transition-colors duration-300 py-3 active:scale-95 outline-none focus-visible:text-red-500"
            @click="emit('request-delete', item.id)"
          >
            删除
          </button>
        </div>
      </article>
    </TransitionGroup>

    <div v-if="view.footer.showLoadMoreButton" class="pt-12 border-t border-[#0F0F11] flex justify-center">
      <button
        type="button"
        :disabled="view.footer.loadingMore"
        class="w-full sm:w-auto px-6 sm:px-12 py-4 sm:py-3 border border-[#0F0F11] text-[10px] font-black tracking-normal uppercase transition-all duration-300 hover:bg-[#0F0F11] hover:text-white disabled:opacity-30 outline-none focus-visible:ring-2 focus-visible:ring-[#0F0F11]"
        @click="emit('load-more')"
      >
        <span :class="{ 'animate-pulse': view.footer.loadingMore }">{{ view.footer.loadMoreButtonText }}</span>
      </button>
    </div>

    <p v-else-if="view.footer.showEndHint" class="pt-12 border-t border-[#F4F4F5] text-[9px] font-bold tracking-normal text-[#D4D4D8] uppercase">
      {{ view.footer.endHintText }}
    </p>
  </div>
</template>

<script setup lang="ts">
import type { UserMessagesPageViewContract } from '@/view-contracts/userMessages'
import { userMessagesTokens } from '@/view-contracts/userMessages'

const tokens = userMessagesTokens

defineProps<{
  view: UserMessagesPageViewContract
}>()

const emit = defineEmits<{
  'mark-read': [id: string]
  'request-delete': [id: string]
  'load-more': []
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

.wrap-break-word {
  overflow-wrap: break-word;
  word-break: break-word;
}
</style>
