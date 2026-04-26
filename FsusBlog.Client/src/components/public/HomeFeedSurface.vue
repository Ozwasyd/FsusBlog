<template>
  <div class="fsus-page-shell flex flex-col lg:flex-row gap-10 lg:gap-16 xl:gap-20">
    <div class="grow lg:w-2/3">
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
</template>

<script setup lang="ts">
</script>
