#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { generatedArtifactWatchIgnorePatterns } from '../../../../src/frontend/scripts/vite-watch-policy.mjs'

const repoRoot = resolve(process.cwd(), '../..')
const errors = []

function read(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8')
}

function assert(condition, message) {
  if (!condition) {
    errors.push(message)
  }
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    const info = statSync(fullPath)
    if (info.isDirectory()) {
      walk(fullPath, files)
      continue
    }
    if (/\.(ts|vue)$/u.test(entry)) {
      files.push(fullPath)
    }
  }
  return files
}

function repoRelative(path) {
  return path.replace(`${repoRoot}\\`, '').replace(`${repoRoot}/`, '').replaceAll('\\', '/')
}

function imgBlocks(source) {
  return source.match(/<img\b[\s\S]*?\/>/gu) ?? []
}

const viteConfig = read('src/frontend/vite.config.ts')
const assetBudget = read('tests/frontend/checks/static/check-asset-size-budget.mjs')
const routePressure = read('tests/frontend/checks/perf/check-route-render-pressure.mjs')
const domBudget = read('tests/frontend/checks/perf/check-dom-budget.mjs')
const auditConsole = read('src/frontend/src/services/auditConsole.ts')
const telemetryPrivacy = read('tests/frontend/checks/static/check-telemetry-privacy.mjs')
const echartsRuntime = read('src/frontend/src/utils/echartsRuntime.ts')
const performanceDoc = read('docs/performance-governance.md')
const packageJson = read('src/frontend/package.json')

for (const chunkName of [
  'route-admin-article',
  'route-admin-moderation',
  'route-admin-security',
  'route-admin-users',
  'route-admin-ops',
  'route-admin-dashboard',
  'route-admin-content',
  'route-admin-messages'
]) {
  assert(viteConfig.includes(`return '${chunkName}'`), `vite admin chunk split missing ${chunkName}`)
}
assert(viteConfig.includes('function resolveAdminManualChunk'), 'vite config must keep admin domain chunk resolver')
assert(
  viteConfig.includes('ignored: generatedArtifactWatchIgnorePatterns'),
  'vite dev server must isolate browser measurements from generated test artifacts'
)
for (const pattern of ['**/coverage/**', '**/test-results/**', '**/playwright-report/**']) {
  assert(
    generatedArtifactWatchIgnorePatterns.includes(pattern),
    `vite watcher must ignore generated artifact path ${pattern}`
  )
}
assert(!viteConfig.includes("id.includes('/src/bootstrap/entry.ts')"), 'vite config must keep the real entry module out of manual chunks to avoid preload-helper cycles')
assert(!viteConfig.includes("id.includes('/src/services/themeRuntime.ts')"), 'vite config must keep Vue-backed theme runtime out of early entry-runtime chunks')
assert(assetBudget.includes('adminRouteChunkBytes'), 'asset budget must define admin route chunk raw budget')
assert(assetBudget.includes('adminRouteChunkGzipBytes'), 'asset budget must define admin route chunk gzip budget')
assert(assetBudget.includes('adminRouteChunkBrotliBytes'), 'asset budget must define admin route chunk brotli budget')
assert(assetBudget.includes('isAdminRouteChunk'), 'asset budget must detect route-admin chunks')
assert(assetBudget.includes('isEchartsVendorChunk'), 'asset budget must detect ECharts chunks')
assert(assetBudget.includes('elementPlusVendorBytes'), 'asset budget must keep Element Plus vendor on an explicit budget')
assert(assetBudget.includes('isElementPlusVendorChunk'), 'asset budget must detect Element Plus vendor chunks')
assert(
  domBudget.includes("import { evaluateAfterNavigationSettles } from './route-render-pressure-readiness.mjs'"),
  'DOM budget must reuse the bounded navigation-settle evaluator'
)
assert(
  domBudget.includes('await evaluateAfterNavigationSettles(page,'),
  'DOM budget measurements must tolerate only bounded navigation context resets'
)

for (const route of [
  '/user/manage/moderation',
  '/user/manage/moderation/comments',
  '/user/manage/security'
]) {
  assert(routePressure.includes(route), `route render pressure must cover ${route}`)
  assert(domBudget.includes(route), `DOM budget must cover ${route}`)
}

assert(echartsRuntime.includes("import('@/utils/echartsRuntime.bundle')"), 'ECharts runtime must stay dynamically imported')
const echartsImports = walk(resolve(repoRoot, 'src/frontend/src'))
  .map((file) => ({
    file: repoRelative(file),
    source: readFileSync(file, 'utf8')
  }))
  .filter(({ source }) => /from ['"]echarts|import \* as echarts from ['"]echarts|import\(['"]echarts/u.test(source))
for (const { file } of echartsImports) {
  assert(
    file === 'src/frontend/src/utils/echartsRuntime.ts'
      || file === 'src/frontend/src/utils/echartsRuntime.bundle.ts',
    `ECharts import must stay in lazy runtime files, found ${file}`
  )
}

assert(auditConsole.includes('VITE_FSUSBLOG_AUDIT_CONSOLE_INFO'), 'info audit console must require explicit env flag')
assert(auditConsole.includes('return isInfoAuditConsoleEnabled() ? safeConsoleInfo : null'), 'info audit console must be silent by default')
assert(telemetryPrivacy.includes('VITE_FSUSBLOG_AUDIT_CONSOLE_INFO'), 'telemetry privacy check must cover info console gating')

const publicImageRoots = [
  'src/frontend/src/components/public',
  'src/frontend/src/components/home',
  'src/frontend/src/views/Home.vue',
  'src/frontend/src/views/ArticleDetail.vue',
  'src/frontend/src/public-renderers'
]
const publicImageFiles = publicImageRoots.flatMap((relativePath) => {
  const fullPath = resolve(repoRoot, relativePath)
  const info = statSync(fullPath)
  return info.isDirectory() ? walk(fullPath) : [fullPath]
})

for (const file of publicImageFiles) {
  const label = repoRelative(file)
  for (const block of imgBlocks(readFileSync(file, 'utf8'))) {
    assert(/\bwidth=/.test(block), `${label} public image missing width`)
    assert(/\bheight=/.test(block), `${label} public image missing height`)
    assert(/\bdecoding="async"/.test(block), `${label} public image missing async decoding`)
    assert(/\bloading="(?:lazy|eager)"/.test(block), `${label} public image missing explicit loading policy`)

    if (/\b(?:object-cover|aspect-)/.test(block)) {
      assert(/\bsizes=/.test(block), `${label} responsive public image missing sizes`)
    }

    if (/\bfetchpriority="high"/.test(block)) {
      assert(
        label.endsWith('PublicArticleDetailPageContent.vue')
          || label.endsWith('FeaturedArticlesSection.vue'),
        `${label} high priority image is not an article LCP image`
      )
      assert(/\bloading="eager"/.test(block), `${label} high priority image must be eager`)
    }
  }
}

for (const token of [
  'Admin route chunks',
  'Public image delivery',
  'Production telemetry console noise',
  'Route render pressure'
]) {
  assert(performanceDoc.includes(token), `performance governance doc missing ${token}`)
}
assert(packageJson.includes('check:performance-governance'), 'package scripts must expose performance governance check')

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[performance-governance] ${error}`)
  }
  process.exit(1)
}

console.log(`[performance-governance] ok images=${publicImageFiles.length} echartsImports=${echartsImports.length}`)
