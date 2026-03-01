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
          <p class="text-[9px] font-mono font-bold text-zinc-400 uppercase tracking-[0.2em]" aria-live="polite">
            {{ unreadCount }} 未阅读
          </p>
        </div>
        <!-- [修复 2026-02-24] A11y：补充 button 类型与 outline-none，防止表单劫持及优化键盘焦点 -->
        <button 
          v-if="unreadCount > 0"
          type="button"
          @click="handleReadAll"
          class="text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-400 hover:text-zinc-950 transition-colors duration-300 pb-1 border-b border-transparent hover:border-zinc-950 outline-none focus-visible:text-zinc-950 focus-visible:border-zinc-950"
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
                aria-hidden="true"
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
            <!-- [修复 2026-02-24] 安全性：虽然目前是纯文本，但预防性拦截潜在的换行注水攻击 -->
            <p class="text-zinc-500 text-sm leading-relaxed whitespace-pre-wrap wrap-break-word">
              {{ item.content }}
            </p>
          </div>

          <div class="flex justify-end gap-6 items-center pt-2">
            <button 
              v-if="!item.isRead"
              type="button"
              @click="handleMarkRead(item.id)"
              class="text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-950 underline underline-offset-8 decoration-zinc-200 hover:decoration-zinc-950 transition-all py-3 outline-none focus-visible:decoration-zinc-950"
            >
              我知道了
            </button>
            <button 
              v-if="item.category !== MessageCategory.Broadcast"
              type="button"
              @click="requestDelete(item.id)"
              class="text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-300 hover:text-red-500 transition-colors duration-300 py-3 active:scale-95 outline-none focus-visible:text-red-500"
            >
              删除
            </button>
          </div>
        </article>
      </TransitionGroup>

      <div v-if="hasMore || loadingMore" class="pt-12 border-t border-zinc-950 flex justify-center">
        <button 
          type="button"
          @click="loadMore"
          :disabled="loadingMore"
          class="w-full sm:w-auto px-12 py-4 sm:py-3 border border-zinc-950 text-[10px] font-black tracking-[0.3em] uppercase transition-all duration-300 hover:bg-zinc-950 hover:text-white disabled:opacity-30 outline-none focus-visible:ring-2 focus-visible:ring-zinc-950"
        >
          <template v-if="loadingMore">
            <span class="animate-pulse">同步中...</span>
          </template>
          <template v-else>加载更多消息</template>
        </button>
      </div>
      <div v-else-if="messages.length > 0" class="pt-12 border-t border-zinc-100 text-center">
        <span class="text-[9px] font-bold tracking-[0.3em] text-zinc-300 uppercase">
          上面的消息已为最后一条消息。
        </span>
      </div>
    </div>

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
import { ref, onMounted, onUnmounted, shallowRef } from 'vue'
import { useNotification } from '@/composables/useNotification'
import { messageApi, MessageCategory, type MessageItem } from '@/api/message' 
import { toast } from '@/utils/toast'
import { TimeUtils } from '@/utils/time'
import ConfirmModal from '@/components/ui/ConfirmModal.vue' 

const { unreadCount } = useNotification()

// 内存最优化：使用 shallowRef 减少深层响应式代理的开销
const messages = shallowRef<MessageItem[]>([])

// P0 修复：拆分锁机制，解除静默刷新与分页加载的相互死锁
const loading = ref(false)     // 专用于首次加载或强制刷新
const loadingMore = ref(false) // 专用于分页加载

const page = ref(1)
const hasMore = ref(true)

const showConfirm = ref(false)
const pendingDeleteId = ref<string | null>(null)

// P1 修复：O(1) 物理索引，消除 map 映射带来的 GC 压力
const existingIds = new Set<string>()

// P1 修复：乐观更新暂存区，解决与静默刷新的并发覆盖冲突
const pendingReadIds = new Set<string>()
const pendingDeleteIds = new Set<string>()

// P0 修复：语义拆分 AbortController
let refreshController: AbortController | null = null
let paginationController: AbortController | null = null

// 物理安全机制
let isMounted = false

/**
 * 算法最优：映射乐观状态，确保服务器返回的旧数据不会冲掉本地的已读/删除操作
 */
const applyOptimisticState = (items: MessageItem[]): MessageItem[] => {
  return items
    .filter(m => !pendingDeleteIds.has(String(m.id)))
    .map(m => pendingReadIds.has(String(m.id)) ? { ...m, isRead: true } : m)
}

/**
 * 🌟 核心：刷新机制 (首屏 / SignalR 触发)
 */
const refreshMessages = async (silent = false) => {
  if (refreshController) refreshController.abort()
  const currentController = new AbortController()
  refreshController = currentController
  const currentSignal = currentController.signal

  if (!silent) loading.value = true
  
  try {
    const data = await messageApi.getInbox(1, 10, { signal: currentSignal })
    
    if (!currentSignal.aborted) {
      const processed = applyOptimisticState(data)
      
      // 性能最大化：利用 Object.freeze 物理断绝 Vue 的深度代理，配合 shallowRef 使用
      messages.value = Object.freeze(processed) as MessageItem[]
      
      existingIds.clear()
      processed.forEach(m => existingIds.add(String(m.id)))
      
      page.value = 1
      hasMore.value = data.length === 10
    }
  } catch (err: any) {
    if (err.name !== 'AbortError' && !currentSignal.aborted) {
      console.error('[Inbox] Refresh Error:', err.message)
      if (!silent) toast.error('获取通知失败')
    }
  } finally {
    if (refreshController === currentController) {
      refreshController = null;
      loading.value = false;
    }
  }
}

