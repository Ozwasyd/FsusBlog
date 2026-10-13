<template>
    <FsusUiButton
        text
        :disabled="disabled || pending || !intent"
        :loading="pending"
        :aria-pressed="membership === 'pinned'"
        data-pin-action="article-pin-toggle"
        @click="toggle"
    >
        {{ membership === 'pinned' ? '取消固定' : '固定' }}
    </FsusUiButton>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { FsusUiButton } from '@/fsusui/button';

import { createArticlePinToggleIntent, type ArticlePinDisplayBinding, type ArticlePinToggleIntent } from './articlePinPresentation';

const props = defineProps<{
    binding?: ArticlePinDisplayBinding;
    articleId: number;
    membership: 'pinned' | 'unpinned' | 'unknown';
    pinId: string | null;
    pending?: boolean;
    disabled?: boolean;
}>();
const emit = defineEmits<{ intent: [intent: ArticlePinToggleIntent]; }>();
const intent = computed(() => props.binding
    ? createArticlePinToggleIntent(props.binding, props.articleId, props.membership, props.pinId) : null);
function toggle(): void
{
    if (!props.disabled && !props.pending && intent.value)
    {
        emit('intent', intent.value);
    }
}
</script>
