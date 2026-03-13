<template>
  <div class="max-w-3xl mx-auto px-6 sm:px-8 min-h-screen">

    <!-- 骨架屏 -->
    <div v-if="loading" class="animate-pulse space-y-8 py-8" aria-hidden="true">
      <div class="h-8 sm:h-12 bg-zinc-100 w-full sm:w-4/5"></div>
      <div class="flex gap-4">
        <div class="h-4 bg-zinc-100 w-20 sm:w-24"></div>
        <div class="h-4 bg-zinc-100 w-20 sm:w-24"></div>
      </div>
      <div class="space-y-4 pt-8 sm:pt-12">
        <div v-for="i in 6" :key="i" class="h-4 bg-zinc-100 w-full"></div>
      </div>
    </div>

    <!-- 状态区分：明确分离加载异常与文章不存在 -->
    <div v-else-if="isError" class="py-32 text-center grow flex flex-col items-center justify-center">
      <p class="text-sm font-medium tracking-widest uppercase text-zinc-400 mb-6">数据加载异常，请稍后重试。</p>
      <button 
        type="button"
        @click="loadArticle(false)"
        class="text-[11px] font-bold tracking-[0.2em] uppercase text-zinc-950 border-b border-zinc-950 pb-0.5 hover:text-zinc-500 hover:border-zinc-500 transition-all outline-none"
      >
        重载页面
      </button>
    </div>

    <!-- [物理防线] 加入 overflow-anchor: none 彻底斩断浏览器由于异步渲染导致的自动向下滚动劫持！ -->
    <article v-else-if="article" class="animate-in fade-in slide-in-from-bottom-4 duration-700" style="overflow-anchor: none;">

      <header class="mb-10 sm:mb-16 pb-8 sm:pb-12 border-b border-zinc-100">
        <h1 class="text-2xl sm:text-4xl font-bold text-zinc-950 leading-tight sm:leading-snug mb-5 sm:mb-6 tracking-tight">
          {{ article.title }}
        </h1>

        <div class="flex flex-wrap items-center gap-3 text-[10px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase">
          <time :datetime="article.createTime" :title="TimeUtils.toFullLocalString(article.createTime)">
            {{ TimeUtils.toSmartTime(article.createTime) }}
          </time>
          <span class="text-zinc-300 font-light" aria-hidden="true">/</span>

          <router-link v-if="article.category" :to="`/category/${article.category.id}`"
            class="text-zinc-500 hover:text-zinc-950 transition-colors">
            {{ article.category.name }}
          </router-link>
          <span v-else class="text-zinc-500">未分类</span>

          <span class="text-zinc-300 font-light" aria-hidden="true">/</span>
          <span>{{ article.views }} 浏览</span>
        </div>
      </header>

      <MarkdownRenderer 
        ref="articleRendererRef"
        :content="article.content" 
        @render-complete="handleRenderComplete"
      />

      <footer class="mt-12 sm:mt-24 pt-8 sm:pt-10 border-t border-zinc-100">
        <div class="flex flex-wrap gap-3 sm:gap-4">
          <router-link v-for="tag in article.tags" :key="tag.id" :to="`/tag/${tag.id}`"
            class="text-[11px] sm:text-sm font-medium text-zinc-400 hover:text-zinc-950 transition-colors px-0 py-1.5 sm:p-0">
            #{{ tag.name }}
          </router-link>
        </div>
      </footer>

      <section class="mt-16 sm:mt-24 pt-12 border-t border-zinc-950/5 pb-24">

        <h3 class="text-[10px] sm:text-xs font-bold tracking-[0.2em] text-zinc-400 uppercase mb-8">
          评论<span v-if="comments.length"> ({{ comments.length }}+)</span>
        </h3>

        <div v-if="userStore.isLoggedIn" class="mb-12">
          <textarea v-model="commentContent" rows="3" 
            aria-label="发表评论"
            :placeholder="userStore.isBanned ? '您已被封禁，仅限阅读。' : '在此写出你的评论 (Ctrl + Enter 发送)'"
            class="w-full bg-transparent border border-zinc-100 focus:border-zinc-950 rounded-none p-4 text-sm text-zinc-900 placeholder:text-zinc-400 outline-none transition-colors resize-none appearance-none"
            :class="{ 'opacity-50 cursor-not-allowed': userStore.isBanned }"
            :disabled="submittingComment || powProvider.isCalculating.value || userStore.isBanned"
            @keydown.ctrl.enter="submitComment"
            @keydown.meta.enter="submitComment"
          ></textarea>
          <div class="mt-3 flex justify-end">
            <button 
              type="button"
              @click="submitComment"
              :disabled="!commentContent.trim() || submittingComment || powProvider.isCalculating.value || userStore.isBanned"
              :aria-disabled="!commentContent.trim() || submittingComment || powProvider.isCalculating.value || userStore.isBanned"
              class="w-full sm:w-auto text-xs font-bold tracking-[0.2em] uppercase px-8 py-3 bg-zinc-950 text-white hover:opacity-80 disabled:opacity-30 transition-all">
              <template v-if="userStore.isBanned">账号已封禁</template>
              <template v-else-if="powProvider.isCalculating.value">安全校验...</template>
              <template v-else-if="submittingComment">发送中...</template>
              <template v-else>发送</template>
            </button>
          </div>
        </div>

        <div v-else class="mb-12 py-8 bg-white flex items-center justify-center border border-zinc-100">
          <p class="text-xs sm:text-sm font-medium tracking-widest uppercase text-zinc-400">
            请 <router-link :to="{ path: '/login', query: { redirect: route.fullPath } }" class="text-zinc-950 underline underline-offset-4 font-bold">登录</router-link>
            后发表评论
          </p>
        </div>

        <!--[重构 2026-03-13] 剥离极耗性能的 TransitionGroup，引入基于切片的 O(1) 虚拟滚动容器 -->
        <div ref="virtualListRef" class="space-y-8" :style="{ paddingTop: paddingTop + 'px', paddingBottom: paddingBottom + 'px' }" aria-live="polite">
          <div v-for="comment in visibleComments" :key="comment.id" class="group border-b border-zinc-100 pb-8 last:border-0">
            <div class="flex items-center justify-between gap-3 mb-3">
              <div class="flex items-center gap-3">
                <span class="text-sm font-bold text-zinc-950 truncate">{{ comment.userName }}</span>
                <button
                  v-if="userStore.isAdmin || (userStore.isLoggedIn && String(comment.userName) === String(userStore.userInfo?.username))"
                  @click="handleCommentDelete(String(comment.id))"
                  aria-label="删除评论"
                  class="text-[9px] font-bold text-red-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-all uppercase tracking-widest outline-none">
                  [删除]
                </button>
              </div>
              <span class="text-[10px] font-mono text-zinc-400 shrink-0 tabular-nums"
                :title="TimeUtils.toFullLocalString(comment.createTime)">
                {{ TimeUtils.toRelative(comment.createTime) }}
              </span>
            </div>
            <p class="text-sm text-zinc-600 leading-relaxed whitespace-pre-wrap wrap-break-word">
              {{ comment.content }}
            </p>
          </div>
        </div>

        <!-- 触底加载触发器 -->
        <div ref="loadMoreTrigger" class="h-32 flex flex-col items-center justify-center mt-8">
          <Transition name="state-fade" mode="out-in">
            <div v-if="loadingComments" key="loading" class="flex flex-col items-center gap-3" role="status">
              <span class="text-[10px] font-bold tracking-[0.2em] text-zinc-400 uppercase animate-pulse">加载中</span>
              <div class="w-10 h-px bg-zinc-100 overflow-hidden relative">
                <div class="absolute inset-0 bg-zinc-950/20 animate-loading-bar"></div>
              </div>
            </div>
            <div v-else-if="!hasMore" key="end"
              class="text-[10px] font-mono text-zinc-300 uppercase tracking-widest px-4 text-center">
              {{ comments.length > 0 ? '上面的评论已为最后一条。' : '暂无评论。' }}
            </div>
          </Transition>
        </div>
      </section>
    </article>

    <div v-else class="py-32 text-center grow flex flex-col items-center justify-center">
      <p class="text-sm font-medium tracking-widest uppercase text-zinc-400 mb-6">文章未找到。</p>
      <router-link to="/"
        class="text-[11px] font-bold tracking-[0.2em] uppercase text-zinc-950 border-b border-zinc-950 pb-0.5 outline-none">
        回到主页
      </router-link>
    </div>

    <!-- 统一层级协调 -->
    <ConfirmModal v-model:visible="modalState.visible" :title="modalState.title" :content="modalState.content"
      @confirm="modalState.onConfirm" @cancel="modalState.onCancel" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getArticleById, type ArticleDetail } from '@/api/article'
