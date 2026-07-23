#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { buildGovernanceSuitePlan, serializeGovernanceSuitePlan } from './governance-suite-plan.mjs'
import { runWeightedCommandManifest } from './run-command-manifest.mjs'
import { sourceIdentity } from './test-asset-audit/preflight.mjs'

const root = path.resolve(new URL('../..', import.meta.url).pathname)
const node = process.env.FSUSBLOG_NODE || process.execPath
const files = String(process.env.FSUSBLOG_STATIC_CONTRACT_FILES ?? '').split('\n').filter(Boolean)
const zdtFile = process.argv[2]
if (files.length === 0 || !zdtFile) throw new Error('static contract files and zero-downtime fixture are required')

const historicalDurationMs = new Map([
  ['gateway-switch.test.mjs', 36_000],
  ['deployment-slots.test.mjs', 32_000],
  ['security-source-analyzer.test.mjs', 12_000],
  ['release-traffic-probe-session.test.mjs', 8_000],
  ['release-rollout-probes.test.mjs', 4_000],
  ['release-rollout-evidence.test.mjs', 3_000]
])

function suiteCommand(suite) {
  const options = suite.isolation === 'none' ? ['--test-isolation=none', '--test-concurrency=1'] : []
  return [node, '--test', ...options, ...suite.files]
}

const suites = buildGovernanceSuitePlan(files)
const planFile = path.join(root, '.tmp/test-governance/suite-plan.json')
fs.mkdirSync(path.dirname(planFile), { recursive: true })
fs.writeFileSync(planFile, `${JSON.stringify(serializeGovernanceSuitePlan(root, suites, sourceIdentity(root)), null, 2)}\n`)

const suiteCommands = suites.map((suite) => ({
  id: `suite:${suite.id}`,
  access: 'read',
  command: suiteCommand(suite),
  estimatedDurationMs: suite.files.reduce((sum, file) => sum + (historicalDurationMs.get(path.basename(file)) ?? 1_000), 0)
}))
const zdtShards = [
  ['all', 1_000],
  ['sigkill-resume', 16_000],
  ['explicit-rollback', 12_000],
  ['post-switch-rollback', 7_000],
  ['normal', 7_000],
  ['base', 1_000]
]
const environment = { ...process.env }
delete environment.FSUSBLOG_COMMAND_MANIFEST_WORKERS
await runWeightedCommandManifest({
  schema: 'fsusblog.test-command-manifest.v1',
  lane: 'static-governance-node-contracts',
  commands: [
    ...suiteCommands,
    ...zdtShards.map(([shard, estimatedDurationMs]) => ({
      id: `zdt:${shard}`,
      access: 'read',
      command: [node, '--test', zdtFile],
      environment: { FSUSBLOG_ZDT_FIXTURE_SHARD: shard },
      concurrencyWeight: Number.MAX_SAFE_INTEGER,
      estimatedDurationMs
    }))
  ]
}, {
  cwd: root,
  env: environment,
  orchestrationWorkersPerCpu: 1,
  orchestrationMemoryGiBPerWorker: process.memoryUsage().rss / 1024 ** 3
})
