<template>
    <div v-if="visible" class="dialog-overlay" role="dialog" aria-modal="true" aria-labelledby="pkg-dialog-title">
        <div class="dialog-content">
            <h3 id="pkg-dialog-title" class="dialog-title">
                {{ mode === 'export' ? 'Export Portable Canvas Package' : 'Import Portable Canvas Package' }}
            </h3>

            <!-- Export Mode -->
            <template v-if="mode === 'export'">
                <p class="dialog-desc">
                    Canvas package includes notes, references, geometry, and portable manifests without copying article bodies.
                </p>
                <textarea
                    readonly
                    class="package-textarea"
                    :value="exportContent"
                    aria-label="Exported Package JSON"
                ></textarea>
                <div class="dialog-actions">
                    <button type="button" class="btn secondary" @click="$emit('close')">Close</button>
                    <button type="button" class="btn primary" @click="handleCopyExport">Copy Package JSON</button>
                </div>
            </template>

            <!-- Import Mode -->
            <template v-else>
                <div v-if="!importPlan">
                    <p class="dialog-desc">
                        Paste an <code>authoring-canvas</code> JSON package to inspect and safely import.
                    </p>
                    <textarea
                        v-model="importInput"
                        class="package-textarea"
                        placeholder="Paste package JSON here..."
                        aria-label="Paste Package JSON"
                    ></textarea>
                    <div v-if="importError" class="dialog-error-banner">{{ importError }}</div>
                    <div class="dialog-actions">
                        <button type="button" class="btn secondary" @click="$emit('close')">Cancel</button>
                        <button type="button" class="btn primary" :disabled="!importInput.trim()" @click="handleValidateAndPlan">
                            Inspect Package
                        </button>
                    </div>
                </div>

                <div v-else class="import-plan-view">
                    <div class="plan-summary">
                        <h4>Package: {{ importPlan.package.manifest.title }}</h4>
                        <p>Nodes: {{ importPlan.package.manifest.counts.nodes }} | Edges: {{ importPlan.package.manifest.counts.edges }}</p>
                        <p>Resolved References: {{ importPlan.resolvedCount }} | Unresolved: {{ importPlan.unresolvedCount }}</p>
                    </div>

                    <div v-if="importPlan.unresolvedCount > 0" class="unresolved-list">
                        <h5>Unresolved References Decision</h5>
                        <div v-for="item in importPlan.reResolutionItems" :key="item.nodeId" class="unresolved-item">
                            <span v-if="item.status !== 'resolved'">
                                Node {{ item.nodeId }} (Article #{{ item.targetArticleId }}):
                                <select v-model="unresolvedDecisions[item.nodeId]" class="decision-select">
                                    <option value="leave-broken">Leave Reference Broken</option>
                                    <option value="remove-node">Remove Node & Edges</option>
                                </select>
                            </span>
                        </div>
                    </div>

                    <div class="dialog-actions">
                        <button type="button" class="btn secondary" @click="importPlan = null">Back</button>
                        <button type="button" class="btn primary" @click="handleExecuteImport">
                            Execute Safe Import
                        </button>
                    </div>
                </div>
            </template>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type {
    AuthoringCanvasImportPlan,
    UnresolvedDecisionAction
} from '@/services/authoringCanvasPackage';
import {
    planCanvasPackageImport,
    validateAndParseCanvasPackage
} from '@/services/authoringCanvasPackage';

const props = defineProps<{
    visible: boolean;
    mode: 'export' | 'import';
    exportContent?: string;
}>();

const emit = defineEmits<{
    (e: 'close'): void;
    (e: 'execute-import', plan: AuthoringCanvasImportPlan, decisions: Record<string, { action: UnresolvedDecisionAction }>): void;
}>();

const importInput = ref('');
const importError = ref<string | null>(null);
const importPlan = ref<AuthoringCanvasImportPlan | null>(null);
const unresolvedDecisions = ref<Record<string, UnresolvedDecisionAction>>({});

async function handleValidateAndPlan() {
    importError.value = null;
    const validation = validateAndParseCanvasPackage(importInput.value);
    if (!validation.valid || !validation.package) {
        importError.value = validation.error || 'Invalid canvas package';
        return;
    }

    try {
        const plan = await planCanvasPackageImport(validation.package);
        importPlan.value = plan;
        // Default decisions for unresolved items
        const decisions: Record<string, UnresolvedDecisionAction> = {};
        for (const item of plan.reResolutionItems) {
            if (item.status !== 'resolved') {
                decisions[item.nodeId] = 'leave-broken';
            }
        }
        unresolvedDecisions.value = decisions;
    } catch (err: unknown) {
        importError.value = err instanceof Error ? err.message : String(err);
    }
}

function handleExecuteImport() {
    if (!importPlan.value) return;
    const decisions: Record<string, { action: UnresolvedDecisionAction }> = {};
    for (const [nodeId, action] of Object.entries(unresolvedDecisions.value)) {
        decisions[nodeId] = { action };
    }
    emit('execute-import', importPlan.value, decisions);
    importPlan.value = null;
    importInput.value = '';
}

function handleCopyExport() {
    if (props.exportContent) {
        void navigator.clipboard?.writeText(props.exportContent);
    }
}
</script>

<style scoped>
.dialog-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background: rgba(15, 23, 42, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
}

.dialog-content {
    background: #ffffff;
    border-radius: 8px;
    width: 90%;
    max-width: 580px;
    padding: 24px;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.15);
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.dialog-title {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: #1e293b;
}

.dialog-desc {
    margin: 0;
    font-size: 13px;
    color: #475569;
}

.package-textarea {
    width: 100%;
    height: 180px;
    font-family: monospace;
    font-size: 12px;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    padding: 8px;
    box-sizing: border-box;
    resize: none;
}

.dialog-error-banner {
    background: #fee2e2;
    color: #b91c1c;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 13px;
}

.plan-summary {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    padding: 12px;
    font-size: 13px;
}

.plan-summary h4 {
    margin: 0 0 6px 0;
}

.plan-summary p {
    margin: 0 0 4px 0;
    color: #64748b;
}

.unresolved-list {
    margin-top: 12px;
    font-size: 13px;
}

.unresolved-item {
    margin-bottom: 6px;
}

.decision-select {
    margin-left: 6px;
    padding: 2px 6px;
    font-size: 12px;
    border-radius: 4px;
    border: 1px solid #cbd5e1;
}

.dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
}

.btn {
    padding: 8px 16px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
}

.btn.secondary {
    background: #f1f5f9;
    border: 1px solid #cbd5e1;
    color: #475569;
}

.btn.primary {
    background: #3b82f6;
    border: 1px solid #2563eb;
    color: #ffffff;
}

.btn.primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}
</style>
