#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const forbiddenToken = 'var(--el-color-'
const scanRoots = [
  'src/views/admin',
  'src/components/admin',
].map((entry) => path.join(frontendRoot, entry))

const textExtensions = new Set([
  '.cjs',
  '.css',
  '.js',
  '.jsx',
  '.less',
  '.mjs',
  '.sass',
  '.scss',
  '.ts',
  '.tsx',
  '.vue',
])

const failures = []

function rel(file) {
  return path.relative(frontendRoot, file).replaceAll(path.sep, '/')
}

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) {
    return files
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(fullPath, files)
      continue
    }

    if (entry.isFile() && textExtensions.has(path.extname(entry.name))) {
      files.push(fullPath)
    }
  }

  return files
}

function checkFile(file) {
  const source = fs.readFileSync(file, 'utf8')
  const lines = source.split(/\r?\n/)

  lines.forEach((line, index) => {
    const column = line.indexOf(forbiddenToken)
    if (column >= 0) {
      failures.push(
        `${rel(file)}:${index + 1}:${column + 1}: admin views/components must use FsusBlog design tokens instead of ${forbiddenToken}`
      )
    }
  })
}

for (const file of scanRoots.flatMap((root) => walk(root))) {
  checkFile(file)
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `[admin-tokens] ${failure}`).join('\n'))
  process.exit(1)
}

console.log(`[admin-tokens] ok roots=${scanRoots.length}`)
