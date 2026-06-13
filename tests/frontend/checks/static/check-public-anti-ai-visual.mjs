#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(process.cwd(), '../..')
const errors = []

function read(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

function expectIncludes(source, token, label) {
  if (!source.includes(token)) {
    errors.push(`${label} missing ${token}`)
  }
}

function expectNotIncludes(source, token, label) {
  if (source.includes(token)) {
    errors.push(`${label} must not include ${token}`)
  }
}

function expectNotMatches(source, pattern, label) {
  if (pattern.test(source)) {
    errors.push(label)
  }
}

const publicCss = read('src/frontend/src/assets/public-page.css')
const themeTokens = read('src/frontend/src/ui-tokens/themeTokens.ts')
const motion = read('src/frontend/src/fsusui/motion.ts')
const articleList = read('src/frontend/src/components/public/PublicArticleList.vue')
const homePage = read('src/frontend/src/components/public/pages/PublicHomePageContent.vue')
const featured = read('src/frontend/src/components/home/FeaturedArticlesSection.vue')
const articleDetail = read('src/frontend/src/components/public/pages/PublicArticleDetailPageContent.vue')
const homeFeedSurface = read('src/frontend/src/components/public/HomeFeedSurface.vue')
const hotArticlesIsland = read('src/frontend/src/public-renderers/homeHotArticlesIsland.ts')
const siteStore = read('src/frontend/src/store/site.ts')
const filterView = read('src/frontend/src/view-contracts/filterView.ts')
const articleListView = read('src/frontend/src/view-contracts/articleList.ts')
const homeEmptyState = read('src/frontend/src/components/home/HomeArticleEmptyState.vue')
const homeErrorState = read('src/frontend/src/components/home/HomeArticleErrorState.vue')
const aboutPage = read('src/frontend/src/components/public/pages/PublicAboutPageContent.vue')
const articleDetailState = read('src/frontend/src/view-contracts/articleDetail.ts')
const homeViewComposable = read('src/frontend/src/composables/useHomeView.ts')
const packageJson = JSON.parse(read('src/frontend/package.json'))

for (const token of [
  '--fsusblog-reading-radius-control: 6px;',
  '--fsusblog-reading-radius-panel: 10px;',
  '--fsusblog-reading-radius-media: 12px;',
  '--fsusblog-reading-shadow-panel: none;',
  '--fsusblog-reading-backdrop-blur: 0px;',
  '--fsusblog-reading-motion-trail: transparent;',
  '--fsusblog-reading-glow: transparent;'
]) {
  expectIncludes(publicCss, token, 'public-page.css')
}

expectIncludes(publicCss, 'border-radius: var(--fsusblog-reading-radius-panel);', 'public-page.css .aot-panel')
expectIncludes(publicCss, 'box-shadow: var(--fsusblog-reading-shadow-panel);', 'public-page.css .aot-panel')
expectNotIncludes(publicCss, '--stagger-delay', 'public-page.css')
expectNotMatches(publicCss, /animation-delay:\s*calc\(min\(var\(--index/s, 'public-page.css must not stagger AOT fade-in by content index')

const publicReadingSources = new Map([
  ['public-page.css', publicCss],
  ['themeTokens.ts', themeTokens],
  ['fsusui/motion.ts', motion],
  ['PublicArticleList.vue', articleList],
  ['PublicHomePageContent.vue', homePage],
  ['FeaturedArticlesSection.vue', featured],
  ['PublicArticleDetailPageContent.vue', articleDetail],
  ['HomeFeedSurface.vue', homeFeedSurface],
  ['homeHotArticlesIsland.ts', hotArticlesIsland]
])

for (const [label, source] of publicReadingSources) {
  for (const token of [
    '--fsus-radius-panel',
    '--fsus-shadow-panel',
    '--fsus-backdrop-blur-soft',
    'list-stagger'
  ]) {
    expectNotIncludes(source, token, label)
  }
}

for (const [label, source] of [
  ['fsusui/motion.ts', motion],
  ['PublicArticleList.vue', articleList],
  ['PublicHomePageContent.vue', homePage],
  ['FeaturedArticlesSection.vue', featured],
  ['PublicArticleDetailPageContent.vue', articleDetail]
]) {
  expectNotIncludes(source, 'fade-up', label)
}

expectIncludes(themeTokens, 'commentsPlaceholderRoot', 'themeTokens.ts')
expectIncludes(themeTokens, 'rounded-[var(--fsusblog-reading-radius-panel)]', 'themeTokens.ts comments placeholder')
expectIncludes(themeTokens, 'shadow-none', 'themeTokens.ts comments placeholder')
expectNotIncludes(themeTokens, 'backdrop-blur', 'themeTokens.ts comments placeholder')
expectNotIncludes(themeTokens, 'pageSurfaceTranslucent', 'themeTokens.ts comments placeholder')

expectIncludes(motion, "homeHero: 'fade-in'", 'fsusui/motion.ts')
expectIncludes(motion, "articleCards: 'fade-in'", 'fsusui/motion.ts')
expectIncludes(motion, "articleTitle: 'fade-in'", 'fsusui/motion.ts')
expectIncludes(motion, "name: 'fade-in'", 'fsusui/motion.ts scroll reveal')

expectIncludes(articleList, 'v-motion="{ name: fsusBlogMotionPresets.articleCards, once: true }"', 'PublicArticleList.vue')
expectIncludes(articleList, 'data-fsus-motion-surface="article-card"', 'PublicArticleList.vue')
expectNotIncludes(articleList, 'index, once: true', 'PublicArticleList.vue')

expectIncludes(homePage, 'data-fsus-motion-surface="home-hero"', 'PublicHomePageContent.vue')
expectNotIncludes(homePage, 'fsusBlogMotionPresets.homeHero', 'PublicHomePageContent.vue')
expectNotMatches(homePage, /<header[\s\S]*?\bv-motion=/, 'PublicHomePageContent.vue home hero must not use v-motion by default')

expectIncludes(featured, 'data-fsus-motion-surface="home-featured-articles"', 'FeaturedArticlesSection.vue')
expectIncludes(featured, 'rounded-[var(--fsusblog-reading-radius-media)]', 'FeaturedArticlesSection.vue')
expectNotIncludes(featured, 'v-motion=', 'FeaturedArticlesSection.vue')
expectNotIncludes(featured, 'fsusBlogMotionPresets.articleCards', 'FeaturedArticlesSection.vue')

expectIncludes(articleDetail, 'rounded-[var(--fsusblog-reading-radius-media)]', 'PublicArticleDetailPageContent.vue')
expectIncludes(homeFeedSurface, 'rounded-[var(--fsusblog-reading-radius-panel)]', 'HomeFeedSurface.vue')
expectIncludes(hotArticlesIsland, 'rounded-[var(--fsusblog-reading-radius-control)]', 'homeHotArticlesIsland.ts')
expectIncludes(siteStore, '工程记录、性能实验、UI 系统与 FsusBlog 构建过程。', 'site.ts default description')
expectIncludes(siteStore, '.NET, 前端性能, 系统设计, UI 系统, 技术博客, FsusBlog', 'site.ts default keywords')
expectNotIncludes(siteStore, '极简主义个人内容发布系统', 'site.ts default description')
expectNotIncludes(siteStore, 'Minimalism, Blog, Fsu', 'site.ts default keywords')

const publicStateCopySources = new Map([
  ['filterView.ts', filterView],
  ['articleList.ts', articleListView],
  ['HomeArticleEmptyState.vue', homeEmptyState],
  ['HomeArticleErrorState.vue', homeErrorState],
  ['PublicAboutPageContent.vue', aboutPage],
  ['articleDetail.ts', articleDetailState],
  ['useHomeView.ts', homeViewComposable]
])

expectIncludes(filterView, '正在完成访问校验', 'filterView.ts pow indicator')
expectIncludes(filterView, '这个筛选条件下暂无文章', 'filterView.ts empty state')
expectIncludes(articleListView, '没有匹配的文章', 'articleList.ts empty state')
expectIncludes(homeEmptyState, '没有匹配的文章', 'HomeArticleEmptyState.vue')
expectIncludes(homeErrorState, '内容暂时无法载入', 'HomeArticleErrorState.vue')
expectIncludes(aboutPage, '内容连接中断', 'PublicAboutPageContent.vue')

for (const [label, source] of publicStateCopySources) {
  for (const token of [
    'Security verifying',
    '没有找到文章。',
    '无相关内容',
    '筛选目标不存在',
    '暂时无法加载内容',
    '连接丢失。',
    '数据加载异常'
  ]) {
    expectNotIncludes(source, token, label)
  }
}

if (!packageJson.scripts?.['check:public-anti-ai-visual']) {
  errors.push('package.json missing check:public-anti-ai-visual')
}

const viewsConstraints = packageJson.scripts?.['check:views-constraints'] ?? ''
if (!viewsConstraints.includes('npm run check:public-reading-motion && npm run check:public-anti-ai-visual')) {
  errors.push('check:views-constraints must run check:public-anti-ai-visual after check:public-reading-motion')
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[public-anti-ai-visual] ${error}`)
  }
  process.exit(1)
}

console.log(`[public-anti-ai-visual] ok files=${publicReadingSources.size}`)
