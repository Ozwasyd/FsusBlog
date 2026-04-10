<template>
  <div class="aot-host" v-html="safeHtml" />
</template>

<script setup lang="ts">
import { computed, watch } from 'vue';
import { sanitizeAotHtml } from '@/utils/aotHtml';
import { emitTelemetry } from '@/services/telemetryService';

const props = defineProps<{
  html: unknown;
}>();

const normalizedHtml = computed(() => typeof props.html === 'string' ? props.html : '');
const safeHtml = computed(() => sanitizeAotHtml(normalizedHtml.value));

let lastSignature = '';

watch(
  () => normalizedHtml.value,
  (raw) => {
    if (!raw || raw.length === 0) {
      return;
    }

    const safe = sanitizeAotHtml(raw);
    const signature = `${raw.length}:${safe.length}:${safe.slice(0, 24)}`;
    if (signature === lastSignature) {
      return;
    }

    lastSignature = signature;
    if (!safe) {
      emitTelemetry('aot_html_blocked', { rawLength: raw.length }, 'warn');
      return;
    }

    emitTelemetry('aot_html_rendered', {
      rawLength: raw.length,
      safeLength: safe.length
    });
  },
  { immediate: true }
);
</script>
