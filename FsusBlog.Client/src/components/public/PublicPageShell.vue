<template>
  <div id="fsus-aot-shell" :data-public-hydration-kind="hydrationKind">
    <div class="flex flex-col lg:flex-row gap-12 lg:gap-24">
      <div class="grow lg:w-2/3">
        <header class="mb-12 sm:mb-20">
          <h1 class="text-3xl sm:text-4xl font-bold tracking-tight text-zinc-950">
            {{ siteTitleText }}<span class="text-zinc-400">.</span>
          </h1>
          <p class="mt-4 text-sm sm:text-base text-zinc-500 max-w-xl leading-relaxed">
            {{ siteDescriptionText }}
          </p>
        </header>

        <slot name="main" />
      </div>

      <aside class="hidden lg:block lg:w-80 shrink-0 space-y-16 pt-8 lg:pt-0">
        <slot name="aside">
          <section class="public-aside-placeholder rounded-3xl border border-zinc-100 bg-zinc-50/60 px-6 py-8" aria-hidden="true">
            <h2 class="text-xs font-bold tracking-[0.2em] text-zinc-400 uppercase mb-8">热门文章</h2>
            <div class="space-y-6">
              <div v-for="i in 5" :key="i" class="flex items-start gap-4">
                <div class="w-6 text-sm font-mono text-zinc-200">0{{ i }}</div>
                <div class="flex-1 space-y-2 pt-0.5">
                  <div class="h-3 rounded-sm bg-zinc-100"></div>
                  <div class="h-3 w-2/3 rounded-sm bg-zinc-100/90"></div>
                </div>
              </div>
            </div>
          </section>
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