import { getComments, createComment, deleteComment, type CommentItem } from '@/api/comment'
import { useUserStore } from '@/store/user'
import MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue' 
import { toast } from '@/utils/toast'
import ConfirmModal from '@/components/ui/ConfirmModal.vue'
import { TimeUtils } from '@/utils/time'
import { usePow } from '@/composables/usePow'
import { validateCommentContent } from '@/utils/contentFilter'

// 信令常量定义
const SIGNALS = {
  CREATED: 'signalr:article-created',
  UPDATED: 'signalr:article-updated',
  DELETED: 'signalr:article-deleted',
  RESTORED: 'signalr:article-restored',
  RECONNECTED: 'signalr:reconnected',
  COMMENT_ADD: 'signalr:comment-added',
  COMMENT_DEL: 'signalr:comment-removed'
} as const;

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const powProvider = usePow()

const article = ref<ArticleDetail | null>(null)
const loading = ref(true)
const isError = ref(false)

const articleRendererRef = ref<InstanceType<typeof MarkdownRenderer> | null>(null)

// 基础评论源列表
const comments = shallowRef<CommentItem[]>([])
const nextCursor = ref<string | null>(null)
const hasMore = ref(true)
const loadingComments = ref(false)
const loadMoreTrigger = ref<HTMLElement | null>(null)

