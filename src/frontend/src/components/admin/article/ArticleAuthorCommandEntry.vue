<template>
    <FsusUiButton
        native-type="button"
        text
        aria-haspopup="dialog"
        aria-keyshortcuts="Control+P Meta+P"
        :disabled="!palette.available.value"
        @click="palette.open()"
    >
        {{ label }}
    </FsusUiButton>
</template>

<script setup lang="ts">
import type { useArticleAuthorCommandPalette } from '@/composables/useArticleAuthorCommandPalette';
import { FsusUiButton } from '@/fsusui/button';

defineProps<{
    palette: ReturnType<typeof useArticleAuthorCommandPalette>;
    label: string;
}>();
</script>
