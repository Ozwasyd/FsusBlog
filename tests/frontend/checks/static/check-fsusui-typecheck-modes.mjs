import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const frontendRoot = path.join(repoRoot, 'src/frontend')
const packageJsonPath = path.join(frontendRoot, 'package.json')
const appTsconfigPath = path.join(frontendRoot, 'tsconfig.app.json')
const publishedTsconfigPath = path.join(frontendRoot, 'tsconfig.fsusui-published.json')
const localTsconfigPath = path.join(frontendRoot, 'tsconfig.fsusui-local.json')
const viteAliasPath = path.join(frontendRoot, 'scripts/fsusui-local.ts')
const localRunnerPath = path.join(frontendRoot, 'scripts/run-local-fsusui-typecheck.mjs')
const augmentationPath = path.join(frontendRoot, 'src/fsusui/elementPlusAugmentations.d.ts')
const contractPath = path.join(repoRoot, 'tests/frontend/typecheck/fsusui-export-contract.ts')
const docsPath = path.join(repoRoot, 'docs/frontend/fsusui-typecheck-modes.md')

const failures = []

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

function readJson(file) {
  return JSON.parse(read(file))
}

function requireFile(file) {
  if (!fs.existsSync(file)) {
    failures.push(`${path.relative(repoRoot, file).replaceAll(path.sep, '/')}: missing`)
  }
}

function expectIncludes(file, content, token, detail) {
  if (!content.includes(token)) {
    failures.push(`${path.relative(repoRoot, file).replaceAll(path.sep, '/')}: missing ${detail}`)
  }
}

for (const file of [
  packageJsonPath,
  appTsconfigPath,
  publishedTsconfigPath,
  localTsconfigPath,
  viteAliasPath,
  localRunnerPath,
  contractPath,
  docsPath,
]) {
  requireFile(file)
}

if (fs.existsSync(augmentationPath)) {
  failures.push('src/frontend/src/fsusui/elementPlusAugmentations.d.ts: temporary package augmentation must be removed')
}

