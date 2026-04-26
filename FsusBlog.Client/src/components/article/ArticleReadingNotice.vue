<template>
  <section
    v-if="visible"
    class="mt-6 sm:mt-8 rounded-[var(--fsus-radius-xl)] border border-[#E4E4E7]/80 bg-[#FCFCFC]/90 px-4 py-4 sm:px-5 sm:py-4 text-[#3F3F46] dark:border-[#27272A] dark:bg-[#18181B]/80 dark:text-[#E4E4E7]"
    aria-label="阅读前提示"
  >
    <div class="flex items-start gap-5">
      <span class="mt-0.5 text-[10px] font-black uppercase text-[#8E8E93] dark:text-[#A1A1AA]">
        Read
      </span>
      <p class="text-sm leading-7 sm:text-[15px] sm:leading-8">
        {{ label }}
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
defineProps<{
  visible: boolean;
  label: string;
}>()
</script>
