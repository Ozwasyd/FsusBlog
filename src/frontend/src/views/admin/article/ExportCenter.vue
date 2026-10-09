<template>
    <ElDrawer
        :model-value="visible"
        title="导出中心"
        size="min(100vw, 42rem)"
        :destroy-on-close="false"
        @update:model-value="emit('update:visible', $event)"
    >
        <div
            class="document-export-center"
            data-document-export-center
        >
            <form
                v-if="state.permitted.value"
                ref="requestForm"
                :aria-busy="state.busy.value"
                @submit.prevent="start"
            >
                <fieldset :disabled="submissionLocked">
                    <legend>来源与格式</legend>
                    <label for="document-export-source">明确来源坐标</label>
                    <ElSelect
                        id="document-export-source"
                        v-model="sourceId"
                        :disabled="submissionLocked"
                        aria-label="明确来源坐标"
                    >
                        <ElOption
                            v-for="item in port.sources"
                            :key="item.id"
                            :value="item.id"
                            :label="item.label"
                        />
                    </ElSelect>
                    <ElRadioGroup
                        v-model="formatId"
                        class="document-export-center__formats"
                        aria-label="导出格式"
                        :disabled="submissionLocked"
                    >
                        <ElRadio
                            v-for="item in port.catalog"
                            :key="item.id"
                            :value="item.id"
                            :disabled="!item.available"
                        >
                            {{ item.label }}
                        </ElRadio>
                    </ElRadioGroup>
                    <p
                        v-for="item in port.catalog.filter((item) => !item.available)"
                        :key="item.id"
                    >{{ item.label }}：{{ item.reason }}</p>
                    <template v-if="format">
                        <label for="document-export-layout">布局</label>
                        <ElSelect
                            id="document-export-layout"
                            v-model="layout"
                            :disabled="submissionLocked"
                            aria-label="布局"
                        >
                            <ElOption
                                v-for="option in format.layouts"
                                :key="option"
                                :value="option"
                                :label="option"
                            />
                        </ElSelect>
                        <label for="document-export-theme">主题</label>
                        <ElSelect
                            id="document-export-theme"
                            v-model="theme"
                            :disabled="submissionLocked"
                            aria-label="主题"
                        >
                            <ElOption
                                v-for="option in format.themes"
                                :key="option"
                                :value="option"
                                :label="option"
                            />
                        </ElSelect>
                        <ul aria-label="格式支持与限制">
                            <li
                                v-for="(support, index) in format.support"
                                :key="index"
                            >{{ support }}</li>
                        </ul>
                    </template>
                    <p v-if="source?.private">结果含私密内容，仅短期保留，未自动加密。</p>
                    <p v-if="source">将冻结来源：{{ source.label }}</p>
                    <ElCheckbox
                        v-model="confirmed"
                        :disabled="!selectionValid || submissionLocked"
                    >
                        确认冻结来源、格式与选项
                    </ElCheckbox>
                </fieldset>
                <ElButton
                    native-type="submit"
                    type="primary"
                    :disabled="!selectionValid || !confirmed || submissionLocked"
                >开始导出</ElButton>
            </form>

            <section
                v-if="$slots['markdown-package']"
                aria-label="Markdown package"
            >
                <slot name="markdown-package" />
            </section>

            <p
                v-if="['pending', 'uncertain', 'rejected'].includes(state.submission.value.phase) || !state.permitted.value"
                role="status"
                aria-live="polite"
            >
                <template v-if="state.submission.value.phase === 'pending'">正在提交，请等待服务器确认。</template>
                <template v-else-if="state.submission.value.phase === 'uncertain'">请求结果待核实；再次核实使用原请求身份，不会改用其他格式。</template>
                <template v-else-if="state.submission.value.phase === 'rejected'">请求被拒绝，请检查来源与权限。</template>
                <template v-else-if="!state.permitted.value">权限已失效或任务不可用，当前私密视图已清除。</template>
            </p>
            <ElButton
                v-if="state.submission.value.phase === 'uncertain'"
                :disabled="state.busy.value || !state.permitted.value"
                @click="state.retrySubmission"
            >核实原请求</ElButton>

            <section
                aria-labelledby="document-export-tasks"
                :aria-busy="state.loading.value"
            >
                <h2
                    id="document-export-tasks"
                    ref="tasksTitle"
                    tabindex="-1"
                >任务</h2>
                <p>关闭面板不会取消任务。</p>
                <p
                    v-if="state.queryFailure.value"
                    role="status"
                >无法核实任务，下载与修改操作已暂停。</p>
                <ElButton
                    :disabled="!state.permitted.value || state.loading.value"
                    @click="state.refresh()"
                >刷新任务</ElButton>
                <p v-if="state.views.value.length === 0 && !state.loading.value && !state.queryFailure.value">本页暂无可用任务</p>
                <div
                    v-if="state.views.value.length"
                    class="document-export-center__list"
                >
                    <ElAutoResizer>
                        <template #default="{ width, height }">
                            <ElTableV2
                                :data="state.views.value"
                                :columns="columns"
                                :width="width"
                                :height="height"
                                row-key="taskId"
                            />
                        </template>
                    </ElAutoResizer>
                </div>
                <nav aria-label="任务分页">
                    <ElButton
                        :disabled="state.offset.value === 0 || state.loading.value || !state.permitted.value"
                        @click="state.refresh(Math.max(0, state.offset.value - state.pageSize))"
                    >上一页</ElButton>
                    <span
                        role="status"
                        aria-live="polite"
                    >第 {{ Math.floor(state.offset.value / state.pageSize) + 1 }} 页，本页 {{ state.views.value.length }} 项</span>
                    <ElButton
                        :disabled="state.views.value.length < state.pageSize || state.loading.value || !state.permitted.value"
                        @click="state.refresh(state.offset.value + state.pageSize)"
                    >下一页</ElButton>
                </nav>
            </section>

            <section
                v-if="state.selectedView.value"
                ref="detailSection"
                aria-labelledby="document-export-detail"
                :data-export-task="state.selectedView.value.taskId"
                :data-export-input-digest="state.selectedView.value.inputDigest"
                :data-export-receipt-digest="state.selectedView.value.contentDigest"
                :data-export-status="state.selectedView.value.status"
            >
                <h2
                    id="document-export-detail"
                    ref="detailTitle"
                    tabindex="-1"
                >任务详情</h2>
                <p>{{ state.selectedView.value.source }}</p>
                <p>{{ state.selectedView.value.format }} · {{ state.selectedView.value.provider }} · {{ state.selectedView.value.options }}</p>
                <p
                    role="status"
                    aria-live="polite"
                >{{ documentExportStatusLabel(state.selectedView.value.status) }}：{{ state.selectedView.value.reason }}</p>
                <p v-if="state.selectedView.value.warnings === null">警告信息尚不可用。</p>
                <ul
                    v-else
                    aria-label="格式警告"
                >
                    <li
                        v-for="(warning, index) in state.selectedView.value.warnings"
                        :key="index"
                    >{{ warning }}</li>
                </ul>
                <template v-if="state.selectedView.value.output">
                    <p>{{ state.selectedView.value.output.filename ?? '文件名待下载授权确认' }} · {{ state.selectedView.value.output.bytes }} bytes · {{ state.selectedView.value.output.mediaType }}</p>
                    <p>保留至 {{ state.selectedView.value.output.expiresAt }}；{{ state.selectedView.value.output.deleted ? '下载授权已撤销；清理状态见任务状态' : '私密结果未自动加密' }}</p>
                </template>
                <div class="document-export-center__actions">
                    <ElButton
                        :disabled="!state.actionAllowed('status', state.selectedView.value)"
                        @click="state.act('status', state.selectedView.value.taskId)"
                    >核实状态</ElButton>
                    <ElButton
                        :disabled="!state.actionAllowed('cancel', state.selectedView.value)"
                        @click="state.act('cancel', state.selectedView.value.taskId)"
                    >取消任务</ElButton>
                    <ElButton
                        :disabled="!state.actionAllowed('retry', state.selectedView.value)"
                        @click="state.act('retry', state.selectedView.value.taskId)"
                    >请求重试</ElButton>
                    <ElButton
                        :disabled="!state.actionAllowed('download', state.selectedView.value)"
                        @click="state.act('download', state.selectedView.value.taskId)"
                    >授权下载</ElButton>
                    <ElButton
                        :disabled="!state.actionAllowed('delete', state.selectedView.value)"
                        @click="state.act('delete', state.selectedView.value.taskId)"
                    >{{ state.selectedView.value.status === 10 ? '请求清理' : '删除结果' }}</ElButton>
                </div>
            </section>

            <p
                v-if="state.actionState.value.phase === 'pending'"
                role="status"
            >等待服务器确认 {{ state.actionName.value }}。</p>
            <p
                v-if="state.actionState.value.phase === 'uncertain'"
                role="status"
            >操作结果待核实，未确认取消、删除或下载完成。</p>
            <p
                v-if="state.actionState.value.phase === 'rejected'"
                role="status"
                aria-live="polite"
                aria-atomic="true"
            >{{ actionLabel }}请求被拒绝，当前任务状态未作更改。</p>
            <ElButton
                v-if="state.actionState.value.phase === 'uncertain'"
                :disabled="state.busy.value || !state.permitted.value"
                @click="state.reconcile"
            >核实任务</ElButton>
            <ElButton
                v-if="state.actionState.value.phase === 'uncertain' && ['cancel', 'delete', 'status'].includes(state.actionName.value)"
                :disabled="state.busy.value || !state.permitted.value"
                @click="state.retryAction"
            >重试原操作</ElButton>
        </div>
    </ElDrawer>
