<template>
    <article 
        :class="themeTokens.articleList.card"
        :style="articleStyle"
        itemscope 
        itemtype="https://schema.org/BlogPosting"
    >
        <!-- SEO 元数据：隐藏字段 -->
        <meta itemprop="author" :content="view.meta.categoryName || 'Fsu'" />
        <meta itemprop="datePublished" :content="view.meta.isoTime" />

        <div :class="themeTokens.articleList.metaRow">
            <time :datetime="view.meta.isoTime"
                  :title="fullTime"
                  itemprop="dateCreated"
                  class="tabular-nums">
                {{ displayTime }}
            </time>

            <span :class="themeTokens.articleList.metaSeparator" aria-hidden="true">/</span>
            <span :class="themeTokens.articleList.metaCategory" itemprop="articleSection">
                {{ categoryName }}
            </span>

            <template v-if="displayTags.length">
                <span :class="`${themeTokens.articleList.metaSeparator} hidden sm:inline`" aria-hidden="true">/</span>
                <UiTag v-for="tag in displayTags" :key="tag.label" :contract="tag" />
            </template>
        </div>

        <h2 :class="themeTokens.articleList.title"
            itemprop="headline">
            <component :is="linkComponent" v-bind="titleLinkProps" :class="themeTokens.articleList.titleLink">
                <!-- 性能优化: 绑定预计算的高亮内容 -->
                <span v-html="highlightedTitle"></span>
            </component>
        </h2>

        <p :class="themeTokens.articleList.summary"
           itemprop="description">
            <span v-html="highlightedSummary"></span>
        </p>

        <component :is="linkComponent"
                     v-bind="readLinkProps"
                     aria-label="阅读全文"
                     :class="themeTokens.articleList.readLink">
            阅读<span aria-hidden="true">→</span>
        </component>
    </article>
</template>

<script setup lang="ts">
    import { computed } from 'vue'
    import { RouterLink } from 'vue-router'
    import type { ArticleListCardViewContract } from '@/view-contracts/articleList'
    import { themeTokens } from '@/ui-tokens/themeTokens'
    import UiTag from '@/ui-adapters/element-plus/UiTag.vue'

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
        view: ArticleListCardViewContract;
        searchKeyword?: string;
        index?: number;
        linkMode?: 'router' | 'anchor';
    }>()

    // ==========================================
    // 1. 基础数据计算 (解决模板热路径调用问题)
    // ==========================================

    const displayTime = computed(() => props.view.meta.displayTime);
    const fullTime = computed(() => props.view.meta.fullTime);
    const categoryName = computed(() => props.view.meta.categoryName);
    const displayTags = computed(() => props.view.tags?.slice(0, MAX_TAGS_DISPLAY) || []);

    const articleLink = computed(() => ({
        name: 'ArticleDetail',
        params: { id: props.view.id }
    }));

    const articleHref = computed(() => props.view.href || `/article/${props.view.id}`);
    const linkComponent = computed(() => props.linkMode === 'anchor' ? 'a' : RouterLink);
    const titleLinkProps = computed(() => props.linkMode === 'anchor'
        ? { href: articleHref.value, 'data-public-link': 'article' }
        : { to: articleLink.value });
    const readLinkProps = computed(() => props.linkMode === 'anchor'
        ? { href: articleHref.value, 'data-public-link': 'article' }
        : { to: articleLink.value });

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
    const highlightedTitle = computed(() => performHighlight(props.view.title));
    const highlightedSummary = computed(() => performHighlight(props.view.summary));

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
