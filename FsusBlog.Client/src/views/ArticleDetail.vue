<template>
  <div class="max-w-3xl mx-auto px-6 sm:px-8 min-h-screen">

    <div v-if="loading" class="animate-pulse space-y-8 py-8">
      <div class="h-8 sm:h-12 bg-zinc-100 w-full sm:w-4/5"></div>
      <div class="flex gap-4">
        <div class="h-4 bg-zinc-100 w-20 sm:w-24"></div>
        <div class="h-4 bg-zinc-100 w-20 sm:w-24"></div>
      </div>
      <div class="space-y-4 pt-8 sm:pt-12">
        <div v-for="i in 6" :key="i" class="h-4 bg-zinc-100 w-full"></div>
      </div>
    </div>

    <article v-else-if="article" class="animate-in fade-in slide-in-from-bottom-4 duration-700">

      <header class="mb-10 sm:mb-16 pb-8 sm:pb-12 border-b border-zinc-100">
        <h1
          class="text-2xl sm:text-4xl font-bold text-zinc-950 leading-tight sm:leading-snug mb-5 sm:mb-6 tracking-tight">
          {{ article.title }}
        </h1>

        <div
          class="flex flex-wrap items-center gap-3 text-[10px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase">
          <time :datetime="article.createTime" :title="TimeUtils.toFullLocalString(article.createTime)">
            {{ TimeUtils.toSmartTime(article.createTime) }}
          </time>
          <span class="text-zinc-300 font-light">/</span>

          <router-link v-if="article.category" :to="`/category/${article.category.id}`"
            class="text-zinc-500 hover:text-zinc-950 transition-colors">
            {{ article.category.name }}
          </router-link>
          <span v-else class="text-zinc-500">未分类</span>

          <span class="text-zinc-300 font-light">/</span>
          <span>{{ article.views }} 浏览</span>
        </div>
      </header>

      <div ref="articleContentRef"
        class="prose prose-zinc prose-base sm:prose-lg max-w-none subpixel-antialiased
                  prose-headings:text-zinc-950 prose-headings:font-bold prose-headings:tracking-tighter
                  prose-p:text-zinc-800 prose-p:leading-relaxed prose-p:tracking-[0.01em]
                  prose-li:text-zinc-800 prose-li:leading-relaxed
                  prose-a:text-zinc-950 prose-a:underline prose-a:underline-offset-4 hover:prose-a:opacity-60 transition-all
                  prose-blockquote:border-l-zinc-200 prose-blockquote:font-normal prose-blockquote:text-zinc-500 prose-blockquote:not-italic prose-blockquote:pl-8
                  prose-strong:text-zinc-950 prose-strong:font-bold
                  prose-hr:border-zinc-100
                  prose-img:rounded-md prose-img:mx-auto prose-img:shadow-sm prose-img:border prose-img:border-zinc-100" v-html="renderedContent">
      </div>

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
          <textarea v-model="commentContent" rows="3" :placeholder="userStore.isBanned ? '您已被封禁，仅限阅读。' : '在此写出你的评论。'"
            class="w-full bg-transparent border border-zinc-100 focus:border-zinc-950 rounded-none p-4 text-sm text-zinc-900 placeholder:text-zinc-400 outline-none transition-colors resize-none appearance-none"
            :class="{ 'opacity-50 cursor-not-allowed': userStore.isBanned }"
            :disabled="submittingComment || isCalculating || userStore.isBanned"></textarea>
          <div class="mt-3 flex justify-end">
            <button @click="() => submitComment()"
              :disabled="!commentContent.trim() || submittingComment || isCalculating || userStore.isBanned"
              class="w-full sm:w-auto text-xs font-bold tracking-[0.2em] uppercase px-8 py-3 bg-zinc-950 text-white hover:opacity-80 disabled:opacity-30 transition-all">
              <template v-if="userStore.isBanned">账号已封禁</template>
              <template v-else-if="isCalculating">安全校验...</template>
              <template v-else-if="submittingComment">发送中...</template>
              <template v-else>发送</template>
            </button>
          </div>
        </div>

        <div v-else class="mb-12 py-8 bg-white flex items-center justify-center border border-zinc-100">
          <p class="text-xs sm:text-sm font-medium tracking-widest uppercase text-zinc-400">
            请 <router-link to="/login" class="text-zinc-950 underline underline-offset-4 font-bold">登录</router-link>
            后发表评论
          </p>
        </div>

        <TransitionGroup name="list-fade-up" tag="div" class="space-y-8">
          <div v-for="comment in comments" :key="comment.id" class="group border-b border-zinc-100 pb-8 last:border-0">
            <div class="flex items-center justify-between gap-3 mb-3">
              <div class="flex items-center gap-3">
                <span class="text-sm font-bold text-zinc-950 truncate">{{ comment.userName }}</span>

                <button
                  v-if="userStore.userInfo?.role === 'admin' || (userStore.isLoggedIn && String(comment.userName) === String(userStore.userInfo?.username))"
                  @click="handleCommentDelete(String(comment.id))"
                  class="text-[9px] font-bold text-red-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-all uppercase tracking-widest">
                  [删除]
                </button>
              </div>
              <span class="text-[10px] font-mono text-zinc-400 shrink-0"
                :title="TimeUtils.toFullLocalString(comment.createTime)">
                {{ TimeUtils.toRelative(comment.createTime) }}
              </span>
            </div>
            <p class="text-sm text-zinc-600 leading-relaxed whitespace-pre-wrap wrap-break-word">
              {{ comment.content }}
            </p>
          </div>
        </TransitionGroup>

        <div ref="loadMoreTrigger" class="h-32 flex flex-col items-center justify-center">
          <Transition name="state-fade" mode="out-in">
            <div v-if="loadingComments" key="loading" class="flex flex-col items-center gap-3">
              <span class="text-[10px] font-bold tracking-[0.2em] text-zinc-400 uppercase animate-pulse">加载中</span>
              <div class="w-10 h-px bg-zinc-100 overflow-hidden relative">
                <div class="absolute inset-0 bg-zinc-950/20 animate-loading-bar"></div>
              </div>
            </div>
            <div v-else-if="!hasMore" key="end"
              class="text-[10px] font-mono text-zinc-300 uppercase tracking-widest px-4 text-center">
              {{ comments.length > 0 ? '上面的评论已为最后一条评论。' : '无评论。' }}
            </div>
          </Transition>
        </div>
      </section>
    </article>

    <div v-else class="py-32 text-center grow flex flex-col items-center justify-center">
      <p class="text-sm font-medium tracking-widest uppercase text-zinc-400 mb-6">文章未找到。</p>
      <router-link to="/"
        class="text-[11px] font-bold tracking-[0.2em] uppercase text-zinc-950 border-b border-zinc-950 pb-0.5">
        回到主页
      </router-link>
    </div>

    <ConfirmModal v-model:visible="modalState.visible" :title="modalState.title" :content="modalState.content"
      @confirm="modalState.onConfirm" @cancel="modalState.onCancel" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getArticleById, type ArticleDetail } from '@/api/article'