const commentContent = ref('')
const submittingComment = ref(false)

// ==========================================
// 🚀 O(1) 虚拟滚动核心状态与引擎
// ==========================================
const virtualListRef = ref<HTMLElement | null>(null)
const visibleComments = shallowRef<CommentItem[]>([])
const paddingTop = ref(0)
const paddingBottom = ref(0)
const ITEM_HEIGHT = 120; // 预估单条评论基准高度
const BUFFER_SIZE = 12; // 视口上下预渲染数量缓冲

let scrollRAF: number | null = null;

const handleVirtualScroll = () => {
  if (scrollRAF !== null) return;
  scrollRAF = requestAnimationFrame(() => {
    updateVirtualScroll();
    scrollRAF = null;
  });
};

const updateVirtualScroll = () => {
  const total = comments.value.length;
  if (total === 0) {
    visibleComments.value =[];
    paddingTop.value = 0;
    paddingBottom.value = 0;
    return;
  }

  const scrollY = window.scrollY;
  const winHeight = window.innerHeight;

  let containerTop = 0;
  if (virtualListRef.value) {
    // 获取列表容器距离文档顶部绝对物理距离
    containerTop = virtualListRef.value.getBoundingClientRect().top + scrollY;
  }

  let startIdx = 0;
  if (scrollY > containerTop && containerTop !== 0) {
    startIdx = Math.floor((scrollY - containerTop) / ITEM_HEIGHT) - BUFFER_SIZE;
  }
  startIdx = Math.max(0, startIdx);

  let endIdx = startIdx + Math.ceil(winHeight / ITEM_HEIGHT) + (BUFFER_SIZE * 2);
  endIdx = Math.min(total, endIdx);

  // 切片渲染
  visibleComments.value = comments.value.slice(startIdx, endIdx);
  // 计算占位高度，确保系统原生滚动条长度完全真实
  paddingTop.value = startIdx * ITEM_HEIGHT;
  paddingBottom.value = (total - endIdx) * ITEM_HEIGHT;
};

