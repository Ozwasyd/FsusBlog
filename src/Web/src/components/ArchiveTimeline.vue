<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import type { ArticleCard } from '../../../Contracts/client'
import { siteLocale, t } from '../siteLocale'

const props = defineProps<{ heading: string; items: ArticleCard[]; total: number }>()
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
    <header class="archive-header editorial-rule">
      <div class="archive-header-top">
        <h1>{{ heading }}</h1>
        <p class="archive-count">{{ t('reading.archiveTotal', { count }) }}</p>
      </div>
      <nav v-if="groups.size > 1" class="archive-jump" :aria-label="t('reading.archiveYears')">
        <a v-for="[year] in groups" :key="year" :href="`#archive-year-${year}`">{{ year }}</a>
      </nav>
    </header>

    <p v-if="!groups.size" class="archive-empty">{{ t('reading.noArticles') }}</p>
    <div v-else class="archive-years">
      <section v-for="[year, yearMonths] in groups" :id="`archive-year-${year}`" :key="year" class="archive-year">
        <div class="archive-year-heading">
          <h2>{{ year }}</h2>
        </div>
        <section v-for="[month, entries] in yearMonths" :key="month" class="archive-month">
          <h3><span>{{ siteLocale === 'zh-CN' ? `${month + 1} 月` : months.format(entries[0].date) }}</span></h3>
          <ol role="list">
            <li v-for="item in entries" :key="item.id">
              <RouterLink :to="{ name: 'article', params: { id: item.id } }">
                <time :datetime="item.date.toISOString()" :title="fullDate.format(item.date)">{{ item.day }}</time>
                <span class="archive-entry-title">{{ item.title }}</span>
              </RouterLink>
            </li>
          </ol>
        </section>
      </section>
    </div>
  </div>
</template>

<style scoped>
.archive-timeline { --archive-date-col: 3.25rem; --archive-col-gap: 1.5rem; }
.archive-header { padding-block-end: 1.25rem; margin-block-end: 2.75rem; }
.archive-header-top { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: .5rem 1.25rem; }
.archive-header-top h1 { margin: 0; font-size: clamp(1.625rem, 1.25rem + 1.5vw, 2rem); line-height: 1.25; text-wrap: balance; }
.archive-count { margin: 0; color: var(--fsus-color-text-quiet); font-size: .875rem; font-weight: 500; line-height: 1.5; font-variant-numeric: tabular-nums; }
.archive-jump { display: flex; flex-wrap: wrap; flex-wrap: balance; gap: .25rem .75rem; margin-block-start: 1rem; }
.archive-jump a { display: inline-flex; align-items: center; min-block-size: 2rem; padding-inline: .375rem; margin-inline-start: -.375rem; border-radius: var(--fsus-radius-control-small); color: var(--fsus-color-text-quiet); font-size: .875rem; font-weight: 500; line-height: 1.5; font-variant-numeric: tabular-nums; text-decoration: none; transition: color var(--fsus-motion-control-fast) var(--fsus-motion-standard), background-color var(--fsus-motion-control-fast) var(--fsus-motion-standard); }
.archive-jump a:hover, .archive-jump a:focus-visible { color: var(--fsus-scholarly-blue); background: var(--fsus-state-hover-bg); }
.archive-empty { margin: 0; color: var(--fsus-color-text-quiet); }
.archive-years { display: grid; grid-template-columns: minmax(var(--archive-date-col), max-content) minmax(0, 1fr); column-gap: var(--archive-col-gap); }
.archive-year { grid-column: 1 / -1; display: grid; grid-template-columns: minmax(var(--archive-date-col), max-content) minmax(0, 1fr); grid-template-columns: subgrid; margin-block: 0; scroll-margin-block-start: 7.5rem; }
.archive-year + .archive-year { margin-block-start: 3.25rem; }
.archive-year-heading { grid-column: 1 / -1; position: sticky; inset-block-start: 5.75rem; z-index: 10; background: var(--fsus-page); padding-block: .25rem .75rem; margin-block-end: .5rem; }
.archive-year-heading h2 { margin: 0; font-size: clamp(1.375rem, 1.15rem + .75vw, 1.5rem); font-weight: 700; line-height: 1.25; font-variant-numeric: tabular-nums; color: var(--fsus-ink); }
.archive-month { grid-column: 1 / -1; display: grid; grid-template-columns: minmax(var(--archive-date-col), max-content) minmax(0, 1fr); grid-template-columns: subgrid; margin-block-start: 2rem; }
.archive-year-heading + .archive-month { margin-block-start: 0; }
.archive-month h3 { grid-column: 1 / -1; display: grid; grid-template-columns: minmax(var(--archive-date-col), max-content) minmax(0, 1fr); grid-template-columns: subgrid; column-gap: var(--archive-col-gap); align-items: center; margin: 0 0 .75rem; color: var(--fsus-color-text-quiet); font-size: .8125rem; font-weight: 500; line-height: 1.5; font-variant-numeric: tabular-nums; }
.archive-month h3::after { content: ''; display: block; border-block-start: 1px solid var(--fsus-border); }
.archive-month ol { grid-column: 1 / -1; display: grid; grid-template-columns: minmax(0, 1fr); grid-template-columns: subgrid; row-gap: .25rem; margin: 0; padding: 0; list-style: none; }
.archive-month li { grid-column: 1 / -1; display: grid; grid-template-columns: minmax(0, 1fr); grid-template-columns: subgrid; }
.archive-month a { grid-column: 1 / -1; display: grid; grid-template-columns: minmax(var(--archive-date-col), max-content) minmax(0, 1fr); grid-template-columns: subgrid; column-gap: var(--archive-col-gap); align-items: baseline; padding-block: .625rem; min-block-size: 44px; border-radius: var(--fsus-radius-control-small); text-decoration: none; overflow-wrap: anywhere; }
.archive-month time { color: var(--fsus-color-text-quiet); font-size: .875rem; font-weight: 500; line-height: 1.5; font-variant-numeric: tabular-nums; transition: color var(--fsus-motion-control-fast) var(--fsus-motion-standard); }
.archive-entry-title { color: var(--fsus-ink); font-size: clamp(1.0625rem, 1rem + .25vw, 1.125rem); font-weight: 500; line-height: 1.5; transition: color var(--fsus-motion-control-fast) var(--fsus-motion-standard); }
.archive-month a:hover time, .archive-month a:focus-visible time { color: var(--fsus-scholarly-blue); }
.archive-month a:hover .archive-entry-title, .archive-month a:focus-visible .archive-entry-title { color: var(--fsus-scholarly-blue); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: .25em; }
@media (max-width: 767px) {
  .archive-year { scroll-margin-block-start: 6.75rem; }
  .archive-year-heading { inset-block-start: 5.25rem; }
}
@media (max-width: 35.99rem) {
  .archive-timeline { --archive-date-col: 2.5rem; --archive-col-gap: .875rem; }
  .archive-header { padding-block-end: 1rem; margin-block-end: 2rem; }
  .archive-year + .archive-year { margin-block-start: 2.5rem; }
}
@media (pointer: coarse) { .archive-jump a { min-block-size: 44px; min-inline-size: 44px; justify-content: center; } }
@media (prefers-reduced-motion: reduce) { .archive-jump a, .archive-month time, .archive-entry-title { transition-duration: 1ms; } }
</style>
