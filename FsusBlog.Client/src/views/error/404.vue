<template>
  <div class="min-h-[75vh] flex items-center justify-center px-6 sm:px-8 subpixel-antialiased">
    
    <div class="flex flex-col sm:flex-row items-center gap-10 sm:gap-16 animate-in fade-in duration-1000">
      
      <h1 class="text-7xl sm:text-9xl font-extrabold tracking-tighter text-zinc-950">
        404<span class="text-zinc-200">.</span>
      </h1>
      
      <div class="hidden sm:block w-px h-24 bg-zinc-200"></div>
      <div class="sm:hidden w-16 h-px bg-zinc-200"></div>
      
      <div class="flex flex-col items-center sm:items-start text-center sm:text-left">
        
        <h2 class="text-[10px] sm:text-xs font-mono font-bold tracking-[0.3em] text-zinc-400 uppercase mb-4">
          Page Not Found
        </h2>
        
        <p class="text-sm text-zinc-500 leading-relaxed max-w-65 mb-10">
          抱歉，你所寻找的资源已移动、删除或从未存在。
        </p>
        
        <router-link 
          to="/" 
          class="group inline-flex items-center gap-3 text-[10px] sm:text-xs font-bold tracking-[0.2em] uppercase text-zinc-950 hover:text-zinc-500 transition-colors"
        >
          <span class="group-hover:-translate-x-1 transition-transform duration-300">←</span>
          回到主页
        </router-link>
        
      </div>
      
    </div>
  </div>
</template>

<style scoped>
@reference "@/assets/main.css";
</style>