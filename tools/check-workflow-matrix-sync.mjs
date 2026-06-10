#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const defaultPlanPath = path.join(root, '.tmp/ci-plan.json')
const defaultWorkflowPath = path.join(root, '.github/workflows/quality-gate.yml')
const matrixPath = path.join(root, 'tests/matrix.yml')

function parseValue(raw) {
  const value = String(raw ?? '').trim()
  if (value === '[]') return []
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    if (inner === '') return []
    return inner.split(',').map((item) => parseValue(item))
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function parseMatrix(text) {
  const matrix = { tiers: [] }
  let current = null
  let inTiers = false

  for (const rawLine of text.split(/\r?\n/)) {
    const withoutComment = rawLine.replace(/\s+#.*$/, '')
    if (!withoutComment.trim()) continue

    const topMatch = withoutComment.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/)
    if (topMatch && !rawLine.startsWith(' ')) {
      const [, key, value] = topMatch
      if (key === 'tiers') {
        inTiers = true
        current = null
        continue
      }
      matrix[key] = parseValue(value)
      continue
    }

    if (!inTiers) continue

    const itemMatch = withoutComment.match(/^\s{2}-\s+([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/)
    if (itemMatch) {
      current = {}
      matrix.tiers.push(current)
      current[itemMatch[1]] = parseValue(itemMatch[2])
      continue
    }

    const fieldMatch = withoutComment.match(/^\s{4}([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/)
    if (fieldMatch && current) {
      current[fieldMatch[1]] = parseValue(fieldMatch[2])
    }
  }

  return matrix
}

function loadPlan(planPath) {
  if (fs.existsSync(planPath)) {
    return JSON.parse(fs.readFileSync(planPath, 'utf8'))
  }

  const result = spawnSync('node', ['tools/run-test-matrix.mjs', 'ci-plan', '--format', 'github-actions'], {
    cwd: root,
    encoding: 'utf8'
  })
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) {
    throw new Error(`failed to generate CI plan: node tools/run-test-matrix.mjs ci-plan exited ${result.status}`)
  }
  return JSON.parse(result.stdout)
}

function parseInlineList(value) {
  const trimmed = value.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(',').map((item) => item.trim()).filter(Boolean)
  }
  return [trimmed]
}

function parseWorkflow(text) {
  const jobs = new Map()
  let inJobs = false
  let currentJob = null
  let collectingNeeds = null

  for (const rawLine of text.split(/\r?\n/)) {
    if (/^jobs:\s*$/.test(rawLine)) {
      inJobs = true
      continue
    }
    if (!inJobs) continue

    const jobMatch = rawLine.match(/^  ([A-Za-z0-9_-]+):\s*$/)
    if (jobMatch) {
      currentJob = jobMatch[1]
      collectingNeeds = null
      jobs.set(currentJob, { needs: new Set(), runs: [], timeoutMinutes: null })
      continue
    }
    if (!currentJob) continue

    const timeoutMatch = rawLine.match(/^    timeout-minutes:\s*(\d+)\s*$/)
    if (timeoutMatch) {
      jobs.get(currentJob).timeoutMinutes = Number(timeoutMatch[1])
      continue
    }

    const needsMatch = rawLine.match(/^    needs:\s*(.*?)\s*$/)
    if (needsMatch) {
      const value = needsMatch[1]
      collectingNeeds = value === '' ? currentJob : null
      for (const need of parseInlineList(value)) {
        jobs.get(currentJob).needs.add(need)
      }
      continue
    }

    if (collectingNeeds === currentJob) {
      const itemMatch = rawLine.match(/^      -\s+([A-Za-z0-9_-]+)\s*$/)
      if (itemMatch) {
        jobs.get(currentJob).needs.add(itemMatch[1])
        continue
      }
      if (!/^\s*$/.test(rawLine)) {
        collectingNeeds = null
      }
    }

    const runMatch = rawLine.match(/^      - run:\s*(.*?)\s*$/)
    if (runMatch) {
      jobs.get(currentJob).runs.push(runMatch[1])
    }
  }

  return jobs
}

function planTierClosure(tiersById, targetId, noDeps) {
  if (noDeps) return new Set([targetId])
  const covered = new Set()
  function visit(id) {
    if (covered.has(id)) return
    const tier = tiersById.get(id)
    if (!tier) return
    for (const dep of tier.dependsOn ?? []) visit(dep)
    covered.add(id)
  }
  visit(targetId)
  return covered
}

function coveredTiersForWorkflowJob(job, tiersById) {
  const covered = new Set()
  for (const command of job.runs) {
    if (command === 'node tools/run-test-matrix.mjs validate') {
      covered.add('validate-matrix')
      continue
    }

    const testMatch = command.match(/(?:^|\s)(?:\.\/)?tools\/test\.sh\s+([A-Za-z0-9_-]+)/)
    if (!testMatch) continue

    const tierId = testMatch[1]
    const noDeps = /(?:^|\s)--no-deps(?:\s|$)/.test(command)
    for (const coveredTier of planTierClosure(tiersById, tierId, noDeps)) {
      covered.add(coveredTier)
    }
  }

  return covered
}

function main() {
  const planPath = path.resolve(root, process.argv[2] ?? defaultPlanPath)
  const workflowPath = path.resolve(root, process.argv[3] ?? defaultWorkflowPath)
  const plan = loadPlan(planPath)
  const matrix = parseMatrix(fs.readFileSync(matrixPath, 'utf8'))
  const tiersById = new Map(matrix.tiers.map((tier) => [tier.id, tier]))
  const workflowJobs = parseWorkflow(fs.readFileSync(workflowPath, 'utf8'))
  const errors = []

  const isWorkflowRequiredTier = (tierId) => {
    const tier = tiersById.get(tierId)
    if (!tier) {
      errors.push(`CI plan references missing matrix tier: ${tierId}`)
      return false
    }
    return tier.localOnly !== true && tier.nightlyOnly !== true && tier.manualOnly !== true
  }

  const requiredPlanJobs = plan.jobs.filter((job) => job.tiers.some(isWorkflowRequiredTier))
  const requiredJobIds = new Set(requiredPlanJobs.map((job) => job.id))

  for (const job of requiredPlanJobs) {
    if (!workflowJobs.has(job.id)) {
      errors.push(`workflow is missing matrix ciJob: ${job.id} (tiers: ${job.tiers.join(', ')})`)
      continue
    }

    const actualNeeds = workflowJobs.get(job.id).needs
    const actualTimeout = workflowJobs.get(job.id).timeoutMinutes
    if (actualTimeout !== Number(job.timeoutMinutes)) {
      errors.push(`workflow job ${job.id} timeout-minutes ${actualTimeout ?? 'missing'} does not match ci-plan ${job.timeoutMinutes}`)
    }

    for (const need of job.needs.filter((id) => requiredJobIds.has(id))) {
      if (!actualNeeds.has(need)) {
        errors.push(`workflow job ${job.id} is missing ci-plan dependency: ${need}`)
      }
    }

    if (job.id !== 'production-summary') {
      const coveredTiers = coveredTiersForWorkflowJob(workflowJobs.get(job.id), tiersById)
      for (const tier of job.tiers.filter(isWorkflowRequiredTier)) {
        if (!coveredTiers.has(tier)) {
          errors.push(`workflow job ${job.id} does not run matrix tier: ${tier}`)
        }
      }
    }
  }

  const productionTier = tiersById.get('production')
  for (const dep of productionTier?.dependsOn ?? []) {
    const depTier = tiersById.get(dep)
    if (!depTier || !isWorkflowRequiredTier(dep)) continue
    if (!workflowJobs.has(depTier.ciJob)) {
      errors.push(`production dependency ${dep} maps to missing workflow job: ${depTier.ciJob}`)
    }
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(`[workflow-matrix-sync] ${error}`)
    process.exit(1)
  }

  console.log(`[workflow-matrix-sync] ok (${requiredPlanJobs.length} required jobs)`)
}

try {
  main()
} catch (error) {
  console.error(`[workflow-matrix-sync] ${error.message}`)
  process.exit(1)
}
