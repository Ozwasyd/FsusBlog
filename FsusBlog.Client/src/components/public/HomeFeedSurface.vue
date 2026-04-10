<template>
  <div class="flex flex-col lg:flex-row gap-12 lg:gap-24">
    <div class="grow lg:w-2/3">
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
</template>

<script setup lang="ts">
</script>