// 监听源数组变化，同步重构渲染切片
watch(comments, () => {
  updateVirtualScroll();
});

// ==========================================
// 物理安全与竞态控制
// ==========================================
let isMounted = false
let abortController: AbortController | null = null
let commentAbortController: AbortController | null = null

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

const modalState = ref({
  visible: false,
  title: '',
  content: '',
  onConfirm: () => { },
  onCancel: () => { }
})

const triggerModal = (config: { title: string, content: string, onConfirm: () => void, onCancel?: () => void }) => {
  modalState.value = {
    visible: true,
    title: config.title,
    content: config.content,
    onConfirm: config.onConfirm,
    onCancel: config.onCancel || (() => { modalState.value.visible = false })
  }
}

let observer: IntersectionObserver | null = null

const runSmoothUpdate = async (updateAction: () => Promise<void>) => {
  const container = articleRendererRef.value?.rootEl;
  if (!container || !article.value) {
    await updateAction();
    return;
  }
  const children = Array.from(container.children);
  let anchorIndex = -1;
  let anchorOffset = 0;
  
  const foundAnchor = children.find((el, index) => {
    const rect = el.getBoundingClientRect();
    if (rect.top >= 0) {
      anchorIndex = index;
      anchorOffset = rect.top;
      return true;
    }
    return false;
  });
  
  await updateAction();
  
  if (foundAnchor && anchorIndex !== -1) {
    await nextTick();
    const freshContainer = articleRendererRef.value?.rootEl;
    if (freshContainer && freshContainer.children.length > anchorIndex) {
      const targetElement = freshContainer.children[anchorIndex] as HTMLElement;
      if (targetElement) {
        const newRect = targetElement.getBoundingClientRect();
        const diff = newRect.top - anchorOffset;
        window.scrollBy(0, diff);
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' }); 
      }
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' }); 
    }
  }
}

const loadArticle = async (silent = false) => {
  const id = Number(route.params.id)
  if (isNaN(id)) return

  if (abortController) abortController.abort()
  const currentController = new AbortController()
  abortController = currentController
  const currentSignal = currentController.signal

  if (!silent) {
    loading.value = true
    isError.value = false
  }

  const action = async () => {
    try {
      const res = await getArticleById(id, { signal: currentSignal })
      if (isMounted && !currentSignal.aborted && res) {
        article.value = res
        if (!silent) {
          comments.value =[]
          nextCursor.value = null
          hasMore.value = true
          await loadMoreComments()
        }
      }
    } catch (error: any) {
      if (error.name !== 'AbortError' && isMounted && !currentSignal.aborted) {
        console.error("[Article] Load failed:", error)
        isError.value = true
      }
    }
  };

  if (silent) {
    await runSmoothUpdate(action);
  } else {
    await action();
    if (isMounted && !currentSignal.aborted) {
      await nextTick();
      initObserver();
    }
  }
  
  if (abortController === currentController) {
      if (isMounted && !silent) loading.value = false;
      abortController = null;
  }
}

const handleRenderComplete = () => {
  // 渲染完成，刷新一下高度缓存以防止切片错位
  updateVirtualScroll();
}

