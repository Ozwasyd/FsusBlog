<template>
  <div class="max-w-3xl mx-auto w-full py-10 sm:py-16 px-6 sm:px-8 antialiased">
    
    <header class="mb-12 sm:mb-20">
      <div class="flex justify-between items-end">
        <div>
          <div class="text-[9px] sm:text-[10px] font-bold tracking-[0.3em] text-zinc-400 uppercase mb-4">
            收件箱
          </div>
          <h1 class="text-3xl sm:text-5xl font-bold tracking-tighter text-zinc-950 mb-3 sm:mb-4">
            通知中心
          </h1>
          <p class="text-[9px] font-mono font-bold text-zinc-400 uppercase tracking-[0.2em]">
            {{ unreadCount }} 未阅读
          </p>
        </div>
        <button 
          v-if="unreadCount > 0"
          @click="handleReadAll"
          class="text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-400 hover:text-zinc-950 transition-colors duration-300 pb-1 border-b border-transparent hover:border-zinc-950"
        >
          全部标记已读
        </button>
      </div>
    </header>

    <div v-if="!loading && messages.length === 0" class="py-20 border-t border-zinc-100">
      <p class="text-[11px] font-bold tracking-[0.2em] text-zinc-300 uppercase text-center">
        无消息。
      </p>
    </div>

    <div v-else class="space-y-10 sm:space-y-12">
      <TransitionGroup name="list-fade" tag="div" class="relative">
        <article 
          v-for="item in messages" 
          :key="item.id"
          class="group relative pt-10 border-t border-zinc-100 first:border-t-0 sm:first:border-t transition-all duration-500"
          :class="{ 'opacity-50 grayscale-[0.8]': item.isRead }"
        >
          <div class="flex justify-between items-start mb-6">
            <div class="flex items-center gap-3">
              <div 
                v-if="!item.isRead"
                class="w-1.5 h-1.5 rounded-full bg-zinc-950 animate-pulse"
              ></div>
              <span 
                class="text-[9px] font-bold uppercase tracking-[0.2em] px-2 py-0.5 rounded-xs border"
                :class="getCategoryStyle(item.category)"
              >
                {{ getCategoryName(item.category) }}
              </span>
            </div>
            <time 
              :datetime="item.createTime"
              :title="TimeUtils.toFullLocalString(item.createTime)"
              class="text-[10px] font-mono font-bold text-zinc-300 uppercase tracking-widest shrink-0 pt-0.5"
            >
              {{ TimeUtils.toSmartTime(item.createTime) }}
            </time>
          </div>

          <div class="space-y-3 pr-0 sm:pr-12">
            <h3 class="text-base sm:text-lg font-bold tracking-tight text-zinc-950 leading-snug">
              {{ item.title }}
            </h3>
            <p class="text-zinc-500 text-sm leading-relaxed whitespace-pre-wrap wrap-break-word">
              {{ item.content }}
            </p>
          </div>

          <div class="flex justify-end gap-6 items-center pt-2">
            <button 
              v-if="!item.isRead"
              @click="handleMarkRead(item.id)"
              class="text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-950 underline underline-offset-8 decoration-zinc-200 hover:decoration-zinc-950 transition-all py-3"
            >
              我知道了
            </button>
            <button 
              v-if="item.category !== MessageCategory.Broadcast"
              @click="requestDelete(item.id)"
              class="text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-300 hover:text-red-500 transition-colors duration-300 py-3 active:scale-95"
            >
              删除
            </button>
          </div>
        </article>
      </TransitionGroup>

      <div v-if="hasMore || loading" class="pt-12 border-t border-zinc-950 flex justify-center">
        <button 
          @click="loadMore"
          :disabled="loading"
          class="w-full sm:w-auto px-12 py-4 sm:py-3 border border-zinc-950 text-[10px] font-black tracking-[0.3em] uppercase transition-all duration-300 hover:bg-zinc-950 hover:text-white disabled:opacity-30"
        >
          {{ loading ? '同步中...' : '加载更多消息' }}
        </button>
      </div>
      <div v-else-if="messages.length > 0" class="pt-12 border-t border-zinc-100 text-center">
        <span class="text-[9px] font-bold tracking-[0.3em] text-zinc-300 uppercase">
          上面的消息已为最后一条消息。
        </span>
      </div>
    </div>

    <ConfirmModal 
      v-model:visible="showConfirm"
      title="移除通知"
      content="确定要将此通知移出您的收件箱吗？该操作无法撤销。"
      @confirm="executeDelete"
    />

  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useNotification } from '@/composables/useNotification'