import { getComments, createComment, deleteComment, type CommentItem } from '@/api/comment'
import { useUserStore } from '@/store/user'
import MarkdownIt from 'markdown-it'
import { createHighlighter } from 'shiki'
import { toast } from '@/utils/toast'
import ConfirmModal from '@/components/ui/ConfirmModal.vue'
import { TimeUtils } from '@/utils/time'
import { getPowChallenge } from '@/api/auth'
import { getBrowserFp } from '@/utils/fingerprint'
import { usePow } from '@/composables/usePow'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

const article = ref<ArticleDetail | null>(null)
const loading = ref(true)
const renderedContent = ref('')
const articleContentRef = ref<HTMLElement | null>(null)

const comments = ref<CommentItem[]>([])
const nextCursor = ref<string | null>(null)
const hasMore = ref(true)
const loadingComments = ref(false)
const loadMoreTrigger = ref<HTMLElement | null>(null)

const commentContent = ref('')
const submittingComment = ref(false)

const lastEventTime = ref<number>(0)
const debounceTimers = new Map<string, any>()

const { calculate, isCalculating } = usePow()

// 核心：模态框调度中心状态
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
let highlighterInstance: any = null

const runSmoothUpdate = async (updateAction: () => Promise<void>) => {
  const container = articleContentRef.value;
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
    const freshContainer = articleContentRef.value;
    if (freshContainer) {
      const targetElement = freshContainer.children[anchorIndex] as HTMLElement | undefined;
      if (targetElement) {
        const newRect = targetElement.getBoundingClientRect();
        const diff = newRect.top - anchorOffset;
        window.scrollBy(0, diff);
      }
    }
  }
}