const handleRemoteArticleUpdated = (e: Event) => {
  const data = (e as CustomEvent).detail;
  if (!data || typeof data !== 'object' || !('articleId' in data) || !article.value) return;
  
  const articleId = String(data.articleId);
  if (articleId !== String(article.value.id)) return;

  if (debounceTimers.has(articleId)) clearTimeout(debounceTimers.get(articleId));
  const timer = setTimeout(async () => {
    if (isMounted) {
      await loadArticle(true);
      toast.info('内容已实时同步'); 
    }
    debounceTimers.delete(articleId);
  }, 500);
  debounceTimers.set(articleId, timer);
}

const handleRemoteArticleDeleted = (e: Event) => {
  const data = (e as CustomEvent).detail;
  if (!data || typeof data !== 'object' || !('articleId' in data)) return;
  
  const targetId = String(data.articleId);
  if (article.value && targetId === String(article.value.id)) {
    if (debounceTimers.has(targetId)) {
      clearTimeout(debounceTimers.get(targetId));
      debounceTimers.delete(targetId);
    }
    article.value = null;

    triggerModal({
      title: '文章已被删除',
      content: '该文章内容已被作者移除，正在为您返回首页。',
      onConfirm: () => { 
        modalState.value.visible = false;
        router.replace('/'); 
      },
      onCancel: () => { 
        modalState.value.visible = false;
        router.replace('/'); 
      }
    });
  }
}

const handleSignalRReconnected = () => {
  if (isMounted && article.value) loadArticle(true);
}

// ==========================================
// 2. 评论交互引擎
// ==========================================

const loadMoreComments = async () => {
  if (loadingComments.value || !hasMore.value || !article.value) return
  
  if (commentAbortController) commentAbortController.abort()
  const currentController = new AbortController()
  commentAbortController = currentController
  const currentSignal = currentController.signal

  loadingComments.value = true
  try {
    const res = await getComments(article.value.id, nextCursor.value, 10, { signal: currentSignal })
    if (isMounted && !currentSignal.aborted) {
      if (res.data && res.data.length > 0) {
        const existingIds = new Set(comments.value.map(c => String(c.id)));
        const uniqueNewComments = res.data.filter(newItem => !existingIds.has(String(newItem.id)));
        
        comments.value = [...comments.value, ...uniqueNewComments]
        nextCursor.value = res.nextCursor ? String(res.nextCursor) : null
        hasMore.value = res.hasMore
      } else {
        hasMore.value = false
      }
    }
  } catch (error: any) {
    if (error.name !== 'AbortError' && isMounted && !currentSignal.aborted) {
      console.error("[Comments] Load failed:", error)
    }
  } finally {
    if (commentAbortController === currentController) {
      commentAbortController = null
      if (isMounted && !currentSignal.aborted) loadingComments.value = false
    }
  }
}

const submitComment = async () => {
  if (!commentContent.value.trim() || !article.value) return

  const checkResult = validateCommentContent(commentContent.value);
  if (!checkResult.isValid) {
      toast.error(checkResult.message);
      return;
  }

  if (submittingComment.value || powProvider.isCalculating.value) return
  submittingComment.value = true

  if (commentAbortController) commentAbortController.abort();
  const currentController = new AbortController()
  commentAbortController = currentController
  const currentSignal = currentController.signal

  try {
    await createComment({
      articleId: article.value.id,
      content: commentContent.value
    }, { signal: currentSignal })

    if (!currentSignal.aborted) {
      toast.success('发送成功')
      commentContent.value = ''
    }

  } catch (error: any) {
    if (error.name !== 'AbortError') {
      console.error("[Comment] Submit failed:", error)
      toast.error(error.response?.data?.message || '评论发布失败');
    }
  } finally {
    if (commentAbortController === currentController) {
      commentAbortController = null
      if (isMounted && !currentSignal.aborted) submittingComment.value = false
    }
  }
}

