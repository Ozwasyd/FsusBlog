<template>
  <div class="max-w-3xl mx-auto w-full py-10 sm:py-16 px-6 sm:px-8">
    
    <header class="mb-12 sm:mb-20">
      <div class="text-[9px] sm:text-[10px] font-bold tracking-[0.3em] text-zinc-400 uppercase mb-4">交互</div>
      <h1 class="text-3xl sm:text-5xl font-bold tracking-tighter text-zinc-950 mb-6 sm:mb-8">
        我的评论
      </h1>
    </header>

    <div v-if="!loading && list.length === 0" class="py-20 border-t border-zinc-100">
      <p class="text-[11px] font-bold tracking-[0.2em] text-zinc-400 uppercase text-center">无评论数据。</p>
    </div>

    <div v-else class="space-y-10 sm:space-y-12">
      <transition-group name="list-fade" tag="div" class="relative">
        <article 
          v-for="item in list" 
          :key="item.id" 
          class="group relative pt-8 border-t border-zinc-100 first:border-t-0 sm:first:border-t"
        >
          <div class="flex flex-col sm:flex-row justify-between items-start gap-3 sm:gap-6 mb-5 sm:mb-6">
            <div class="space-y-1.5 grow pr-0 sm:pr-8">
              <span class="text-[9px] font-bold text-zinc-400 uppercase tracking-[0.2em]">回复文章</span>
              <router-link 
                :to="`/article/${item.articleId}`" 
                class="block text-sm font-bold text-zinc-950 hover:text-zinc-500 transition-colors tracking-wide leading-snug wrap-break-word"
              >
                {{ item.articleTitle }}
              </router-link>
            </div>
            <time 
              :datetime="item.createTime"
              :title="TimeUtils.toFullLocalString(item.createTime)"
              class="text-[10px] font-mono font-bold text-zinc-300 uppercase tracking-widest shrink-0 pt-0.5"
            >
              {{ TimeUtils.toRelative(item.createTime) }}
            </time>
          </div>

          <p class="text-zinc-600 text-sm leading-relaxed whitespace-pre-wrap mb-6 wrap-break-word overflow-hidden">
            {{ item.content }}
          </p>

          <div class="flex justify-end">
            <button 
              @click="onDelete(String(item.id))"
              class="text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-300 hover:text-zinc-950 transition-colors duration-300 py-3 -mr-3 px-3 active:scale-95"
            >
              删除
            </button>
          </div>
        </article>
      </transition-group>

      <div class="pt-12 border-t border-zinc-950 flex justify-center">
        <button 
          v-if="hasMore" 
          @click="fetchComments" 
          :disabled="loading"
          class="w-full sm:w-auto px-10 py-4 sm:py-3 border border-zinc-950 text-[10px] font-black tracking-[0.3em] uppercase transition-all duration-300 active:bg-zinc-950 active:text-white sm:hover:bg-zinc-950 sm:hover:text-white disabled:opacity-30"
        >
          {{ loading ? '加载中...' : '加载更多记录' }}
        </button>
        <span v-else-if="list.length > 0" class="text-[9px] font-bold tracking-[0.3em] text-zinc-300 uppercase">
          上面的评论已为最后一条评论。
        </span>
      </div>
    </div>

    <ConfirmModal 
      v-model:visible="showConfirm"
      title="删除评论"
      content="确定要永久移除这条评论吗？此操作无法撤销。"
      @confirm="executeDelete"
    />

  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { getMyComments, deleteComment, type MyCommentItem } from '@/api/comment'
import { TimeUtils } from '@/utils/time'
import ConfirmModal from '@/components/ui/ConfirmModal.vue'

const list = ref<MyCommentItem[]>([])
const loading = ref(false)
const cursor = ref<string | undefined>(undefined)
const hasMore = ref(true)

// --- 🌟 模态框逻辑状态 ---
const showConfirm = ref(false)
const pendingDeleteId = ref<string | null>(null)

const fetchComments = async () => {
  if (loading.value) return
  loading.value = true
  
  try {
    const res = await getMyComments(cursor.value) 
    if (res) {
      list.value.push(...res.data)
      // 🌟 核心：确保 cursor 作为 string 处理
      cursor.value = res.nextCursor ? String(res.nextCursor) : undefined 
      hasMore.value = res.hasMore
    }
  } catch (error) {
    console.error('[Comment] Fail:', error)
  } finally {
    loading.value = false
  }
}

/**
 * 🌟 触发删除确认模态框
 * 强制将 ID 转为 string 避免 JS 精度丢失
 */
const onDelete = (id: string) => { 
  pendingDeleteId.value = String(id)
  showConfirm.value = true
}

/**
 * 🌟 确认删除后的执行逻辑
 */
const executeDelete = async () => {
  if (!pendingDeleteId.value) return
  
  const targetId = pendingDeleteId.value

  try {
    // 逻辑自洽：发送给后端的 ID 必须与数据库一致（字符串传输）
    await deleteComment(targetId)
    // 利用 String 强制比对，确保 UI 过滤准确
    list.value = list.value.filter(i => String(i.id) !== targetId)
  } catch (error) {
    console.error('Delete fail:', error)
  } finally {
    showConfirm.value = false
    pendingDeleteId.value = null
  }
}

onMounted(() => {
  fetchComments()
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
</style>