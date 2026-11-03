<template>
    <section
        class="article-relation-graph"
        aria-label="局部文章关系"
        :aria-busy="state.pending"
    >
        <div class="article-relation-graph__controls">
            <span>局部关系 · 深度 {{ state.request?.requestedDepth ?? 1 }}</span>
            <ElButton
                :disabled="state.pending"
                @click="changeDepth"
            >
                {{ state.request?.requestedDepth === 2 ? '收起到一层' : '展开到两层' }}
            </ElButton>
            <ElButton
                v-if="state.pending"
                @click="session.cancel()"
            >取消查询</ElButton>
            <ElButton @click="session.open(identity, sessionId)">刷新（一层）</ElButton>
            <ElButton
                :disabled="!state.layout"
                @click="session.resetLayout()"
            >重置布局</ElButton>
            <ElButton @click="close">关闭</ElButton>
        </div>
        <p
            ref="feedback"
            data-graph-feedback
            role="status"
            aria-live="polite"
            tabindex="-1"
        >
            {{ state.pending ? state.result ? '正在布局（列表可用）' : '正在查询' : state.result ? statusLabels[state.result.status] : '未打开' }}
            · 实际深度 {{ state.result?.effectiveDepth ?? 0 }}
            · {{ nodes.length }}/{{ articleGraphLimits.nodes }} 文章
            · {{ edges.length }}/{{ articleGraphLimits.edges }} 关系
            <span v-if="state.result?.reason"> · {{ state.result.reason }}</span>
            <span v-if="state.layoutOutcome?.status === 'blocked'"> · 仅列表（布局 {{ state.layoutOutcome.reason }}）</span>
        </p>
        <p
            v-if="state.navigationStatus !== 'idle'"
            role="status"
        >
            {{ state.navigationStatus === 'unavailable' ? '文章或精确来源导航尚未接入' : state.navigationStatus === 'failed' ? '导航失败，请重试' : state.navigationStatus === 'pending' ? '正在导航' : '导航完成' }}
        </p>
        <fieldset class="article-relation-graph__filters">
            <legend>当前查询筛选</legend>
            <label>范围
                <ElSelect
                    :model-value="state.request?.scope"
                    aria-label="范围"
                    @change="changeScope"
                >
                    <ElOption
                        value="current-editable"
                        label="当前可编辑"
                    />
                    <ElOption
                        value="published"
                        label="已发布"
                    />
                </ElSelect>
            </label>
            <ElCheckbox
                v-for="kind in articleGraphEdgeKinds"
                :key="kind"
                :model-value="state.request?.filters.kinds.includes(kind)"
                :disabled="state.request?.filters.kinds.length === 1 && state.request.filters.kinds.includes(kind)"
                @change="changeKind(kind, Boolean($event))"
            >{{ edgeSymbols[kind] }} {{ kindLabels[kind] }}</ElCheckbox>
            <label>分类 ID（逗号分隔）<ElInput
                v-model="categories"
                maxlength="512"
                aria-label="分类 ID"
            /></label>
            <label>标签 ID（逗号分隔）<ElInput
                v-model="tags"
                maxlength="512"
                aria-label="标签 ID"
            /></label>
            <ElButton @click="changeFilters()">应用筛选（一层）</ElButton>
        </fieldset>
        <p
            v-if="filterError"
            role="alert"
        >{{ filterError }}</p>
        <ElCheckbox
            v-model="showGraph"
            :disabled="!state.layout"
        >显示局部图（下方列表提供全部导航）</ElCheckbox>
        <div
            v-if="showGraph && state.layout"
            class="article-relation-graph__diagram"
        >
            <svg
                :width="state.layout.width"
                :height="state.layout.height"
                aria-hidden="true"
            >
                <g
                    v-for="edge in edges"
                    :key="edge.relationIdentity"
                    :data-graph-edge="edge.relationIdentity"
                    @click="session.revealEdge(edge.relationIdentity)"
                >
                    <title>{{ kindLabels[edge.kind] }} · {{ edge.resolution }} · 来源 {{ edge.source.start }}–{{ edge.source.end }}</title>
                    <line
                        v-if="edge.targetArticle !== null"
                        :x1="nodePoint(edge.sourceArticle).x"
                        :y1="nodePoint(edge.sourceArticle).y"
                        :x2="nodePoint(edge.targetArticle).x"
                        :y2="nodePoint(edge.targetArticle).y"
                        :stroke-dasharray="dashPatterns[edge.kind]"
                    />
                    <text
                        :x="nodePoint(edge.sourceArticle).x + 16 + articleGraphEdgeKinds.indexOf(edge.kind) * 24"
                        :y="nodePoint(edge.sourceArticle).y - 16"
                    >{{ edgeSymbols[edge.kind] }}</text>
                </g>
                <g
                    v-for="node in nodes"
                    :key="node.articleIdentity"
                    :data-graph-node="node.articleIdentity"
                    :transform="`translate(${nodePoint(node.articleIdentity).x},${nodePoint(node.articleIdentity).y})`"
                    @pointerdown="startDrag(node.articleIdentity, $event)"
                    @pointermove="moveDrag"
                    @pointerup="endDrag"
                    @pointercancel="endDrag"
                    @click="clickNode(node.articleIdentity)"
                >
                    <circle :r="node.articleIdentity === identity.rootArticle ? 12 : 8" />
                    <text
                        y="28"
                        text-anchor="middle"
                    >{{ node.title.slice(0, 14) }}</text>
                </g>
            </svg>
        </div>
        <section aria-label="等价文章列表">
            <h3
                ref="nodeHeading"
                data-graph-node-heading
                tabindex="-1"
            >文章（{{ nodes.length }}）</h3>
            <ul>
                <li
                    v-for="node in visibleNodes"
                    :key="node.articleIdentity"
                    :data-list-node="node.articleIdentity"
                >
                    <ElButton @click="session.openNode(node.articleIdentity)">{{ node.title || node.articleIdentity }}</ElButton>
                    <span>{{ node.articleIdentity === identity.rootArticle ? '当前文章 · ' : '' }}{{ node.lifecycle }}</span>
                </li>
            </ul>
            <nav
                aria-label="文章列表分页"
                class="article-relation-graph__controls"
            >
                <ElButton
                    :disabled="nodePage === 0"
                    @click="changePage('node', -1, $event)"
                >上一页文章</ElButton>
                <span>{{ nodePage + 1 }} / {{ Math.max(1, Math.ceil(nodes.length / pageSize)) }}</span>
                <ElButton
                    :disabled="(nodePage + 1) * pageSize >= nodes.length"
                    @click="changePage('node', 1, $event)"
                >下一页文章</ElButton>
            </nav>
        </section>
        <section aria-label="等价关系列表">
            <h3
                ref="edgeHeading"
                data-graph-edge-heading
                tabindex="-1"
            >关系（{{ edges.length }}）</h3>
            <ul>
                <li
                    v-for="edge in visibleEdges"
                    :key="edge.relationIdentity"
                    :data-list-edge="edge.relationIdentity"
                >
                    <span>{{ edge.sourceArticle }} {{ edgeSymbols[edge.kind] }} {{ edge.targetArticle ?? '无可导航目标' }} · {{ kindLabels[edge.kind] }} · {{ edge.resolution }}</span>
                    <ElButton @click="session.revealEdge(edge.relationIdentity)">查看精确来源 {{ edge.source.start }}–{{ edge.source.end }}</ElButton>
                </li>
            </ul>
            <nav
                aria-label="关系列表分页"
                class="article-relation-graph__controls"
            >
                <ElButton
                    :disabled="edgePage === 0"
                    @click="changePage('edge', -1, $event)"
                >上一页关系</ElButton>
                <span>{{ edgePage + 1 }} / {{ Math.max(1, Math.ceil(edges.length / pageSize)) }}</span>
                <ElButton
                    :disabled="(edgePage + 1) * pageSize >= edges.length"
                    @click="changePage('edge', 1, $event)"
                >下一页关系</ElButton>
            </nav>
        </section>
    </section>
