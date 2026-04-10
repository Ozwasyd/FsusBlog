<template>
  <div class="max-w-3xl mx-auto w-full py-10 sm:py-16 px-6 sm:px-8 antialiased">
    <UserMessagesHeader :view="pageView.header" @read-all="handleReadAll" />

    <UserMessagesEmptyState v-if="!loading && pageView.items.length === 0" :view="pageView.emptyState" />

    <UserMessagesList
      v-else
      :view="pageView"
      @mark-read="handleMarkRead"
      @request-delete="requestDelete"
      @load-more="loadMore"
    />

    <!-- 模态框逻辑自洽 -->
    <ConfirmModal 
      v-model:visible="showConfirm"
      title="移除通知"
      content="确定要将此通知移出您的收件箱吗？该操作无法撤销。"
      @confirm="executeDelete"
    />

  </div>
</template>

<script setup lang="ts">
import { useUserMessagesInbox } from '@/composables/useUserMessagesInbox'
import ConfirmModal from '@/components/ui/ConfirmModal.vue'
import UserMessagesEmptyState from '@/components/user/messages/UserMessagesEmptyState.vue'
import UserMessagesHeader from '@/components/user/messages/UserMessagesHeader.vue'
import UserMessagesList from '@/components/user/messages/UserMessagesList.vue'

const {
  pageView,
  loading,
  showConfirm,
  handleReadAll,
  handleMarkRead,
  requestDelete,
  executeDelete,
  loadMore
} = useUserMessagesInbox()
</script>

<style scoped>
@reference "@/assets/main.css";

.antialiased {
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}

@media (min-width: 1080px) {
  p {
    line-height: 1.8;
    letter-spacing: 0.015em;
  }
}
</style>
