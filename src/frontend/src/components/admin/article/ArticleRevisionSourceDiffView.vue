<template>
    <section
        aria-label="经验证的 Markdown 源码差异"
        class="revision-source-view"
    >
        <nav
            aria-label="变化与章节导航"
            class="revision-source-navigation"
        >
            <ElButton
                :disabled="changes.length === 0"
                @click="moveChange(-1)"
            >上一处变化</ElButton>
            <ElButton
                :disabled="changes.length === 0"
                @click="moveChange(1)"
            >下一处变化</ElButton>
            <label
                v-if="presentation.headings.length"
                class="revision-source-heading-picker"
            >
                章节
                <select
                    :value="headingIdentity"
                    @change="selectHeading"
                >
                    <option value="">选择服务端章节</option>
                    <option
                        v-for="heading in presentation.headings"
                        :key="heading.identity"
                        :value="heading.identity"
                    >{{ heading.label }}</option>
                </select>
            </label>
        </nav>
        <p
            role="status"
            aria-live="polite"
            class="revision-source-status"
        >{{ announcement }}</p>
        <p v-if="changes.length === 0">服务端未发现正文变化。</p>
        <p class="revision-source-status">已验证 {{ presentation.response.sourceDiff.receipt.chunkCount }} 个完整分块；− 基准源码，+ 比较源码。</p>
        <div
            ref="scrollRegion"
            class="revision-source-scroll"
            tabindex="0"
            aria-label="源码差异范围，Alt 加方向键跳转变化"
            @keydown="handleKeydown"
        >
            <article
                v-for="row in presentation.rows"
                :key="row.id"
                :ref="element => registerRow(row.id, element)"
                tabindex="-1"
                class="revision-source-row"
                :class="{ 'revision-source-row--split': split, 'revision-source-row--changed': row.kind !== 0 }"
                :data-range-id="row.id"
            >
                <header class="revision-source-row-heading">
                    <span>{{ kindLabels[row.kind] }} · 基准行 {{ row.baseLine }} / 比较行 {{ row.compareLine }}</span>
                    <ElButton
                        v-if="row.collapsed"
                        :aria-expanded="expanded.has(row.id)"
                        @click="toggleContext(row.id)"
                    >
                        {{ expanded.has(row.id) ? '折叠未变化范围' : '展开未变化范围' }}
                    </ElButton>
                </header>
                <div
                    v-if="!row.collapsed || expanded.has(row.id)"
                    class="revision-source-pair"
                >
                    <div class="revision-source-side revision-source-side--base">
                        <div class="revision-source-side-heading"><span>{{ row.kind === 0 ? '= 基准' : '− 基准' }}</span>
                            <ElButton
                                :disabled="row.baseRange.length === 0"
                                @click="copyRange(row, 'base')"
                            >复制基准范围</ElButton></div>
                        <pre dir="auto"><template
v-for="(piece, index) in row.base"
:key="index"
><mark
v-if="piece.changed"
                        class="revision-source-word-change"
aria-label="删除或替换的词"
                        >{{ piece.text }}</mark><template v-else>{{ piece.text }}</template></template></pre>
                    </div>
                    <div class="revision-source-side revision-source-side--compare">
                        <div class="revision-source-side-heading"><span>{{ row.kind === 0 ? '= 比较' : '+ 比较' }}</span>
                            <ElButton
                                :disabled="row.compareRange.length === 0"
                                @click="copyRange(row, 'compare')"
                            >复制比较范围</ElButton></div>
                        <pre dir="auto"><template
v-for="(piece, index) in row.compare"
:key="index"
><mark
v-if="piece.changed"
                        class="revision-source-word-change"
aria-label="增加或替换的词"
                        >{{ piece.text }}</mark><template v-else>{{ piece.text }}</template></template></pre>
                    </div>
                </div>
            </article>
        </div>
    </section>
</template>

<script setup lang="ts">
import { computed, ref, shallowReactive, watch, type ComponentPublicInstance } from 'vue';

import { readRevisionSourceRange, type RevisionSourcePresentation, type RevisionSourceRow } from '@/services/revisionComparePresentation';
import { emitTelemetry } from '@/services/telemetryBus';