</template>

<script setup lang="ts">
import { ElButton, ElCheckbox, ElInput } from '@ozwasyd/element-plus';
import { computed, nextTick, onBeforeUnmount, onMounted, shallowRef, ref, watch } from 'vue';

import { FsusUiClassicOption as ElOption, FsusUiClassicSelect as ElSelect } from '@/fsusui/classicSelect';
import { articleGraphEdgeKinds, articleGraphLimits } from '@/services/authoring/articleGraphQuery';
import type { ArticleGraphIdentity, ArticleGraphNavigationHost, ArticleGraphQueryHost, ArticleGraphScope } from '@/services/authoring/articleGraphQuery';
import { ArticleGraphSession } from '@/services/authoring/articleGraphSession';

const props = defineProps<{
    identity: ArticleGraphIdentity;
    sessionId: string;
    queryHost?: ArticleGraphQueryHost;
    navigationHost?: ArticleGraphNavigationHost;
}>();
const emit = defineEmits<{ close: []; }>();
const session = new ArticleGraphSession(props.queryHost, props.navigationHost, value =>
{
    state.value = value;
});
const state = shallowRef(session.state);
const feedback = ref<HTMLParagraphElement | null>(null);
const nodeHeading = ref<HTMLHeadingElement | null>(null);
const edgeHeading = ref<HTMLHeadingElement | null>(null);
const showGraph = ref(false);
const nodePage = ref(0);
const edgePage = ref(0);
const categories = ref('');
const tags = ref('');
const filterError = ref('');
const pageSize = 40;
const nodes = computed(() =>
{
    const facts = new Map(state.value.result?.nodes.map(node => [node.articleIdentity, node]) ?? []);
    return state.value.layout?.nodeOrder.map(identity => facts.get(identity)!).filter(Boolean) ?? state.value.result?.nodes ?? [];
});
const edges = computed(() =>
{
    const facts = new Map(state.value.result?.edges.map(edge => [edge.relationIdentity, edge]) ?? []);
    return state.value.layout?.edgeOrder.map(identity => facts.get(identity)!).filter(Boolean) ?? state.value.result?.edges ?? [];
});
const visibleNodes = computed(() => nodes.value.slice(nodePage.value * pageSize, (nodePage.value + 1) * pageSize));
const visibleEdges = computed(() => edges.value.slice(edgePage.value * pageSize, (edgePage.value + 1) * pageSize));
const positions = computed(() => new Map(state.value.layout?.positions.map(position => [position.articleIdentity, position]) ?? []));
const statusLabels = { complete: '完整', truncated: '已截断', unavailable: '关系查询尚未接入', refused: '请求被拒绝', stale: '结果已失效', cancelled: '已取消' };
const kindLabels = { link: '链接', embed: '嵌入', broken: '断链', 'visibility-risk': '可见性风险' };
const edgeSymbols = { link: '→', embed: '⇒', broken: '×', 'visibility-risk': '!' };
const dashPatterns = { link: '', embed: '8 3', broken: '2 4', 'visibility-risk': '8 3 2 3' };
let drag: { article: string; pointer: number; clientX: number; clientY: number; x: number; y: number; sequence: number; moved: boolean; } | null = null;
let suppressNodeClick = false;

