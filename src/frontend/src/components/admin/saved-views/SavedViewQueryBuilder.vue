<template>
    <section
        ref="root"
        class="saved-view-builder"
        tabindex="-1"
        aria-label="视图筛选"
    >
        <ElButton
            v-if="!open"
            data-action="edit"
            :disabled="!sourceReady"
            @click="beginEdit"
        >编辑筛选</ElButton>
        <form
            v-else
            ref="form"
            tabindex="-1"
            aria-label="筛选编辑器"
            @submit.prevent="submit"
            @keydown.esc.stop.prevent="cancel"
            @keydown.ctrl.enter.prevent="submit"
            @keydown.meta.enter.prevent="submit"
        >
            <p>满足全部条件（AND）；同字段多选满足任一值（OR）。</p>
            <p
                v-if="!sourceReady"
                role="status"
            >正在等待完整的服务端查询版本；不能将旧查询提交到新版本。</p>
            <p
                v-else-if="queryAwaitingRevision"
                role="status"
            >服务端查询已更新；正在等待对应版本，暂时不能提交。</p>
            <p
                v-if="dirty"
                role="status"
            >修改尚未同步到服务端。</p>
            <p
                v-if="drifted || commandState === 'conflict' || commandState === 'stale'"
                role="alert"
            >
                服务端视图已变化。当前修改已保留；取消后重新编辑最新版本。
            </p>
            <p
                v-if="commandState === 'pending'"
                role="status"
            >正在提交，等待服务端确认。</p>
            <p
                v-if="commandState === 'failure'"
                role="alert"
            >提交失败。{{ commandReason }}</p>
            <ol class="saved-view-conditions">
                <li
                    v-for="(condition, index) in visibleConditions"
                    :key="index"
                    class="saved-view-condition"
                    @keydown.alt.up.prevent="moveCondition(index, -1)"
                    @keydown.alt.down.prevent="moveCondition(index, 1)"
                >
                    <ElSelect
                        :model-value="savedViewFieldKey(condition.field)"
                        :aria-label="`条件 ${index + 1} 字段`"
                        :disabled="!editable"
                        @update:model-value="chooseField(index, $event)"
                    >
                        <ElOption
                            v-for="field in availableFields"
                            :key="savedViewFieldKey(field.field)"
                            :value="savedViewFieldKey(field.field)"
                            :label="field.label"
                        />
                    </ElSelect>
                    <ElSelect
                        :model-value="condition.operatorId"
                        :aria-label="`条件 ${index + 1} 操作符`"
                        :disabled="!editable"
                        @update:model-value="replaceCondition(index, { ...condition, operatorId: String($event) })"
                    >
                        <ElOption
                            v-for="operator in findSavedViewEditorField(condition.field, definitions)?.operators ?? []"
                            :key="operator.id"
                            :value="operator.id"
                            :label="operator.label"
                        />
                    </ElSelect>
                    <ElSelect
                        v-if="findSavedViewEditorOperator(condition, definitions)?.valueKind === 1"
                        :model-value="condition.values"
                        :aria-label="`条件 ${index + 1} 值`"
                        multiple
                        :multiple-limit="findSavedViewEditorOperator(condition, definitions)?.cardinality === 1
                            ? 1 : definitions?.maxValuesPerCondition"
                        :disabled="!editable"
                        @update:model-value="updateValues(index, $event)"
                    >
                        <ElOption
                            v-for="choice in findSavedViewEditorField(condition.field, definitions)?.choices ?? []"
                            :key="choice.value"
                            :value="choice.value"
                            :label="choice.label"
                        />
                    </ElSelect>
                    <div
                        v-else
                        class="saved-view-values"
                    >
                        <template v-if="[2, 3].includes(findSavedViewEditorOperator(condition, definitions)?.valueKind ?? -1)">
                            <ElInput
                                v-for="(value, valueIndex) in condition.values"
                                :key="valueIndex"
                                :model-value="value"
                                :aria-label="`条件 ${index + 1} 值 ${valueIndex + 1}`"
                                :type="findSavedViewEditorOperator(condition, definitions)?.valueKind === 3 ? 'date' : 'text'"
                                :maxlength="definitions?.maxValueLength"
                                :disabled="!editable"
                                :csp-safe="true"
                                @update:model-value="updateValue(index, valueIndex, $event)"
                            />
                            <ElButton
                                :disabled="!editable || condition.values.length >= (definitions?.maxValuesPerCondition ?? 0)"
                                :aria-label="`条件 ${index + 1} 添加值`"
                                @click="updateValues(index, [...condition.values, ''])"
                            >添加值</ElButton>
                        </template>
                        <p v-else>{{ condition.field.identity }} · {{ condition.operatorId }} · {{ condition.values.join('、') }}</p>
                    </div>
                    <ElSelect
                        v-if="findSavedViewEditorOperator(condition, definitions)?.valueKind === 3 || condition.timeZoneId"
                        class="saved-view-timezone"
                        :model-value="condition.timeZoneId ?? ''"
                        :aria-label="`条件 ${index + 1} 时区`"
                        :disabled="!editable"
                        @update:model-value="replaceCondition(index, { ...condition, timeZoneId: String($event) })"
                    >
                        <ElOption
                            v-for="zone in definitions?.timeZones ?? []"
                            :key="zone"
                            :value="zone"
                            :label="zone"
                        />
                    </ElSelect>
                    <div class="saved-view-actions">
                        <ElButton
                            :disabled="!editable || index === 0"
                            :aria-label="`条件 ${index + 1} 上移`"
                            @click="moveCondition(index, -1)"
                        >上移</ElButton>
                        <ElButton
                            :disabled="!editable || index + 1 === visibleConditions.length"
                            :aria-label="`条件 ${index + 1} 下移`"
                            @click="moveCondition(index, 1)"
                        >下移</ElButton>
                        <ElButton
                            :disabled="!editable"
                            :aria-label="`条件 ${index + 1} 清空值`"
                            @click="updateValues(index, [])"
                        >清空值</ElButton>
                        <ElButton
                            :disabled="!editable"
                            :data-remove="index"
                            :aria-label="`删除条件 ${index + 1}`"
                            @click="removeCondition(index)"
                        >删除条件</ElButton>
                    </div>
                    <p
                        v-for="issue in issues.filter(item => item.conditionIndex === index)"
                        :key="issue.reason"
                        role="alert"
                    >{{ issue.reason }}</p>
                </li>
            </ol>
            <p
                v-if="draft.conditions.length > visibleConditions.length"
                role="alert"
            >条件超过编辑上限；未显示的条件仍完整保留，不能提交。</p>
            <ElButton
                class="saved-view-add"
                data-action="add"
                :disabled="!editable || draft.conditions.length >= (definitions?.maxConditions ?? 0)"
                @click="addCondition"
            >添加条件</ElButton>
            <p>排序：{{ draft.sort.field.identity }} · {{ draft.sort.direction === 0 ? '升序' : '降序' }}；空值：{{ draft.sort.nullPlacement === 0 ? '在前' : '在后' }}；排序规则：{{ draft.sort.collation }}；稳定顺序：{{ draft.sort.stableTieBreaker }}；时区：{{ draft.sort.timeZoneId ?? '不适用' }}。</p>
            <p>显示字段：{{ draft.projection.map(field => field.identity).join('、') }}。</p>
            <label>
                每页数量
                <ElInput
                    :model-value="draft.pageSize"
                    aria-label="每页数量"
                    type="number"
                    :disabled="!editable"
                    :csp-safe="true"
                    @update:model-value="draft.pageSize = Number($event); dirty = true"
                />
            </label>
            <p
                v-for="issue in issues.filter(item => item.conditionIndex === undefined)"
                :key="issue.reason"
                role="alert"
            >{{ issue.reason }}</p>
            <p
                v-if="!submitAvailable"
                role="status"
            >保存接口当前不可用，修改仅保留在此次编辑中。</p>
            <div class="saved-view-actions">
                <ElButton
                    native-type="submit"
                    type="primary"
                    data-action="submit"
                    :disabled="!canSubmit"
                >提交修改</ElButton>
                <ElButton
                    data-action="cancel"
                    :disabled="commandState === 'pending'"
                    @click="cancel"
                >取消</ElButton>
            </div>
        </form>
    </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

