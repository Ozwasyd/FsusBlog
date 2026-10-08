<template>
    <section
        v-if="definition"
        class="article-metadata-field"
        :aria-labelledby="labelId"
    >
        <label :id="labelId">{{ fieldName }}</label>
        <p
            :id="statusId"
            class="article-metadata-field__status"
            role="status"
        >
            {{ serverStatus }}
        </p>
        <div
            :key="controlGeneration"
            class="article-metadata-field__control"
        >
            <label
                v-if="supported"
                :id="presenceLabelId"
            >{{ labels.presenceLabel }}</label>
            <FsusUiSelect
                v-if="supported"
                :model-value="draftPresence"
                :options="presenceOptions"
                :label="presenceLabelId"
                :aria-label="labels.presenceLabel"
                :aria-describedby="statusId"
                :disabled="blocked"
                :validate-event="false"
                @update:model-value="handlers.presence"
            />
            <FsusUiInput
                ref="control"
                v-if="definition.valueType === 0 || definition.valueType === 7"
                :model-value="text"
                :type="definition.valueType === 0 ? 'textarea' : 'text'"
                :rows="2"
                resize="vertical"
                :inputmode="definition.valueType === 7 ? 'url' : 'text'"
                :aria-labelledby="labelId"
                :aria-describedby="statusId"
                :aria-invalid="invalid"
                :disabled="blocked || draftPresence !== 2"
                :validate-event="false"
                @update:model-value="handlers.text"
            />
            <FsusUiSwitch
                ref="control"
                v-else-if="definition.valueType === 2"
                :model-value="boolean"
                :aria-labelledby="labelId"
                :aria-describedby="statusId"
                :aria-invalid="invalid"
                :disabled="blocked || draftPresence !== 2"
                :validate-event="false"
                @update:model-value="handlers.boolean"
            />
            <FsusUiSelect
                ref="control"
                v-else-if="definition.valueType === 4 || definition.valueType === 5"
                :model-value="definition.valueType === 4 ? single : multiple"
                :multiple="definition.valueType === 5"
                :label="labelId"
                :options="options"
                :placeholder="labels.choose"
                :collapse-tags="true"
                :aria-labelledby="labelId"
                :aria-describedby="statusId"
                :aria-invalid="invalid"
                :disabled="blocked || draftPresence !== 2"
                :validate-event="false"
                @update:model-value="handlers.options"
            />
            <p v-else>{{ labels.editorUnavailable }}</p>
        </div>
        <p
            class="article-metadata-field__status"
            :data-presence="presence"
        >
            {{ labels.presence[presence] }}
            <span v-if="entry?.defaultApplied"> · {{ labels.defaultApplied }}</span>
            <span v-if="definition.required"> · {{ labels.required }}</span>
        </p>
        <p
            class="article-metadata-field__status"
            role="status"
        >
            {{ dirty ? labels.unvalidated : labels.commitUnavailable }}
        </p>
        <div class="article-metadata-field__actions">
            <FsusUiButton
                :disabled="blocked || !supported"
                @click="cancelFromControl"
            >
                {{ labels.cancel }}
            </FsusUiButton>
            <FsusUiButton disabled>{{ labels.save }}</FsusUiButton>
        </div>
        <details
            ref="summaryDisclosure"
            :open="summaryExpanded"
            @toggle="toggleSummary"
        >
            <summary
                :aria-expanded="summaryExpanded"
                :aria-controls="summaryExpanded ? summaryId : undefined"
            >{{ labels.definitionSummary.toggle }}</summary>
            <dl
                v-if="summaryExpanded"
                :id="summaryId"
                class="article-metadata-field__summary"
            >
                <template
                    v-for="row in summaryRows"
                    :key="row.key"
                >
                    <dt>{{ row.label }}</dt>
                    <dd :data-definition-flag="row.key">{{ row.value }}</dd>
                </template>
            </dl>
        </details>
    </section>
    <p
        v-else
        role="status"
    >{{ labels.unavailable }}</p>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue';

