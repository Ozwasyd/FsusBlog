<template>
  <div class="fsus-page-shell min-h-[75vh] bg-[#F7F7F8] px-5 py-16 text-[#0F0F11] subpixel-antialiased dark:bg-[#0F0F11] dark:text-[#FCFCFC] sm:px-8 sm:py-20">
    <section class="mx-auto flex w-full max-w-5xl flex-col gap-8 animate-in fade-in duration-700 sm:gap-12">
      <h1 class="text-6xl font-extrabold leading-none text-[#0F0F11] sm:text-9xl dark:text-[#FCFCFC]">
        404<span class="text-[#A1A1AA]">.</span>
      </h1>

      <div class="h-px w-full max-w-2xl bg-[#E4E4E7] dark:bg-[#27272A]"></div>

      <div class="safe-inline-wrap max-w-xl">
        <h2 class="text-2xl font-extrabold leading-tight text-[#0F0F11] sm:text-4xl dark:text-[#FCFCFC]">
          页面未找到
        </h2>
        <p class="mt-4 text-sm leading-7 text-[#52525B] dark:text-[#A1A1AA]">
          抱歉，你所寻找的资源已移动、删除或从未存在。
        </p>

        <router-link
          to="/"
          class="mt-10 inline-flex min-h-11 w-full items-center justify-center rounded-[8px] bg-[#0F0F11] px-5 text-sm font-bold text-white shadow-[0_32px_64px_rgba(0,0,0,0.08)] transition-colors hover:bg-[#2A599C] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#F7F7F8] dark:bg-[#FCFCFC] dark:text-[#0F0F11] dark:hover:bg-[#7EA7E0] dark:focus-visible:ring-[#7EA7E0] dark:focus-visible:ring-offset-[#0F0F11] sm:w-auto"
        >
          回到主页
        </router-link>
      </div>
    </section>
  </div>
</template>

<style scoped>
@reference "@/assets/main.css";
</style>
