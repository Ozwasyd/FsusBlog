<template>
    <section
        v-if="state !== 'inactive'"
        class="article-metadata-read-panel"
        :aria-label="labels.title"
        :aria-busy="state === 'loading'"
    >
        <h3>{{ labels.title }}</h3>
        <p
            v-if="state !== 'ready'"
            role="status"
            aria-live="polite"
        >{{ labels.states[state] }}</p>
        <template v-else-if="model">
            <p>{{ revisionLabel }}</p>
            <p v-if="model.definitions.length === 0">{{ labels.empty }}</p>
            <dl v-else>
                <div
                    v-for="definition in model.definitions"
                    :key="definition.definitionId"
                >
                    <dt>{{ definition.displayNames.find(name => name.locale === locale)?.value
                        ?? definition.displayNames[0]?.value ?? definition.machineKey }}</dt>
                    <dd>{{ displayValue(definition) }}</dd>
                </div>
            </dl>
            <p
                v-if="model.reconciliation.some(item => item.status !== 0)"
                role="status"
            >
                {{ labels.reconciliation }}
            </p>
        </template>
        <FsusUiButton
            v-if="state === 'ready' || state === 'unavailable'"
            native-type="button"
            text
            @click="$emit('refresh')"
        >{{ labels.refresh }}</FsusUiButton>
    </section>
</template>

<script setup lang="ts">
import type { ArticlePropertyDefinitionReadDescriptor, ArticlePropertyValueReadResponse } from '@/codecs/binary/articlePropertyValueReadCodecs';
import { FsusUiButton } from '@/fsusui/button';

const props = defineProps<{
    model: ArticlePropertyValueReadResponse | null;
    state: 'inactive' | 'article-required' | 'draft-unavailable' | 'loading' | 'ready' | 'unavailable';
    locale: string;
    revisionLabel: string;
    labels: {
        title: string;
        refresh: string;
        empty: string;
        missing: string;
        nullValue: string;
        yes: string;
        no: string;
        unknownOption: string;
        reconciliation: string;
        states: Readonly<Record<'article-required' | 'draft-unavailable' | 'loading' | 'unavailable', string>>;
    };
}>();

defineEmits<(event: 'refresh') => void>();

/** Display the borrowed typed value; never coerce or replace its persisted representation. */
function displayValue(definition: ArticlePropertyDefinitionReadDescriptor): string
{
    const entry = props.model?.current?.snapshot.values.find(value => value.definitionId === definition.definitionId);
    if (!entry || entry.presence === 0)
    {
        return props.labels.missing;
    }
    if (entry.presence === 1 || entry.value === null)
    {
        return props.labels.nullValue;
    }
    const value = entry.value;
    const optionLabel = (id: string): string =>
    {
        const option = definition.options.find(candidate => candidate.optionId === id);
        return option?.localizedLabels.find(name => name.locale === props.locale)?.value
            ?? option?.label ?? props.labels.unknownOption;
    };
    switch (value.type)
    {
        case 0:
            return value.text;
        case 1:
        {
            const number = value.number;
            const coefficient = BigInt(number.lo) + (BigInt(number.mid) << 32n) + (BigInt(number.hi) << 64n);
            const digits = coefficient.toString().padStart(number.scale + 1, '0');
            const fraction = number.scale === 0 ? digits : `${digits.slice(0, -number.scale)}.${digits.slice(-number.scale)}`;
            return `${number.negative ? '-' : ''}${fraction}`;
        }
        case 2:
            return value.boolean ? props.labels.yes : props.labels.no;
        case 3:
        {
            const ticks = BigInt(value.utc);
            const seconds = ticks / 10_000_000n - 62_135_596_800n;
            const whole = new Date(Number(seconds) * 1000).toISOString().slice(0, -5);
            return `${whole}.${(ticks % 10_000_000n).toString().padStart(7, '0')}Z`;
        }
        case 4:
            return optionLabel(value.optionId);
        case 5:
            return value.optionIds.map(optionLabel).join(' · ');
        case 6:
            return value.articleIds.map(id => `#${id}`).join(' · ');
        case 7:
            return value.url;
    }
}
</script>

<style scoped>
.article-metadata-read-panel
{
    margin-block-start: var(--fsus-space-4);
    padding-block-start: var(--fsus-space-4);
    border-block-start: 1px solid var(--fsusblog-panel-border);
    overflow-wrap: anywhere;
}
</style>
