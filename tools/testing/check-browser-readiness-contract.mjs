#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { glob } from 'node:fs/promises'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const canonicalOwner = 'tests/frontend/support/playwright/readiness.mjs'
const correctnessPatterns = [
  'tests/browser-contract/**/*.mjs',
  'tests/frontend/support/playwright/*.{mjs,ts}',
  'tests/frontend/e2e/acceptance/**/*.{ts,mjs}',
  'tests/frontend/checks/runtime/**/*.mjs',
  'tests/frontend/checks/security/**/*.mjs',
  'tests/frontend/checks/resilience/**/*.mjs'
]

export function inspectBrowserReadinessSource(source, file) {
  const violations = []
  const lines = source.split(/\r?\n/u)
  for (const [index, line] of lines.entries()) {
    if (/waitUntil\s*:\s*['"]networkidle['"]|waitForLoadState\(\s*['"]networkidle['"]/u.test(line)) {
      violations.push(`${file}:${index + 1}: networkidle is not a correctness readiness condition`)
    }
    if (/\.waitForTimeout\s*\(/u.test(line) && file !== canonicalOwner) {
      violations.push(`${file}:${index + 1}: direct page.waitForTimeout is forbidden in correctness assets`)
    }
    if (/\bwaitFor(?:LoadState|Function|URL|Selector)\b.*\.catch\(\s*\(\)\s*=>\s*(?:\{\s*\}|undefined)\s*\)/u.test(line)) {
      violations.push(`${file}:${index + 1}: readiness timeout must not be silently ignored`)
    }
  }
  return violations
}

export function inspectMeasurementHelper(source) {
  const requiredTokens = [
    'runBrowserMeasurementWindow',
    'purpose',
    'maxWindowMs',
    'evidenceClass',
    "'performance'",
    "'soak'",
    'page.waitForTimeout(maxWindowMs)'
  ]
  return requiredTokens
    .filter((token) => !source.includes(token))
    .map((token) => `${canonicalOwner}: approved measurement helper is missing ${token}`)
}

export async function checkBrowserReadinessContract(root = repoRoot) {
  const violations = []
  for (const pattern of correctnessPatterns) {
    for await (const relative of glob(pattern, { cwd: root })) {
      const source = await readFile(path.join(root, relative), 'utf8')
      violations.push(...inspectBrowserReadinessSource(source, relative))
    }
  }
  const ownerSource = await readFile(path.join(root, canonicalOwner), 'utf8')
  violations.push(...inspectMeasurementHelper(ownerSource))
  return violations
}

async function main() {
  const violations = await checkBrowserReadinessContract()
  if (violations.length > 0) {
    throw new Error(`browser readiness contract failed:\n${violations.join('\n')}`)
  }
  console.log('browser readiness contract passed')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
