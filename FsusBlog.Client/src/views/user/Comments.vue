<template>
  <div class="max-w-3xl mx-auto w-full py-10 sm:py-16 px-6 sm:px-8">
    
    <header class="mb-12 sm:mb-20">
      <div class="text-[9px] sm:text-[10px] font-bold tracking-[0.3em] text-zinc-400 uppercase mb-4">交互</div>
      <h1 class="text-3xl sm:text-5xl font-bold tracking-tighter text-zinc-950 mb-6 sm:mb-8">
        我的评论
      </h1>
    </header>

    <!-- 状态暴露：增加错误异常状态，防止白屏 -->
    <div v-if="isError" class="py-20 border-t border-zinc-100 flex flex-col items-center">
      <p class="text-[11px] font-bold tracking-[0.2em] text-zinc-400 uppercase text-center mb-4">加载失败</p>
      <button 
        type="button" 
        @click="fetchComments" 
        class="text-[10px] font-bold tracking-[0.2em] text-zinc-950 border-b border-zinc-950 pb-0.5 hover:text-zinc-500 hover:border-zinc-500 transition-all outline-none focus-visible:ring-2 focus-visible:ring-zinc-950"
      >
        重试
      </button>
    </div>

    <div v-else-if="!loading && list.length === 0" class="py-20 border-t border-zinc-100">
      <p class="text-[11px] font-bold tracking-[0.2em] text-zinc-400 uppercase text-center">无评论数据。</p>
    </div>

    <div v-else class="space-y-10 sm:space-y-12">
      <!-- 列表动画渲染 -->
      <transition-group name="list-fade" tag="div" class="relative">
        <article 
          v-for="item in list" 
          :key="item.id" 
          class="group relative pt-8 border-t border-zinc-100 first:border-t-0 sm:first:border-t"
        >
          <div class="flex flex-col sm:flex-row justify-between items-start gap-3 sm:gap-6 mb-5 sm:mb-6">
            <div class="space-y-1.5 grow pr-0 sm:pr-8">
              <span class="text-[9px] font-bold text-zinc-400 uppercase tracking-[0.2em]">回复文章</span>
              <!-- [修复 2026-02-24] 规范化：使用对象路由绑定参数 -->
              <router-link 
                :to="{ name: 'ArticleDetail', params: { id: item.articleId } }" 
                class="block text-sm font-bold text-zinc-950 hover:text-zinc-500 transition-colors tracking-wide leading-snug wrap-break-word outline-none focus-visible:ring-2 focus-visible:ring-zinc-950 rounded-sm"
              >
                {{ item.articleTitle }}
              </router-link>
            </div>
            <!-- UX 提升：增加 tabular-nums 防止时间跳动 -->
            <time 
              :datetime="item.createTime"
              :title="TimeUtils.toFullLocalString(item.createTime)"
              class="text-[10px] font-mono font-bold text-zinc-300 uppercase tracking-widest shrink-0 pt-0.5 tabular-nums"
            >
              {{ TimeUtils.toRelative(item.createTime) }}
            </time>
          </div>

          <p class="text-zinc-600 text-sm leading-relaxed whitespace-pre-wrap mb-6 wrap-break-word overflow-hidden">
            {{ item.content }}
          </p>

          <div class="flex justify-end">
            <!-- A11y 强化：增加 type="button" 及 focus-visible 语义 -->
            <button 
              type="button"
              @click="onDelete(String(item.id))"
              aria-label="删除此评论"
              class="text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-300 hover:text-zinc-950 transition-colors duration-300 py-3 -mr-3 px-3 active:scale-95 outline-none focus-visible:text-zinc-950"
            >
              删除
            </button>
          </div>
        </article>
      </transition-group>

      <div class="pt-12 border-t border-zinc-950 flex justify-center">
        <button 
          v-if="hasMore" 
          type="button"
          @click="fetchComments" 
          :disabled="loading"
          class="w-full sm:w-auto px-10 py-4 sm:py-3 border border-zinc-950 text-[10px] font-black tracking-[0.3em] uppercase transition-all duration-300 active:bg-zinc-950 active:text-white sm:hover:bg-zinc-950 sm:hover:text-white disabled:opacity-30 outline-none focus-visible:ring-2 focus-visible:ring-zinc-950"
        >
          <template v-if="loading">
            <span class="animate-pulse">加载中...</span>
          </template>
          <template v-else>
            加载更多记录
          </template>
        </button>
        <span v-else-if="list.length > 0" class="text-[9px] font-bold tracking-[0.3em] text-zinc-300 uppercase">
          上面的评论已为最后一条评论。
        </span>
      </div>
    </div>

    <!-- 模态框统一调用 -->
    <ConfirmModal 
      v-model:visible="showConfirm"
      title="删除评论"
      content="确定要永久移除这条评论吗？此操作无法撤销。"
      @confirm="executeDelete"
    />

  </div>