import { FsusUiButton as ElButton } from '@/fsusui/button';
import { FsusUiClassicOption as ElOption, FsusUiClassicSelect as ElSelect } from '@/fsusui/classicSelect';
import { FsusUiInput as ElInput } from '@/fsusui/input';

import {
    cloneSavedViewDraft,
    findSavedViewEditorField,
    findSavedViewEditorOperator,
    sameSavedViewDraft,
    savedViewFieldKey,
    validateSavedViewDraft
} from './savedViewBuilder';

import type {
    SavedViewBuilderDefinitions,
    SavedViewCondition,
    SavedViewDraftSubmission,
    SavedViewQuerySnapshot
} from './savedViewBuilder';

const props = withDefaults(defineProps<{
    viewId: string;
    revision: number;
    /** Response coordinates travel atomically with the immutable query, separately from the current target. */
    snapshot: SavedViewQuerySnapshot;
    definitions: SavedViewBuilderDefinitions | null;
    submitAvailable?: boolean;
    commandState?: 'idle' | 'pending' | 'failure' | 'conflict' | 'stale';
    commandReason?: string;
}>(), {
    submitAvailable: false,
    commandState: 'idle',
    commandReason: ''
});

const emit = defineEmits<{
    submit: [submission: SavedViewDraftSubmission];
    cancel: [];
}>();