import type { ArticlePropertyValueReadResponse } from '@/codecs/binary/articlePropertyValueReadCodecs';
import { FsusUiButton } from '@/fsusui/button';
import { FsusUiInput } from '@/fsusui/input';
import { FsusUiSelect } from '@/fsusui/select';
import { FsusUiSwitch } from '@/fsusui/switch';
import type { ArticleDocumentContext } from '@/services/authoring/articleDocumentContext';

// Leaf control for the one owner-mounted inspector. Only immutable canonical
// reads enter; transient input is neither a command nor a persisted value. The
// canonical owner has not supplied a mutation/validation/reference editor port.
const props = defineProps<{
    model: ArticlePropertyValueReadResponse | null;
    definitionId: string;
    definitionOwnerUserId: string | null;
    context: ArticleDocumentContext | null;
    enabled: boolean;
    editable: boolean;
    readKey: string;
    locale: string;
    labels: {
        unavailable: string;
        editorUnavailable: string;
        commitUnavailable: string;
        unvalidated: string;
        choose: string;
        unknownOption: string;
        defaultApplied: string;
        required: string;
        conflict: string;
        cancel: string;
        save: string;
        presenceLabel: string;
        presence: readonly string[];
        reconciliation: readonly string[];
        definitionSummary: {
            toggle: string;
            searchEligible: string;
            filterable: string;
            sortable: string;
            required: string;
            missing: string;
            null: string;
            empty: string;
            visibilityScope: string;
            displayPlacement: string;
            yes: string;
            no: string;
            absent: string;
            nullValue: string;
            unknown: string;
            missingBehavior: readonly string[];
            nullBehavior: readonly string[];
            emptyBehavior: readonly string[];
            visibility: readonly string[];
            placement: readonly string[];
        };
    };
}>();

const labelId = useId();
const statusId = useId();
const presenceLabelId = useId();
const summaryId = useId();
const summaryExpanded = ref(false);
const summaryDisclosure = shallowRef<HTMLDetailsElement | null>(null);
const revokedModel = shallowRef<ArticlePropertyValueReadResponse | null>(null);
watch([
    () => props.context?.articleId,
    () => props.context?.documentId,
    () => props.context?.documentEpoch,
    () => props.context?.editorSessionId,
    () => props.context?.siteScope,
    () => props.context?.userScope,
    () => props.context?.draftId,
    () => props.context?.draftRevision,
    () => props.definitionOwnerUserId,
    () => props.enabled,
    () => props.readKey
], () =>
{
    // A same-article session/permission switch cannot reuse the previous read.
    // The read owner must supply a fresh model; body-only changes are excluded.
    revokedModel.value = props.model;
}, { flush: 'sync' });

const visible = computed(() => props.enabled && props.context !== null
    && props.context.articleId === props.model?.articleId
    && props.context.draftRevision === null
    && props.model !== revokedModel.value
    && props.model?.scope.definitionOwnerUserId === props.definitionOwnerUserId);
const definition = computed(() => visible.value
    ? props.model?.definitions.find((item) => item.definitionId === props.definitionId) ?? null
    : null);
const entry = computed(() => definition.value
    ? props.model?.current?.snapshot.values.find((item) => item.definitionId === props.definitionId) ?? null
    : null);
const reconciliation = computed(() => definition.value
    ? props.model?.reconciliation.find((item) => item.definitionId === props.definitionId) ?? null
    : null);
const incompatible = computed(() => !!entry.value && !!definition.value
    && (entry.value.definitionSchemaRevision !== definition.value.schemaRevision
        || entry.value.definitionDigest !== definition.value.contentDigest
        || (entry.value.value !== null && entry.value.value.type !== definition.value.valueType)));
const blocked = computed(() => !props.editable || definition.value?.status !== 0
    || incompatible.value || [1, 2, 3, 5].includes(reconciliation.value?.status ?? 1));
const invalid = computed(() => [4, 6].includes(reconciliation.value?.status ?? -1));
const serverStatus = computed(() => incompatible.value ? props.labels.conflict
    : props.labels.reconciliation[definition.value?.status !== 0 ? 2 : reconciliation.value?.status ?? 1] ?? props.labels.unavailable);
