<template>
  <div class="max-w-3xl mx-auto px-6 sm:px-8 min-h-screen">
    
    <header class="mb-12 sm:mb-16 pb-8 sm:pb-12 border-b border-zinc-100">
      <h1 class="text-3xl sm:text-5xl font-bold text-zinc-950 leading-tight sm:leading-snug mb-6">
        归档
      </h1>
      <div class="flex items-center gap-3 text-[11px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase">
        <span>目前发布</span>
        <span class="text-zinc-300 font-light">/</span>
        <span class="text-zinc-950 font-bold">{{ total }}</span>
      </div>
    </header>

    <div v-if="loading" class="space-y-12 animate-pulse pl-8 sm:pl-10">
      <div v-for="i in 3" :key="i" class="space-y-6">
        <div class="h-6 bg-zinc-100 w-16"></div>
        <div class="space-y-4 border-l border-zinc-100 pl-6">
          <div v-for="j in 3" :key="j" class="h-4 bg-zinc-50 w-full"></div>
        </div>
      </div>
    </div>

    <div v-else class="relative pb-24">
      
      <div v-if="articles.length > 0" class="absolute left-4.5 top-3 bottom-0 w-px bg-zinc-200"></div>

      <div class="space-y-20">
        <section 
          v-for="(year, yearIndex) in sortedYears" 
          :key="year" 
          class="relative animate-in slide-in-from-bottom-4 fade-in duration-700"
          :style="{ animationDelay: `${yearIndex * 100}ms` }"
        >
          
          <div class="sticky top-20 z-10 bg-white py-3 mb-10 flex items-center">
            <div class="absolute left-0 w-9 h-9 bg-white flex items-center justify-center">
                <div class="w-2.5 h-2.5 rounded-full bg-zinc-950 ring-4 ring-white"></div>
            </div>
            <h2 class="text-3xl sm:text-4xl font-bold text-zinc-950 pl-12 font-mono tracking-tighter">
              {{ year }}
            </h2>
          </div>

          <div class="space-y-14 pl-12">
            <div 
              v-for="month in getSortedMonths(year)" 
              :key="month"
              class="relative"
            >
              <h3 class="text-xs font-black tracking-[0.3em] text-zinc-400 uppercase mb-6 flex items-center gap-4">
                {{ formatMonthName(month) }}
                <span class="h-px grow bg-zinc-100/80"></span>
              </h3>

              <div class="space-y-6">
                <article 
                  v-for="article in (archiveGroups[year]?.[month] || [])" 
                  :key="article.id"
                  class="relative group"
                >
                  <router-link 
                    :to="`/article/${article.id}`"
                    class="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-6 group py-1 sm:py-0"
                  >
                    <time 
                      :datetime="article.createTime"
                      :title="TimeUtils.toFullLocalString(article.createTime)"
                      class="flex-none text-xs sm:text-sm font-mono text-zinc-400 group-hover:text-zinc-950 transition-colors w-12"
                    >
                      {{ formatDay(article.createTime) }}
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
    </div>

    <div v-if="!loading && articles.length === 0" class="py-32 text-center">
        <p class="text-[11px] font-mono text-zinc-300 uppercase tracking-widest">
           无文章。
        </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { getArticles, type ArticleListItem } from '@/api/article'
import { TimeUtils } from '@/utils/time'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'

dayjs.extend(utc)

const articles = ref<ArticleListItem[]>([])
const loading = ref(true)
const total = ref(0)

/**
 * 核心逻辑：按年和月进行双层分组
 * 性能最大化：单次循环完成映射构造
 */
const archiveGroups = computed(() => {
  const groups: Record<string, Record<string, ArticleListItem[]>> = {}
  
  articles.value.forEach(article => {
    // 逻辑自洽：使用本地时间进行年份和月份的提取
    const localTime = dayjs.utc(article.createTime).local()
    const year = localTime.year().toString()
    const month = localTime.format('MM')
    
    if (!groups[year]) {
      groups[year] = {}
    }
    if (!groups[year][month]) {
      groups[year][month] = []
    }
    groups[year][month].push(article)
  })
  
  return groups
})

/**
 * 获取排序后的年份列表 (降序)
 */
const sortedYears = computed(() => {
  return Object.keys(archiveGroups.value).sort((a, b) => Number(b) - Number(a))
})

/**
 * 获取指定年份下排序后的月份列表 (降序)
 */
const getSortedMonths = (year: string) => {
  const yearGroup = archiveGroups.value[year]
  return yearGroup ? Object.keys(yearGroup).sort((a, b) => Number(b) - Number(a)) : []
}

/**
 * 转换月份显示格式 (例如: 05 -> May)
 */
const formatMonthName = (monthStr: string) => {
  return dayjs().month(Number(monthStr) - 1).format('MMMM')
}

/**
 * 格式化日期：仅保留日
 */
const formatDay = (dateStr: string) => {
  if (!dateStr) return ''
  return dayjs.utc(dateStr).local().format('DD')
}

const loadArticles = async () => {
  loading.value = true
  try {
    const res = await getArticles({ page: 1, size: 200 })
    articles.value = res.items
    total.value = res.total
  } catch (error) {
    console.error('[Archive] 无法加载文章列表:', error)
  } finally {
    loading.value = false
  }
}

onMounted(loadArticles)
</script>

<style scoped>
@reference "@/assets/main.css";

@media (max-width: 640px) {
  .sticky {
    top: 64px;
  }
  .leading-snug {
    line-height: 1.4;
  }
}

.group:hover {
  transform: translateX(2px);
  transition: transform 0.3s ease;
}
</style>