const loadArticle = async (silent = false) => {
  const id = Number(route.params.id)
  if (isNaN(id)) return
  if (!silent) loading.value = true
  const action = async () => {
    try {
      const res = await getArticleById(id)
      if (res) {
        article.value = res
        await renderMarkdown(res.content)
        if (!silent) {
          comments.value = []
          nextCursor.value = null
          hasMore.value = true
          await loadMoreComments()
        }
      }
    } catch (error) {
      console.error("文章加载失败:", error)
    }
  };
  if (silent) {
    await runSmoothUpdate(action);
  } else {
    await action();
    loading.value = false;
    await nextTick();
    initObserver();
  }
}

const handleRemoteArticleUpdated = (e: Event) => {
  const data = (e as CustomEvent).detail;
  const articleId = String(data.articleId);
  const eventTimestamp = new Date(data.eventTime).getTime();

  if (!article.value || articleId !== String(article.value.id)) return;
  if (eventTimestamp <= lastEventTime.value) return;
  lastEventTime.value = eventTimestamp;

  if (debounceTimers.has(articleId)) clearTimeout(debounceTimers.get(articleId));
  const timer = setTimeout(async () => {
    await loadArticle(true);
    toast.success('内容已实时同步');
    debounceTimers.delete(articleId);
  }, 500);
  debounceTimers.set(articleId, timer);
}

const handleRemoteArticleDeleted = (e: Event) => {
  const { articleId } = (e as CustomEvent).detail;
  const targetId = String(articleId);
  if (article.value && targetId === String(article.value.id)) {
    if (debounceTimers.has(targetId)) {
      clearTimeout(debounceTimers.get(targetId));
      debounceTimers.delete(targetId);
    }
    article.value = null;

    triggerModal({
      title: '文章已被删除',
      content: '该文章内容已被移除，正在为您返回首页。',
      onConfirm: () => { router.replace('/') },
      onCancel: () => { router.replace('/') }
    });
  }
}

const handleSignalRReconnected = () => {
  if (article.value) loadArticle(true);
}

const renderMarkdown = async (content: string) => {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: true })
  if (!highlighterInstance) {
    highlighterInstance = await createHighlighter({
      themes: ['vitesse-light'],
      langs: ['csharp', 'typescript', 'javascript', 'sql', 'bash', 'json', 'html', 'css', 'markdown']
    })
  }
  md.options.highlight = (code, lang) => {
    return highlighterInstance.codeToHtml(code, {
      lang: lang || 'text',
      theme: 'vitesse-light'
    })
  }
  renderedContent.value = md.render(content || '')
}

const loadMoreComments = async () => {
  if (loadingComments.value || !hasMore.value || !article.value) return
  loadingComments.value = true
  try {
    const res = await getComments(article.value.id, nextCursor.value, 10)
    if (res.data && res.data.length > 0) {
      const uniqueNewComments = res.data.filter(
        newItem => !comments.value.some(existing => String(existing.id) === String(newItem.id))
      )
      comments.value.push(...uniqueNewComments)
      nextCursor.value = res.nextCursor ? String(res.nextCursor) : null
      hasMore.value = res.hasMore
    } else {
      hasMore.value = false
    }
  } catch (error) {
    console.error("Comments loading failed:", error)
  } finally {
    await new Promise(resolve => setTimeout(resolve, 100))
    loadingComments.value = false
  }
}

/**
 * 带 PoW 的评论提交
 */
const submitComment = async (retryCount = 0) => {
  // 基础校验
  if (!commentContent.value.trim() || !article.value) return

  // 防止重复提交
  if (submittingComment.value || isCalculating.value) return

  submittingComment.value = true

  try {
    // 1. 获取挑战包 (Action: 'comment')
    const challengeRes = await getPowChallenge({ action: 'comment' });
    const { salt, difficulty, timestamp, signature } = challengeRes as any;

    // 2. 算力求解 (Worker)
    const fp = getBrowserFp();
    const { nonce } = await calculate(salt, fp, difficulty);

    // 3. 提交评论 (带上 PoW 凭证)
    await createComment({
      articleId: article.value.id,
      content: commentContent.value,
      // PoW 字段
      powSalt: salt,
      powNonce: nonce,
      powTimestamp: timestamp,
      difficulty: difficulty,
      powSignature: signature,
      browserFp: fp
    })

    toast.success('发送成功')
    commentContent.value = '' // 清空输入框

  } catch (error: any) {
    console.error("Submit failed:", error)

    // 处理 403 难度提升重试
    if (error.response?.status === 403 && retryCount < 1) {
      toast.info("评论区繁忙，正在提升算力重试...");
      submittingComment.value = false; // 先释放锁，递归调用会重新上锁
      await submitComment(retryCount + 1);
      return;
    }

    // 其他错误提示
    toast.error(error.response?.data?.message || '评论发布失败');
  } finally {
    submittingComment.value = false
  }
}

