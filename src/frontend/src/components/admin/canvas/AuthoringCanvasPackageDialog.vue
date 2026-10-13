<template>
    <FsusDialog
        :model-value="visible"
        :title="t(mode === 'export' ? 'admin.canvas.exportPackage' : 'admin.canvas.importPackage')"
        :width="fsusDialogWidths.longForm"
        @update:model-value="!$event && $emit('close')"
    >

        <!-- Export Mode -->
        <template v-if="mode === 'export'">

            <ElInput
                type="textarea"
                :rows="8"
                readonly
                :maxlength="16 * 1024 * 1024"
                class="package-textarea"
                :model-value="exportContent"
                :aria-label="t('admin.canvas.exportPackage')"
            ></ElInput>
            <div class="dialog-actions">
                <ElButton
                    native-type="button"
                    class="btn secondary"
                    @click="$emit('close')"
                >{{ t('common.actions.close') }}</ElButton>
                <ElButton
                    native-type="button"
                    class="btn primary"
                    @click="handleCopyExport"
                >{{ t('admin.canvas.copyPackage') }}</ElButton>
            </div>
        </template>

        <!-- Import Mode -->
        <template v-else>
            <div v-if="!importPlan">

                <ElInput
                    type="textarea"
                    :rows="8"
                    v-model="importInput"
                    :maxlength="16 * 1024 * 1024"
                    class="package-textarea"
                    :placeholder="t('admin.canvas.packageInput')"
                    :aria-label="t('admin.canvas.packageInput')"
                ></ElInput>
                <div
                    v-if="importError"
                    class="dialog-error-banner"
                    role="alert"
                >{{ importError }}</div>
                <div class="dialog-actions">
                    <ElButton
                        native-type="button"
                        class="btn secondary"
                        @click="$emit('close')"
                    >{{ t('common.actions.cancel') }}</ElButton>
                    <ElButton
                        native-type="button"
                        class="btn primary"
                        :disabled="!importInput.trim()"
                        @click="handleValidateAndPlan"
                    >
                        {{ t('admin.canvas.inspectPackage') }}
                    </ElButton>
                </div>
            </div>

            <div
                v-else
                class="import-plan-view"
            >
                <div class="plan-summary">
                    <h4>{{ importPlan.package.manifest.title }}</h4>
                    <p>Nodes: {{ importPlan.package.manifest.counts.nodes }} | Edges: {{ importPlan.package.manifest.counts.edges }}</p>
                    <p>Resolved References: {{ importPlan.resolvedCount }} | Unresolved: {{ importPlan.unresolvedCount }}</p>
                </div>

                <div
                    v-if="importPlan.unresolvedCount > 0"
                    class="unresolved-list"
                >
                    <h5>{{ t('admin.canvas.keepBroken') }}</h5>
                    <div
                        v-for="item in importPlan.reResolutionItems"
                        :key="item.nodeId"
                        class="unresolved-item"
                    >
                        <span v-if="item.status !== 'resolved'">
                            Node {{ item.nodeId }} (Article #{{ item.targetArticleId }}):
                            <ElSelect
                                v-model="unresolvedDecisions[item.nodeId]"
                                class="decision-select"
                            >
                                <ElOption
                                    value="leave-broken"
                                    :label="t('admin.canvas.keepBroken')"
                                />
                                <ElOption
                                    value="remove-node"
                                    :label="t('admin.canvas.removeNode')"
                                />
                            </ElSelect>
                        </span>
                    </div>
                </div>

                <div class="dialog-actions">
                    <ElButton
                        native-type="button"
                        class="btn secondary"
                        @click="importPlan = null"
                    >{{ t('admin.canvas.back') }}</ElButton>
                    <ElButton
                        native-type="button"
                        class="btn primary"
                        :disabled="!canExecuteImport"
                        @click="handleExecuteImport"
                    >
                        {{ t('admin.canvas.importUnavailable') }}
                    </ElButton>
                </div>
            </div>
        </template>
    </FsusDialog>
</template>

<script setup lang="ts">
import { ElButton, ElInput, ElOption, ElSelect } from '@ozwasyd/element-plus';
import { ref, watch } from 'vue';

import FsusDialog from '@/components/ui/FsusDialog.vue';
import { useI18nText } from '@/composables/useI18nText';
import { fsusDialogWidths } from '@/fsusui/dialog';
import type { AuthoringCanvasImportPlan, AuthoringCanvasPackage, UnresolvedDecisionAction } from '@/services/authoringCanvasPackage';
import { validateAndParseCanvasPackage } from '@/services/authoringCanvasPackage';
const props = defineProps<{
    visible: boolean;
    mode: 'export' | 'import';
    exportContent?: string;
    planImport?: (pkg: AuthoringCanvasPackage) => Promise<AuthoringCanvasImportPlan>;
    canExecuteImport?: boolean;
}>();
const emit = defineEmits<{
    (e: 'close'): void;
    (e: 'execute-import', plan: AuthoringCanvasImportPlan, decisions: Record<string, {
        action: UnresolvedDecisionAction;
    }>): void;
}>();
const { t } = useI18nText();
const importInput = ref('');
const importError = ref<string | null>(null);
const importPlan = ref<AuthoringCanvasImportPlan | null>(null);
const unresolvedDecisions = ref<Record<string, UnresolvedDecisionAction>>({});
let planGeneration = 0;
watch(() => [props.visible, props.mode], () =>
{
    planGeneration++;
    importPlan.value = null;
    importError.value = null;
    unresolvedDecisions.value = {};
});
async function handleValidateAndPlan()
{
    const generation = ++planGeneration;
    importError.value = null;
    const validation = validateAndParseCanvasPackage(importInput.value);
    if (!validation.valid || !validation.package)
    {
        importError.value = t('admin.canvas.unavailable');
        return;
    }
    try
    {
        const pkg = validation.package;
        const plan = props.planImport ? await props.planImport(pkg) : {
            package: pkg, isNewCanvas: true,
            reResolutionItems: pkg.portableReferences.map(ref => ({ nodeId: ref.nodeId, nodeType: ref.nodeType,
                                                                    targetArticleId: ref.sourceArticleId, status: 'unresolved_ambiguous' as const })),
            resolvedCount: 0, unresolvedCount: pkg.portableReferences.length, canDirectlyExecute: false
        };
        if (generation !== planGeneration || !props.visible)
        {
            return;
        }
        importPlan.value = plan;
        // Default decisions for unresolved items
        const decisions: Record<string, UnresolvedDecisionAction> = {};
        for (const item of plan.reResolutionItems)
        {
            if (item.status !== 'resolved')
            {
                decisions[item.nodeId] = 'leave-broken';
            }
        }
        unresolvedDecisions.value = decisions;
    }
    catch
    {
        importError.value = t('admin.canvas.unavailable');
    }
}
function handleExecuteImport()
{
    if (!importPlan.value || !props.canExecuteImport)
    {
        return;
    }
    const decisions: Record<string, {
        action: UnresolvedDecisionAction;
    }> = {};
    for (const [nodeId, action] of Object.entries(unresolvedDecisions.value))
    {
        decisions[nodeId] = { action };
    }
    emit('execute-import', importPlan.value, decisions);
    importPlan.value = null;
    importInput.value = '';
}
async function handleCopyExport()
{
    try
    {
        if (props.exportContent)
        {
            await navigator.clipboard.writeText(props.exportContent);
        }
    }
    catch
    {
        importError.value = t('admin.canvas.unavailable');
    }
}
</script>



<style scoped>



.dialog-desc
 {
    margin: 0;
    font-size: var(--el-font-size-base);
    color: var(--el-text-color-secondary);
}


.dialog-error-banner
 {
    background: var(--el-color-danger-light-9);
    color: var(--el-color-danger);
    padding: var(--fsus-space-2) var(--fsus-space-3);
    border-radius: var(--fsus-radius-panel);
    font-size: var(--el-font-size-base);
}

.plan-summary
 {
    background: var(--el-bg-color-page);
    border: 1px solid var(--el-border-color);
    border-radius: var(--fsus-radius-panel);
    padding: var(--fsus-space-3);
    font-size: var(--el-font-size-base);
}

.plan-summary h4
 {
    margin: 0 0 var(--fsus-space-2) 0;
}

.plan-summary p
 {
    margin: 0 0 var(--fsus-space-1) 0;
    color: var(--el-text-color-secondary);
}

.unresolved-list
 {
    margin-top: var(--fsus-space-3);
    font-size: var(--el-font-size-base);
}

.unresolved-item
 {
    margin-bottom: var(--fsus-space-2);
}


.dialog-actions
 {
    display: flex;
    justify-content: flex-end;
    gap: var(--fsus-space-2);
}




</style>
