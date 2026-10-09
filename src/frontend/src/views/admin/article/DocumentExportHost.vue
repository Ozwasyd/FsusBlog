<template>
    <ElButton
        :disabled="disabled"
        @click="open"
    >文档导出</ElButton>
    <ElDrawer
        :model-value="selectorVisible"
        title="选择导出来源"
        size="min(100%, 36rem)"
        destroy-on-close
        @update:model-value="value => { if (!value) close(); }"
    >
        <div class="document-export-source-selector">
            <ElSelect
                v-model="articleId"
                aria-label="选择导出文章"
                placeholder="请选择文章"
                clearable
                filterable
                :disabled="loading"
                @update:model-value="selectArticle"
            >
                <ElOption
                    v-for="article in props.articles"
                    :key="article.id"
                    :value="article.id"
                    :label="article.title"
                />
            </ElSelect>
            <ElButton
                :disabled="articleId === undefined || loading"
                :loading="loading"
                @click="readRevisions"
            >读取修订</ElButton>
            <ElSelect
                v-model="choiceId"
                aria-label="选择导出修订"
                placeholder="请选择修订"
                clearable
                :disabled="loading || !choices?.choices.length"
            >
                <ElOption
                    v-for="choice in choices?.choices ?? []"
                    :key="choice.choiceId"
                    :value="choice.choiceId"
                    :label="choice.label"
                />
            </ElSelect>
            <p role="status">{{ message || availabilityMessage }}</p>
            <ElButton
                :disabled="!selectedChoice || !authorities"
                @click="continueToExport"
            >继续导出</ElButton>
        </div>
    </ElDrawer>
    <ExportCenter
        v-if="port && selectedChoice"
        :visible="centerVisible"
        :identity="selectedChoice.choiceId"
        :port="port"
        @update:visible="value => { if (!value) close(); }"
    />
</template>

<script lang="ts">
import { computed, inject, onBeforeUnmount, ref, shallowRef } from 'vue';

import { captureDocumentExportRequest, classifyDocumentExportFailure } from '@/api/documentExport';
import { captureDocumentExportRevisionChoices } from '@/api/documentExportSourceOptions';
import type { DocumentExportSourceChoiceResponse, DocumentExportSourceChoicesResponse } from '@/codecs/binary/documentExportSourceOptionsWire.generated';
import type { DocumentExportRequest } from '@/codecs/binary/documentExportWire.generated';
import { createDocumentExportPrivateUiLifecycle } from '@/components/document-export/documentExportPrivateUiLifecycle';
import { captureDocumentExportSourceChoicesResponse, mapDocumentExportSourceChoices } from '@/components/document-export/documentExportSourceChoices';
import type { DocumentExportFormatChoice, DocumentExportSelection } from '@/components/document-export/documentExportUiPort';
import { createDocumentExportBrowserUiPort } from '@/composition/documentExport';
import { FsusUiButton as ElButton } from '@/fsusui/button';
import { FsusUiClassicOption as ElOption, FsusUiClassicSelect as ElSelect } from '@/fsusui/classicSelect';
import { FsusUiExportDrawer as ElDrawer } from '@/fsusui/documentExportControls';
import { activeLocale } from '@/locales';

import ExportCenter from './ExportCenter.vue';

import type { InjectionKey } from 'vue';

/**
 * A future authenticated canonical catalog/readiness and source-policy reader
 * must provide these facts. No producer is registered while those APIs are absent.
 * Output download policy and declared implementation flags do not supply them.
 */
export interface DocumentExportHostAuthorities {
    readCatalog: () => readonly DocumentExportFormatChoice[] | undefined;
    privateForSource: (choice: Readonly<DocumentExportSourceChoiceResponse>) => boolean | undefined;
}

export const documentExportHostAuthoritiesKey: InjectionKey<DocumentExportHostAuthorities> = Symbol('document-export-host-authorities');

/** Require the explicit persisted choice and actual readiness/privacy projections. */
export function requireDocumentExportHostFacts(
    response: DocumentExportSourceChoicesResponse,
    choiceId: string,
    authorities: DocumentExportHostAuthorities | undefined,
    assertCurrent: () => void
)
{
    const captured = captureDocumentExportSourceChoicesResponse(response);
    const choice = captured.choices.find(value => value.choiceId === choiceId);
    if (!choice)
    {
        throw new RangeError('document_export_explicit_source_required');
    }
    assertCurrent();
    const catalog = authorities?.readCatalog();
    assertCurrent();
    if (!catalog?.some(format => format.available === true))
    {
        throw new Error('document_export_runtime_availability_unavailable');
    }
    const privateSource = authorities?.privateForSource(choice);
    assertCurrent();
    if (typeof privateSource !== 'boolean')
    {
        throw new Error('document_export_source_privacy_unavailable');
    }
    return {
        choice,
        catalog,
        sources: mapDocumentExportSourceChoices({ choices: [choice] }, () => privateSource)
    };
}

