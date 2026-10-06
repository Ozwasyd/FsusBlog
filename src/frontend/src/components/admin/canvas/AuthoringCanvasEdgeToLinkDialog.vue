<template>
    <FsusDialog
        :model-value="visible"
        :title="t('admin.canvas.linkTitle')"
        :width="fsusDialogWidths.compact"
        @update:model-value="!$event && $emit('cancel')"
    >

        <div
            v-if="!plan?.valid"
            class="dialog-error-banner"
        >
            {{ t('admin.canvas.unavailable') }}
        </div>

        <div
            v-else
            class="dialog-plan-body"
        >


            <div class="plan-details">
                <div class="plan-row">
                    <span class="row-label">{{ t('admin.canvas.reference') }}</span>
                    <span class="row-value">{{ plan.sourceNodeId }}</span>
                </div>
                <div class="plan-row">
                    <span class="row-label">{{ t('admin.canvas.article') }}</span>
                    <span class="row-value">{{ plan.targetTitle || `${t('admin.canvas.article')} #${plan.targetArticleId}` }}</span>
                </div>
                <div class="plan-row">
                    <span class="row-label">{{ t('admin.canvas.linkTitle') }}</span>
                    <code class="markdown-preview">{{ plan.generatedMarkdownLink }}</code>
                </div>
            </div>
        </div>

        <div class="dialog-actions">
            <ElButton
                native-type="button"
                class="btn secondary"
                @click="$emit('cancel')"
            >{{ t('common.actions.cancel') }}</ElButton>
            <ElButton
                native-type="button"
                class="btn primary"
                :disabled="!plan?.valid || !canCommit"
                type="primary"
                @click="confirmConversion"
            >
                {{ t(canCommit ? 'common.actions.confirm' : 'admin.canvas.unavailable') }}
            </ElButton>
        </div>
    </FsusDialog>
</template>

<script setup lang="ts">
import { ElButton } from '@ozwasyd/element-plus';

import FsusDialog from '@/components/ui/FsusDialog.vue';
import { useI18nText } from '@/composables/useI18nText';
import { fsusDialogWidths } from '@/fsusui/dialog';
import type { EdgeToLinkPlan } from '@/services/authoringCanvasEdgeToLink';
const props = defineProps<{
    visible: boolean;
    plan: EdgeToLinkPlan | null;
    canCommit?: boolean;
}>();
const emit = defineEmits<{
    (e: 'cancel'): void;
    (e: 'confirm', plan: EdgeToLinkPlan): void;
}>();
const { t } = useI18nText();
function confirmConversion()
{
    if (props.plan?.valid && props.canCommit)
    {
        emit('confirm', props.plan);
    }
}
</script>



<style scoped>



.dialog-error-banner
 {
    background: var(--el-color-danger-light-9);
    color: var(--el-color-danger);
    padding: var(--fsus-space-3) var(--fsus-space-4);
    border-radius: var(--fsus-radius-panel);
    font-size: var(--el-font-size-base);
}

.plan-desc
 {
    margin: 0 0 var(--fsus-space-3) 0;
    font-size: var(--el-font-size-base);
    color: var(--el-text-color-secondary);
}

.plan-details
 {
    display: flex;
    flex-direction: column;
    gap: var(--fsus-space-2);
    background: var(--el-bg-color-page);
    border: 1px solid var(--el-border-color);
    border-radius: var(--fsus-radius-panel);
    padding: var(--fsus-space-3);
}

.plan-row
 {
    display: flex;
    align-items: center;
    gap: var(--fsus-space-2);
    font-size: var(--el-font-size-base);
}

.row-label
 {
    font-weight: 500;
    color: var(--el-text-color-secondary);
    min-width: 130px;
}

.row-value
 {
    color: var(--el-text-color-primary);
}

.markdown-preview
 {
    background: var(--el-border-color);
    padding: 0 var(--fsus-space-2);
    border-radius: var(--fsus-radius-panel);
    font-family: monospace;
    font-size: var(--el-font-size-base);
    color: var(--el-text-color-primary);
}

.dialog-actions
 {
    display: flex;
    justify-content: flex-end;
    gap: var(--fsus-space-2);
    margin-top: var(--fsus-space-2);
}




</style>
