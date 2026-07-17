#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const frontendRoot = path.join(repoRoot, 'src', 'frontend')
const defaultFsusUiRoot = path.resolve(repoRoot, '..', 'FsusUI')
const fsusUiRoot = path.resolve(process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT || defaultFsusUiRoot)
const aliasSource = fs.readFileSync(path.join(frontendRoot, 'scripts', 'fsusui-local.ts'), 'utf8')
const themeDist = path.join(fsusUiRoot, 'vue', 'packages', 'theme-chalk', 'dist')
const themeSource = path.join(fsusUiRoot, 'vue', 'packages', 'theme-chalk', 'src')
const contracts = [
  'el-public-shell__mobile-nav-menu.is-closing',
  'el-public-shell-mobile-nav-menu-enter-active',
  'el-public-shell-mobile-nav-menu-leave-active',
  'el-public-shell-mobile-nav-menu-enter-from',
  'el-public-shell-mobile-nav-menu-leave-to',
  'prefers-reduced-motion:reduce',
]
const failures = []

if (!fs.existsSync(themeSource)) {
  failures.push(`local FsusUI theme source is missing: ${themeSource}`)
} else {
  const source = ['public-shell.scss', 'public-shell-critical.scss']
    .map((fileName) => fs.readFileSync(path.join(themeSource, fileName), 'utf8'))
    .join('\n')
  for (const contract of [
    '@include when(closing)',
    '&-mobile-nav-menu-enter-active',
    '&-mobile-nav-menu-leave-active',
    '&-mobile-nav-menu-enter-from',
    '&-mobile-nav-menu-leave-to',
    'prefers-reduced-motion: reduce',
  ]) {
    if (!source.includes(contract)) failures.push(`local FsusUI theme source is missing ${contract}`)
  }
}

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(absolute)
    return /\.(?:css|scss|vue)$/u.test(entry.name) ? [absolute] : []
  })
}

for (const token of [
  'assertLocalFsusUiPublicShellMotionAssets',
  'el-public-shell-critical.css',
  'localThemeDist',
  'publicShellMotionContracts',
]) {
  if (!aliasSource.includes(token)) failures.push(`alias source is missing ${token}`)
}

if (fs.existsSync(themeDist)) {
  for (const fileName of ['index.css', 'el-public-shell-critical.css']) {
    const file = path.join(themeDist, fileName)
    if (!fs.existsSync(file)) {
      failures.push(`local FsusUI artifact is missing: ${file}`)
      continue
    }
    const css = fs.readFileSync(file, 'utf8')
    for (const contract of contracts) {
      if (!css.includes(contract)) failures.push(`${fileName} is missing ${contract}`)
    }
  }
}

for (const file of sourceFiles(path.join(frontendRoot, 'src'))) {
  const source = fs.readFileSync(file, 'utf8')
  if (/:(?:deep|global)\(\.el-public-shell__mobile-nav-menu/u.test(source)) {
    failures.push(`${path.relative(repoRoot, file)} must not override internal FsusUI mobile menu motion`)
  }
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `[local-fsusui-public-shell-motion] ${failure}`).join('\n'))
  process.exit(1)
}

console.log(`[local-fsusui-public-shell-motion] ok root=${fsusUiRoot}`)