const open = ref(false);
const acceptedSource = ref({
    viewId: props.snapshot.viewId,
    revision: props.snapshot.revision,
    query: cloneSavedViewDraft(props.snapshot.query)
});
const sourceReady = computed(() => acceptedSource.value.viewId === props.viewId
    && Number.isSafeInteger(props.revision) && props.revision > 0
    && Number.isSafeInteger(acceptedSource.value.revision)
    && acceptedSource.value.revision >= props.revision);
const queryAwaitingRevision = computed(() => sourceReady.value
    && acceptedSource.value.revision !== props.revision);
const draft = ref(cloneSavedViewDraft(props.snapshot.query));
const baseRevision = ref(props.snapshot.revision);
const baseViewId = ref(props.snapshot.viewId);
const dirty = ref(false);
const drifted = ref(false);
const form = ref<HTMLFormElement | null>(null);
const root = ref<HTMLElement | null>(null);
let returnFocus: HTMLElement | null = null;

const issues = computed(() => validateSavedViewDraft(draft.value, props.definitions));
const editable = computed(() => sourceReady.value && props.commandState !== 'pending'
    && draft.value.schemaVersion === props.definitions?.schemaVersion);
const visibleConditions = computed(() => draft.value.conditions.slice(
    0, Math.min(props.definitions?.maxConditions ?? 64, 64)
));
const availableFields = computed(() => props.definitions?.fields.slice(0, 64) ?? []);
const canSubmit = computed(() => props.submitAvailable && editable.value
    && !queryAwaitingRevision.value && !drifted.value && !['conflict', 'stale'].includes(props.commandState)
    && dirty.value && issues.value.length === 0);

watch(() => [props.viewId, props.revision, props.snapshot] as const, (current, previous) =>
{
    const targetChanged = current[0] !== previous[0] || current[1] !== previous[1];
    const snapshot = props.snapshot;
    // Only the response's own coordinates bind its query. A delayed Q8 cannot
    // become Q9 by reference replacement; obsolete or foreign responses are ignored.
    const canAccept = snapshot.viewId === props.viewId
        && Number.isSafeInteger(snapshot.revision) && snapshot.revision > 0
        && snapshot.revision >= props.revision
        && (snapshot.viewId !== acceptedSource.value.viewId
            || snapshot.revision >= acceptedSource.value.revision);
    const sourceChanged = canAccept && (snapshot.viewId !== acceptedSource.value.viewId
        || snapshot.revision !== acceptedSource.value.revision
        || !sameSavedViewDraft(snapshot.query, acceptedSource.value.query));
    if (canAccept)
    {
        acceptedSource.value = {
            viewId: snapshot.viewId,
            revision: snapshot.revision,
            query: cloneSavedViewDraft(snapshot.query)
        };
    }
    if (open.value && dirty.value)
    {
        if (targetChanged || sourceChanged)
        {
            drifted.value = true;
        }
    }
    else
    {
        resetDraft();
    }
}, { deep: true });

function resetDraft(): void
{
    draft.value = cloneSavedViewDraft(acceptedSource.value.query);
    baseRevision.value = acceptedSource.value.revision;
    baseViewId.value = acceptedSource.value.viewId;
    dirty.value = false;
    drifted.value = false;
}

async function beginEdit(event: MouseEvent): Promise<void>
{
    if (!sourceReady.value)
    {
        return;
    }
    resetDraft();
    returnFocus = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    open.value = true;
    await nextTick();
    form.value?.focus();
}

