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
  let collectingPath = null

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
      collectingPath = null
      jobs.set(currentJob, { needs: new Set(), runs: [], timeoutMinutes: null, uploadPaths: new Set() })
      continue
    }
    if (!currentJob) continue

    const pathMatch = rawLine.match(/^(\s*)path:\s*(.*?)\s*$/)
    if (pathMatch) {
      const [, indent, value] = pathMatch
      collectingPath = value === '|' ? { job: currentJob, indent: indent.length } : null
      if (value && value !== '|') jobs.get(currentJob).uploadPaths.add(value.trim())
      continue
    }

    if (collectingPath?.job === currentJob) {
      const indent = rawLine.match(/^(\s*)/)?.[1].length ?? 0
      if (rawLine.trim() === '') continue
      if (indent > collectingPath.indent) {
        jobs.get(currentJob).uploadPaths.add(rawLine.trim())
        continue
      }
      collectingPath = null
    }

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

function normalizeArtifactPath(value) {
  return String(value ?? '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\/+$/g, '')
}

function baseBeforeGlob(value) {
  const normalized = normalizeArtifactPath(value)
  const globIndex = normalized.search(/[*{]/)
  if (globIndex < 0) return normalized
  return normalized.slice(0, globIndex).replace(/\/+$/g, '')
}

function pathPatternCovers(uploadPattern, expectedPath) {
  const upload = normalizeArtifactPath(uploadPattern)
  const expected = normalizeArtifactPath(expectedPath)
  if (!upload || !expected) return false
  if (upload === expected) return true

  const uploadBase = baseBeforeGlob(upload)
  const expectedBase = baseBeforeGlob(expected)
  if (upload.includes('*') || upload.includes('{')) {
    return expected === uploadBase || expected.startsWith(`${uploadBase}/`) || expectedBase === uploadBase || expectedBase.startsWith(`${uploadBase}/`)
  }
  if (expected.includes('*') || expected.includes('{')) {
    return upload === expectedBase || upload.startsWith(`${expectedBase}/`)
  }
  return false
}

function requiresUpload(pathValue) {
  const value = normalizeArtifactPath(pathValue)
  return value.startsWith('.tmp/')
    || value.startsWith('src/frontend/test-results/')
    || value.startsWith('src/frontend/playwright-report')
    || value.startsWith('BenchmarkDotNet.Artifacts/')
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
    if (command === 'node tools/run-test-matrix.mjs validate' || command === 'node tools/run-test-matrix.mjs preflight') {
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

  for (const jobId of workflowJobs.keys()) {
    if (!requiredJobIds.has(jobId)) {
      errors.push(`workflow job ${jobId} is not declared by required matrix ciJob metadata`)
    }
  }

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

      const uploadPaths = workflowJobs.get(job.id).uploadPaths
      for (const artifact of job.artifacts) {
        if (![...uploadPaths].some((uploadPath) => pathPatternCovers(uploadPath, artifact))) {
          errors.push(`workflow job ${job.id} does not upload matrix artifact: ${artifact}`)
        }
      }
      for (const evidence of job.evidence.filter(requiresUpload)) {
        if (![...uploadPaths].some((uploadPath) => pathPatternCovers(uploadPath, evidence))) {
          errors.push(`workflow job ${job.id} does not upload generated matrix evidence: ${evidence}`)
        }
      }
    }
  }

  for (const [jobId, workflowJob] of workflowJobs.entries()) {
    for (const tierId of coveredTiersForWorkflowJob(workflowJob, tiersById)) {
      const tier = tiersById.get(tierId)
      if (tier?.localOnly === true) errors.push(`workflow job ${jobId} runs local-only matrix tier: ${tierId}`)
      if (tier?.nightlyOnly === true) errors.push(`workflow job ${jobId} runs nightly-only matrix tier: ${tierId}`)
      if (tier?.manualOnly === true) errors.push(`workflow job ${jobId} runs manual-only matrix tier: ${tierId}`)
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
