#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const repoRoot = resolve(process.cwd(), '../..')
const srcRoot = resolve(repoRoot, 'src/frontend/src')
const errors = []

function read(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

function requireFile(path) {
  if (!existsSync(resolve(repoRoot, path))) {
    errors.push(`missing ${path}`)
  }
}

function expectIncludes(path, needle, label) {
  const source = read(path)
  if (!source.includes(needle)) {
    errors.push(`${path}: missing ${label}`)
  }
  return source
}

function walk(dir, predicate, results = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      walk(full, predicate, results)
    } else if (predicate(full)) {
      results.push(full)
    }
  }
  return results
}

requireFile('src/frontend/src/assets/motion.css')
requireFile('src/frontend/src/composables/useMotionPreference.ts')
requireFile('src/frontend/src/fsusui/motion.ts')
requireFile('docs/frontend/motion-guidelines.md')

const mainCss = read('src/frontend/src/assets/main.css')
if (!mainCss.includes("@import '@/assets/motion.css';"))
{
    errors.push('main.css must import motion.css');
}
for (const token of [
    '.transition-fsus {',
    'transition-property: color, background-color, border-color, box-shadow, opacity, transform;',
    'transition-timing-function: var(--fsus-motion-standard, cubic-bezier(0.4, 0, 0.2, 1));',
    '.transition-fsus-fast {',
    'transition-duration: var(--fsus-motion-control-fast, 220ms);',
    '.transition-fsus-base {',
    'transition-duration: var(--fsus-motion-control-base, var(--fsus-motion-control, 360ms));'
])
{
    if (!mainCss.includes(token)) {errors.push(`main.css missing reusable motion contract ${token}`)};
}

const motionCss = read('src/frontend/src/assets/motion.css');
for (const token of [
  '--blog-motion-fast',
  '--blog-motion-control',
  '--blog-motion-panel',
  '--blog-motion-overlay',
  '--blog-motion-ease',
  '.blog-motion-page-enter',
  '.blog-motion-panel-enter',
  '.blog-motion-state-change',
  '.blog-motion-task-region',
  '.blog-motion-row-state',
  '.blog-motion-summary-enter',
  '.blog-motion-highlight',
  '.blog-motion-safe-transform'
]) {
  if (!motionCss.includes(token)) {
    errors.push(`motion.css missing ${token}`)
  }
}

for (const forbidden of [
  'blog-motion-media-hover',
  'blog-motion-icon-nudge',
  'blog-motion-row-nudge',
  'blog-motion-loading-bar'
]) {
  if (motionCss.includes(forbidden)) {
    errors.push(`motion.css must not expose generic decorative helper .${forbidden}`)
  }
}