</template>

<script setup lang="ts" generic="TSnapshot, TRequest">
import { ElAutoResizer, ElButton, ElCheckbox, ElDrawer, ElOption, ElRadio, ElRadioGroup, ElSelect, ElTableV2 } from '@ozwasyd/element-plus';
import { computed, h, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';


import { documentExportStatusLabel } from '@/components/document-export/documentExportUiPort';
import type { DocumentExportPresentation, DocumentExportUiPort } from '@/components/document-export/documentExportUiPort';
import { useDocumentExport } from '@/composables/useDocumentExport';

const props = defineProps<{
    visible: boolean;
    identity: string;
    port: DocumentExportUiPort<TSnapshot, TRequest>;
}>();
const emit = defineEmits<{ 'update:visible': [value: boolean]; }>();
let center = useDocumentExport(props.port);
const revision = ref(0);
const state = computed(() =>
{
    void revision.value;
    return center;
});
const sourceId = ref('');
const formatId = ref('');
const layout = ref('');
const theme = ref('');
const confirmed = ref(false);
const detailTitle = ref<HTMLElement | null>(null);
const detailSection = ref<HTMLElement | null>(null);
const tasksTitle = ref<HTMLElement | null>(null);
const requestForm = ref<HTMLElement | null>(null);
let detailHadFocus = false;
let formHadFocus = false;
let focusSequence = 0;
const format = computed(() => props.port.catalog.find((item) => item.id === formatId.value));
const source = computed(() => props.port.sources.find((item) => item.id === sourceId.value));
const selectionValid = computed(() => source.value !== undefined && format.value?.available === true
    && format.value.layouts.includes(layout.value) && format.value.themes.includes(theme.value));
const submissionLocked = computed(() => state.value.busy.value
    || state.value.submission.value.phase === 'uncertain' || !state.value.permitted.value);
const actionLabel = computed(() => new Map([
    ['cancel', '取消任务'], ['retry', '重试任务'], ['download', '下载结果'],
    ['delete', '删除或清理结果'], ['status', '核实状态']
]).get(state.value.actionName.value) ?? '操作');

watch([sourceId, formatId, layout, theme], () =>
{
    confirmed.value = false;
});
watch(formatId, () =>
{
    layout.value = '';
    theme.value = '';
});
watch(() => props.visible, (visible) => state.value.setOpen(visible), { immediate: true });
watch([() => props.identity, () => props.port], () =>
{
    center.dispose();
    center = useDocumentExport(props.port);
    revision.value += 1;
    clearSelection();
    center.setOpen(props.visible);
});
function clearSelection(): void
{
    sourceId.value = '';
    formatId.value = '';
    layout.value = '';
    theme.value = '';
    confirmed.value = false;
}
watch(() => state.value.permitted.value, (permitted) =>
{
    if (!permitted)
    {
        clearSelection();
    }
});
watch([() => state.value.selectedView.value?.taskId, () => state.value.permitted.value], ([taskId, permitted]) =>
{
    if (props.visible && ((taskId === undefined && detailHadFocus) || (!permitted && formHadFocus)))
    {
        detailHadFocus = false;
        formHadFocus = false;
        const sequence = focusSequence;
        void nextTick(() =>
        {
            if (props.visible && state.value.selectedView.value === null && focusSequence === sequence)
            {
                tasksTitle.value?.focus();
            }
        });
    }
});
function rememberFocus(event: FocusEvent): void
{
    // A pending action disables its button and may move focus to body before
    // denial removes private content. Keep its last focus owner until another focusin.
    focusSequence += 1;
    detailHadFocus = event.target instanceof Node && detailSection.value?.contains(event.target) === true;
    formHadFocus = event.target instanceof Node && requestForm.value?.contains(event.target) === true;
}
onMounted(() => document.addEventListener('focusin', rememberFocus, true));
onBeforeUnmount(() =>
{
    document.removeEventListener('focusin', rememberFocus, true);
    center.dispose();
});

const columns = [
    {
        key: 'source', dataKey: 'source', title: '已冻结来源', width: 260, flexGrow: 1,
        cellRenderer: ({ rowData }: { rowData: DocumentExportPresentation; }) => h(ElButton, {
            text: true,
            'aria-label': `查看 ${rowData.source}，${rowData.format}，${documentExportStatusLabel(rowData.status)}`,
            onClick: () =>
            {
                state.value.select(rowData.taskId);
                void nextTick(() => detailTitle.value?.focus());
            }
        }, () => rowData.source)
    },
    { key: 'format', dataKey: 'format', title: '格式', width: 90 },
    {
        key: 'status', dataKey: 'status', title: '状态', width: 130,
        cellRenderer: ({ rowData }: { rowData: DocumentExportPresentation; }) => h('span', documentExportStatusLabel(rowData.status))
    }
];

function start(): void
{
    if (selectionValid.value && confirmed.value && !submissionLocked.value)
    {
        void state.value.submit({ sourceId: sourceId.value, formatId: formatId.value, layout: layout.value, theme: theme.value });
    }
}
</script>

<style scoped>
.document-export-center
 {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--fsus-space-6);
    color: var(--fsus-ink);
}

.document-export-center fieldset
 {
    display: grid;
    min-inline-size: 0;
    gap: var(--fsus-space-3);
    border: 0;
    padding: 0;
}

.document-export-center__list
 {
    block-size: min(40vh, 24rem);
}

.document-export-center__formats
 {
    display: flex;
    flex-wrap: wrap;
}

.document-export-center__actions
 {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fsus-space-2);
}

.document-export-center p,
.document-export-center li
 {
    overflow-wrap: anywhere;
}
</style>