/** Bind the actual locale and exact coordinate without allocating jobs or normalizing Int64. */
export function createDocumentExportHostPrepareRequest(
    choice: Readonly<DocumentExportSourceChoiceResponse>,
    catalog: readonly DocumentExportFormatChoice[],
    readLocale: () => string,
    allocateIdentity: () => Pick<DocumentExportRequest, 'requestId' | 'idempotencyKey'> = () => ({
        requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID()
    })
): (selection: Readonly<DocumentExportSelection>) => DocumentExportRequest
{
    const boundChoice = captureDocumentExportSourceChoicesResponse({ choices: [choice] }).choices[0];
    let prior: DocumentExportRequest | undefined;
    return selection =>
    {
        const format = catalog.find(value => value.id === selection.formatId);
        if (selection.sourceId !== boundChoice.choiceId || format?.available !== true
            || !format.layouts.includes(selection.layout) || !format.themes.includes(selection.theme))
        {
            throw new RangeError('document_export_selection_unavailable');
        }
        const locale = readLocale();
        if (prior?.formatId === selection.formatId && prior.layoutProfile === selection.layout
            && prior.themeProfile === selection.theme && prior.locale === locale)
        {
            return prior;
        }
        // Allocate one identity for this explicit intent; capture owns the wire grammar.
        const coordinate = boundChoice.coordinate;
        const identity = allocateIdentity();
        prior = captureDocumentExportRequest({
            ...identity, source: coordinate, formatId: selection.formatId,
            layoutProfile: selection.layout, themeProfile: selection.theme, locale
        });
        return prior;
    };
}
</script>

<script setup lang="ts">
const props = defineProps<{ articles: readonly { id: number; title: string; }[]; disabled?: boolean; }>();
const authorities = inject(documentExportHostAuthoritiesKey, undefined);
const selectorVisible = ref(false);
const centerVisible = ref(false);
const articleId = ref<number>();
const choiceId = ref<string>();
const choices = shallowRef<DocumentExportSourceChoicesResponse>();
const port = shallowRef<ReturnType<typeof createDocumentExportBrowserUiPort>>();
const loading = ref(false);
const message = ref('');
let lifecycle: ReturnType<typeof createDocumentExportPrivateUiLifecycle> | undefined;
let pending: AbortController | undefined;
const selectedChoice = computed(() => choices.value?.choices.find(choice => choice.choiceId === choiceId.value));
const availabilityMessage = computed(() => selectedChoice.value
    ? authorities
        ? '继续导出前将核验运行资格和该来源的隐私判定。'
        : '导出暂不可用：运行资格和该来源的隐私判定尚未提供。'
    : '请选择文章并读取修订，再显式选择一个修订。');

function clearPrivateView(): void
{
    pending?.abort();
    pending = undefined;
    port.value?.dispose?.();
    port.value = undefined;
    choices.value = undefined;
    articleId.value = undefined;
    choiceId.value = undefined;
    message.value = '';
    loading.value = false;
    selectorVisible.value = false;
    centerVisible.value = false;
}

function close(): void
{
    const retired = lifecycle;
    lifecycle = undefined;
    retired?.dispose();
    clearPrivateView();
}

function open(): void
{
    close();
    lifecycle = createDocumentExportPrivateUiLifecycle(clearPrivateView);
    selectorVisible.value = true;
}

function selectArticle(): void
{
    pending?.abort();
    pending = undefined;
    loading.value = false;
    choices.value = undefined;
    choiceId.value = undefined;
    message.value = '';
}

async function readRevisions(): Promise<void>
{
    const selectedArticle = articleId.value;
    const current = lifecycle;
    if (!current || selectedArticle === undefined || loading.value)
    {
        return;
    }
    current.assertCurrent();
    const request = new AbortController();
    pending = request;
    const abort = (): void => request.abort(current.signal.reason);
    current.signal.addEventListener('abort', abort, { once: true });
    loading.value = true;
    choices.value = undefined;
    choiceId.value = undefined;
    message.value = '';
    try
    {
        const captured = await captureDocumentExportRevisionChoices({ articleId: selectedArticle }, request.signal);
        current.assertCurrent();
        request.signal.throwIfAborted();
        if (pending !== request || articleId.value !== selectedArticle)
        {
            return;
        }
        choices.value = captured;
        if (captured.choices.length === 0)
        {
            message.value = '这篇文章没有可选择的修订。';
        }
    }
    catch (error)
    {
        if (request.signal.aborted || pending !== request)
        {
            return;
        }
        if (classifyDocumentExportFailure(error) === 'permission-revoked')
        {
            close();
            return;
        }
        message.value = '未能确认修订选择结果。没有自动重试，请明确重新读取。';
    }
    finally
    {
        current.signal.removeEventListener('abort', abort);
        if (pending === request)
        {
            pending = undefined;
            loading.value = false;
        }
    }
}

function continueToExport(): void
{
    const current = lifecycle;
    if (!current || !choices.value || !choiceId.value)
    {
        return;
    }
    let created: ReturnType<typeof createDocumentExportBrowserUiPort> | undefined;
    try
    {
        current.assertCurrent();
        const facts = requireDocumentExportHostFacts(choices.value, choiceId.value, authorities, current.assertCurrent);
        current.assertCurrent();
        const prepare = createDocumentExportHostPrepareRequest(facts.choice, facts.catalog, () => activeLocale.value);
        created = createDocumentExportBrowserUiPort({
            catalog: facts.catalog, sources: facts.sources,
            prepareRequest: selection =>
            {
                current.assertCurrent();
                const request = prepare(selection);
                current.assertCurrent();
                return request;
            }
        });
        current.assertCurrent();
        port.value = created;
        selectorVisible.value = false;
        centerVisible.value = true;
    }
    catch (error)
    {
        created?.dispose?.();
        if (classifyDocumentExportFailure(error) === 'permission-revoked')
        {
            close();
            return;
        }
        message.value = availabilityMessage.value;
    }
}

onBeforeUnmount(close);
</script>

<style scoped>
.document-export-source-selector
 {
    display: grid;
    gap: var(--fsus-space-4);
}
</style>