</template>

<script setup lang="ts">
import { ref, shallowRef, onMounted, onUnmounted } from 'vue'
import { getMyComments, deleteComment, type MyCommentItem } from '@/api/comment'
import { TimeUtils } from '@/utils/time'
import { toast } from '@/utils/toast'
import ConfirmModal from '@/components/ui/ConfirmModal.vue'

// 使用 shallowRef 降低深层响应式代理开销
const list = shallowRef<MyCommentItem[]>([])
const loading = ref(false)
const isError = ref(false)
const cursor = ref<string | undefined>(undefined)
const hasMore = ref(true)

const showConfirm = ref(false)
const pendingDeleteId = ref<string | null>(null)

// [修复 2026-02-24] 维护常驻组件生命周期的 Set 集合，实现真正的 O(1) 增量去重
const existingIds = new Set<string>()

// 竞态隔离
let abortController: AbortController | null = null

/**
 * 核心加载逻辑
 */
const fetchComments = async () => {
  if (loading.value) return

  if (abortController) abortController.abort()
  const currentController = new AbortController()
  abortController = currentController
  const currentSignal = currentController.signal

  loading.value = true
  isError.value = false
  
  try {
    const res = await getMyComments(cursor.value, 10, { signal: currentSignal }) 
    
    // [修复 2026-02-24] 移除冗余的 isMounted，依靠 signal.aborted 实现闭环
    if (!currentSignal.aborted && res) {
      // 增量过滤并更新常驻缓存
      const uniqueNew = res.data.filter(i => !existingIds.has(String(i.id)))
      uniqueNew.forEach(i => existingIds.add(String(i.id)))

      list.value = [...list.value, ...uniqueNew]
      
      cursor.value = res.nextCursor ? String(res.nextCursor) : undefined 
      hasMore.value = res.hasMore
    }
  } catch (error: any) {
    if (error.name !== 'AbortError' && !currentSignal.aborted) {
      console.error('[Comment] Fetch fail:', error)
      isError.value = true
    }
  } finally {
    if (abortController === currentController) {
      loading.value = false
      abortController = null
    }
  }
}

const onDelete = (id: string) => { 
  pendingDeleteId.value = String(id)
  showConfirm.value = true
}

/**
 * 确认删除后的执行逻辑
 */
const executeDelete = async () => {
  if (!pendingDeleteId.value) return
  
  const targetId = pendingDeleteId.value
  const originalList = list.value

  // 1. 乐观更新：过滤目标项并清理 ID 缓存
  list.value = list.value.filter(i => String(i.id) !== targetId)
  existingIds.delete(targetId)

  try {
    await deleteComment(targetId)
    toast.success('评论已移除')
  } catch (error: any) {
    // 2. 异常回滚：通过原始快照恢复状态
    list.value = originalList
    existingIds.add(targetId)
    
    toast.error(error.response?.data?.message || '删除失败，请稍后重试')
    console.error('Delete fail:', error)
  } finally {
    showConfirm.value = false
    pendingDeleteId.value = null
  }
}

onMounted(() => {
  fetchComments()
})

onUnmounted(() => {
  if (abortController) abortController.abort()
})
</script>

<style scoped>
@reference "@/assets/main.css";

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