import { messageApi, MessageCategory, type MessageItem } from '@/api/message' 
import { toast } from '@/utils/toast'
import { TimeUtils } from '@/utils/time'
import ConfirmModal from '@/components/ui/ConfirmModal.vue' 

const { unreadCount } = useNotification()

const messages = ref<MessageItem[]>([])
const loading = ref(false)
const page = ref(1)
const hasMore = ref(true)

const showConfirm = ref(false)
const pendingDeleteId = ref<string | null>(null)

/**
 * 🌟 核心：支持静默更新的消息抓取逻辑
 */
const fetchMessages = async (isLoadMore = false, silent = false) => {
  if (loading.value) return
  if (!silent) loading.value = true
  
  try {
    const targetPage = isLoadMore ? page.value : 1;
    const data = await messageApi.getInbox(targetPage, 10)
    
    if (isLoadMore) {
      messages.value.push(...data)
    } else {
      messages.value = data
    }
    hasMore.value = data.length === 10
  } catch (err: any) {
    console.error('[Inbox] Sync Error:', err)
  } finally {
    loading.value = false
  }
}

/**
 * 🌟 响应 SignalR 刷新指令
 */
const handleRefreshInbox = () => {
  console.log("[SignalR] 信令驱动刷新：从服务端同步最新状态...");
  fetchMessages(false, true);
}

const getCategoryStyle = (category: number) => {
  switch (category) {
    case MessageCategory.Broadcast: 
      return 'bg-zinc-950 text-white border-zinc-950'
    default: 
      return 'bg-white text-zinc-400 border-zinc-200'
  }
}

const getCategoryName = (category: number) => {
  if (category === MessageCategory.Broadcast) return '公告'
  if (category === MessageCategory.SystemTask) return '系统'
  return '管理员通知'
}

const handleMarkRead = async (id: string) => {
  const item = messages.value.find(m => String(m.id) === String(id))
  if (!item || item.isRead) return
  try {
    item.isRead = true
    if (unreadCount.value > 0) unreadCount.value-- 
    await messageApi.markAsRead(id)
  } catch (err: any) {
    item.isRead = false
    unreadCount.value++ 
    toast.error('操作失败')
  }
}

const handleReadAll = async () => {
  if (unreadCount.value === 0) return
  const previousCount = unreadCount.value
  try {
    unreadCount.value = 0
    messages.value.forEach(m => m.isRead = true)
    await messageApi.markAllRead()
    toast.success('已标记全部')
  } catch (err: any) {
    unreadCount.value = previousCount
    fetchMessages() 
  }
}

const requestDelete = (id: string) => {
  pendingDeleteId.value = id
  showConfirm.value = true
}

const executeDelete = async () => {
  if (!pendingDeleteId.value) return
  const id = pendingDeleteId.value
  const item = messages.value.find(m => String(m.id) === String(id))
  const wasUnread = item && !item.isRead
  const originalList = [...messages.value]

  messages.value = messages.value.filter(m => String(m.id) !== String(id))
  if (wasUnread && unreadCount.value > 0) unreadCount.value--
  
  try {
    await messageApi.deleteMessage(id)
    toast.success('已移除')
  } catch (err: any) {
    messages.value = originalList
    if (wasUnread) unreadCount.value++
    toast.error(err.message || '操作受限')
  } finally {
    pendingDeleteId.value = null
  }
}

const loadMore = () => {
  page.value++
  fetchMessages(true)
}

onMounted(() => {
  fetchMessages()
  window.addEventListener('signalr:refresh-inbox', handleRefreshInbox)
})

onUnmounted(() => {
  window.removeEventListener('signalr:refresh-inbox', handleRefreshInbox)
})
</script>

<style scoped>
@reference "@/assets/main.css";

.antialiased {
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}

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

@media (min-width: 1080px) {
  p {
    line-height: 1.8;
    letter-spacing: 0.015em;
  }
}
</style>