const fieldName = computed(() => definition.value?.displayNames.find((name) => name.locale === props.locale)?.value
    ?? definition.value?.machineKey ?? props.labels.unavailable);
function toggleSummary(event: Event): void
{
    // Native disclosure supplies keyboard and focus behavior; read withdrawal
    // must not let a queued toggle expose a previous descriptor.
    if (event.currentTarget !== summaryDisclosure.value)
    {
        return;
    }
    summaryExpanded.value = visible.value && summaryDisclosure.value?.open === true;
}
// Display only the descriptor actually returned by the Server. Labels describe
// closed codes; none of these flags determines grants, validation or UI ports.
function summaryValue(value: unknown, choices?: readonly string[]): string
{
    const copy = props.labels.definitionSummary;
    if (value === undefined)
    {
        return copy.absent;
    }
    if (value === null)
    {
        return copy.nullValue;
    }
    if (!choices && typeof value === 'boolean')
    {
        return value ? copy.yes : copy.no;
    }
    if (choices && typeof value === 'number' && Number.isFinite(value))
    {
        const label = Number.isInteger(value) && value >= 0 ? choices[value] : undefined;
        return `${label ?? copy.unknown} (${value})`;
    }
    return copy.unknown;
}
const summaryRows = computed(() =>
{
    if (!summaryExpanded.value || !definition.value)
    {
        return [];
    }
    const descriptor = definition.value;
    const copy = props.labels.definitionSummary;
    return [
        { key: 'searchEligible', label: copy.searchEligible, value: summaryValue(descriptor.searchEligible) },
        { key: 'filterable', label: copy.filterable, value: summaryValue(descriptor.filterable) },
        { key: 'sortable', label: copy.sortable, value: summaryValue(descriptor.sortable) },
        { key: 'required', label: copy.required, value: summaryValue(descriptor.required) },
        { key: 'missing', label: copy.missing, value: summaryValue(descriptor.presence?.missing, copy.missingBehavior.slice(0, 2)) },
        { key: 'null', label: copy.null, value: summaryValue(descriptor.presence?.null, copy.nullBehavior.slice(0, 2)) },
        { key: 'empty', label: copy.empty, value: summaryValue(descriptor.presence?.empty, copy.emptyBehavior.slice(0, 3)) },
        { key: 'visibilityScope', label: copy.visibilityScope, value: summaryValue(descriptor.visibilityScope, copy.visibility.slice(0, 3)) },
        { key: 'displayPlacement', label: copy.displayPlacement, value: summaryValue(descriptor.displayPlacement, copy.placement.slice(0, 3)) }
    ];
});
type ValuePresence = NonNullable<ArticlePropertyValueReadResponse['current']>['snapshot']['values'][number]['presence'];
const presence = computed<ValuePresence>(() => entry.value?.presence ?? 0);
const supported = computed(() => [0, 2, 4, 5, 7].includes(definition.value?.valueType ?? -1));
const presenceOptions = computed(() => ([0, 1, 2] as const).map((value) => ({ value, label: props.labels.presence[value] })));
const draftPresence = ref<ValuePresence>(0);
const options = computed(() =>
{
    const choices = definition.value?.options.map((option) => ({
        value: option.optionId,
        label: option.localizedLabels.find((name) => name.locale === props.locale)?.value ?? option.label,
        disabled: option.status !== 0
    })) ?? [];
    const value = entry.value?.value;
    const selected = value?.type === 4 ? [value.optionId] : value?.type === 5 ? value.optionIds : [];
    for (const optionId of selected)
    {
        if (!choices.some((option) => option.value === optionId))
        {
            choices.push({ value: optionId, label: props.labels.unknownOption, disabled: true });
        }
    }
    return choices;
});

