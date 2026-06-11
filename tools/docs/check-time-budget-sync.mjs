#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { loadMatrix, root } from './lib/matrix.mjs'

const outFile = path.join(root, '.tmp/docs/time-budget-sync.json')
const matrix = loadMatrix()
const errors = []
const ids = new Set()

for (const tier of matrix.tiers) {
  if (ids.has(tier.id)) errors.push(`duplicate tier budget: ${tier.id}`)
  ids.add(tier.id)
  if (!Number.isInteger(tier.timeoutMinutes) || tier.timeoutMinutes < 1) {
    errors.push(`${tier.id}.timeoutMinutes must be a positive integer`)
  }
  if (tier.timeoutMinutes > 240) {
    errors.push(`${tier.id}.timeoutMinutes exceeds the documented 240m ceiling`)
  }
}

const required = ['fast', 'coverage-gate', 'production', 'release-evidence']
for (const tier of required) {
  if (!ids.has(tier)) errors.push(`required budget tier missing: ${tier}`)
}

const summary = {
  status: errors.length === 0 ? 'ok' : 'failed',
  generatedAt: new Date().toISOString(),
  source: 'tests/matrix.yml',
  tierCount: matrix.tiers.length,
  budgets: Object.fromEntries(matrix.tiers.map((tier) => [tier.id, {
    target: `${tier.timeoutMinutes}m`,
    hardTimeout: `${tier.timeoutMinutes}m`,
    source: tier.manualOnly ? 'manual' : tier.nightlyOnly ? 'nightly' : 'github-actions',
    ciJob: tier.ciJob
  }])),
  errors
}

fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`)

if (errors.length > 0) {
  for (const error of errors) console.error(`[time-budget-sync] ${error}`)
  process.exit(1)
}
console.log(`[time-budget-sync] ok tiers=${matrix.tiers.length}`)