if (failures.length === 0) {
  const pkg = readJson(packageJsonPath)
  const scripts = pkg.scripts ?? {}
  const published = readJson(publishedTsconfigPath)
  const publishedPaths = published.compilerOptions?.paths ?? {}
  const local = readJson(localTsconfigPath)
  const localPaths = local.compilerOptions?.paths ?? {}
  const viteAliases = read(viteAliasPath)
  const localRunner = read(localRunnerPath)
  const contract = read(contractPath)
  const docs = read(docsPath)

  if (scripts['typecheck:published-fsusui'] !== 'vue-tsc --noEmit -p tsconfig.fsusui-published.json') {
    failures.push('src/frontend/package.json: typecheck:published-fsusui must run the published package tsconfig')
  }
  if (scripts['typecheck:local-fsusui'] !== 'node ./scripts/run-local-fsusui-typecheck.mjs') {
    failures.push('src/frontend/package.json: typecheck:local-fsusui must run the local FsusUI runner')
  }
  if (scripts['check:fsusui-typecheck-modes'] !== 'node ../../tests/frontend/checks/static/check-fsusui-typecheck-modes.mjs') {
    failures.push('src/frontend/package.json: check:fsusui-typecheck-modes script is missing')
  }
  if (!String(scripts['check:views-constraints'] ?? '').includes('check:fsusui-typecheck-modes')) {
    failures.push('src/frontend/package.json: check:views-constraints must include check:fsusui-typecheck-modes')
  }

  if (!published.include?.includes('../../tests/frontend/typecheck/fsusui-export-contract.ts')) {
    failures.push('src/frontend/tsconfig.fsusui-published.json: must include the FsusUI export contract')
  }
  if (published.include?.some((entry) => entry.includes('elementPlusAugmentations'))) {
    failures.push('src/frontend/tsconfig.fsusui-published.json: must not include Blog-local package augmentations')
  }
  if (publishedPaths['@ozwasyd/element-plus/*']) {
    failures.push('src/frontend/tsconfig.fsusui-published.json: published mode must not use a wildcard @ozwasyd/element-plus mapping')
  }
  for (const [alias, expected] of [
    ['@ozwasyd/element-plus', './node_modules/@ozwasyd/element-plus'],
    ['@ozwasyd/element-plus/theme', './node_modules/@ozwasyd/element-plus/es/theme.d.ts'],
  ]) {
    if (!publishedPaths[alias]?.includes(expected)) {
      failures.push(`src/frontend/tsconfig.fsusui-published.json: missing published path mapping ${alias} -> ${expected}`)
    }
  }
  for (const paths of Object.values(publishedPaths)) {
    if (paths.some((entry) => entry.includes('../../../FsusUI') || entry.includes('elementPlusAugmentations'))) {
      failures.push('src/frontend/tsconfig.fsusui-published.json: published mode must not reference local FsusUI source or Blog-local augmentations')
    }
  }

  for (const [alias, expected] of [
    ['@ozwasyd/element-plus', '../../../FsusUI/vue/packages/element-plus/index.ts'],
    ['@ozwasyd/element-plus/theme', '../../../FsusUI/vue/packages/element-plus/theme.ts'],
    ['@ozwasyd/element-plus/markdown-runtime', '../../../FsusUI/vue/packages/element-plus/markdown-runtime.ts'],
    ['@ozwasyd/element-plus/motion', '../../../FsusUI/vue/packages/element-plus/motion.ts'],
    ['@ozwasyd/element-plus/perception-challenge', '../../../FsusUI/vue/packages/element-plus/perception-challenge.ts'],
    ['@element-plus/*', '../../../FsusUI/vue/packages/*'],
  ]) {
    if (!localPaths[alias]?.includes(expected)) {
      failures.push(`src/frontend/tsconfig.fsusui-local.json: missing local path mapping ${alias} -> ${expected}`)
    }
  }

  const localPathEntries = Object.values(localPaths).flat()
  if (localPathEntries.some((entry) => entry.includes('../../../FsusUI/packages'))) {
    failures.push('src/frontend/tsconfig.fsusui-local.json: must not reference the old FsusUI root packages path')
  }
  if (local.include?.some((entry) => entry.includes('../../../FsusUI/global.d.ts') || entry.includes('../../../FsusUI/typings/'))) {
    failures.push('src/frontend/tsconfig.fsusui-local.json: must include local FsusUI declarations from ../../../FsusUI/vue')
  }
  if (viteAliases.includes('/packages/') && !viteAliases.includes('/vue/packages/')) {
    failures.push('src/frontend/scripts/fsusui-local.ts: local aliases must resolve through the FsusUI vue/ workspace')
  }
  if (localRunner.includes("fromLocal('packages'") || localRunner.includes("path.join(localRoot, 'global.d.ts')")) {
    failures.push('src/frontend/scripts/run-local-fsusui-typecheck.mjs: local typecheck runner must resolve through the FsusUI vue/ workspace')
  }

  for (const token of [
    'resolveLocalFsusUiRoot',
    'createFsusUiAliases',
    'assertLocalFsusUiPublicShellMotionAssets',
    'el-public-shell-mobile-nav-menu-enter-active',
    'el-public-shell-mobile-nav-menu-leave-active',
    'prefers-reduced-motion:reduce',
    'corepack pnpm run build:theme',
    '@ozwasyd\\/element-plus',
    '@ozwasyd\\/element-plus\\/motion',
    '@ozwasyd\\/element-plus\\/perception-challenge',
    '@element-plus\\/([^/]+)',
  ]) {
    expectIncludes(viteAliasPath, viteAliases, token, `Vite alias token ${token}`)
  }
  for (const token of [
    'FSUSBLOG_LOCAL_FSUSUI_ROOT',
    'tsconfig.fsusui-published.json',
    '@ozwasyd/element-plus/theme',
    '@ozwasyd/element-plus/motion',
    '@ozwasyd/element-plus/perception-challenge',
    '@element-plus/*',
  ]) {
    expectIncludes(localRunnerPath, localRunner, token, `local typecheck runner token ${token}`)
  }
  for (const token of [
    'ElEmptyState',
    'ElSiteHeader',
    'FsusPerceptionChallenge',
    'FsusTextTaskChallenge',
    'PerceptionChallengeAssignment',
    'PerceptionChallengeClient',
    'ElMarkdownEditor',
    'FsuMotion',
    'MotionPresetName',
    '@ozwasyd/element-plus/theme',
  ]) {
    expectIncludes(contractPath, contract, token, `export contract token ${token}`)
  }
  for (const token of [
    'typecheck:published-fsusui',
    'typecheck:local-fsusui',
    'FSUSBLOG_LOCAL_FSUSUI_ROOT',
    'Full App Typecheck',
  ]) {
    expectIncludes(docsPath, docs, token, `documentation token ${token}`)
  }
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `[fsusui-typecheck-modes] ${failure}`).join('\n'))
  process.exit(1)
}

console.log('[fsusui-typecheck-modes] ok')
