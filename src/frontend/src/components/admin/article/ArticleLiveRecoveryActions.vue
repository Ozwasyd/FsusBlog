<template>
    <div
        v-if="visible"
        class="article-live-recovery-actions"
        :aria-busy="busy || undefined"
    >
        <span
            role="status"
            aria-live="polite"
            class="article-live-recovery-actions__status"
        >{{ message }}</span>
        <FsusUiButton
            v-if="canEscape"
            text
            :disabled="busy"
            @click="emit('escape')"
        >{{ messages.escape }}</FsusUiButton>
        <FsusUiButton
            v-if="canRecover"
            text
            :disabled="busy"
            :loading="busy"
            @click="emit('recover')"
        >{{ messages.recover }}</FsusUiButton>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { FsusUiButton } from '@/fsusui/button';
import type { ArticleEditorSurfaceRuntimeState } from '@/services/authoring/articleEditorSurfaceRuntime';

type MessageKey = Exclude<ArticleEditorSurfaceRuntimeState['reason'], null> | 'escaped' | 'escape' | 'recover';
const props = defineProps<{
    state: ArticleEditorSurfaceRuntimeState;
    messages: Readonly<Record<MessageKey, string>>;
    busy: boolean;
}>();
const emit = defineEmits<{
    (event: 'escape'): void;
    (event: 'recover'): void;
}>();
const visible = computed(() => props.state.documentCurrent && props.state.preference.surface === 'live' && (props.state.reason !== null || props.state.escaped));
const message = computed(() => props.state.escaped ? props.messages.escaped : props.state.reason === null ? '' : props.messages[props.state.reason]);
const canEscape = computed(() => props.state.reason === 'feature-degraded' && !props.state.escaped && props.state.desiredSurface === 'live');
const canRecover = computed(() => props.state.desiredSurface === 'source' && props.state.reason !== 'capability-pending');
</script>

<style scoped>
.article-live-recovery-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
}

.article-live-recovery-actions__status {
    min-width: 0;
    overflow-wrap: anywhere;
}
</style>
