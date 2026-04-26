<template>
  <div id="fsus-aot-shell" :data-public-hydration-kind="hydrationKind">
    <div class="fsus-page-shell flex flex-col lg:flex-row gap-10 lg:gap-16 xl:gap-20">
      <div class="grow lg:w-2/3">
        <header class="mb-12 sm:mb-20">
          <h1 class="text-3xl sm:text-4xl font-bold text-[#0F0F11]">
            {{ siteTitleText }}<span class="text-[#A1A1AA]">.</span>
          </h1>
          <p class="mt-4 text-sm sm:text-base text-[#8E8E93] max-w-xl leading-relaxed">
            {{ siteDescriptionText }}
          </p>
        </header>

        <slot name="main" />
      </div>

      <aside class="hidden lg:block lg:w-80 shrink-0 space-y-10 xl:space-y-12 pt-8 lg:pt-0">
        <slot name="aside">
          <div
            class="public-aside-placeholder min-h-[18rem] rounded-[24px] border border-[#F4F4F5] bg-[#FCFCFC]/60"
            aria-hidden="true"
          />
        </slot>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  hydrationKind: 'Home' | 'ArticleDetail' | string;
  siteTitle?: string | null;
  siteDescription?: string | null;
}>();

const siteTitleText = computed(() => props.siteTitle?.trim() || 'Fsus');
const siteDescriptionText = computed(() => props.siteDescription?.trim() || '以极简形式呈现内容与思考。');
</script>
