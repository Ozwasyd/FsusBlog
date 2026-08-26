<template>
    <div v-if="visible" class="dialog-overlay" role="dialog" aria-modal="true" aria-labelledby="link-dialog-title">
        <div class="dialog-content">
            <h3 id="link-dialog-title" class="dialog-title">Convert Canvas Edge to Article Link</h3>

            <div v-if="!plan?.valid" class="dialog-error-banner">
                {{ plan?.reason || 'Invalid edge conversion plan' }}
            </div>

            <div v-else class="dialog-plan-body">
                <p class="plan-desc">
                    You are converting an explicit canvas reference into a Markdown link.
                </p>

                <div class="plan-details">
                    <div class="plan-row">
                        <span class="row-label">Source Node:</span>
                        <span class="row-value">{{ plan.sourceNodeId }}</span>
                    </div>
                    <div class="plan-row">
                        <span class="row-label">Target Article:</span>
                        <span class="row-value">{{ plan.targetTitle || `Article #${plan.targetArticleId}` }}</span>
                    </div>
                    <div class="plan-row">
                        <span class="row-label">Generated Markdown:</span>
                        <code class="markdown-preview">{{ plan.generatedMarkdownLink }}</code>
                    </div>
                </div>
            </div>

            <div class="dialog-actions">
                <button type="button" class="btn secondary" @click="$emit('cancel')">Cancel</button>
                <button
                    type="button"
                    class="btn primary"
                    :disabled="!plan?.valid"
                    @click="$emit('confirm', plan)"
                >
                    Confirm & Copy Link
                </button>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import type { EdgeToLinkPlan } from '@/services/authoringCanvasEdgeToLink';

defineProps<{
    visible: boolean;
    plan: EdgeToLinkPlan | null;
}>();

defineEmits<{
    (e: 'cancel'): void;
    (e: 'confirm', plan: EdgeToLinkPlan): void;
}>();
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
    max-width: 480px;
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

.dialog-error-banner {
    background: #fee2e2;
    color: #b91c1c;
    padding: 10px 14px;
    border-radius: 6px;
    font-size: 13px;
}

.plan-desc {
    margin: 0 0 12px 0;
    font-size: 13px;
    color: #475569;
}

.plan-details {
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    padding: 12px;
}

.plan-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
}

.row-label {
    font-weight: 500;
    color: #64748b;
    min-width: 130px;
}

.row-value {
    color: #1e293b;
}

.markdown-preview {
    background: #e2e8f0;
    padding: 2px 6px;
    border-radius: 4px;
    font-family: monospace;
    font-size: 12px;
    color: #0f172a;
}

.dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 8px;
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