const handleRemoteAdd = (e: Event) => {
  const data = (e as CustomEvent).detail;
  if (!data || typeof data !== 'object' || !('comment' in data) || !data.comment?.id) return;
  
  if (article.value && String(data.articleId) === String(article.value.id)) {
    const exists = comments.value.some(c => String(c.id) === String(data.comment.id));
    if (!exists) {
      comments.value = [data.comment, ...comments.value]
      if (comments.value.length > 500) comments.value = comments.value.slice(0, 500);
    }
  }
};

const handleRemoteDelete = (e: Event) => {
  const data = (e as CustomEvent).detail;
  if (!data || typeof data !== 'object' || !('articleId' in data)) return;
  
  if (article.value && String(data.articleId) === String(article.value.id)) {
    const targetIdStr = String(data.commentId);
    comments.value = comments.value.filter(c => String(c.id) !== targetIdStr);
  }
};

const handleCommentDelete = (id: string) => {
  const targetId = String(id);
  const isAdmin = userStore.isAdmin; 

  triggerModal({
    title: isAdmin ? '管理员操作' : '删除评论',
    content: isAdmin ? '确定要删除这条评论吗？操作记录将被审计。' : '确定要删除这条评论吗？',
    onConfirm: async () => {
      try {
        await deleteComment(targetId);
        toast.success('已移除');
        comments.value = comments.value.filter(c => String(c.id) !== targetId);
      } catch (err) {
        toast.error('操作失败');
      } finally {
        modalState.value.visible = false;
      }
    }
  });
}

const initObserver = () => {
  if (!loadMoreTrigger.value) return
  if (observer) observer.disconnect() 
  
  observer = new IntersectionObserver(([entry]) => {
    if (entry?.isIntersecting && hasMore.value && !loadingComments.value) {
      loadMoreComments()
    }
  }, { rootMargin: '400px' }) 
  
  observer.observe(loadMoreTrigger.value)
}

onMounted(() => {
  isMounted = true;
  loadArticle();
  powProvider.prewarm(); 
  
  window.addEventListener('scroll', handleVirtualScroll, { passive: true });
  window.addEventListener('resize', handleVirtualScroll, { passive: true });
  
  window.addEventListener(SIGNALS.COMMENT_ADD, handleRemoteAdd);
  window.addEventListener(SIGNALS.COMMENT_DEL, handleRemoteDelete);
  window.addEventListener(SIGNALS.UPDATED, handleRemoteArticleUpdated);
  window.addEventListener(SIGNALS.RESTORED, handleRemoteArticleUpdated);
  window.addEventListener(SIGNALS.DELETED, handleRemoteArticleDeleted);
  window.addEventListener(SIGNALS.RECONNECTED, handleSignalRReconnected);
});

onUnmounted(() => {
  isMounted = false;
  if (observer) observer.disconnect();
  
  window.removeEventListener('scroll', handleVirtualScroll);
  window.removeEventListener('resize', handleVirtualScroll);
  
  debounceTimers.forEach(timer => clearTimeout(timer));
  debounceTimers.clear();
  
  if (abortController) abortController.abort();
  if (commentAbortController) commentAbortController.abort();
  
  window.removeEventListener(SIGNALS.COMMENT_ADD, handleRemoteAdd);
  window.removeEventListener(SIGNALS.COMMENT_DEL, handleRemoteDelete);
  window.removeEventListener(SIGNALS.UPDATED, handleRemoteArticleUpdated);
  window.removeEventListener(SIGNALS.RESTORED, handleRemoteArticleUpdated);
  window.removeEventListener(SIGNALS.DELETED, handleRemoteArticleDeleted);
  window.removeEventListener(SIGNALS.RECONNECTED, handleSignalRReconnected);
});
</script>

<style scoped>
@reference "@/assets/main.css";

@keyframes loading-bar {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}

.animate-loading-bar {
  animation: loading-bar 1.5s infinite;
}

.state-fade-enter-active,
.state-fade-leave-active {
  transition: opacity 0.3s ease;
}
.state-fade-enter-from,
.state-fade-leave-to {
  opacity: 0;
}
</style>