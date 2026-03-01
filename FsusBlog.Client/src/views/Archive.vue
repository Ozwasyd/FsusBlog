<template>
  <div class="max-w-3xl mx-auto px-6 sm:px-8 min-h-screen">
    
    <header class="mb-12 sm:mb-16 pb-8 sm:pb-12 border-b border-zinc-100">
      <h1 class="text-3xl sm:text-5xl font-bold text-zinc-950 leading-tight sm:leading-snug mb-6">
        归档
      </h1>
      <div class="flex items-center gap-3 text-[11px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase">
        <span>目前发布</span>
        <span class="text-zinc-300 font-light" aria-hidden="true">/</span>
        <span class="text-zinc-950 font-bold tabular-nums">{{ total }}</span>
      </div>
    </header>

    <!-- 加载骨架屏 -->
    <div v-if="loading" class="space-y-12 animate-pulse pl-8 sm:pl-10" aria-hidden="true">
      <div v-for="i in 3" :key="i" class="space-y-6">
        <div class="h-6 bg-zinc-100 w-16"></div>
        <div class="space-y-4 border-l border-zinc-100 pl-6">
          <div v-for="j in 3" :key="j" class="h-4 bg-zinc-50 w-full"></div>
        </div>
      </div>
    </div>

    <div v-else class="relative pb-24">
      
      <!-- 物理时间线 -->
      <div v-if="renderData.length > 0" class="absolute left-4.5 top-3 bottom-0 w-px bg-zinc-200 z-0"></div>

      <div class="space-y-20">
        <!-- [修复 2026-02-23] 逻辑自洽：直接遍历预排好序的渲染专用数组 -->
        <section 
          v-for="(yearGroup, yearIndex) in renderData" 
          :key="yearGroup.year" 
          class="relative animate-in slide-in-from-bottom-4 fade-in duration-700"
          :style="{ '--stagger': yearIndex }"
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
                {{ formatMonthName(monthGroup.month) }}
                <span class="h-px grow bg-zinc-100/80" aria-hidden="true"></span>
              </h3>

              <div class="space-y-6">
                <article 
                  v-for="article in monthGroup.items" 
                  :key="article.id"
                  class="relative group"
                >
                  <router-link 
                    :to="{ name: 'ArticleDetail', params: { id: String(article.id) } }"
                    class="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-6 group py-1 sm:py-0 outline-none"
                  >
                    <time 
                      :datetime="article.createTime"
                      :title="TimeUtils.toFullLocalString(article.createTime)"
                      class="flex-none text-xs sm:text-sm font-mono text-zinc-400 group-hover:text-zinc-950 transition-colors w-12 tabular-nums"
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

    <div v-if="!loading && renderData.length === 0" class="py-32 text-center">
        <p class="text-[11px] font-mono text-zinc-300 uppercase tracking-widest">
           暂无文章归档
        </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, shallowRef } from 'vue'
import { getArticles, type ArticleListItem } from '@/api/article'
import { TimeUtils } from '@/utils/time'
import dayjs from 'dayjs'

const SIGNALS = {
  CREATED: 'signalr:article-created',
  DELETED: 'signalr:article-deleted',
  RESTORED: 'signalr:article-restored',
  RECONNECTED: 'signalr:reconnected'
} as const;

// 归档渲染模型定义
interface MonthGroup { month: string; items: ArticleListItem[] }
interface YearGroup { year: string; months: MonthGroup[] }

const articles = shallowRef<ArticleListItem[]>([])
const loading = ref(true)
const total = ref(0)

// [修复 2026-02-23] P3 修复：提前转换为渲染专用数组，提升模板性能与可读性
const renderData = shallowRef<YearGroup[]>([])

let isMounted = false;
let abortController: AbortController | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 算法最优：数据坍缩引擎
 * [修复 2026-02-23] P1 修复：增加月内文章降序排列逻辑
 */
