<template>
    <article
        :id="`comment-${node.id}`"
        ref="nodeElement"
        class="fsus-comment-tree-node"
        :class="[depthClass, { 'is-root': depth === 0, 'is-deep': depth >= 4 }]"
        tabindex="-1"
        @keydown.left.self.stop="collapseBranch"
        @keydown.right.self.stop="expandBranch"
    >
        <header class="fsus-comment-tree-node__header">
            <div class="fsus-comment-tree-node__identity">
                <span :class="['fsus-comment-tree-node__author', isAnonymous ? 'is-anonymous' : 'is-authenticated']">
                    {{ node.author.displayName }}
                </span>
                <span
                    v-if="isAnonymous"
                    class="fsus-comment-tree-node__badge"
                >匿名</span>
                <span
                    v-if="node.replyToAuthor"
                    class="fsus-comment-tree-node__target"
                >
                    回复 @{{ node.replyToAuthor.displayName }}
                </span>
            </div>
            <a
                class="fsus-comment-tree-node__time"
                :href="`#comment-${node.id}`"
                :title="time.fullLocalTimeText"
                :aria-label="`${time.fullLocalTimeText}，评论永久链接`"
            >
                <time :datetime="time.isoTime">{{ time.relativeTimeText }}</time>
            </a>
            <span
                v-if="node.isEdited"
                class="fsus-comment-tree-node__edited"
                aria-label="此评论已编辑"
            >已编辑</span>
        </header>

        <CommentMarkdownRenderer
            class="fsus-comment-tree-node__content"
            :content="node.content"
            :collapsed-lines="COMMENT_CONTENT_CONSTRAINT.collapsedMarkdownMaxLines"
            :expanded="contentExpanded"
            :collapsible="contentFoldable"
            @overflow-change="contentOverflow = $event"
        />

        <footer class="fsus-comment-tree-node__footer">
            <FsusUiButton
                native-type="button"
                link
                inline-action
                class="fsus-comment-tree-node__action"
                @click="emitReply"
            >
                {{ isLoggedIn ? '回复' : '登录后回复' }}
            </FsusUiButton>
            <FsusUiButton
                v-if="contentFoldable"
                native-type="button"
                link
                inline-action
                class="fsus-comment-tree-node__action"
                @click="contentExpanded = !contentExpanded"
            >
                {{ contentExpanded ? '收起正文' : '展开正文' }}
            </FsusUiButton>
            <FsusUiButton
                v-if="node.childCount > 0"
                native-type="button"
                link
                inline-action
                class="fsus-comment-tree-node__action"
                :aria-expanded="branchExpanded"
                :aria-controls="`comment-children-${node.id}`"
                @click="toggleBranch"
            >
                {{ branchExpanded ? '收起回复' : `展开 ${node.childCount} 条直接回复` }}
            </FsusUiButton>
            <FsusUiButton
                v-if="canEdit"
                native-type="button"
                link
                inline-action
                class="fsus-comment-tree-node__action"
                @click="$emit('edit', { id: node.id, content: node.content })"
            >
                编辑
            </FsusUiButton>
            <FsusUiButton
                v-if="canDelete"
                native-type="button"
                type="danger"
                link
                inline-action
                class="fsus-comment-tree-node__action"
                :aria-label="depth === 0 ? '删除评论' : '删除回复'"
                @click="$emit('delete', { id: node.id, rootId: node.rootId, parentId: node.parentId ?? null, content: node.content })"
            >
                删除
            </FsusUiButton>
        </footer>

        <section
            v-if="branchExpanded && (visibleChildren.length > 0 || node.hasMoreChildren)"
            :id="`comment-children-${node.id}`"
            class="fsus-comment-tree-node__children"
            role="group"
            :aria-label="`${node.author.displayName} 的直接回复`"
        >
            <ArticleCommentTreeNode
                v-for="child in visibleChildren"
                :key="child.id"
                :node="child"
                :depth="depth + 1"
                :is-admin="isAdmin"
                :is-logged-in="isLoggedIn"
                :owned-comment-ids="ownedCommentIds"
                :loading-replies="loadingReplies"
                @reply="$emit('reply', $event)"
                @load-more="$emit('loadMore', $event)"
                @edit="$emit('edit', $event)"
                @delete="$emit('delete', $event)"
            />
            <FsusUiButton
                v-if="node.hasMoreChildren"
                native-type="button"
                link
                inline-action
                class="fsus-comment-tree-node__action fsus-comment-tree-node__load-more"
                :disabled="loadingReplies[node.id] === true"
                @click="$emit('loadMore', node.id)"
            >
                {{ loadingReplies[node.id] === true ? '加载中…' : '加载本分支更多回复' }}
            </FsusUiButton>
            <p
                v-if="hiddenChildCount > 0"
                class="fsus-comment-tree-node__limit-note"
            >
                已达到本分支渲染上限，另有 {{ hiddenChildCount }} 条已加载回复暂不渲染。
            </p>
        </section>
    </article>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { CommentAuthorView } from '@/api/comment';
