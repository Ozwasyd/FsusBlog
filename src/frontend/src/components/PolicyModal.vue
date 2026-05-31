<template>
  <el-dialog
    v-model="dialogVisible"
    :title="titleMap[type] || '条款详情'"
    width="min(92vw, 48rem)"
    align-center
    @closed="handleAfterLeave"
  >
    <div>
      <el-scrollbar max-height="min(64vh, 44rem)" :aria-busy="loading" aria-label="条款正文">
        <div>
          <div v-if="loading" class="h-48 py-4" role="status">
            <el-skeleton animated :rows="4" />
            <span class="sr-only">正在加载内容...</span>
          </div>

          <div v-else-if="error" class="flex h-40 flex-col items-center justify-center">
            <p class="text-sm font-medium text-[var(--fsusblog-text-muted)]">无法加载文档内容</p>
            <div class="mt-2">
              <el-button type="primary" @click="fetchData">重试</el-button>
            </div>
          </div>

          <p
            v-else-if="!markdownContent"
            class="text-sm font-medium text-[var(--fsusblog-text-muted)]"
          >
            暂未配置{{ titleMap[type] }}。
          </p>
          <MarkdownRenderer
            v-else
            class="policy-legal-doc"
            :content="markdownContent"
            mode="about"
            @render-complete="handleMarkdownComplete"
            @render-error="handleMarkdownError"
          />
        </div>
      </el-scrollbar>
    </div>

    <template #footer>
      <div class="flex justify-end">
        <el-button type="primary" @click="close">
          我已阅读
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue'
import { getPageData } from '@/api/system'
import MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue'

const props = defineProps<{
  visible: boolean,
  type: 'privacy' | 'guidelines'
}>()

const emit = defineEmits<{ (e: 'update:visible', value: boolean): void }>()

const titleMap: Record<string, string> = {
  privacy: '隐私政策',
  guidelines: '用户守则'
}

const markdownContent = ref('')
const loading = ref(false)
const error = ref(false)
const loadedType = ref('')

let abortController: AbortController | null = null

const dialogVisible = computed({
  get: () => props.visible,
  set: (value: boolean) => emit('update:visible', value)
})

const close = () => emit('update:visible', false)

const fetchData = async () => {
  if (abortController) abortController.abort()
  abortController = new AbortController()
  const currentSignal = abortController.signal

  loading.value = true
  error.value = false

  try {
    const res = await getPageData(props.type, { signal: currentSignal })

    if (!currentSignal.aborted) {
      const rawContent = (res as any)?.data?.content || (res as any)?.content || ''
      markdownContent.value = rawContent
      loadedType.value = props.type
    }
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      console.error('[PolicyModal] Fetch failed:', err)
      error.value = true
    }
  } finally {
    abortController = null
    if (!currentSignal.aborted) loading.value = false
  }
}

const handleAfterLeave = () => {
  if (loadedType.value !== props.type) {
    markdownContent.value = ''
    loadedType.value = ''
  }
}

const handleMarkdownComplete = () => {
  loadedType.value = props.type
}

const handleMarkdownError = (renderError: { message?: string }) => {
  console.error('[PolicyModal] Markdown render failed:', renderError.message ?? renderError)
  error.value = true
}

watch(() => props.visible, (newVal) => {
  if (newVal) {
    if (loadedType.value !== props.type) {
      fetchData()
    }
  }
})

onUnmounted(() => {
  if (abortController) abortController.abort()
})
</script>

<style scoped>
@reference "@/assets/main.css";

/* =======================================================
   法务公文级排版引擎 (Legal Document Typography)
   核心要求：严谨、清晰的层级、紧凑但不拥挤、去除花哨装饰
======================================================= */

.policy-legal-doc {
  color: var(--fsusblog-text-secondary);
  font-size: 0.95rem;
  line-height: 1.7;
  letter-spacing: 0;
  text-align: left;
  text-autospace: ideograph-alpha ideograph-numeric;
  text-spacing-trim: space-all;
}

@media (prefers-reduced-motion: reduce) {
  .policy-legal-doc * {
    animation: none !important;
    transition: none !important;
  }
}

/* 消除顶部元素的无意义边距 */
.policy-legal-doc :deep(:where(h1, h2, h3, h4, p, ul, ol, blockquote):first-child) { margin-top: 0; }

/* 1. 标题层级重构 (Headings) */
.policy-legal-doc :deep(h1),
.policy-legal-doc :deep(h2),
.policy-legal-doc :deep(h3),
.policy-legal-doc :deep(h4) {
  color: var(--fsusblog-text-primary);
  font-weight: 700;
  text-indent: 0;
  margin-bottom: 0.8em;
}

/* 协议主标题 */
.policy-legal-doc :deep(h1) {
  font-size: 1.5em;
  margin-top: 2em;
  text-align: left;
  border-bottom: 2px solid var(--fsusblog-panel-bg-soft);
  padding-bottom: 0.5em;
  margin-bottom: 1.5em;
}

/* 条款大类 (如：一、数据收集) */
.policy-legal-doc :deep(h2) {
  font-size: 1.15em;
  margin-top: 2.5em;
  border-bottom: 1px solid var(--fsusblog-panel-border);
  padding-bottom: 0.4em;
}

/* 具体细则条款 */
.policy-legal-doc :deep(h3) {
  font-size: 1em;
  margin-top: 1.8em;
}

/* 2. 段落节律 (Paragraphs) */
.policy-legal-doc :deep(p) {
  margin-top: 0;
  margin-bottom: 0.8em;
  text-indent: 0;
}

/* 3. 有序编号体系 (Lists & Indentation)
   法务文档极其依赖清晰的缩进结构（如 1.1, 1.1.1）
*/
.policy-legal-doc :deep(ol),
.policy-legal-doc :deep(ul) {
  padding-left: 1.8em;
  margin-top: 0.5em;
  margin-bottom: 1.2em;
}

.policy-legal-doc :deep(li) {
  margin-bottom: 0.4em;
  padding-left: 0.2em;
}

.policy-legal-doc :deep(li p) {
  margin-bottom: 0;
  margin-top: 0.2em;
}

/* 4. 关键信息强调 (Strong & Emphasis) */
.policy-legal-doc :deep(strong) {
  font-weight: 700;
  color: var(--fsusblog-text-primary);
  background-color: var(--fsusblog-panel-bg-soft);
  padding: 0 0.2em;
  border-radius: 2px;
}

/* 5. 引用块 (Blockquotes - 常用于定义或免责声明) */
.policy-legal-doc :deep(blockquote) {
  border-left: 3px solid var(--fsusblog-text-tertiary);
  margin: 1.5em 0;
  padding: 0.8em 1.2em;
  color: var(--fsusblog-text-secondary);
  background-color: var(--fsusblog-page-bg-soft);
  font-size: 0.9em;
  font-weight: 500;
}

.policy-legal-doc :deep(blockquote p) {
  margin-bottom: 0.5em;
}
.policy-legal-doc :deep(blockquote p:last-child) {
  margin-bottom: 0;
}

/* 6. 超链接 */
.policy-legal-doc :deep(a) {
  color: var(--fsusblog-color-primary);
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 3px;
  transition: opacity var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}

.policy-legal-doc :deep(a:hover) {
  color: var(--fsusblog-text-primary);
}
</style>
