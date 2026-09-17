#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseMatrix } from '../test-matrix/parse-matrix.mjs'

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const rootArgument = process.argv.slice(2).find((argument) => argument.startsWith('--root='))
const root = rootArgument ? path.resolve(rootArgument.slice('--root='.length)) : defaultRoot
const contract = JSON.parse(fs.readFileSync(path.join(root, 'config/testing/producer-execution-class-contract.json'), 'utf8'))
const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'))
const errors = []
const runnerPattern = /run-deterministic-command\.mjs\b/gu
const correctnessRequirements = ['producerId', 'schedulerRunId', 'sourceIdentity']

function runnerInvocations(file, source) {
  if (file === 'config/governance/custom-rule-registry.json') {
    return JSON.parse(source).rules
      .map((rule) => String(rule.execution?.command ?? ''))
      .filter((command) => command.includes('run-deterministic-command.mjs'))
  }
  return [...source.matchAll(runnerPattern)]
    .filter((match) => !source.slice(source.lastIndexOf('\n', match.index) + 1, match.index).includes('--path'))
    .map((match) => source.slice(match.index, match.index + 1200))
}

function invocationKey(invocation) {
  return invocation.match(/--key\s+(?:["']([^"']+)["']|([^\s"'\\]+))/u)?.slice(1).find(Boolean) ?? null
}

if (contract.schema !== 'fsusblog.test-producer-execution-class.v1') errors.push('execution class contract schema is invalid')
if (!contract.canonicalRunnerInvocations
    || typeof contract.canonicalRunnerInvocations !== 'object'
    || Array.isArray(contract.canonicalRunnerInvocations)
    || Object.keys(contract.canonicalRunnerInvocations).length === 0) {
  errors.push('execution class contract must declare canonical runner invocations')
}
for (const tier of matrix.tiers) {
  const evidenceClass = tier.evidenceClass ?? 'correctness'
  const mapping = contract.classes?.[evidenceClass]
  if (!mapping) { errors.push(`${tier.id}: evidenceClass ${evidenceClass} lacks execution class mapping`); continue }
  if (mapping.executionClass === 'correctness'
      && JSON.stringify(mapping.requires) !== JSON.stringify(correctnessRequirements)) {
    errors.push(`${tier.id}: correctness mapping must require producer, scheduler run, and source identity`)
  }
  if (mapping.executionClass === 'diagnostic' && mapping.qualificationEligible !== false) errors.push(`${tier.id}: diagnostic mapping must be unqualified`)
}
for (const [file, expectedKeys] of Object.entries(contract.canonicalRunnerInvocations ?? {})) {
  if (!Array.isArray(expectedKeys) || expectedKeys.length === 0 || expectedKeys.some((key) => typeof key !== 'string' || !key)) {
    errors.push(`${file}: canonical runner invocation keys must be a non-empty string array`)
    continue
  }
  if (new Set(expectedKeys).size !== expectedKeys.length) {
    errors.push(`${file}: canonical runner invocation keys must be unique`)
  }
  const source = fs.readFileSync(path.join(root, file), 'utf8')
  const invocations = runnerInvocations(file, source)
  const actualKeys = []
  for (const invocation of invocations) {
    const key = invocationKey(invocation)
    if (!key) {
      errors.push(`${file}: canonical runner invocation lacks --key`)
      continue
    }
    actualKeys.push(key)
    if (!invocation.includes('--execution-class correctness') || !invocation.includes('--producer-id')) {
      errors.push(`${file}: canonical runner invocation ${key} bypasses correctness execution class or producer identity`)
    }
  }
  if (new Set(actualKeys).size !== actualKeys.length) {
    errors.push(`${file}: canonical runner invocation keys must match the exact inventory without duplicates`)
  }
  for (const key of expectedKeys) {
    if (!actualKeys.includes(key)) errors.push(`${file}: missing canonical runner invocation ${key}`)
  }
  for (const key of actualKeys) {
    if (!expectedKeys.includes(key)) errors.push(`${file}: unexpected canonical runner invocation ${key}`)
  }
}
if (errors.length) { for (const error of errors) console.error(`[execution-class] ${error}`); process.exit(1) }
console.log(`[execution-class] ok tiers=${matrix.tiers.length} correctness=${matrix.tiers.filter(t => contract.classes[t.evidenceClass ?? 'correctness'].executionClass === 'correctness').length}`)
