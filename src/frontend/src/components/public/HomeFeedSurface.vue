<template>
  <div id="fsus-home-feed-layout" class="blog-page-shell flex flex-col lg:flex-row gap-10 lg:gap-16 xl:gap-20">
    <div id="fsus-home-main-column" class="grow lg:w-2/3">
      <slot name="main" />
    </div>

    <aside
      id="fsus-home-hot-articles-slot"
      class="hidden lg:block lg:w-80 shrink-0 space-y-10 xl:space-y-12 pt-8 lg:pt-0"
      aria-label="热门文章"
    >
      <slot name="aside">
        <div
          id="fsus-home-hot-articles-slot-content"
          class="public-aside-placeholder min-h-[18rem] rounded-[var(--fsus-radius-panel)] border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg)]/50"
          aria-hidden="true"
        />
      </slot>
    </aside>
  </div>
</template>

<script setup lang="ts">
</script>
