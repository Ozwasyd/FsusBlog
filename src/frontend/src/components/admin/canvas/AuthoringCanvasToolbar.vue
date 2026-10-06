<template>
    <header
        class="canvas-toolbar"
        role="toolbar"
        :aria-label="t('admin.canvas.toolbar')"
    >
        <div class="toolbar-group">
            <ElButton
                native-type="button"
                class="toolbar-btn"
                :title="t('admin.canvas.note')"
                :aria-label="t('admin.canvas.note')"
                :disabled="disabled"
                @click="$emit('add-note')"
            >
                <span class="btn-text">{{ t('admin.canvas.note') }}</span>
            </ElButton>
            <ElButton
                native-type="button"
                class="toolbar-btn"
                :title="t('admin.canvas.reference')"
                :aria-label="t('admin.canvas.reference')"
                :disabled="disabled"
                @click="$emit('add-reference')"
            >
                <span class="btn-text">{{ t('admin.canvas.reference') }}</span>
            </ElButton>
            <ElButton
                native-type="button"
                class="toolbar-btn"
                :title="t('admin.canvas.frame')"
                :aria-label="t('admin.canvas.frame')"
                :disabled="disabled"
                @click="$emit('add-frame')"
            >
                <span class="btn-text">{{ t('admin.canvas.frame') }}</span>
            </ElButton>
        </div>

        <div class="toolbar-group">
            <ElButton
                :disabled="disabled || !canConnect"
                @click="$emit('connect-visual')"
            >{{ t('admin.canvas.connectVisual') }}</ElButton>
            <ElButton
                :disabled="disabled || !canConnect"
                @click="$emit('connect-reference')"
            >{{ t('admin.canvas.connectReference') }}</ElButton>
            <ElButton
                :disabled="disabled || !canConvert"
                @click="$emit('convert-selected')"
            >{{ t('admin.canvas.linkTitle') }}</ElButton>
        </div>
        <div
            class="toolbar-divider"
            role="separator"
            aria-orientation="vertical"
        ></div>

        <div class="toolbar-group">
            <ElButton
                native-type="button"
                class="toolbar-btn"
                :disabled="disabled || !canUndo"
                :title="t('admin.canvas.undo')"
                :aria-label="t('admin.canvas.undo')"
                @click="$emit('undo')"
            >
                <span class="btn-text">{{ t('admin.canvas.undo') }}</span>
            </ElButton>
            <ElButton
                native-type="button"
                class="toolbar-btn"
                :disabled="disabled || !canRedo"
                :title="t('admin.canvas.redo')"
                :aria-label="t('admin.canvas.redo')"
                @click="$emit('redo')"
            >
                <span class="btn-text">{{ t('admin.canvas.redo') }}</span>
            </ElButton>
            <ElButton
                native-type="button"
                class="toolbar-btn"
                type="danger"
                text
                :disabled="disabled || !hasSelection"
                :title="t('common.actions.delete')"
                :aria-label="t('common.actions.delete')"
                @click="$emit('delete-selected')"
            >
                <span class="btn-text">{{ t('common.actions.delete') }}</span>
            </ElButton>
        </div>

        <div
            class="toolbar-divider"
            role="separator"
            aria-orientation="vertical"
        ></div>

        <div class="toolbar-group">
            <ElButton
                native-type="button"
                class="toolbar-btn"
                :title="t('admin.canvas.zoomOut')"
                :aria-label="t('admin.canvas.zoomOut')"
                :disabled="disabled"
                @click="$emit('zoom-out')"
            >
                -
            </ElButton>
            <span
                class="zoom-indicator"
                aria-live="polite"
            >{{ Math.round(zoom * 100) }}%</span>
            <ElButton
                native-type="button"
                class="toolbar-btn"
                :title="t('admin.canvas.zoomIn')"
                :aria-label="t('admin.canvas.zoomIn')"
                :disabled="disabled"
                @click="$emit('zoom-in')"
            >
                +
            </ElButton>
            <ElButton
                native-type="button"
                class="toolbar-btn"
                :title="t('admin.canvas.reset')"
                :aria-label="t('admin.canvas.reset')"
                :disabled="disabled"
                @click="$emit('reset-zoom')"
            >
                {{ t('admin.canvas.reset') }}
            </ElButton>
        </div>

        <div
            class="toolbar-divider"
            role="separator"
            aria-orientation="vertical"
        ></div>

        <div class="toolbar-group right-group">
            <ElButton
                native-type="button"
                class="toolbar-btn mode-toggle"
                :class="{ active: viewMode === 'outline' }"
                :title="t(viewMode === 'canvas' ? 'admin.canvas.outline' : 'admin.canvas.canvas')"
                :aria-label="t(viewMode === 'canvas' ? 'admin.canvas.outline' : 'admin.canvas.canvas')"
                @click="$emit('toggle-view-mode')"
            >
                {{ t(viewMode === 'canvas' ? 'admin.canvas.outline' : 'admin.canvas.canvas') }}
            </ElButton>
            <ElButton
                native-type="button"
                class="toolbar-btn"
                :title="t('admin.canvas.exportPackage')"
                :aria-label="t('admin.canvas.exportPackage')"
                :disabled="disabled"
                @click="$emit('export-package')"
            >
                {{ t('admin.canvas.exportPackage') }}
            </ElButton>
            <ElButton
                native-type="button"
                class="toolbar-btn"
                :title="t('admin.canvas.importPackage')"
                :aria-label="t('admin.canvas.importPackage')"
                :disabled="disabled"
                @click="$emit('import-package')"
            >
                {{ t('admin.canvas.importPackage') }}
            </ElButton>
        </div>
    </header>
</template>

<script setup lang="ts">
import { ElButton } from '@ozwasyd/element-plus';

import { useI18nText } from '@/composables/useI18nText';
defineProps<{
    zoom: number;
    disabled?: boolean;
    canUndo: boolean;
    canRedo: boolean;
    hasSelection: boolean;
    canConnect?: boolean;
    canConvert?: boolean;
    viewMode: 'canvas' | 'outline';
}>();
defineEmits<{
    (e: 'connect-visual'): void;
    (e: 'connect-reference'): void;
    (e: 'convert-selected'): void;
    (e: 'add-note'): void;
    (e: 'add-reference'): void;
    (e: 'add-frame'): void;
    (e: 'undo'): void;
    (e: 'redo'): void;
    (e: 'delete-selected'): void;
    (e: 'zoom-in'): void;
    (e: 'zoom-out'): void;
    (e: 'reset-zoom'): void;
    (e: 'toggle-view-mode'): void;
    (e: 'export-package'): void;
    (e: 'import-package'): void;
}>();
const { t } = useI18nText();
</script>



<style scoped>
.canvas-toolbar
 {
    display: flex;
    align-items: center;
    gap: var(--fsus-space-2);
    padding: var(--fsus-space-2) var(--fsus-space-4);
    background: var(--el-bg-color-overlay);
    border-bottom: 1px solid var(--el-border-color);
    user-select: none;
    flex-wrap: wrap;
    z-index: 10;
}

.toolbar-group
 {
    display: flex;
    align-items: center;
    gap: var(--fsus-space-1);
    flex-wrap: wrap;
    min-width: 0;
}

.toolbar-divider
 {
    width: 1px;
    height: 24px;
    background: var(--el-border-color);
    margin: 0 var(--fsus-space-1);
}






.zoom-indicator
 {
    font-size: var(--el-font-size-base);
    font-variant-numeric: tabular-nums;
    min-width: 48px;
    text-align: center;
    color: var(--el-text-color-secondary);
}

.right-group
 {
    margin-left: auto;
}


</style>