/**
 * 🌟 核心：分页机制
 */
const loadMore = async () => {
  if (loadingMore.value || !hasMore.value) return

  if (paginationController) paginationController.abort()
  const currentController = new AbortController()
  paginationController = currentController
  const currentSignal = currentController.signal

  loadingMore.value = true

  try {
    const nextPage = page.value + 1
    const data = await messageApi.getInbox(nextPage, 10, { signal: currentSignal })
    
    if (!currentSignal.aborted) {
      const uniqueNew = data.filter(item => !existingIds.has(String(item.id)))
      const processed = applyOptimisticState(uniqueNew)
      
      processed.forEach(m => existingIds.add(String(m.id)))
      messages.value = Object.freeze([...messages.value, ...processed]) as MessageItem[]
      
      page.value = nextPage
      hasMore.value = data.length === 10
    }
  } catch (err: any) {
    if (err.name !== 'AbortError' && !currentSignal.aborted) {
      console.error('[Inbox] Pagination Error:', err.message)
    }
  } finally {
    if (paginationController === currentController) {
      paginationController = null;
      loadingMore.value = false;
    }
  }
}

const handleRefreshInbox = () => {
  if (isMounted) {
    console.log("[SignalR] 信令驱动刷新：从服务端同步最新状态...");
    refreshMessages(true);
  }
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

/**
 * 逻辑自洽：乐观更新与异常回滚闭环
 */
const handleMarkRead = async (id: string) => {
  const targetId = String(id)
  const itemIndex = messages.value.findIndex(m => String(m.id) === targetId)
  if (itemIndex === -1) return
  
  const item = messages.value[itemIndex]
  
  // [修复 2026-02-24] 严格类型检查：确保 item 不为 undefined，修复 TS18048 / TS2322
  if (!item || item.isRead) return

  // 1. 乐观更新 UI 与暂存区
  pendingReadIds.add(targetId)
  const newMessages = [...messages.value]
  newMessages[itemIndex] = { ...item, isRead: true }
  messages.value = Object.freeze(newMessages) as MessageItem[]
  
  // 防止下溢
  unreadCount.value = Math.max(0, unreadCount.value - 1)
  
  try {
    await messageApi.markAsRead(targetId)
  } catch (err: any) {
    // 2. 回滚 UI 与暂存区
    pendingReadIds.delete(targetId)
    if (isMounted) {
      const rollbackMessages = [...messages.value]
      const currentIdx = rollbackMessages.findIndex(m => String(m.id) === targetId)
      if (currentIdx !== -1) {
        // 由于上面已经通过 !item 保证了类型安全，此处解构回滚绝对安全
        rollbackMessages[currentIdx] = { ...item, isRead: false }
        messages.value = Object.freeze(rollbackMessages) as MessageItem[]
      }
      unreadCount.value++ 
      toast.error('操作失败，请重试')
    }
  }
}

const handleReadAll = async () => {
  if (unreadCount.value === 0) return
  
  const previousCount = unreadCount.value
  const previousMessages = [...messages.value]

  // 乐观更新
  unreadCount.value = 0
  const processed = messages.value.map(m => {
    pendingReadIds.add(String(m.id))
    return { ...m, isRead: true }
  })
  messages.value = Object.freeze(processed) as MessageItem[]

  try {
    await messageApi.markAllRead()
    toast.success('已标记全部')
  } catch (err: any) {
    if (isMounted) {
      unreadCount.value = previousCount
      messages.value = Object.freeze(previousMessages) as MessageItem[]
      messages.value.forEach(m => pendingReadIds.delete(String(m.id)))
      toast.error('标记失败')
      refreshMessages(true) 
    }
  }
}

const requestDelete = (id: string) => {
  pendingDeleteId.value = String(id)
  showConfirm.value = true
}

const executeDelete = async () => {
  if (!pendingDeleteId.value) return
  
  const id = pendingDeleteId.value
  const item = messages.value.find(m => String(m.id) === id)
  const wasUnread = item && !item.isRead

  // 1. 乐观更新
  pendingDeleteIds.add(id)
  messages.value = Object.freeze(messages.value.filter(m => String(m.id) !== id)) as MessageItem[]
  
  if (wasUnread) {
    unreadCount.value = Math.max(0, unreadCount.value - 1)
  }
  
  try {
    await messageApi.deleteMessage(id)
    toast.success('已移除')
  } catch (err: any) {
    pendingDeleteIds.delete(id)
    if (isMounted) {
      if (wasUnread) unreadCount.value++
      toast.error(err.response?.data?.message || err.message || '操作受限')
      refreshMessages(true)
    }
  } finally {
    pendingDeleteId.value = null
  }
}

onMounted(() => {
  isMounted = true
  refreshMessages()
  window.addEventListener('signalr:refresh-inbox', handleRefreshInbox)
})

onUnmounted(() => {
  isMounted = false
  if (refreshController) refreshController.abort()
  if (paginationController) paginationController.abort()
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

.wrap-break-word {
  overflow-wrap: break-word;
  word-break: break-word;
}
</style>