<template>
    <header class="canvas-toolbar" role="toolbar" aria-label="Canvas operations toolbar">
        <div class="toolbar-group">
            <button
                type="button"
                class="toolbar-btn"
                title="Add Plain Text Note"
                aria-label="Add Plain Text Note"
                @click="$emit('add-note')"
            >
                <span class="btn-icon">📝</span>
                <span class="btn-text">Note</span>
            </button>
            <button
                type="button"
                class="toolbar-btn"
                title="Add Article Reference"
                aria-label="Add Article Reference"
                @click="$emit('add-reference')"
            >
                <span class="btn-icon">📄</span>
                <span class="btn-text">Reference</span>
            </button>
            <button
                type="button"
                class="toolbar-btn"
                title="Add Group Frame"
                aria-label="Add Group Frame"
                @click="$emit('add-frame')"
            >
                <span class="btn-icon">🔲</span>
                <span class="btn-text">Frame</span>
            </button>
        </div>

        <div class="toolbar-divider" role="separator" aria-orientation="vertical"></div>

        <div class="toolbar-group">
            <button
                type="button"
                class="toolbar-btn"
                :disabled="!canUndo"
                title="Undo (Ctrl+Z)"
                aria-label="Undo"
                @click="$emit('undo')"
            >
                <span class="btn-icon">↩</span>
                <span class="btn-text">Undo</span>
            </button>
            <button
                type="button"
                class="toolbar-btn"
                :disabled="!canRedo"
                title="Redo (Ctrl+Y)"
                aria-label="Redo"
                @click="$emit('redo')"
            >
                <span class="btn-icon">↪</span>
                <span class="btn-text">Redo</span>
            </button>
            <button
                type="button"
                class="toolbar-btn danger"
                :disabled="!hasSelection"
                title="Delete Selected (Delete)"
                aria-label="Delete Selected"
                @click="$emit('delete-selected')"
            >
                <span class="btn-icon">🗑</span>
                <span class="btn-text">Delete</span>
            </button>
        </div>

        <div class="toolbar-divider" role="separator" aria-orientation="vertical"></div>

        <div class="toolbar-group">
            <button
                type="button"
                class="toolbar-btn"
                title="Zoom Out"
                aria-label="Zoom Out"
                @click="$emit('zoom-out')"
            >
                -
            </button>
            <span class="zoom-indicator" aria-live="polite">{{ Math.round(zoom * 100) }}%</span>
            <button
                type="button"
                class="toolbar-btn"
                title="Zoom In"
                aria-label="Zoom In"
                @click="$emit('zoom-in')"
            >
                +
            </button>
            <button
                type="button"
                class="toolbar-btn"
                title="Reset Viewport"
                aria-label="Reset Viewport"
                @click="$emit('reset-zoom')"
            >
                Reset
            </button>
        </div>

        <div class="toolbar-divider" role="separator" aria-orientation="vertical"></div>

        <div class="toolbar-group right-group">
            <button
                type="button"
                class="toolbar-btn mode-toggle"
                :class="{ active: viewMode === 'outline' }"
                :title="viewMode === 'canvas' ? 'Switch to Outline View' : 'Switch to Canvas View'"
                :aria-label="viewMode === 'canvas' ? 'Switch to Outline View' : 'Switch to Canvas View'"
                @click="$emit('toggle-view-mode')"
            >
                {{ viewMode === 'canvas' ? '📋 Outline' : '🗺 Canvas' }}
            </button>
            <button
                type="button"
                class="toolbar-btn"
                title="Export Portable Package"
                aria-label="Export Portable Package"
                @click="$emit('export-package')"
            >
                Export
            </button>
            <button
                type="button"
                class="toolbar-btn"
                title="Import Portable Package"
                aria-label="Import Portable Package"
                @click="$emit('import-package')"
            >
                Import
            </button>
        </div>
    </header>
</template>

<script setup lang="ts">
defineProps<{
    zoom: number;
    canUndo: boolean;
    canRedo: boolean;
    hasSelection: boolean;
    viewMode: 'canvas' | 'outline';
}>();

defineEmits<{
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
</script>

<style scoped>
.canvas-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    background: var(--fsus-bg-color-overlay, #ffffff);
    border-bottom: 1px solid var(--fsus-border-color, #e2e8f0);
    user-select: none;
    flex-wrap: wrap;
    z-index: 10;
}

.toolbar-group {
    display: flex;
    align-items: center;
    gap: 4px;
}

.toolbar-divider {
    width: 1px;
    height: 24px;
    background: var(--fsus-border-color, #e2e8f0);
    margin: 0 4px;
}

.toolbar-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    font-size: 13px;
    font-weight: 500;
    color: var(--fsus-text-color-primary, #1e293b);
    background: var(--fsus-fill-color-light, #f1f5f9);
    border: 1px solid var(--fsus-border-color-lighter, #cbd5e1);
    border-radius: 6px;
    cursor: pointer;
    transition: background-color 0.15s ease, border-color 0.15s ease;
}

.toolbar-btn:hover:not(:disabled) {
    background: var(--fsus-fill-color, #e2e8f0);
    border-color: var(--fsus-border-color, #94a3b8);
}

.toolbar-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}

.toolbar-btn.danger:hover:not(:disabled) {
    background: #fee2e2;
    border-color: #fca5a5;
    color: #b91c1c;
}

.toolbar-btn.mode-toggle.active {
    background: var(--fsus-color-primary, #3b82f6);
    color: #ffffff;
    border-color: var(--fsus-color-primary-dark, #2563eb);
}

.zoom-indicator {
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    min-width: 48px;
    text-align: center;
    color: var(--fsus-text-color-secondary, #64748b);
}

.right-group {
    margin-left: auto;
}

@media (max-width: 640px) {
    .btn-text {
        display: none;
    }
    .canvas-toolbar {
        padding: 6px 8px;
        gap: 4px;
    }
}
</style>
