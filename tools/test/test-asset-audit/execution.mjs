import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { blockedRequirements } from './preflight.mjs'
import { redactAuditText } from './redaction.mjs'

export { redactAuditText } from './redaction.mjs'

function defaultExecutor(root, command, env) {
  const [executable, ...args] = command
  const result = spawnSync(executable, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`
  }
}

function layerRecords(inventory, layerId) {
  return inventory.assignments.filter((entry) => entry.layerId === layerId)
}

function splitRecords(records, producerTier) {
  return {
    executable: records.filter((entry) => entry.invocationCount > 0 && entry.tierIds.includes(producerTier)),
    outsideProducer: records.filter((entry) => entry.invocationCount > 0 && !entry.tierIds.includes(producerTier)),
    inactive: records.filter((entry) => entry.invocationCount === 0)
  }
}

function blockedLayer(layer, records, missing) {
  const { executable, outsideProducer, inactive } = splitRecords(records, layer.producerTier)
  const skipped = [...outsideProducer, ...inactive]
  return {
    id: layer.id,
    producerTier: layer.producerTier,
    outcome: 'blocked',
    testIds: records.map((entry) => entry.id),
    executedTestIds: [],
    passedTestIds: [],
    failedTestIds: [],
    skippedTestIds: skipped.map((entry) => entry.id),
    blockedTestIds: executable.map((entry) => entry.id),
    counts: { discovered: records.length, executed: 0, passed: 0, failed: 0, skipped: outsideProducer.length + inactive.length, blocked: executable.length },
    unexecuted: [
      ...executable.map((entry) => ({ id: entry.id, reason: `missing-capability:${missing.join(',')}` })),
      ...outsideProducer.map((entry) => ({ id: entry.id, reason: 'canonical-producer-outside-audit-profile' })),
      ...inactive.map((entry) => ({ id: entry.id, reason: 'no-canonical-physical-producer' }))
    ],
    missingRequirements: missing
  }
}

function discoveryLayer(layer, records) {
  return {
    id: layer.id,
    producerTier: layer.producerTier,
    outcome: 'skipped',
    testIds: records.map((entry) => entry.id),
    executedTestIds: [],
    passedTestIds: [],
    failedTestIds: [],
    skippedTestIds: records.map((entry) => entry.id),
    blockedTestIds: [],
    counts: { discovered: records.length, executed: 0, passed: 0, failed: 0, skipped: records.length, blocked: 0 },
    unexecuted: records.map((entry) => ({ id: entry.id, reason: 'non-executable-support-asset' })),
    missingRequirements: []
  }
}

export function executeAuditLayers({ root, profile, preflight, inventory, runId, selectedLayers = null, executor = defaultExecutor, env = process.env }) {
  const receipts = []
  const selected = selectedLayers ? new Set(selectedLayers) : null
  const executionEnv = {
    ...env,
    FSUSBLOG_TEST_AUDIT_RUN_ID: runId,
    FSUSBLOG_TEST_RUN_ID: runId,
    FSUSBLOG_TEST_NAMESPACE: runId,
    FSUSBLOG_TEST_SOURCE_COMMIT: preflight.source.commit,
    FSUSBLOG_TEST_SOURCE_FINGERPRINT: preflight.source.worktreeFingerprint
  }
  for (const layer of profile.layers) {
    const records = layerRecords(inventory, layer.id)
    if (layer.discoveryOnly) {
      receipts.push(discoveryLayer(layer, records))
      continue
    }
    if (selected && !selected.has(layer.id)) {
      receipts.push({ ...discoveryLayer(layer, records), outcome: 'not-requested', unexecuted: records.map((entry) => ({ id: entry.id, reason: 'layer-not-requested' })) })
      continue
    }
    const missing = blockedRequirements(preflight, layer.requirements)
    if (missing.length > 0) {
      receipts.push(blockedLayer(layer, records, missing))
      continue
    }
    const result = executor(root, layer.command, executionEnv)
    const passed = result.status === 0
    const { executable, outsideProducer, inactive } = splitRecords(records, layer.producerTier)
    const logPath = path.join(root, '.tmp/test-asset-audit/logs', `${layer.id}.log`)
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.writeFileSync(logPath, redactAuditText(result.output, env))
    receipts.push({
      id: layer.id,
      producerTier: layer.producerTier,
      outcome: passed ? 'passed' : 'failed',
      testIds: records.map((entry) => entry.id),
      executedTestIds: executable.map((entry) => entry.id),
      passedTestIds: passed ? executable.map((entry) => entry.id) : [],
      failedTestIds: passed ? [] : executable.map((entry) => entry.id),
      skippedTestIds: [...outsideProducer, ...inactive].map((entry) => entry.id),
      blockedTestIds: [],
      counts: {
        discovered: records.length,
        executed: executable.length,
        passed: passed ? executable.length : 0,
        failed: passed ? 0 : executable.length,
        skipped: outsideProducer.length + inactive.length,
        blocked: 0
      },
      unexecuted: [
        ...outsideProducer.map((entry) => ({ id: entry.id, reason: 'canonical-producer-outside-audit-profile' })),
        ...inactive.map((entry) => ({ id: entry.id, reason: 'no-canonical-physical-producer' }))
      ],
      missingRequirements: [],
      exitCode: result.status,
      log: path.relative(root, logPath).split(path.sep).join('/'),
      evidenceBasis: 'canonical-producer-outcome-with-authoritative-test-id-union'
    })
  }
  return receipts
}

export function summarizeAuditLayers(receipts) {
  const totals = receipts.reduce((sum, receipt) => {
    for (const key of ['discovered', 'executed', 'passed', 'failed', 'skipped', 'blocked']) {
      sum[key] += receipt.counts[key]
    }
    return sum
  }, { discovered: 0, executed: 0, passed: 0, failed: 0, skipped: 0, blocked: 0 })
  return {
    outcome: receipts.some((entry) => entry.outcome === 'failed')
      ? 'failed'
      : receipts.some((entry) => entry.outcome === 'blocked')
        ? 'blocked'
        : 'passed',
    totals
  }
}
