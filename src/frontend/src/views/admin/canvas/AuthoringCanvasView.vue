<template>
    <div class="account-page authoring-canvas-view">
        <FsusUiTaskPageHeader
            :title="t('admin.canvas.title')"
            density="compact"
        >
            <template
                v-if="session && !canvasId && !requestedCreation"
                #actions
            >
                <ElButton
                    type="primary"
                    @click="requestedCreation = true"
                >{{ t('admin.canvas.canvas') }}</ElButton>
            </template>
        </FsusUiTaskPageHeader>
        <p
            v-if="loading"
            role="status"
        >{{ t('common.loading.status') }}</p>
        <ElAlert
            v-else-if="unavailable"
            :title="t('admin.canvas.unavailable')"
            type="error"
            :closable="false"
        />
        <AuthoringCanvasWorkspace
            v-else-if="session && (canvasId || requestedCreation)"
            :key="canvasId || 'new-canvas'"
            :session="session"
            :link-transaction="linkTransaction"
            :canvas-id="canvasId"
            :new-canvas-title="requestedCreation ? t('admin.canvas.title') : undefined"
        />
        <ElTable
            v-else
            :data="documents"
            row-key="id"
            @row-click="openCanvas"
        >
            <ElTableColumn
                prop="title"
                :label="t('admin.canvas.title')"
            >
                <template #default="{ row }"><ElButton
                    text
                    @click.stop="openCanvas(row)"
                >{{ row.title }}</ElButton></template>
            </ElTableColumn>
            <template #empty>{{ t('admin.canvas.empty') }}</template>
        </ElTable>
    </div>
</template>

<script setup lang="ts">
import { ElAlert, ElButton, ElTable, ElTableColumn } from '@ozwasyd/element-plus';
import { computed, onBeforeUnmount, onMounted, shallowRef, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import AuthoringCanvasWorkspace from '@/components/admin/canvas/AuthoringCanvasWorkspace.vue';
import type { AuthoringCanvasSession } from '@/composables/useAuthoringCanvas';
import { useI18nText } from '@/composables/useI18nText';
import type { AuthoringCanvasDocumentSummary } from '@/contracts/authoringCanvas';
import { FsusUiTaskPageHeader } from '@/fsusui/taskPageHeader';
import { createArticleCanvasLinkTransaction, type ArticleCanvasLinkTransaction } from '@/services/articleCanvasLinkTransaction';
import { createAuthoringCanvasSession } from '@/services/authoringCanvasSession';
const route = useRoute();
const router = useRouter();
const { t } = useI18nText();
const session = shallowRef<AuthoringCanvasSession>();
const documents = ref<AuthoringCanvasDocumentSummary[]>([]);
const loading = ref(true);
const unavailable = ref(false);
const requestedCreation = ref(false);
const sessionAbort = new AbortController();
onBeforeUnmount(() => sessionAbort.abort());
const linkTransaction = shallowRef<ArticleCanvasLinkTransaction>();
const canvasId = computed(() => typeof route.params.id === 'string' ? route.params.id : undefined);
watch(canvasId, async (id) =>
{
    requestedCreation.value = false;
    if (!id && session.value)
    {
        try
        {
            documents.value = await session.value.storage.listCanvases(session.value.ownerContext);
        }
        catch
        {
            unavailable.value = true;
        }
    }
});
onMounted(async () =>
{
    try
    {
        const active = await createAuthoringCanvasSession(sessionAbort.signal);
        documents.value = await active.storage.listCanvases(active.ownerContext);
        linkTransaction.value = createArticleCanvasLinkTransaction(active.ownerContext, sessionAbort.signal);
        session.value = active;
    }
    catch
    {
        unavailable.value = true;
    }
    finally
    {
        loading.value = false;
    }
});
function openCanvas(row: AuthoringCanvasDocumentSummary): void
{
    void router.push({ name: 'ManageAuthoringCanvasDocument', params: { id: row.id } });
}
</script>

<style scoped>
.authoring-canvas-view
 {
    display: flex;
    flex-direction: column;
    gap: var(--fsus-space-4);
    min-width: 0;
    min-height: 0;
    height: 100%;
}
</style>
