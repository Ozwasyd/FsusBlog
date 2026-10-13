<template>
    <FsusDialog
        :model-value="visible"
        :title="labels.heading"
        :width="fsusDialogWidths.longForm"
        :show-close="!pending && !unresolved"
        :close-on-click-modal="false"
        @update:model-value="!$event && !pending && !unresolved && emit('close')"
    >
        <form
            class="template-manager"
            @submit.prevent="submit"
        >
            <ElSelect
                v-model="operation"
                :aria-label="labels.operation"
                :disabled="!canEdit"
            >
                <ElOption
                    v-if="!version"
                    value="create"
                    :label="labels.create"
                />
                <template v-else>
                    <ElOption
                        value="rename"
                        :label="labels.rename"
                    />
                    <ElOption
                        v-if="version.status === 'active'"
                        value="new-version"
                        :label="labels.newVersion"
                    />
                    <ElOption
                        v-if="version.status === 'active'"
                        value="retire"
                        :label="labels.retire"
                    />
                    <ElOption
                        v-if="version.provenanceCount === 0"
                        value="delete"
                        :label="labels.delete"
                    />
                </template>
            </ElSelect>
            <ElInput
                v-if="editsName"
                v-model="name"
                :aria-label="labels.name"
                :maxlength="128"
                :disabled="!canEdit"
            />
            <ElInput
                v-if="editsName"
                v-model="description"
                :aria-label="labels.description"
                :maxlength="1024"
                :disabled="!canEdit"
            />
            <ElInput
                v-if="editsSource"
                v-model="source"
                type="textarea"
                :rows="12"
                :aria-label="labels.source"
                :disabled="!canEdit"
            />
            <p v-if="version">{{ labels.affected }}: {{ version.provenanceCount }}</p>
            <p
                v-if="pending"
                role="status"
            >{{ labels.pending }}</p>
            <p
                v-if="reason"
                role="alert"
            >{{ labels.reason(reason) }}</p>
            <p
                v-if="receiptId"
                role="status"
            >{{ labels.done }}</p>
        </form>
        <template #footer>
            <ElButton
                native-type="button"
                :disabled="pending || unresolved"
                @click="emit('close')"
            >{{ labels.cancel }}</ElButton>
            <ElButton
                native-type="button"
                type="primary"
                :disabled="!allowed || (editsName && !name.trim())"
                :loading="pending"
                @click="submit"
            >{{ labels.confirm }}</ElButton>
        </template>
    </FsusDialog>
</template>

<script setup lang="ts">
import { ElButton, ElInput, ElSelect, ElOption } from '@ozwasyd/element-plus';
import { computed, ref, watch } from 'vue';

import type { ArticleTemplateDefaults, ArticleTemplateManagementCommand, ArticleTemplateTransport, ArticleTemplateVersion } from '@/api/articleTemplates';
import FsusDialog from '@/components/ui/FsusDialog.vue';
import { fsusDialogWidths } from '@/fsusui/dialog';

const props = defineProps<{
    visible: boolean;
    transport: ArticleTemplateTransport;
    version: ArticleTemplateVersion | null;
    scope: 'personal' | 'site';
    scopeRevision: number;
    canManage: boolean;
    labels: {
        heading: string; create: string; rename: string; newVersion: string; retire: string; delete: string;
        name: string; description: string; source: string; operation: string; confirm: string; cancel: string;
        affected: string; pending: string; done: string; reason: (code: string) => string;
    };
}>();
const emit = defineEmits<{ close: []; changed: [receiptId: string]; }>();
const operation = ref<'create' | 'rename' | 'new-version' | 'retire' | 'delete'>('create');
const name = ref('');
const description = ref('');
const source = ref('');
const pending = ref(false);
const unresolved = ref(false);
const reason = ref<string | null>(null);
const receiptId = ref<string | null>(null);
let retryCommand: ArticleTemplateManagementCommand | null = null;
const editsSource = computed(() => operation.value === 'create' || operation.value === 'new-version');
const editsName = computed(() => operation.value === 'create' || operation.value === 'rename');
const allowed = computed(() => props.canManage && (!props.version || props.version.canManage) && !pending.value && !receiptId.value);
const canEdit = computed(() => allowed.value && !unresolved.value);

watch(() => [props.visible, props.version, props.scopeRevision], () =>
{
    if (pending.value || unresolved.value)
    {
        return;
    }
    operation.value = props.version ? (props.version.status === 'active' ? 'new-version' : 'rename') : 'create';
    name.value = props.version?.name ?? '';
    description.value = props.version?.description ?? '';
    source.value = props.version?.source ?? '';
    reason.value = null;
    receiptId.value = null;
    retryCommand = null;
}, { immediate: true });
watch([operation, name, description, source], () =>
{
    if (!pending.value && !unresolved.value)
    {
        retryCommand = null;
    }
});

function buildCommand(): ArticleTemplateManagementCommand
{
    const version = props.version;
    const expectedScopeRevision = props.scopeRevision;
    const requestId = crypto.randomUUID();
    if (operation.value === 'create')
    {
        const defaults: ArticleTemplateDefaults = {
            titlePlaceholder: null, summaryPlaceholder: null, categoryId: null, tagIds: [], propertyDefaults: [],
            assetIds: [], rightsProfile: null, responsibilityProfile: null, prepublishProfile: null
        };
        return { kind: 'create', requestId, templateId: crypto.randomUUID(), versionId: crypto.randomUUID(),
                 scope: props.scope, expectedScopeRevision, name: name.value, description: description.value || null, source: source.value, defaults };
    }
    if (!version)
    {
        throw new Error('article_template_selection_required');
    }
    const binding = { requestId, templateId: version.templateId, expectedScopeRevision, expectedDefinitionRevision: version.definitionRevision };
    if (operation.value === 'new-version')
    {
        return { ...binding, kind: 'new-version', versionId: crypto.randomUUID(), expectedCurrentVersionNumber: version.versionNumber,
                 source: source.value, defaults: version.defaults };
    }
    if (operation.value === 'rename')
    {
        return { ...binding, kind: 'rename', name: name.value, description: description.value || null };
    }
    return { ...binding, kind: operation.value };
}

async function submit(): Promise<void>
{
    if (!allowed.value)
    {
        return;
    }
    retryCommand ??= buildCommand();
    pending.value = true;
    reason.value = null;
    try
    {
        const result = await props.transport.manage(retryCommand);
        unresolved.value = false;
        receiptId.value = result.receiptId;
        emit('changed', result.receiptId);
    }
    catch (error)
    {
        const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
        reason.value = typeof code === 'string' && /^[a-z][a-z0-9_:.]{0,127}$/u.test(code) ? code : 'article_template_request_failed';
        if (code === 'network_error')
        {
            unresolved.value = true;
        }
        if (!unresolved.value)
        {
            retryCommand = null;
        }
    }
    finally
    {
        pending.value = false;
    }
}
</script>

<style scoped>
.template-manager
 {
    display: grid;
    gap: var(--fsus-space-3);
}
</style>