async function cancel(): Promise<void>
{
    if (props.commandState === 'pending')
    {
        return;
    }
    resetDraft();
    open.value = false;
    emit('cancel');
    await nextTick();
    if (returnFocus?.isConnected && !returnFocus.matches(':disabled'))
    {
        returnFocus.focus();
    }
    else
    {
        const trigger = root.value?.querySelector<HTMLButtonElement>('[data-action="edit"]');
        if (trigger && !trigger.disabled)
        {
            trigger.focus();
        }
        else
        {
            root.value?.focus();
        }
    }
}

function replaceCondition(index: number, condition: SavedViewCondition): void
{
    if (!editable.value || !draft.value.conditions[index])
    {
        return;
    }
    draft.value.conditions[index] = condition;
    dirty.value = true;
}

function chooseField(index: number, key: unknown): void
{
    const matches = availableFields.value.filter(field => savedViewFieldKey(field.field) === key);
    if (matches.length !== 1)
    {
        return;
    }
    const condition = draft.value.conditions[index];
    // Selecting a field never silently replaces the operator or discards its operands.
    replaceCondition(index, { ...condition, field: { ...matches[0].field } });
}

function updateValues(index: number, values: unknown): void
{
    if (!isStringValues(values)
        || values.length > (props.definitions?.maxValuesPerCondition ?? 0))
    {
        return;
    }
    replaceCondition(index, { ...draft.value.conditions[index], values: [...values] });
}

function isStringValues(values: unknown): values is string[]
{
    return Array.isArray(values) && values.every((value: unknown) => typeof value === 'string');
}

function updateValue(index: number, valueIndex: number, value: string | number): void
{
    const values = [...draft.value.conditions[index].values];
    values[valueIndex] = String(value);
    updateValues(index, values);
}

async function addCondition(): Promise<void>
{
    const field = availableFields.value[0];
    const operator = field?.operators[0];
    if (!editable.value || !field || !operator
        || draft.value.conditions.length >= (props.definitions?.maxConditions ?? 0))
    {
        return;
    }
    draft.value.conditions.push({ field: { ...field.field }, operatorId: operator.id, values: [] });
    dirty.value = true;
    await focusCondition(draft.value.conditions.length - 1);
}

async function focusCondition(index: number): Promise<void>
{
    await nextTick();
    const button = form.value?.querySelector<HTMLButtonElement>(`[data-remove="${index}"]`);
    if (button)
    {
        button.focus();
    }
    else
    {
        form.value?.focus();
    }
}

async function removeCondition(index: number): Promise<void>
{
    if (!editable.value)
    {
        return;
    }
    draft.value.conditions.splice(index, 1);
    dirty.value = true;
    await focusCondition(Math.min(index, draft.value.conditions.length - 1));
}

async function moveCondition(index: number, offset: number): Promise<void>
{
    const target = index + offset;
    if (!editable.value || target < 0 || target >= visibleConditions.value.length)
    {
        return;
    }
    const [condition] = draft.value.conditions.splice(index, 1);
    draft.value.conditions.splice(target, 0, condition);
    dirty.value = true;
    await focusCondition(target);
}

function submit(): void
{
    if (!canSubmit.value || props.revision !== baseRevision.value
        || props.viewId !== baseViewId.value)
    {
        return;
    }
    emit('submit', {
        viewId: baseViewId.value,
        expectedRevision: baseRevision.value,
        query: cloneSavedViewDraft(draft.value)
    });
}
</script>

<style scoped>
.saved-view-builder,
.saved-view-builder form,
.saved-view-condition,
.saved-view-values
 {
    display: grid;
    min-width: 0;
    gap: var(--fsus-space-3);
    overflow-wrap: anywhere;
}

.saved-view-conditions
 {
    display: grid;
    gap: var(--fsus-space-4);
    margin: 0;
    padding-inline-start: var(--fsus-space-6);
}

.saved-view-actions
 {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fsus-space-2);
}

.saved-view-builder p
 {
    margin: 0;
}

.saved-view-add
 {
    justify-self: start;
}

@media (width >= 768px)
 {
    .saved-view-condition
 {
        grid-template-columns: repeat(3, minmax(0, 1fr));
        align-items: start;
    }

    .saved-view-condition > .saved-view-actions,
    .saved-view-condition > p
 {
        grid-column: 1 / -1;
    }

    .saved-view-timezone
 {
        grid-column: 3;
    }
}
</style>
