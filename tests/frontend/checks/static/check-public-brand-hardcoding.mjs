#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const failures = [];
const generatedPublicWasmRoot = path.join(repoRoot, 'src/frontend/public/wasm');

const rel = (file) => path.relative(repoRoot, file).replaceAll(path.sep, '/');
const read = (file) => fs.readFileSync(file, 'utf8');

const targetRoots = [
  'src/frontend/index.html',
  'src/frontend/src/components/public',
  'src/frontend/src/bootstrap',
  'src/frontend/public'
].map((entry) => path.join(repoRoot, entry))

const packageJsonPath = path.join(repoRoot, 'src/frontend/package.json')
const forbiddenTokens = [
  'FsusBlog',
  "Fsu's Blog",
  'Loading...',
  'Initializing Engine'
]

function fail(file, line, message) {
  failures.push(`${rel(file)}:${line}: ${message}`)
}

function walk(entry, files = []) {
  if (entry === generatedPublicWasmRoot) {
    return files
  }
  if (!fs.existsSync(entry)) {
    return files
  }

  const stat = fs.statSync(entry)
  if (stat.isFile()) {
    files.push(entry)
    return files
  }

  for (const dirent of fs.readdirSync(entry, { withFileTypes: true })) {
    const fullPath = path.join(entry, dirent.name)
    if (dirent.isDirectory()) {
      walk(fullPath, files)
      continue
    }

    if (dirent.isFile() && /\.(html|vue|ts|js|mjs|json|webmanifest)$/.test(dirent.name)) {
      files.push(fullPath)
    }
  }

  return files
}

function hasAllowComment(lines, index) {
  return /fsus-allow-public-brand-fallback:/.test(lines[index] ?? '')
    || /fsus-allow-public-brand-fallback:/.test(lines[index - 1] ?? '')
}

for (const file of targetRoots.flatMap((entry) => walk(entry))) {
  const lines = read(file).split(/\r?\n/)
  lines.forEach((line, index) => {
    if (hasAllowComment(lines, index)) {
      return
    }

    for (const token of forbiddenTokens) {
      if (line.includes(token)) {
        fail(file, index + 1, `public first-paint shell must not hard-code "${token}"`)
      }
    }
  })
}

const packageJson = JSON.parse(read(packageJsonPath))
const scripts = packageJson.scripts ?? {}
const checkScript = 'node ../../tests/frontend/checks/static/check-public-brand-hardcoding.mjs'
if (scripts['check:public-brand-hardcoding'] !== checkScript) {
  fail(packageJsonPath, 1, 'check:public-brand-hardcoding script is missing')
}
if (!String(scripts['check:views-constraints'] ?? '').includes('check:public-brand-hardcoding')) {
  fail(packageJsonPath, 1, 'check:views-constraints must run check:public-brand-hardcoding')
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `[public-brand-hardcoding] ${failure}`).join('\n'))
  process.exit(1)
}

console.log('[public-brand-hardcoding] ok')
