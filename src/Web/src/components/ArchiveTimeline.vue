<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import type { ArticleCard } from '../../../Contracts/client'
import { siteLocale, t } from '../siteLocale'

const props = defineProps<{ items: ArticleCard[]; total: number }>()
const route = useRoute()
type Entry = { id: number; title: string; day: string; date: Date }

const groups = computed(() => {
  const years = new Map<number, Map<number, Entry[]>>()
  for (const article of props.items) {
    const date = new Date(article.createdAt)
    const year = date.getFullYear()
    const month = date.getMonth()
    let months = years.get(year)
    if (!months) years.set(year, months = new Map())
    let entries = months.get(month)
    if (!entries) months.set(month, entries = [])
    entries.push({ id: article.id, title: article.title, day: String(date.getDate()).padStart(2, '0'), date })
  }
  return years
})
const count = computed(() => new Intl.NumberFormat(siteLocale.value).format(props.total))
const months = computed(() => new Intl.DateTimeFormat(siteLocale.value, { month: 'long' }))
const fullDate = computed(() => new Intl.DateTimeFormat(siteLocale.value, { dateStyle: 'long' }))

onMounted(() => {
  if (/^#archive-year-\d+$/.test(route.hash)) document.getElementById(route.hash.slice(1))?.scrollIntoView()
})
</script>

<template>
  <div class="archive-timeline">
    <p class="archive-count">{{ t('reading.archiveTotal', { count }) }}</p>
    <nav v-if="groups.size > 1" class="archive-jump" :aria-label="t('reading.archiveYears')">
      <a v-for="[year] in groups" :key="year" :href="`#archive-year-${year}`">{{ year }}</a>
    </nav>

    <p v-if="!groups.size" class="muted">{{ t('reading.noArticles') }}</p>
    <section v-for="[year, yearMonths] in groups" :id="`archive-year-${year}`" :key="year" class="archive-year">
      <h2>{{ year }}</h2>
      <section v-for="[month, entries] in yearMonths" :key="month" class="archive-month">
        <h3>{{ siteLocale === 'zh-CN' ? `${month + 1} 月` : months.format(entries[0].date) }}</h3>
        <ul>
          <li v-for="item in entries" :key="item.id">
            <RouterLink :to="{ name: 'article', params: { id: item.id } }">
              <time :datetime="item.date.toISOString()" :title="fullDate.format(item.date)">{{ item.day }}</time>
              <span>{{ item.title }}</span>
            </RouterLink>
          </li>
        </ul>
      </section>
    </section>
  </div>
</template>

<style scoped>
.archive-count, .archive-jump, .archive-month h3, .archive-month time {
  color: var(--fsus-color-text-muted);
  font-size: .8125rem;
  font-variant-numeric: tabular-nums;
}
.archive-count { margin: 0 0 .5rem; }
.archive-jump { display: flex; gap: .75rem 1.25rem; flex-wrap: wrap; }
.archive-year { margin-block: 2.25rem 2.75rem; scroll-margin-block-start: 7rem; }
.archive-year h2 { margin: 0 0 1rem; font-size: clamp(1.5rem, 4vw, 1.875rem); font-variant-numeric: tabular-nums; }
.archive-month { margin-block: 1.25rem; }
.archive-month h3 { display: flex; align-items: center; gap: .75rem; margin: 0 0 .25rem; font-weight: 500; }
.archive-month h3::after { content: ''; flex: 1; border-block-start: 1px solid var(--fsus-border); }
.archive-month ul { display: grid; gap: .125rem; margin: 0; padding: 0; list-style: none; }
.archive-month a {
  display: grid;
  grid-template-columns: 2.5rem minmax(0, 1fr);
  gap: .5rem;
  align-items: baseline;
  padding-block: .65rem;
  min-block-size: 44px;
  text-decoration: none;
  overflow-wrap: anywhere;
}
.archive-month a:hover span { text-decoration: underline; }
</style>