import CommentMarkdownRenderer from '@/components/article/CommentMarkdownRenderer.vue';
import type { CommentTreeViewNode } from '@/composables/useArticleCommentStream';
import { FsusUiButton } from '@/fsusui/button';
import { getCommentManagementCapabilityVault } from '@/privacy/commentManagementCapabilityVault';
import { COMMENT_CONTENT_CONSTRAINT } from '@/utils/contentFilter';
import { TimeUtils } from '@/utils/time';

defineOptions({ name: 'ArticleCommentTreeNode' });

interface ReplyTargetPayload { id: string; rootId: string; author: CommentAuthorView; depth: number; }
interface DeletePayload { id: string; rootId: string; parentId: string | null; content: string; }
interface EditPayload { id: string; content: string; }

const props = defineProps<{
    node: CommentTreeViewNode;
    depth: number;
    isAdmin: boolean;
    isLoggedIn: boolean;
    ownedCommentIds: ReadonlySet<string>;
    loadingReplies: Record<string, boolean>;
}>();

const emit = defineEmits<{
    reply: [payload: ReplyTargetPayload];
    loadMore: [parentId: string];
    edit: [payload: EditPayload];
    delete: [payload: DeletePayload];
}>();

const nodeElement = ref<HTMLElement | null>(null);
const branchExpanded = ref(props.node.childrenExpanded || props.node.children.length > 0);
const contentExpanded = ref(false);
const contentOverflow = ref(false);
const isAnonymous = computed(() => props.node.author.mode !== 'public');
const depthClass = computed(() => `fsus-comment-tree-node--depth-${Math.min(Math.max(props.depth, 0), 4)}`);
const hasAnonymousCapability = computed(() => getCommentManagementCapabilityVault().get(props.node.id) !== null);
const canEdit = computed(() => !props.node.isDeleted && (props.ownedCommentIds.has(props.node.id) || hasAnonymousCapability.value));
const canDelete = computed(() => props.isAdmin || props.ownedCommentIds.has(props.node.id) || hasAnonymousCapability.value);
const contentFoldable = computed(() => contentOverflow.value
    || props.node.content.length > 360
    || props.node.content.split(/\r\n|\r|\n/u).length > COMMENT_CONTENT_CONSTRAINT.collapsedMarkdownMaxLines);
const visibleChildren = computed(() => props.node.children.slice(0, COMMENT_CONTENT_CONSTRAINT.replyRenderLimit));
const hiddenChildCount = computed(() => Math.max(0, props.node.children.length - visibleChildren.value.length));
const time = computed(() => ({
    isoTime: props.node.createTime,
    relativeTimeText: formatRelativeTime(props.node.createTime),
    fullLocalTimeText: TimeUtils.toFullLocalString(props.node.createTime)
}));

watch(() => props.node.childrenExpanded, (expanded) =>
{
    if (expanded)
    {
        branchExpanded.value = true;
    }
});

