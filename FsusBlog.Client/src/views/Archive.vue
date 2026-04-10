<template>
  <div class="max-w-3xl mx-auto px-6 sm:px-8 min-h-screen">
    <div v-if="loading && !shouldDelayLoadingSkeleton" class="space-y-12 animate-pulse pl-8 sm:pl-10" aria-hidden="true">
      <div v-for="i in 3" :key="i" class="space-y-6">
        <div class="h-6 bg-zinc-100 w-16"></div>
        <div class="space-y-4 border-l border-zinc-100 pl-6">
          <div v-for="j in 3" :key="j" class="h-4 bg-zinc-50 w-full"></div>
        </div>
      </div>
    </div>

    <AotHost
      v-else-if="shouldRenderAotHtml"
      class="aot-archive-page"
      :html="aotRenderedHtml"
    />

    <div v-else class="relative pb-24">
      <header class="mb-12 sm:mb-16 pb-8 sm:pb-12 border-b border-zinc-100">
        <h1 class="text-3xl sm:text-5xl font-bold text-zinc-950 leading-tight sm:leading-snug mb-6">
          归档
        </h1>
        <div class="flex items-center gap-3 text-[11px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase">
          <span>目前发布</span>
          <span class="text-zinc-300 font-light" aria-hidden="true">/</span>
          <span class="text-zinc-950 font-bold tabular-nums">{{ archiveView.total }}</span>
        </div>
      </header>
      
      <!-- 物理时间线 -->
      <div v-if="archiveView.yearGroups.length > 0" class="absolute left-4.5 top-3 bottom-0 w-px bg-zinc-200 z-0"></div>

      <div class="space-y-20">
        <!-- [修复 2026-02-23] 逻辑自洽：直接遍历预排好序的渲染专用数组 -->
        <section 
          v-for="(yearGroup, yearIndex) in archiveView.yearGroups" 
          :key="yearGroup.year" 
          class="relative animate-in slide-in-from-bottom-4 fade-in duration-700"
          :style="getYearSectionStyle(yearIndex)"
        >
          
          <!-- 年份标题 -->
          <div class="sticky top-20 z-10 bg-white py-3 mb-10 flex items-center">
            <div class="absolute left-0 w-9 h-9 bg-white flex items-center justify-center">
                <div class="w-2.5 h-2.5 rounded-full bg-zinc-950 ring-4 ring-white"></div>
            </div>
            <h2 class="text-3xl sm:text-4xl font-bold text-zinc-950 pl-12 font-mono tracking-tighter">
              {{ yearGroup.year }}
            </h2>
          </div>

          <div class="space-y-14 pl-12">
            <div 
              v-for="monthGroup in yearGroup.months" 
              :key="monthGroup.month"
              class="relative"
            >
              <h3 class="text-xs font-black tracking-[0.3em] text-zinc-400 uppercase mb-6 flex items-center gap-4">
                {{ monthGroup.monthLabel }}
                <span class="h-px grow bg-zinc-100/80" aria-hidden="true"></span>
              </h3>

              <div class="space-y-6">
                <article 
                  v-for="article in monthGroup.items" 
                  :key="article.id"
                  class="relative group"
                >
                  <router-link 
                    :to="article.route"
                    class="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-6 group py-1 sm:py-0 outline-none"
                  >
                    <time 
                      :datetime="article.createTime"
                      :title="article.fullLocalTimeText"
                      class="flex-none text-xs sm:text-sm font-mono text-zinc-400 group-hover:text-zinc-950 transition-colors w-12 tabular-nums"
                    >
                      {{ article.dayText }}
                    </time>
                    
                    <span class="text-base sm:text-lg font-medium text-zinc-600 group-hover:text-zinc-950 transition-colors leading-snug border-b border-transparent group-hover:border-zinc-950 pb-0.5">
                      {{ article.title }}
                    </span>
                  </router-link>
                </article>
              </div>
            </div>
          </div>
        </section>
      </div>

      <div v-if="archiveView.yearGroups.length === 0" class="py-32 text-center">
        <p class="text-[11px] font-mono text-zinc-300 uppercase tracking-widest">
           {{ archiveView.emptyState.title }}
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import AotHost from '@/components/AotHost.vue'
import { useArchiveView } from '@/composables/useArchiveView'
const { loading, archiveView, aotRenderedHtml, shouldRenderAotHtml, shouldDelayLoadingSkeleton } = useArchiveView()
const getYearSectionStyle = (yearIndex: number) => ({ '--stagger': yearIndex })
</script>

<style scoped>
@reference "@/assets/main.css";

.animate-in {
  animation-delay: calc(var(--stagger, 0) * 80ms);
}

@media (max-width: 640px) {
  .sticky { top: 64px; }
}

@media (hover: hover) {
  .group {
    will-change: transform;
    transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .group:hover { transform: translateX(4px); }
}

.tabular-nums { font-variant-numeric: tabular-nums; }
</style>
