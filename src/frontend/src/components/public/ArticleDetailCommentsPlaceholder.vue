<template>
  <div class="border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg)] p-10 sm:p-16 text-center">
    <h3 class="text-xl sm:text-2xl font-bold text-[var(--fsusblog-text-primary)] tracking-normal mb-4">
      {{ title }}
    </h3>
    <p
      v-if="body.trim()"
      class="text-sm sm:text-base text-[var(--fsusblog-text-tertiary)] leading-relaxed max-w-md mx-auto mb-8 font-light"
    >
      {{ body }}
    </p>
    <div
      v-if="hint.trim()"
      class="inline-block px-4 py-1 bg-[var(--fsusblog-panel-bg-soft)] text-[10px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]"
    >
      {{ hint }}
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  title: string;
  body: string;
  hint: string;
}>();
</script>