function formatRelativeTime(iso: string): string
{
    const target = TimeUtils._parse(iso);
    if (!target)
    {
        return '时间未知';
    }
    const minutes = Math.floor((Date.now() - target.valueOf()) / 60000);
    if (minutes < -1)
    {
        return target.local().format('MM-DD HH:mm');
    }
    if (minutes <= 0)
    {
        return '刚刚';
    }
    if (minutes < 60)
    {
        return `${minutes}分钟前`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
    {
        return `${hours}小时前`;
    }
    const days = Math.floor(hours / 24);
    if (days < 30)
    {
        return `${days}天前`;
    }
    const months = Math.floor(days / 30);
    return months < 12 ? `${months}个月前` : `${Math.floor(months / 12)}年前`;
}

const emitReply = (): void => emit('reply', {
    id: props.node.id,
    rootId: props.node.rootId,
    author: props.node.author,
    depth: props.node.depth
});

const expandBranch = (): void =>
{
    if (props.node.childCount <= 0)
    {
        return;
    }
    branchExpanded.value = true;
    if (props.node.children.length === 0 && props.node.hasMoreChildren)
    {
        emit('loadMore', props.node.id);
    }
};

const collapseBranch = (): void =>
{
    if (!branchExpanded.value)
    {
        return;
    }
    branchExpanded.value = false;
    nodeElement.value?.focus({ preventScroll: true });
};

const toggleBranch = (): void => branchExpanded.value ? collapseBranch() : expandBranch();
</script>

<style scoped>
.fsus-comment-tree-node
 {
    min-width: 0;
    padding-block: 16px;
    color: var(--fsusblog-text-primary);
    outline: none;
}

.fsus-comment-tree-node--depth-0
 {
    --comment-tree-depth: 0;
}

.fsus-comment-tree-node--depth-1
 {
    --comment-tree-depth: 1;
}

.fsus-comment-tree-node--depth-2
 {
    --comment-tree-depth: 2;
}

.fsus-comment-tree-node--depth-3
 {
    --comment-tree-depth: 3;
}

.fsus-comment-tree-node--depth-4
 {
    --comment-tree-depth: 4;
}

.fsus-comment-tree-node.is-root
 {
    padding-block: 20px;
    border-bottom: 1px solid var(--fsusblog-panel-border);
}

.fsus-comment-tree-node:focus-visible
 {
    border-radius: var(--fsusblog-radius-control, 6px);
    box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
}

.fsus-comment-tree-node__header,
.fsus-comment-tree-node__identity,
.fsus-comment-tree-node__footer
 {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

.fsus-comment-tree-node__header
 {
    justify-content: space-between;
}

.fsus-comment-tree-node__author.is-authenticated
 {
    font-weight: 700;
}

.fsus-comment-tree-node__identity
 {
    min-width: 0;
}

.fsus-comment-tree-node__author,
.fsus-comment-tree-node__target
 {
    min-width: 0;
    overflow-wrap: anywhere;
}

.fsus-comment-tree-node__author.is-anonymous,
.fsus-comment-tree-node__target,
.fsus-comment-tree-node__time
 {
    color: var(--fsusblog-text-quiet);
}

.fsus-comment-tree-node__badge
 {
    padding: 2px 6px;
    border: 1px solid var(--fsusblog-panel-border-strong);
    border-radius: 999px;
    color: var(--fsusblog-text-muted);
    font-size: 12px;
}

.fsus-comment-tree-node__time
 {
    font-size: 14px;
    text-decoration: none;
}

.fsus-comment-tree-node__edited
 {
    color: var(--fsusblog-text-quiet);
    font-size: 12px;
}

.fsus-comment-tree-node__content
 {
    margin-block: 8px;
    overflow-wrap: anywhere;
}

.fsus-comment-tree-node__footer
 {
    gap: 12px;
}

.fsus-comment-tree-node__footer > .fsus-comment-tree-node__action
 {
    margin: 0;
}

.fsus-comment-tree-node__children
 {
    margin-top: 8px;
    margin-left: clamp(10px, calc(18px - var(--comment-tree-depth) * 2px), 18px);
    padding-left: clamp(8px, calc(16px - var(--comment-tree-depth) * 2px), 16px);
    border-left: 2px solid var(--fsusblog-panel-border-strong);
}

.fsus-comment-tree-node.is-deep > .fsus-comment-tree-node__children
 {
    border-left-style: dotted;
}

.fsus-comment-tree-node__load-more
 {
    margin-block: 8px;
}

.fsus-comment-tree-node__limit-note
 {
    color: var(--fsusblog-text-quiet);
    font-size: 12px;
}

@media (width <= 1023px)
 {
    .fsus-comment-tree-node__time
 {
        display: inline-flex;
        min-width: 44px;
        min-height: 44px;
        align-items: center;
    }
}

@media (width <= 640px)
 {
    .fsus-comment-tree-node__header
 {
        align-items: flex-start;
    }

    .fsus-comment-tree-node__children
 {
        margin-left: 6px;
        padding-left: 8px;
    }
}
</style>
