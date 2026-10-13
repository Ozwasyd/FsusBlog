<template>
    <ElButton
        native-type="button"
        @click="picker.search()"
    >{{ labels.entry }}</ElButton>
    <FsusDialog
        :model-value="visible"
        :title="labels.entry"
        :width="fsusDialogWidths.longForm"
        :close-on-click-modal="false"
        :show-close="phase !== 'creating' && phase !== 'create-retry' && phase !== 'open-failed'"
        @update:model-value="!$event && close()"
    >
        <form
            v-if="!version"
            class="template-search"
            @submit.prevent="picker.search(query)"
        >
            <ElInput
                v-model="query"
                :aria-label="labels.search"
                :maxlength="128"
            />
            <ElButton
                native-type="submit"
                :disabled="phase === 'loading'"
            >{{ labels.search }}</ElButton>
        </form>
        <p
            v-if="phase === 'loading' || phase === 'planning'"
            role="status"
        >{{ labels.loading }}</p>
        <p
            v-if="reason"
            role="alert"
        >{{ labels.reason(reason) }}</p>
        <template v-if="!version">
            <p v-if="phase === 'choosing' && items.length === 0">{{ labels.empty }}</p>
            <ul
                class="template-list"
                :aria-label="labels.entry"
            >
                <li
                    v-for="item in items"
                    :key="item.templateId"
                >
                    <ElButton
                        native-type="button"
                        :aria-label="`${labels.select} ${item.name}, ${labels.version} ${item.versionNumber}`"
                        @click="picker.select(item)"
                    >
                        {{ item.name }} · {{ labels.version }} {{ item.versionNumber }}
                    </ElButton>
                    <p v-if="item.description">{{ item.description }}</p>
                </li>
            </ul>
            <ElButton
                v-if="nextCursor"
                native-type="button"
                @click="picker.search(query, nextCursor)"
            >{{ labels.next }}</ElButton>
        </template>
        <template v-else>
            <ArticleTemplatePreview
                :version="version"
                :labels="labels"
            />
            <ElButton
                native-type="button"
                :disabled="phase !== 'preview' && phase !== 'ready'"
                @click="picker.loadVersions()"
            >{{ labels.version }}</ElButton>
            <ul
                class="template-list"
                :aria-label="labels.version"
            >
                <li
                    v-for="choice in versionChoices"
                    :key="choice.versionId"
                >
                    <ElButton
                        native-type="button"
                        :disabled="phase !== 'preview' && phase !== 'ready'"
                        @click="picker.selectVersion(choice)"
                    >{{ labels.version }} {{ choice.versionNumber }}</ElButton>
                </li>
            </ul>
            <ElButton
                v-if="nextVersionNumber"
                native-type="button"
                :disabled="phase !== 'preview' && phase !== 'ready'"
                @click="picker.loadVersions(nextVersionNumber)"
            >{{ labels.next }}</ElButton>
            <form @submit.prevent="picker.validate({ ...context, title: title || null })">
                <ElInput
                    v-if="version.variables.includes('title')"
                    v-model="title"
                    :aria-label="labels.title"
                    :maxlength="128"
                    :disabled="phase === 'creating' || phase === 'create-retry' || phase === 'created' || phase === 'open-failed'"
                />
                <ElButton
                    native-type="submit"
                    :disabled="phase === 'planning' || phase === 'creating' || phase === 'create-retry' || phase === 'created' || phase === 'open-failed'"
                >{{ labels.validate }}</ElButton>
            </form>
        </template>
        <p
            v-if="receipt"
            role="status"
        >{{ labels.created }} #{{ receipt.articleId }}</p>
        <template #footer>
            <ElButton
                native-type="button"
                :disabled="phase === 'creating' || phase === 'create-retry' || phase === 'open-failed'"
                @click="close"
            >{{ labels.cancel }}</ElButton>
            <ElButton
                v-if="phase === 'open-failed'"
                native-type="button"
                type="primary"
                @click="picker.openCreated()"
            >{{ labels.retryOpen }}</ElButton>
            <ElButton
                v-else
                native-type="button"
                type="primary"
                :loading="phase === 'creating'"
                :disabled="!canCreate"
                @click="picker.create()"
            >{{ labels.create }}</ElButton>
        </template>
    </FsusDialog>
</template>

<script setup lang="ts">
import { ElButton, ElInput } from '@ozwasyd/element-plus';
import { ref, watch } from 'vue';

import type { ArticleTemplateCreateHost, ArticleTemplateDefaults, ArticleTemplateInputs, ArticleTemplateTransport } from '@/api/articleTemplates';
import ArticleTemplatePreview from '@/components/admin/article/templates/ArticleTemplatePreview.vue';
import FsusDialog from '@/components/ui/FsusDialog.vue';
import { useArticleTemplatePicker } from '@/composables/useArticleTemplatePicker';
import { fsusDialogWidths } from '@/fsusui/dialog';

const props = defineProps<{
    transport: ArticleTemplateTransport;
    host: ArticleTemplateCreateHost;
    context: Omit<ArticleTemplateInputs, 'title'>;
    labels: {
        entry: string; search: string; empty: string; loading: string; select: string; next: string;
        version: string; source: string; variables: string; defaults: string; title: string;
        validate: string; create: string; cancel: string; retryOpen: string; created: string;
        reason: (code: string) => string;
        defaultLabel: (key: keyof ArticleTemplateDefaults) => string;
        defaultValue: (key: keyof ArticleTemplateDefaults, value: ArticleTemplateDefaults[keyof ArticleTemplateDefaults]) => string;
    };
}>();
const picker = useArticleTemplatePicker(props.transport, props.host, { newRequestId: () => crypto.randomUUID(), now: () => Date.now() });
const { phase, visible, items, nextCursor, version, versionChoices, nextVersionNumber, reason, canCreate, receipt } = picker;
const query = ref('');
const title = ref('');
watch(title, () => picker.editInputs());
watch(() => props.context, () => picker.editInputs(), { deep: true });

function close(): void
{
    if (picker.cancel())
    {
        title.value = '';
        query.value = '';
    }
}
</script>

<style scoped>
.template-search
 {
    display: flex;
    gap: var(--fsus-space-2);
}

.template-list
 {
    list-style: none;
    padding: 0;
    display: grid;
    gap: var(--fsus-space-2);
}
</style>