const control = shallowRef<{ focus: () => void; } | null>(null);
const generation = ref(0);
const controlGeneration = ref(0);
const text = ref('');
const boolean = ref(false);
const single = ref<string | undefined>(undefined);
const multiple = ref<string[]>([]);
const dirty = ref(false);
let disposed = false;
const ignore = (): void =>
{
    return;
};
const handlers = shallowRef<{
    text: (value: unknown) => void;
    boolean: (value: unknown) => void;
    options: (value: unknown) => void;
    presence: (value: unknown) => void;
}>({ text: ignore, boolean: ignore, options: ignore, presence: ignore });

function cancel(): void
{
    generation.value++;
    dirty.value = false;
    draftPresence.value = presence.value;
    const value = entry.value?.value;
    text.value = value?.type === 0 ? value.text : value?.type === 7 ? value.url : '';
    boolean.value = value?.type === 2 ? value.boolean : false;
    single.value = value?.type === 4 ? value.optionId : undefined;
    multiple.value = value?.type === 5 ? [...value.optionIds] : [];
    const currentGeneration = generation.value;
    const current = (): boolean => !disposed && currentGeneration === generation.value
        && visible.value && !blocked.value;
    handlers.value = {
        text: (candidate) =>
        {
            if (current() && draftPresence.value === 2 && typeof candidate === 'string')
            {
                text.value = candidate;
                dirty.value = true;
            }
        },
        boolean: (candidate) =>
        {
            if (current() && draftPresence.value === 2 && typeof candidate === 'boolean')
            {
                boolean.value = candidate;
                dirty.value = true;
            }
        },
        presence: (candidate) =>
        {
            // A transient closed UI selection only. The Server owns presence
            // validation/defaults; never erase the original typed buffer here.
            if (current() && supported.value && (candidate === 0 || candidate === 1 || candidate === 2))
            {
                draftPresence.value = candidate;
                dirty.value = true;
            }
        },
        options: (candidate) =>
        {
            if (!current() || draftPresence.value !== 2)
            {
                return;
            }
            if (definition.value?.valueType === 4 && typeof candidate === 'string')
            {
                single.value = candidate;
                dirty.value = true;
            }
            else if (definition.value?.valueType === 5 && Array.isArray(candidate)
                && candidate.every((optionId: unknown) => typeof optionId === 'string'))
            {
                multiple.value = [...candidate];
                dirty.value = true;
            }
        }
    };
}

async function cancelFromControl(event: MouseEvent): Promise<void>
{
    const previousFocus = document.activeElement;
    const returnFocus = previousFocus === event.currentTarget;
    cancel();
    const cancelledGeneration = generation.value;
    await nextTick();
    if (returnFocus && !disposed && generation.value === cancelledGeneration
        && visible.value && !blocked.value
        && (document.activeElement === previousFocus || document.activeElement === document.body))
    {
        // SelectV2 documents focus(), but this active baseline does not
        // expose it. Keep the stable Cancel button focused for selection or
        // absent values; do not access private internals to emulate that API.
        if (draftPresence.value === 2 && [0, 2, 7].includes(definition.value?.valueType ?? -1))
        {
            control.value?.focus();
        }
    }
}

watch([() => props.model, () => props.definitionId, () => props.editable, visible], () =>
{
    summaryExpanded.value = false;
    controlGeneration.value++;
    cancel();
}, { immediate: true, deep: true, flush: 'sync' });
onBeforeUnmount(() =>
{
    disposed = true;
    cancel();
});
</script>

<style scoped>
.article-metadata-field
 {
    display: grid;
    min-width: 0;
    gap: var(--fsus-space-2);
    overflow-wrap: anywhere;
}

.article-metadata-field__control
 {
    display: grid;
    min-width: 0;
    gap: var(--fsus-space-2);
}

.article-metadata-field__status
 {
    margin: 0;
    overflow-wrap: anywhere;
    color: var(--el-text-color-secondary);
}

.article-metadata-field__actions
 {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fsus-space-2);
}

.article-metadata-field__summary
 {
    display: grid;
    min-width: 0;
    margin: 0;
    gap: var(--fsus-space-2);
    overflow-wrap: anywhere;
    color: var(--el-text-color-secondary);
}

.article-metadata-field__summary dd
 {
    margin: 0;
}
</style>
