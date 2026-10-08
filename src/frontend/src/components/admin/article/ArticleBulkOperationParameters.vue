<template>
    <ElForm
        label-position="top"
        aria-label="文章操作参数"
    >
        <ElFormItem
            v-for="field in props.fields"
            :key="field.name"
            :label="field.label"
        >
            <ElInput
                v-if="field.type === 'rfc3339-utc'"
                type="datetime-local"
                :aria-label="`${field.label}（UTC）`"
                :model-value="String(values[field.name] ?? '').replace(/Z$/u, '')"
                :disabled="disabled"
                @update:model-value="setUtc(field, $event)"
            />
            <ElSelect
                v-else
                :aria-label="field.label"
                :model-value="values[field.name]"
                :multiple="field.type === 'stable-id-array'"
                :disabled="disabled || field.options.length === 0"
                @update:model-value="setIdentifier(field, $event)"
            >
                <ElOption
                    v-for="option in field.options"
                    :key="option.id"
                    :value="option.id"
                    :label="option.label"
                />
            </ElSelect>
            <p v-if="field.type === 'rfc3339-utc'">时间以 UTC 确认。</p>
        </ElFormItem>
    </ElForm>
</template>

<script setup lang="ts">
import { ElForm, ElFormItem, ElInput, ElOption, ElSelect } from '@ozwasyd/element-plus';

import type { ArticleBulkParameterControl } from '@/services/authoring/articleBulkPresentation';

const props = defineProps<{
    fields: readonly ArticleBulkParameterControl[];
    values: Readonly<Record<string, string | readonly string[]>>;
    disabled: boolean;
}>();
const emit = defineEmits<{
    parameter: [name: string, value: string | readonly string[]];
}>();

function setIdentifier(field: ArticleBulkParameterControl, value: unknown): void
{
    const identifiers = field.type === 'stable-id-array' && Array.isArray(value) ? value.map(String) : [String(value)];
    if (identifiers.every(id => field.options.some(option => option.id === id)))
    {
        emit('parameter', field.name, field.type === 'stable-id-array' ? identifiers : identifiers[0]);
    }
}

function setUtc(field: ArticleBulkParameterControl, value: unknown): void
{
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/u.test(text))
    {
        emit('parameter', field.name, `${text.length === 16 ? `${text}:00` : text}Z`);
    }
}
</script>
