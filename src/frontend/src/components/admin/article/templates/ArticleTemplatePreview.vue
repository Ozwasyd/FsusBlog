<template>
    <section :aria-label="labels.version">
        <h3>{{ version.name }} · {{ labels.version }} {{ version.versionNumber }}</h3>
        <p v-if="version.description">{{ version.description }}</p>
        <h4>{{ labels.source }}</h4>
        <pre class="template-source">{{ version.source }}</pre>
        <h4>{{ labels.variables }}</h4>
        <p>{{ version.variables.join(', ') || '—' }}</p>
        <h4>{{ labels.defaults }}</h4>
        <dl class="template-defaults">
            <template
                v-for="(value, key) in version.defaults"
                :key="key"
            >
                <dt>{{ labels.defaultLabel(key) }}</dt>
                <dd>{{ labels.defaultValue(key, value) }}</dd>
            </template>
        </dl>
    </section>
</template>

<script setup lang="ts">
import type { ArticleTemplateDefaults, ArticleTemplateVersion } from '@/api/articleTemplates';

defineProps<{
    version: ArticleTemplateVersion;
    labels: {
        version: string; source: string; variables: string; defaults: string;
        defaultLabel: (key: keyof ArticleTemplateDefaults) => string;
        defaultValue: (key: keyof ArticleTemplateDefaults, value: ArticleTemplateDefaults[keyof ArticleTemplateDefaults]) => string;
    };
}>();
</script>

<style scoped>
.template-source
 {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 16rem;
    overflow: auto;
}

.template-defaults
 {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
    gap: var(--fsus-space-2);
    overflow-wrap: anywhere;
}

.template-defaults dd
 {
    margin: 0;
}
</style>
