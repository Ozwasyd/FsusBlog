#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const allowedClassifications = new Set(['known-flaky', 'unknown-flaky', 'infra-transient', 'benchmark-noise', 'regression'])
const allowedFinalStatuses = new Set(['passed-after-retry', 'failed-after-retry', 'failed-no-retry', 'allow-failure-reported', 'skipped-with-evidence'])

function findFiles(dir, predicate, results = []) {
  if (!fs.existsSync(dir)) return results
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) findFiles(file, predicate, results)
    else if (predicate(file)) results.push(file)
  }
  return results
}

function validate(item, file) {
  const errors = []
  if (item.schema !== 'fsusblog.ci.flaky.v1') errors.push(`${file}: schema must be fsusblog.ci.flaky.v1`)
  for (const field of ['suite', 'classification', 'issue', 'retryCount', 'finalStatus', 'generatedAt']) {
    if (item[field] === undefined || item[field] === null || item[field] === '') errors.push(`${file}: ${field} is required`)
  }
  if (!allowedClassifications.has(item.classification)) errors.push(`${file}: invalid classification ${item.classification}`)
  if (!allowedFinalStatuses.has(item.finalStatus)) errors.push(`${file}: invalid finalStatus ${item.finalStatus}`)
  if (!Number.isInteger(item.issue) || item.issue <= 0) errors.push(`${file}: issue must be a positive integer`)
  if (!Number.isInteger(item.retryCount) || item.retryCount < 0) errors.push(`${file}: retryCount must be zero or greater`)
  if (item.finalStatus === 'passed-after-retry' && item.retryCount < 1) errors.push(`${file}: passed-after-retry requires retryCount >= 1`)
  return errors
}

function main() {
  const roots = [
    path.join(root, '.tmp/release-evidence/flaky'),
    path.join(root, '.tmp/downloaded-artifacts')
  ]
  const files = roots.flatMap((searchRoot) => findFiles(searchRoot, (file) => file.endsWith('.json') && file.includes(`${path.sep}flaky${path.sep}`)))
  const errors = []
  let count = 0
  for (const file of files) {
    let item
    try {
      item = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      errors.push(`${path.relative(root, file)}: ${error.message}`)
      continue
    }
    if (item.schema !== 'fsusblog.ci.flaky.v1') continue
    count += 1
    errors.push(...validate(item, path.relative(root, file)))
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`[flaky-evidence] ${error}`)
    process.exit(1)
  }
  console.log(`[flaky-evidence] ok evidence=${count}`)
}

main()