const props = defineProps<{ presentation: RevisionSourcePresentation; split: boolean; }>();
const emit = defineEmits<(event: 'copy-range', evidence: { planDigest: string; packageDigest: string; range: { offset: number; length: number; }; side: 'base' | 'compare'; }) => void>();
const kindLabels = ['= 未变化', '+ 增加', '− 删除', '± 替换'];
const expanded = shallowReactive(new Set<string>());
const scrollRegion = ref<HTMLElement | null>(null);
const rowElements = new Map<string, HTMLElement>();
const currentChange = ref(-1);
const headingIdentity = ref('');
const announcement = ref('可使用变化导航，或 Alt 加上 / 下方向键；Home / End 跳到首 / 末处变化。');
const changes = computed(() => props.presentation.rows.filter(row => row.kind !== 0));
const registerRow = (identity: string, value: Element | ComponentPublicInstance | null): void =>
{
    if (value instanceof HTMLElement)
    {
        rowElements.set(identity, value);
    }
    else
    {
        rowElements.delete(identity);
    }
};
const navigate = (identity: string): void =>
{
    expanded.add(identity);
    const target = rowElements.get(identity);
    const region = scrollRegion.value;
    if (target && region)
    {
        target.focus({ preventScroll: true });
        region.scrollTop += target.getBoundingClientRect().top - region.getBoundingClientRect().top;
    }
};
const moveChange = (direction: -1 | 1): void =>
{
    if (!changes.value.length)
    {
        return;
    }
    currentChange.value = currentChange.value < 0 ? (direction === 1 ? 0 : changes.value.length - 1)
        : (currentChange.value + direction + changes.value.length) % changes.value.length;
    const row = changes.value[currentChange.value];
    navigate(row.id);
    announcement.value = `第 ${currentChange.value + 1} / ${changes.value.length} 处变化，${kindLabels[row.kind]}，基准行 ${row.baseLine}，比较行 ${row.compareLine}。`;
};
const handleKeydown = (event: KeyboardEvent): void =>
{
    if (event.target instanceof HTMLElement && event.target.closest('button, select, input, textarea'))
    {
        return;
    }
    if ((event.altKey && ['ArrowDown', 'ArrowUp'].includes(event.key)) || ['Home', 'End'].includes(event.key))
    {
        event.preventDefault();
        if (event.key === 'Home' || event.key === 'End')
        {
            currentChange.value = -1;
        }
        moveChange(event.key === 'End' || event.key === 'ArrowUp' ? -1 : 1);
    }
};
const selectHeading = (event: Event): void =>
{
    headingIdentity.value = (event.target as HTMLSelectElement).value;
    const heading = props.presentation.headings.find(value => value.identity === headingIdentity.value);
    if (heading)
    {
        navigate(heading.rowId);
        announcement.value = '已定位所选服务端章节范围。';
    }
};
const toggleContext = (identity: string): void =>
{
    if (expanded.has(identity))
    {
        expanded.delete(identity);
    }
    else
    {
        expanded.add(identity);
    }
};
const copyRange = async (row: RevisionSourceRow, side: 'base' | 'compare'): Promise<void> =>
{
    const range = row[`${side}Range`];
    try
    {
        await navigator.clipboard.writeText(readRevisionSourceRange(side === 'base' ? props.presentation.baseBytes : props.presentation.compareBytes, range));
        emit('copy-range', { planDigest: props.presentation.response.planReceipt.planDigest,
                             packageDigest: side === 'base' ? props.presentation.response.planReceipt.basePackageDigest : props.presentation.response.planReceipt.comparePackageDigest,
                             range: { offset: range.offset, length: range.length }, side });
        emitTelemetry('revision_diff_action', { action: side === 'base' ? 'copy_base' : 'copy_compare',
                                                mode: props.split ? 1 : 0, status: 'accepted', count: range.length, rangeOffset: range.offset,
                                                planDigest: props.presentation.response.planReceipt.planDigest,
                                                packageDigest: side === 'base' ? props.presentation.response.planReceipt.basePackageDigest : props.presentation.response.planReceipt.comparePackageDigest });
        announcement.value = '已复制授权源码范围；草稿与历史版本保持原状。';
    }
    catch
    {
        announcement.value = '复制失败，请检查剪贴板权限。';
    }
};
watch(() => props.presentation, () =>
{
    expanded.clear();
    currentChange.value = -1;
    headingIdentity.value = '';
});
</script>

<style scoped>
.revision-source-view
 {
    min-width: 0;
}

.revision-source-navigation, .revision-source-row-heading, .revision-source-side-heading
 {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--fsus-space-2);
}

.revision-source-heading-picker
 {
    display: flex;
    min-width: 0;
    gap: var(--fsus-space-2);
}

.revision-source-heading-picker select
 {
    min-width: 0;
    max-width: 100%;
    color: var(--fsusblog-text-primary);
    background: var(--fsusblog-page-bg);
}

.revision-source-status
 {
    color: var(--fsusblog-text-secondary);
    font-size: var(--el-font-size-small);
    margin-block: var(--fsus-space-2);
}

.revision-source-scroll
 {
    max-height: 60vh;
    overflow: auto;
    overscroll-behavior: contain;
    min-width: 0;
}

.revision-source-row
 {
    min-width: 0;
    border-block-start: 1px solid var(--fsusblog-panel-border);
    padding-block: var(--fsus-space-2);
}

.revision-source-row:focus-visible
 {
    outline: 2px solid var(--fsusblog-color-focus-ring);
    outline-offset: -2px;
}

.revision-source-pair
 {
    display: grid;
    min-width: 0;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--fsus-space-2);
}

.revision-source-row--split .revision-source-pair
 {
    grid-template-columns: repeat(2, minmax(0, 1fr));
}

.revision-source-side
 {
    min-width: 0;
    border-inline-start: 2px solid var(--fsusblog-panel-border);
    padding-inline-start: var(--fsus-space-2);
}

.revision-source-row--changed .revision-source-side--base
 {
    border-inline-start-color: var(--el-color-danger);
}

.revision-source-row--changed .revision-source-side--compare
 {
    border-inline-start-color: var(--el-color-success);
}

.revision-source-side pre
 {
    overflow-x: auto;
    max-width: 100%;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    unicode-bidi: plaintext;
    margin-block: var(--fsus-space-2);
    font: inherit;
    font-family: monospace;
}

.revision-source-word-change
 {
    background: var(--el-fill-color-light);
    color: inherit;
    font-weight: 700;
    text-decoration: underline;
    text-decoration-thickness: 2px;
}

@media (forced-colors: active)
 {
    .revision-source-side, .revision-source-row
 {
        border-color: CanvasText;
    }

    .revision-source-word-change
 {
        outline: 1px solid Highlight;
    }
}
</style>
