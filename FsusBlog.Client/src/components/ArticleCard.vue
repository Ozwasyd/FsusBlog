<template>
    <article 
        class="group flex flex-col items-start gap-3 sm:gap-4 subpixel-antialiased animate-fade-in"
        :style="articleStyle"
        itemscope 
        itemtype="https://schema.org/BlogPosting"
    >
        <!-- SEO 元数据：隐藏字段 -->
        <meta itemprop="author" :content="article.category?.name || 'Fsu'" />
        <meta itemprop="datePublished" :content="article.createTime" />

        <div class="flex flex-wrap items-center gap-3 text-[11px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase">
            <time :datetime="article.createTime"
                  :title="fullTime"
                  itemprop="dateCreated"
                  class="tabular-nums">
                {{ displayTime }}
            </time>

            <span class="text-zinc-300 font-light" aria-hidden="true">/</span>
            <span class="text-zinc-600" itemprop="articleSection">
                {{ categoryName }}
            </span>

            <template v-if="displayTags.length">
                <span class="text-zinc-300 font-light hidden sm:inline" aria-hidden="true">/</span>
                <span v-for="tag in displayTags" :key="tag.id" class="hidden sm:inline">
                    #{{ tag.name }}
                </span>
            </template>
        </div>

        <h2 class="text-xl sm:text-2xl font-bold text-zinc-950 group-hover:text-zinc-500 transition-colors duration-300 leading-snug"
            itemprop="headline">
            <router-link :to="articleLink" class="block">
                <!-- 性能优化: 绑定预计算的高亮内容 -->
                <span v-html="highlightedTitle"></span>
            </router-link>
        </h2>

        <p class="text-sm sm:text-base text-zinc-600 leading-relaxed sm:leading-loose line-clamp-3"
           itemprop="description">
            <span v-html="highlightedSummary"></span>
        </p>

        <router-link :to="articleLink"
                     aria-label="阅读全文"
                     class="mt-2 text-[11px] sm:text-xs font-bold tracking-[0.2em] uppercase text-zinc-950 hover:text-zinc-500 transition-colors flex items-center gap-2 py-2 -ml-0.5">
            阅读<span aria-hidden="true">→</span>
        </router-link>
    </article>
</template>

<script setup lang="ts">
    import { computed } from 'vue'
    import type { ArticleListItem } from '@/api/article'
    import { TimeUtils } from '@/utils/time'

    // 常量定义
    const DEFAULT_CATEGORY = '通用类';
    const MAX_TAGS_DISPLAY = 5;

    // 性能优化: 将静态映射表移出 setup 以节省内存
    const HTML_ESCAPE_MAP: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
        '/': '&#47;',
        '`': '&#96;'
    }

    const props = defineProps<{
        article: ArticleListItem;
        searchKeyword?: string;
        index?: number;
    }>()

    // ==========================================
    // 1. 基础数据计算 (解决模板热路径调用问题)
    // ==========================================

    const displayTime = computed(() => TimeUtils.toSmartTime(props.article.createTime));
    const fullTime = computed(() => TimeUtils.toFullLocalString(props.article.createTime));
    const categoryName = computed(() => props.article.category?.name || DEFAULT_CATEGORY);
    const displayTags = computed(() => props.article.tags?.slice(0, MAX_TAGS_DISPLAY) || []);

    const articleLink = computed(() => ({
        name: 'ArticleDetail',
        params: { id: props.article.id }
    }));

    const articleStyle = computed(() => ({
        '--index': props.index ?? 0
    }))

    // ==========================================
    // 2. 高亮引擎逻辑 (解决 XSS 与 计算性能问题)
    // ==========================================

    const searchRegex = computed(() => {
        const q = props.searchKeyword?.trim()
        if (!q) return null
        try {
            const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            return new RegExp(`(${escaped})`, 'gi')
        } catch (e) {
            return null
        }
    })

    /**
     * 内部高亮处理逻辑
     * [修复 2026-02-23] 修复 TS 2769 错误：使用空值合并运算符确保 replace 回调返回明确的 string
     */
    const performHighlight = (text: string): string => {
        if (!text) return ''

        // 安全性保障：物理级 HTML 转义
        // 核心修复：HTML_ESCAPE_MAP[m] ?? m 确保了即使未匹配到也能返回原字符，且满足 TS 类型契约
        const safeText = text.replace(/[&<>"'`\/]/g, m => HTML_ESCAPE_MAP[m] ?? m)

        const regex = searchRegex.value
        if (!regex) return safeText

        return safeText.replace(regex, '<mark class="highlight-mark">$1</mark>')
    }

    // 预计算高亮结果，缓存至计算属性
    const highlightedTitle = computed(() => performHighlight(props.article.title));
    const highlightedSummary = computed(() => performHighlight(props.article.snippet || props.article.summary || ''));

</script>

<style scoped>
    /* 样式部分保持一致 */
    .animate-fade-in {
        --stagger-delay: 0.05s;
        animation: slide-up 0.5s cubic-bezier(0.16, 1, 0.3, 1) both;
        animation-delay: calc(min(var(--index, 0), 20) * var(--stagger-delay));
    }

    @keyframes slide-up {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
    }

    .line-clamp-3 {
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 3;
        overflow: hidden;
        word-break: break-word; 
        overflow-wrap: break-word;
    }

    :deep(.highlight-mark) {
        background-color: #f4f4f5;
        color: #09090b;
        padding: 0 2px;
        border-radius: 2px;
        font-weight: 600;
        box-shadow: 0 0 0 1px rgba(228, 228, 231, 0.5);
    }
</style>