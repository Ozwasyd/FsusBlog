#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const failures = []

const rel = (file) => path.relative(repoRoot, file).replaceAll(path.sep, '/')
const read = (file) => fs.readFileSync(file, 'utf8')

const files = {
  accountShell: path.join(repoRoot, 'src/frontend/src/assets/account-shell.css'),
  accountLayout: path.join(repoRoot, 'src/frontend/src/layouts/AccountLayout.vue'),
  login: path.join(repoRoot, 'src/frontend/src/views/auth/Login.vue'),
  register: path.join(repoRoot, 'src/frontend/src/views/auth/Register.vue'),
  mobileActionBar: path.join(repoRoot, 'src/frontend/src/components/article/ArticleMobileActionBar.vue'),
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

checkLines(files.mobileActionBar, [
  {
    pattern: /backdrop-filter:\s*(?:blur|saturate|var|url|opacity|brightness|contrast|drop-shadow|grayscale|hue-rotate|invert|sepia)/,
    message: 'mobile article action bar must not blur reading content underneath'
  },
  {
    pattern: /background:\s*color-mix\([^;]*transparent\)/,
    message: 'mobile article action bar must use a solid surface background'
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
