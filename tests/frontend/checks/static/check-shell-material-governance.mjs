#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const failures = []

const rel = (file) => path.relative(repoRoot, file).replaceAll(path.sep, '/')
const read = (file) => fs.readFileSync(file, 'utf8')

const files = {
  publicPage: path.join(repoRoot, 'src/frontend/src/assets/public-page.css'),
  accountShell: path.join(repoRoot, 'src/frontend/src/assets/account-shell.css'),
  accountLayout: path.join(repoRoot, 'src/frontend/src/layouts/AccountLayout.vue'),
  login: path.join(repoRoot, 'src/frontend/src/views/auth/Login.vue'),
  register: path.join(repoRoot, 'src/frontend/src/views/auth/Register.vue'),
  packageJson: path.join(repoRoot, 'src/frontend/package.json')
}

function fail(file, line, message) {
  failures.push(`${rel(file)}:${line}: ${message}`)
}

function hasAllowComment(lines, index) {
  return /fsus-allow-shell-material:/.test(lines[index] ?? '')
    || /fsus-allow-shell-material:/.test(lines[index - 1] ?? '')
}

function checkLines(file, checks) {
  const lines = read(file).split(/\r?\n/)
  lines.forEach((line, index) => {
    if (hasAllowComment(lines, index)) {
      return
    }

    for (const check of checks) {
      if (check.pattern.test(line)) {
        fail(file, index + 1, check.message)
      }
    }
  })
}

checkLines(files.accountShell, [
  {
    pattern: /box-shadow:\s*var\(--fsus-shadow-floating\)/,
    message: 'account shell panels must not use floating shadow material by default'
  },
  {
    pattern: /backdrop-filter:\s*(?:blur|saturate|var|url|opacity|brightness|contrast|drop-shadow|grayscale|hue-rotate|invert|sepia)/,
    message: 'account shell panels must not use backdrop-filter by default'
  }
])

const publicPageCss = read(files.publicPage)
const requiredPublicHeaderTokens = [
  '--fsus-page: #f8f9f7;',
  '--fsus-paper: #ffffff;',
  '--fsus-ink: #0f0f11;',
  '--fsus-dot-gray: #8e8e93;',
  '--fsus-border: #e4e4df;',
  '--fsus-scholarly-blue: #2a599c;',
  '--fsusblog-header-bg: color-mix(in srgb, var(--fsus-paper) 88%, var(--fsus-page));',
  '--fsusblog-header-border: color-mix(in srgb, var(--fsus-border) 82%, transparent);',
  '--el-bg-color: var(--fsusblog-header-bg);',
  '--el-bg-color-page: var(--fsus-page);',
  '--el-border-color-lighter: var(--fsusblog-header-border);'
]

for (const token of requiredPublicHeaderTokens) {
  if (!publicPageCss.includes(token)) {
    fail(files.publicPage, 1, `public header material contract is missing ${token}`)
  }
}

const publicPageLines = publicPageCss.split(/\r?\n/)
let allowPublicPageMaterialBlock = false
publicPageLines.forEach((line, index) => {
  if (/fsus-allow-shell-material:/.test(line)) {
    allowPublicPageMaterialBlock = true
    return
  }

  if (allowPublicPageMaterialBlock) {
    if (/^\s*\}/.test(line)) {
      allowPublicPageMaterialBlock = false
    }
    return
  }

  if (/\.el-public-shell__(?:header|inner|primary-row|mobile-toolbar|mobile-primary-actions|actions|desktop-nav|mobile-nav)/.test(line)) {
    fail(files.publicPage, index + 1, 'public header must use FsusUI tokens instead of deep PublicShell overrides')
  }

  if (/backdrop-filter:\s*(?:blur|saturate|var|url|opacity|brightness|contrast|drop-shadow|grayscale|hue-rotate|invert|sepia)/.test(line)) {
    fail(files.publicPage, index + 1, 'public page/header material must not add backdrop-filter')
  }

  if (/box-shadow:\s*(?:var\(--fsus-shadow-floating\)|0\s+\d|0\s+0\s+\d)/.test(line)) {
    fail(files.publicPage, index + 1, 'public page/header material must not add floating or glow shadows')
  }
})

checkLines(files.accountLayout, [
  {
    pattern: /backdrop-blur/,
    message: 'account sticky header must use a solid surface without backdrop blur'
  },
  {
    pattern: /bg-\[var\(--fsusblog-page-bg\)\]\/\d+/,
    message: 'account sticky header must not use translucent page background'
  }
])

for (const file of [files.login, files.register]) {
  checkLines(file, [
    {
      pattern: /slide-in-from-bottom/,
      message: 'auth forms must not use local slide-in entrance animation'
    }
  ])
}

checkLines(files.login, [
  {
    pattern: /backdrop-blur/,
    message: 'login MFA notice must not use glass/backdrop material'
  },
  {
    pattern: /shadow-\[var\(--fsus-shadow-panel-light\)\]/,
    message: 'login MFA notice must not use floating panel shadow'
  },
  {
    pattern: /bg-\[var\(--fsusblog-panel-bg\)\]\/\d+/,
    message: 'login MFA notice must use a solid background'
  }
])

const packageJson = JSON.parse(read(files.packageJson))
const scripts = packageJson.scripts ?? {}
const checkScript = 'node ../../tests/frontend/checks/static/check-shell-material-governance.mjs'
if (scripts['check:shell-material-governance'] !== checkScript) {
  fail(files.packageJson, 1, 'check:shell-material-governance script is missing')
}
if (!String(scripts['check:views-constraints'] ?? '').includes('check:shell-material-governance')) {
  fail(files.packageJson, 1, 'check:views-constraints must run check:shell-material-governance')
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `[shell-material-governance] ${failure}`).join('\n'))
  process.exit(1)
}

console.log('[shell-material-governance] ok')