for (const [pattern, label] of [
  [/\bscale\(/, 'generic scale(...)'],
  [/\btranslateX\(/, 'horizontal nudge translateX(...)'],
  [/\blinear\s+infinite\b/, 'linear infinite loading sweep']
]) {
  if (pattern.test(motionCss)) {
    errors.push(`motion.css must not define ${label} outside a documented state whitelist`)
  }
}

const motionPreference = read('src/frontend/src/composables/useMotionPreference.ts')
if (!motionPreference.includes("REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'")) {
  errors.push('useMotionPreference must own the reduced-motion media query')
}
if (!motionPreference.includes('resolveMotionScrollBehavior')) {
  errors.push('useMotionPreference must expose scroll behavior resolver')
}

const fsusMotionAdapter = expectIncludes(
  'src/frontend/src/fsusui/motion.ts',
  "from '@ozwasyd/element-plus'",
  'FsusUI motion import boundary'
)
for (const token of [
  'FsuMotion',
  'FsuTransition',
  'vMotion',
  'vScrollReveal',
  'useScrollReveal',
  'useMotionRouteCleanup',
  'runMotion',
  'fsusBlogMotionPresets',
  'fsusBlogScrollRevealOptions'
]) {
  if (!fsusMotionAdapter.includes(token)) {
    errors.push(`src/frontend/src/fsusui/motion.ts: missing ${token}`)
  }
}

expectIncludes('src/frontend/src/bootstrap/fullApp.ts', 'app.use(FsuMotion)', 'FsusUI motion plugin registration')

const appVue = expectIncludes('src/frontend/src/App.vue', '<Transition', 'Vue route transition host')
for (const token of [
  'isPublicShellRoute',
  'v-if="isPublicShellRoute"',
  'runAppRouteMotion',
  'runMotion',
  'useMotionRouteCleanup',
  'fsusBlogMotionPresets.route',
  '@enter="runAppRouteEnter"',
  '@leave="runAppRouteLeave"',
  ':key="route.fullPath"'
]) {
  if (!appVue.includes(token)) {
    errors.push(`src/frontend/src/App.vue: missing ${token}`)
  }
}
for (const forbidden of ['isPublicSeoRouteName', 'v-if="isPublicSeoRoute"', '<RouterView v-if="isPublicSeoRoute"']) {
  if (appVue.includes(forbidden)) {
    errors.push(`src/frontend/src/App.vue: public shell route transition must not split on ${forbidden}`)
    }
}

const accountRouteFrame = expectIncludes(
    'src/frontend/src/layouts/AccountRouteFrame.vue',
    ':disabled="motionPolicy.preset === null || !motionEnabled"',
    'frame-owned account route motion gate'
);
if (!accountRouteFrame.includes(':key="accountRouteViewKey"'))
{
    errors.push('src/frontend/src/layouts/AccountRouteFrame.vue: account route transition must key child pages by accountRouteViewKey');
}
for (const forbidden of ['mode="out-in"', ':duration="220"', 'duration="220"'])
{
    if (accountRouteFrame.includes(forbidden))
{
        errors.push(`src/frontend/src/layouts/AccountRouteFrame.vue: account route motion must not retain ${forbidden}`);
    }
}
for (const token of ['shouldRestoreAccountRouteFocus', 'if (restoreFocus)', 'accountMain.value?.focus({ preventScroll: true })'])
{
    if (!accountRouteFrame.includes(token))
{
        errors.push(`src/frontend/src/layouts/AccountRouteFrame.vue: account route focus continuity is missing ${token}`);
    }
}

const accountRouteMotion = expectIncludes(
    'src/frontend/src/layouts/accountRouteMotion.ts',
    'ACCOUNT_ROUTE_MOTION_POLICIES',
    'typed account route motion policy'
);
for (const token of [
    "preset: fsusBlogMotionPresets.identityRoute",
    "preset: null",
    "contentMode === 'takeover'",
    "reason: 'pane-continuity'",
    "reason: 'task-immediacy'"
])
{
    if (!accountRouteMotion.includes(token))
{
        errors.push(`src/frontend/src/layouts/accountRouteMotion.ts: missing ${token}`);
    }
}
if (/\bduration\s*:\s*\d+/u.test(accountRouteMotion))
{
    errors.push('src/frontend/src/layouts/accountRouteMotion.ts: frame policy must consume the FsusUI preset duration contract');
}

const accountShellCss = expectIncludes(
    'src/frontend/src/assets/admin-workspace.css',
    '.account-motion-enter',
    'admin page motion compatibility marker'
);
if (/\.account-motion-enter\s*\{[^}]*blog-motion-page-enter/s.test(accountShellCss))
{
    errors.push('src/frontend/src/assets/admin-workspace.css: account-motion-enter must not run page-enter animation; admin routes replace immediately');
}

const blogLayout = expectIncludes(
  'src/frontend/src/layouts/BlogLayout.vue',
  '@navigate="handleNavigate"',
  'public shell SPA navigation handoff'
)
if (!blogLayout.includes(':spa-navigation="isMounted"')) {
  errors.push('src/frontend/src/layouts/BlogLayout.vue: public shell must enable SPA navigation after mount')
}
for (const forbidden of ['name="fade-fast"', '.fade-fast-', 'FsusBlogRouteTransition', 'isPublicSeoRouteName', 'v-if="isSeoShellRoute"']) {
  if (blogLayout.includes(forbidden)) {
    errors.push(`src/frontend/src/layouts/BlogLayout.vue: remove local public route transition ${forbidden}`)
  }
}

const publicShell = expectIncludes(
  'src/frontend/src/bootstrap/publicShell.ts',
  'submitPublicActivationIntent',
  'public route activation coordinator submission'
)
for (const token of [
  'submitPublicActivationIntent',
  'warmPublicActivation',
  'warmPublicFullAppCore',
  'navigateWithDocumentRequest'
]) {
  if (!publicShell.includes(token)) {
    errors.push(`src/frontend/src/bootstrap/publicShell.ts: missing ${token}`)
  }
}
for (const forbidden of [
  'settlePublicNavigationMotionForShell',
  'replacePublicShellForNavigation',
  'applyPublicNavigationDocument'
]) {
  if (publicShell.includes(forbidden)) {
    errors.push(`src/frontend/src/bootstrap/publicShell.ts: public route motion must be owned by SPA routing, found ${forbidden}`)
  }
}

const homePage = expectIncludes('src/frontend/src/components/public/pages/PublicHomePageContent.vue', 'data-fsus-motion-surface="home-hero"', 'home hero motion surface metadata')
if (homePage.includes('fsusBlogMotionPresets.homeHero') || /<header[\s\S]*?\bv-motion=/.test(homePage)) {
  errors.push('PublicHomePageContent.vue: home hero must not animate by default')
}

const articleList = read('src/frontend/src/components/public/PublicArticleList.vue')
for (const token of ['data-fsus-surface="reading"', 'data-fsus-motion-surface="article-card"', ':data-fsus-motion-index="index"']) {
  if (!articleList.includes(token)) {
    errors.push(`PublicArticleList.vue: missing ${token}`)
  }
}
for (const forbidden of ['v-motion', 'fsusBlogMotionPresets.articleCards', '@ozwasyd/element-plus/motion']) {
  if (articleList.includes(forbidden)) {
    errors.push(`PublicArticleList.vue: reading surface must not use ${forbidden}`)
  }
}

const filterPage = read('src/frontend/src/components/public/pages/PublicFilterPageContent.vue')
if (!filterPage.includes('data-fsus-motion-surface="search-panel"')) {
  errors.push('PublicFilterPageContent.vue: search panel must expose motion surface metadata')
}
for (const forbidden of ['v-motion', 'fsusBlogMotionPresets.searchDialog', '@ozwasyd/element-plus/motion']) {
  if (filterPage.includes(forbidden)) {
    errors.push(`PublicFilterPageContent.vue: reading surface must not use ${forbidden}`)
  }
}

const detailPage = read('src/frontend/src/components/public/pages/PublicArticleDetailPageContent.vue')
for (const token of ['data-fsus-surface="reading"', 'data-fsus-motion-surface="article-cover"', 'data-fsus-motion-surface="article-title"']) {
  if (!detailPage.includes(token)) {
    errors.push(`PublicArticleDetailPageContent.vue: missing ${token}`)
  }
}
for (const forbidden of ['v-motion', 'v-scroll-reveal', 'fsusBlogMotionPresets.articleTitle', 'fsusBlogScrollRevealMotion', '@ozwasyd/element-plus/motion']) {
  if (detailPage.includes(forbidden)) {
    errors.push(`PublicArticleDetailPageContent.vue: reading surface must not use ${forbidden}`)
  }
}

const imageEnhancement = expectIncludes('src/frontend/src/composables/article/useArticleImageLightbox.ts', 'useScrollReveal', 'article image scroll reveal')
if (!imageEnhancement.includes("data-fsus-motion-surface', 'article-body-image'")) {
  errors.push('useArticleImageLightbox.ts: article body images must expose motion surface metadata')
}

const codeEnhancement = expectIncludes('src/frontend/src/composables/article/useCodeBlockCopy.ts', 'useScrollReveal', 'code block scroll reveal')
if (!codeEnhancement.includes("data-fsus-motion-surface', 'article-code-block'")) {
  errors.push('useCodeBlockCopy.ts: article code blocks must expose motion surface metadata')
}

expectIncludes('src/frontend/src/components/article/ArticleTocPanel.vue', ':motion="fsusBlogMotionPresets.mobileDrawer"', 'mobile drawer public motion prop')
expectIncludes('src/frontend/src/fsusui/feedback.ts', 'fsusBlogMotionPresets.toast', 'toast motion preset boundary')

const motionDocs = read('docs/frontend/motion-guidelines.md')
for (const token of [
  'FsusUI Preset Adoption',
  'src/frontend/src/fsusui/motion.ts',
  'useMotionRouteCleanup()',
  'useScrollReveal()',
  'Scale, nudge and sweep helpers are not semantic motion classes',
  'check-motion-governance.mjs'
]) {
  if (!motionDocs.includes(token)) {
    errors.push(`docs/frontend/motion-guidelines.md: missing ${token}`)
  }
}

const scanned = walk(srcRoot, path => /\.(vue|ts|css)$/.test(path))
for (const file of scanned) {
  const rel = relative(repoRoot, file).replace(/\\/g, '/')
  const source = readFileSync(file, 'utf8')

  if (rel !== 'src/frontend/src/composables/useMotionPreference.ts'
      && /matchMedia\(["']\(prefers-reduced-motion: reduce\)["']\)/.test(source)) {
    errors.push(`${rel}: use useMotionPreference instead of direct reduced-motion matchMedia`)
  }

  if (!rel.endsWith('motion.css') && /@keyframes\s+/.test(source)) {
        errors.push(`${rel}: keyframes must be registered in assets/motion.css`);
    }

    if (!rel.endsWith('motion.css') && !rel.endsWith('main.css') && /cubic-bezier\(/.test(source))
{
        errors.push(`${rel}: use --blog-motion-ease instead of cubic-bezier`);
    }

    if (/duration-\[var\(--fsus-motion-[^)]+\)\]/u.test(source))
{
        errors.push(`${rel}: consume motion durations through transition-fsus-fast/base`);
    }

    if (/\b(?:blog-motion-media-hover|blog-motion-icon-nudge|blog-motion-row-nudge|blog-motion-loading-bar)\b/.test(source))
{
        errors.push(`${rel}: generic decorative motion helper is not allowed`);
    }

  const allowedIssue728HoverNudge = new Set([
    'src/frontend/src/components/public/PublicComplianceFooter.vue'
  ])
  if (!rel.endsWith('motion.css') && !allowedIssue728HoverNudge.has(rel) && /\b(?:hover|group-hover):(scale|translate)/.test(source)) {
    errors.push(`${rel}: hover scale/translate utilities are decorative; use state feedback or FsusUI presets`)
  }

  if (!rel.endsWith('motion.css') && /:hover[^{]*\{[^}]*\btransform\s*:/.test(source)) {
    errors.push(`${rel}: use a blog-motion-* semantic class instead of local hover transform CSS`)
  }

  if (!rel.endsWith('motion.css') && /:deep\(\.el-[^)]+\)[^{]*\{[^}]*(?:\btransition\s*:|\banimation\s*:|(?<!-)transform\s*:)/s.test(source)) {
    errors.push(`${rel}: do not rewrite Element Plus or FsusUI internal motion through :deep(.el-*)`)
  }

  if (rel !== 'src/frontend/src/fsusui/motion.ts' && /from\s+['"]@element-plus\/motion/.test(source)) {
    errors.push(`${rel}: import FsusUI motion through @/fsusui/motion, not @element-plus/motion`)
  }

  if (/(?:from\s+['"]|import\(['"])(?:gsap|motion-dom)/.test(source)) {
    errors.push(`${rel}: do not import local raw animation engines from FsusBlog`)
  }

  if (!rel.endsWith('motion.css')) {
    for (const match of source.matchAll(/\btransition\s*:[^;\n]*/g)) {
      const declaration = match[0]
      const hasBareDuration = /(?:^|[\s,(])\d+(?:\.\d+)?m?s(?:[\s,);]|$)/.test(declaration)
      const hasBareEase = /(?:^|[\s,(])ease(?:[\s,);]|$)/.test(declaration)
      if (hasBareDuration || hasBareEase) {
        errors.push(`${rel}: transition must use --blog-motion-* or FsusUI motion tokens`)
        break
      }
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[motion-governance] ${error}`)
  }
  process.exit(1)
}

console.log(`[motion-governance] ok files=${scanned.length}`)