watch(() => [props.identity, props.sessionId] as const, () =>
{
    nodePage.value = 0;
    edgePage.value = 0;
    categories.value = '';
    tags.value = '';
    showGraph.value = false;
    drag = null;
    if (!document.hidden)
    {
        void session.open(props.identity, props.sessionId);
    }
    else
    {
        session.close();
    }
}, { immediate: true, deep: true, flush: 'sync' });
watch(() => state.value.request?.sequence, () =>
{
    nodePage.value = 0;
    edgePage.value = 0;
});
function visibilityChanged(): void
{
    if (document.hidden)
    {
        session.close();
    }
    else
    {
        void session.open(props.identity, props.sessionId);
    }
}
onMounted(() => document.addEventListener('visibilitychange', visibilityChanged));
onBeforeUnmount(() =>
{
    document.removeEventListener('visibilitychange', visibilityChanged);
    session.close();
});

async function changeDepth(event: MouseEvent): Promise<void>
{
    if (state.value.pending || !state.value.request)
    {
        return;
    }
    const trigger = event.currentTarget as HTMLButtonElement;
    const restoreFocus = document.activeElement === trigger;
    if (restoreFocus)
    {
        feedback.value?.focus();
    }
    const query = session.setDepth(state.value.request.requestedDepth === 2 ? 1 : 2);
    const sequence = state.value.request?.sequence;
    await query;
    await nextTick();
    if (restoreFocus && document.activeElement === feedback.value && trigger.isConnected
        && !state.value.pending && state.value.request?.sequence === sequence)
    {
        trigger.focus();
    }
}