const handleRemoteAdd = (e: Event) => {
  const { articleId, comment } = (e as CustomEvent).detail;
  if (!comment || !comment.id) return;
  if (article.value && String(articleId) === String(article.value.id)) {
    const exists = comments.value.some(c => String(c.id) === String(comment.id));
    if (!exists) {
      comments.value.unshift(comment);
    }
  }
};

const handleRemoteDelete = (e: Event) => {
  const data = (e as CustomEvent).detail;
  if (article.value && String(data.articleId) === String(article.value.id)) {
    const targetIdStr = String(data.commentId);
    comments.value = comments.value.filter(c => String(c.id) !== targetIdStr);
  }
};

const handleCommentDelete = (id: string) => {
  const targetId = String(id);
  const isAdmin = userStore.userInfo?.role === 'admin';

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
  observer = new IntersectionObserver(([entry]) => {
    if (entry?.isIntersecting && hasMore.value && !loadingComments.value) {
      loadMoreComments()
    }
  }, { rootMargin: '880px' })
  observer.observe(loadMoreTrigger.value)
}

onMounted(() => {
  loadArticle();
  window.addEventListener('signalr:comment-added', handleRemoteAdd);
  window.addEventListener('signalr:comment-removed', handleRemoteDelete);
  window.addEventListener('signalr:article-updated', handleRemoteArticleUpdated);
  window.addEventListener('signalr:article-restored', handleRemoteArticleUpdated);
  window.addEventListener('signalr:article-deleted', handleRemoteArticleDeleted);
  window.addEventListener('signalr:reconnected', handleSignalRReconnected);
});

onUnmounted(() => {
  if (observer) observer.disconnect();
  debounceTimers.forEach(timer => clearTimeout(timer));
  debounceTimers.clear();
  window.removeEventListener('signalr:comment-added', handleRemoteAdd);
  window.removeEventListener('signalr:comment-removed', handleRemoteDelete);
  window.removeEventListener('signalr:article-updated', handleRemoteArticleUpdated);
  window.removeEventListener('signalr:article-restored', handleRemoteArticleUpdated);
  window.removeEventListener('signalr:article-deleted', handleRemoteArticleDeleted);
  window.removeEventListener('signalr:reconnected', handleSignalRReconnected);
});
</script>

<style>
@reference "@/assets/main.css";

/* Shiki 代码块：无边界融入设计 */
.shiki {
  padding: 1.5rem !important;
  margin: 2rem 0 !important;
  background-color: #fbfbfb !important;
  border: 1px solid rgba(24, 24, 27, 0.05) !important;
  border-radius: 2px;
  font-size: 0.85rem;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  line-height: 1.7;
  overflow-x: auto;
}

.prose :not(pre)>code {
  background-color: #f4f4f5 !important;
  color: #18181b !important;
  padding: 0.2rem 0.4rem !important;
  border-radius: 2px !important;
  font-weight: 500 !important;
}

.prose blockquote {
  border-left-width: 2px !important;
  border-left-color: #e4e4e7 !important;
  background-color: transparent !important;
  font-style: normal !important;
  margin: 2.5rem 0 !important;
  padding-left: 2rem !important;
  line-height: 1.8 !important;
  letter-spacing: 0.025em !important;
}

.prose blockquote p {
  margin: 0 !important;
}

.prose ul,
.prose ol {
  padding-left: 1.25rem;
}

.prose li::marker {
  color: #d4d4d8;
}

.prose img {
  display: block;
  margin-left: auto;
  margin-right: auto;
  max-width: 100%;
  max-height: 75vh;
  object-fit: contain;
  background-color: #fff;
  margin-top: 2rem;
  margin-bottom: 2rem;
}

@keyframes loading-bar {
  0% {
    transform: translateX(-100%);
  }

  100% {
    transform: translateX(100%);
  }
}

.animate-loading-bar {
  animation: loading-bar 1.5s infinite;
}

.list-fade-up-enter-active {
  transition: opacity 0.4s ease, transform 0.4s ease;
}

.list-fade-up-enter-from {
  opacity: 0;
  transform: translateY(10px);
}

.list-fade-up-leave-active {
  transition: all 0.5s ease;
  position: absolute;
  width: 100%;
}

.list-fade-up-leave-to {
  opacity: 0;
  transform: translateX(30px);
}

.list-fade-up-move {
  transition: transform 0.5s ease;
}
</style>