import { createApp, h, nextTick, ref } from 'vue';

import '@/assets/public-shell-critical.css';
import '@/assets/main.css';
import ArticleCommentTreeNode from '@/components/article/ArticleCommentTreeNode.vue';
import type { CommentTreeViewNode } from '@/composables/useArticleCommentStream';
import { activateLocaleRuntime } from '@/locales';

const theme = new URL(location.href).searchParams.get('theme') ?? 'light';
document.documentElement.classList.toggle('dark', theme === 'dark');
await activateLocaleRuntime('zh-CN', ['common', 'article']);

const child: CommentTreeViewNode = {
    id: '8', rootId: '7', parentId: '7', replyToCommentId: '7', depth: 1,
    content: '直接回复', createTime: '2026-06-01T03:00:00.000Z',
    author: { mode: 'public', displayName: 'Reader', displayLanguage: 'zh-CN', badge: null, scopeLabel: null },
    replyToAuthor: null, isDeleted: false, isEdited: false, childCount: 0,
    hasMoreChildren: false, children: [], childrenExpanded: false
};
const node: CommentTreeViewNode = {
    ...child, id: '7', parentId: null, replyToCommentId: null, depth: 0,
    content: '足够长的真实评论正文，用于检查折叠、触控目标和横向溢出。'.repeat(30),
    childCount: 2, hasMoreChildren: true, children: [child], childrenExpanded: true
};
const events = ref<{ action: string; payload: unknown }[]>([]);
const loadingReplies = ref<Record<string, boolean>>({});

createApp({
    render: () => h('main', [
        h(ArticleCommentTreeNode, {
            node, depth: 0, isAdmin: false, isLoggedIn: true,
            ownedCommentIds: new Set(['7']), loadingReplies: loadingReplies.value,
            onReply: (payload: unknown) => events.value.push({ action: 'reply', payload }),
            onEdit: (payload: unknown) => events.value.push({ action: 'edit', payload }),
            onDelete: (payload: unknown) => events.value.push({ action: 'delete', payload }),
            onLoadMore: (payload: string) =>
            {
                events.value.push({ action: 'loadMore', payload });
                loadingReplies.value[payload] = true;
            }
        }),
        h('output', { 'data-comment-events': '' }, JSON.stringify(events.value))
    ])
}).mount('#comment-tree-controls');

await nextTick();
document.documentElement.dataset.commentTreeControlsReady = 'true';