const buildArchiveStructure = (data: ArticleListItem[]) => {
  const yearsMap = new Map<string, Map<string, ArticleListItem[]>>();
  
  data.forEach(article => {
    // [修复 2026-02-23] P0 修复：统一使用中心化解析入口，物理消除单位歧义
    const d = TimeUtils._parse(article.createTime);
    if (!d || !d.isValid()) {
      console.warn(`[Archive] Invalid date skipped: ${article.id}`);
      return;
    }

    const year = d.year().toString();
    const month = d.format('MM');

    if (!yearsMap.has(year)) yearsMap.set(year, new Map());
    const monthsMap = yearsMap.get(year)!;

    if (!monthsMap.has(month)) monthsMap.set(month, []);
    monthsMap.get(month)!.push(article);
  });

  // 执行深层排序并转换为数组结构
  const finalStructure: YearGroup[] = Array.from(yearsMap.keys())
    .sort((a, b) => Number(b) - Number(a))
    .map(year => {
      const monthsMap = yearsMap.get(year)!;
      const sortedMonths: MonthGroup[] = Array.from(monthsMap.keys())
        .sort((a, b) => Number(b) - Number(a))
        .map(month => {
          const items = monthsMap.get(month)!;
          // [修复 2026-02-23] P1 修复：确保组内文章按日期降序排列
          items.sort((a, b) => {
             const tA = TimeUtils._parse(a.createTime)?.valueOf() || 0;
             const tB = TimeUtils._parse(b.createTime)?.valueOf() || 0;
             return tB - tA;
          });
          return { month, items: Object.freeze(items) as ArticleListItem[] };
        });
      return { year, months: sortedMonths };
    });

  renderData.value = finalStructure;
}

/**
 * 缓存月份显示名称
 * [修复 2026-02-23] P1 修复：增加 Locale 联动缓存
 */
const monthNameCache = new Map<string, string>();
const formatMonthName = (monthStr: string) => {
  const locale = dayjs.locale();
  const cacheKey = `${locale}:${monthStr}`;
  if (monthNameCache.has(cacheKey)) return monthNameCache.get(cacheKey)!;

  const name = dayjs().month(Number(monthStr) - 1).format('MMMM');
  monthNameCache.set(cacheKey, name);
  return name;
}

const formatDay = (dateStr: string) => {
  const d = TimeUtils._parse(dateStr);
  return d ? d.format('DD') : '';
}

/**
 * [修复 2026-02-23] P0 修复：递归分页合并算法
 * 物理杜绝 1000 条硬编码限制，确保归档数据的绝对完整性
 */
const fetchAllArticles = async (signal: AbortSignal): Promise<ArticleListItem[]> => {
    let allItems: ArticleListItem[] = [];
    let page = 1;
    const size = 100; // 单次拉取步长

    while (true) {
        const res = await getArticles({ page, size }, { signal });
        const items = res?.items || [];
        allItems.push(...items);
        
        const currentTotal = Number(res?.total) || 0;
        if (allItems.length >= currentTotal || items.length < size) {
            total.value = currentTotal;
            break;
        }
        page++;
    }
    return allItems;
}

/**
 * 核心加载逻辑
 * [修复 2026-02-23] P0 修复：物理中断快照置空逻辑
 */
const loadArticles = async (showLoading = true) => {
  if (abortController) abortController.abort()
  const currentController = new AbortController();
  abortController = currentController;
  const { signal } = currentController;

  if (showLoading) loading.value = true;
  
  try {
    const items = await fetchAllArticles(signal);
    
    if (isMounted && !signal.aborted) {
      articles.value = items;
      buildArchiveStructure(items);
    }
  } catch (error: any) {
    if (error.name !== 'AbortError' && isMounted && !signal.aborted) {
      console.error('[Archive] Sync failed:', error.message);
    }
  } finally {
    // 物理真相：仅在当前请求是“最后赢家”时才置空全局控制器
    if (abortController === currentController) {
      abortController = null;
    }
    if (isMounted && !signal.aborted) {
      loading.value = false;
    }
  }
}

const dispatchSync = () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (isMounted) loadArticles(false);
    debounceTimer = null;
  }, 500);
}

onMounted(() => {
  isMounted = true
  loadArticles()
  window.addEventListener(SIGNALS.CREATED, dispatchSync);
  window.addEventListener(SIGNALS.DELETED, dispatchSync);
  window.addEventListener(SIGNALS.RESTORED, dispatchSync);
  window.addEventListener(SIGNALS.RECONNECTED, () => isMounted && loadArticles(false));
})

onUnmounted(() => {
  isMounted = false
  if (debounceTimer) clearTimeout(debounceTimer);
  if (abortController) abortController.abort()
  window.removeEventListener(SIGNALS.CREATED, dispatchSync);
  window.removeEventListener(SIGNALS.DELETED, dispatchSync);
  window.removeEventListener(SIGNALS.RESTORED, dispatchSync);
  window.removeEventListener(SIGNALS.RECONNECTED, () => isMounted && loadArticles(false));
})
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