function changePage(kind: 'node' | 'edge', direction: -1 | 1, event: MouseEvent): void
{
    const page = kind === 'node' ? nodePage : edgePage;
    const count = kind === 'node' ? nodes.value.length : edges.value.length;
    const last = Math.max(0, Math.ceil(count / pageSize) - 1);
    const next = Math.max(0, Math.min(last, page.value + direction));
    if (next === page.value)
    {
        return;
    }
    if (document.activeElement === event.currentTarget && (direction < 0 ? next === 0 : next === last))
    {
        (kind === 'node' ? nodeHeading.value : edgeHeading.value)?.focus();
    }
    page.value = next;
}

function changeScope(value: unknown): void
{
    if (value === 'current-editable' || value === 'published')
    {
        changeFilters(value);
    }
}

function changeFilters(scope: ArticleGraphScope = state.value.request?.scope ?? 'current-editable', kinds = state.value.request?.filters.kinds ?? articleGraphEdgeKinds): void
{
    const split = (value: string): string[] => value.split(',').map(part => part.trim()).filter(Boolean);
    try
    {
        filterError.value = '';
        void session.setFilters({ categories: split(categories.value), tags: split(tags.value), kinds }, scope);
    }
    catch
    {
        filterError.value = '筛选条件无效';
    }
}

function changeKind(kind: typeof articleGraphEdgeKinds[number], checked: boolean): void
{
    const current = state.value.request?.filters.kinds ?? articleGraphEdgeKinds;
    const kinds = checked ? [...current, kind] : current.filter(value => value !== kind);
    if (kinds.length)
    {
        changeFilters(undefined, kinds);
    }
}

function close(): void
{
    session.close();
    emit('close');
}

function nodePoint(article: string): { x: number; y: number; }
{
    return positions.value.get(article) ?? { x: 0, y: 0 };
}

function startDrag(article: string, event: PointerEvent): void
{
    if (event.button !== 0 || !state.value.layout || !state.value.request)
    {
        return;
    }
    const point = nodePoint(article);
    drag = { article, pointer: event.pointerId, clientX: event.clientX, clientY: event.clientY, ...point, sequence: state.value.request.sequence, moved: false };
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
}

function moveDrag(event: PointerEvent): void
{
    const layout = state.value.layout;
    if (!drag || !layout || event.pointerId !== drag.pointer || state.value.request?.sequence !== drag.sequence)
    {
        return;
    }
    const dx = event.clientX - drag.clientX;
    const dy = event.clientY - drag.clientY;
    drag.moved ||= Math.abs(dx) + Math.abs(dy) > 3;
    if (drag.moved)
    {
        session.moveNode(drag.article, Math.max(16, Math.min(layout.width - 16, drag.x + dx)), Math.max(16, Math.min(layout.height - 16, drag.y + dy)));
    }
}

function endDrag(event: PointerEvent): void
{
    if (drag?.pointer === event.pointerId)
    {
        suppressNodeClick = drag.moved;
        drag = null;
    }
}

function clickNode(article: string): void
{
    if (!suppressNodeClick)
    {
        void session.openNode(article);
    }
    suppressNodeClick = false;
}
</script>

<style scoped>
.article-relation-graph
 {
    color: var(--el-text-color-primary);
    overflow-wrap: anywhere;
}

.article-relation-graph__controls,
.article-relation-graph__filters
 {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
}

.article-relation-graph__diagram
 {
    max-height: 28rem;
    overflow: auto;
    border: 1px solid var(--el-border-color);
}

.article-relation-graph__diagram line
 {
    stroke: currentcolor;
    stroke-width: 2;
    cursor: pointer;
}

.article-relation-graph__diagram circle
 {
    fill: var(--el-bg-color);
    stroke: currentcolor;
    stroke-width: 2;
    cursor: pointer;
}

.article-relation-graph__diagram text
 {
    fill: currentcolor;
}

@media (forced-colors: active)
 {
    .article-relation-graph__diagram circle
 {
        fill: Canvas;
        stroke: CanvasText;
    }
}
</style>
