<template>
  <section class="fsus-page-shell max-w-3xl mx-auto px-5 sm:px-8 min-h-screen">
    <div v-if="loading" class="space-y-10 sm:space-y-12 animate-pulse pl-5 sm:pl-10" aria-hidden="true">
      <div v-for="i in 3" :key="i" class="space-y-6">
        <div class="h-6 bg-[#F4F4F5] w-16"></div>
        <div class="space-y-4 border-l border-[#F4F4F5] pl-6">
          <div v-for="j in 3" :key="j" class="h-4 bg-[#FCFCFC] w-full"></div>
        </div>
      </div>
    </div>

    <div v-else class="relative pb-24">
      <header class="mb-12 sm:mb-16 pb-8 sm:pb-12 border-b border-[#F4F4F5]">
        <h1 class="text-3xl sm:text-5xl font-bold text-[#0F0F11] leading-tight sm:leading-snug mb-6">
          归档
        </h1>
        <div class="flex items-center gap-5 text-[11px] sm:text-xs font-mono font-medium text-[#A1A1AA] uppercase">
          <span>目前发布</span>
          <span class="text-[#D4D4D8] font-light" aria-hidden="true">/</span>
          <span class="text-[#0F0F11] font-bold tabular-nums">{{ archiveView.total }}</span>
        </div>
      </header>
      
      <div v-if="archiveView.yearGroups.length > 0" class="absolute left-4.5 top-5 bottom-0 w-px bg-[#E4E4E7] z-0"></div>

      <div class="space-y-14 sm:space-y-16">
        <section 
          v-for="(yearGroup, yearIndex) in archiveView.yearGroups" 
          :key="yearGroup.year" 
          class="relative animate-in slide-in-from-bottom-4 fade-in duration-700"
          :style="getYearSectionStyle(yearIndex)"
        >
          
          <div class="sticky top-20 z-10 bg-[var(--fsus-panel-bg)] py-3 mb-8 sm:mb-10 flex items-center">
            <div class="absolute left-0 w-9 h-9 bg-[var(--fsus-panel-bg)] flex items-center justify-center">
                <div class="w-2.5 h-2.5 rounded-full bg-[#0F0F11] ring-4 ring-white"></div>
            </div>
            <h2 class="text-2xl sm:text-4xl font-bold text-[#0F0F11] pl-10 sm:pl-12 font-mono">
              {{ yearGroup.year }}
            </h2>
          </div>

          <div class="space-y-10 sm:space-y-12 pl-8 sm:pl-12">
            <div 
              v-for="monthGroup in yearGroup.months" 
              :key="monthGroup.month"
              class="relative"
            >
              <h3 class="text-xs font-black text-[#A1A1AA] uppercase mb-6 flex items-center gap-6">
                {{ monthGroup.monthLabel }}
                <span class="h-px grow bg-[#F4F4F5]/80" aria-hidden="true"></span>
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
                      class="flex-none text-xs sm:text-sm font-mono text-[#A1A1AA] group-hover:text-[#2A599C] transition-colors w-12 tabular-nums"
                    >
                      {{ article.dayText }}
                    </time>
                    
                    <span class="safe-inline-wrap text-base sm:text-lg font-medium text-[#71717A] group-hover:text-[#2A599C] transition-colors leading-snug border-b border-transparent group-hover:border-[#2A599C] pb-0.5">
                      {{ article.title }}
                    </span>
                  </router-link>
                </article>
              </div>
            </div>
          </div>
        </section>
      </div>

      <div v-if="archiveView.yearGroups.length === 0" class="py-24 sm:py-32">
        <p class="text-[11px] font-mono text-[#D4D4D8] uppercase">
           {{ archiveView.emptyState.title }}
        </p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { useArchiveView } from '@/composables/useArchiveView'

const { loading, archiveView } = useArchiveView()
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
