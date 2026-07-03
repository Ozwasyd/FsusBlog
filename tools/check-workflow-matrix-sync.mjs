#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const defaultPlanPath = path.join(root, '.tmp/ci-plan.json')
const defaultWorkflowPath = path.join(root, '.github/workflows/quality-gate.yml')
const matrixPath = process.env.FSUSBLOG_MATRIX_FILE
  ? path.resolve(root, process.env.FSUSBLOG_MATRIX_FILE)
  : path.join(root, 'tests/matrix.yml')
const requiredActorDimensionPrefixes = ['anonymous-account-', 'admin-principal-']
const requiredIdentityKindDimensions = ['identity-kind-anonymous-account', 'identity-kind-admin-principal']

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

function normalizeYamlScalar(value) {
  return String(value ?? '').trim().replace(/^['"]|['"]$/g, '')
}

function combineCacheProfile(left, right) {
  const frontend = left === 'frontend' || left === 'full' || right === 'frontend' || right === 'full'
  const backend = left === 'backend' || left === 'full' || right === 'backend' || right === 'full'
  return frontend && backend ? 'full' : frontend ? 'frontend' : backend ? 'backend' : 'none'
}

function combinePlaywrightRequirement(left, right) {
  if (left === 'all' || right === 'all') return 'all'
  if (left === 'chromium' || right === 'chromium') return 'chromium'
  return 'none'
}

function usesAction(text, action, majorVersion) {
  const escapedAction = action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const escapedVersion = majorVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`uses:\\s*${escapedAction}@(?:${escapedVersion}|[a-f0-9]{40}\\s*#\\s*${escapedVersion})(?:\\s|$)`, 'u').test(text)
}

function annotateWorkflowJob(job) {
  const text = job.lines.join('\n')
  job.hasSetupNode = /uses:\s*actions\/setup-node@/.test(text)
  job.hasSetupDotnet = /uses:\s*actions\/setup-dotnet@/.test(text)
  job.nodeCacheDependencyPaths = new Set([...text.matchAll(/cache-dependency-path:\s*(.*?)\s*$/gm)].map((match) => normalizeYamlScalar(match[1])))
  job.hasNpmLockCache = /cache:\s*npm/.test(text) && job.nodeCacheDependencyPaths.has('src/frontend/package-lock.json')
  job.hasNugetCache = usesAction(text, 'actions/cache', 'v4')
    && /path:\s*~\/\.nuget\/packages/.test(text)
    && /key:\s*nuget-\$\{\{\s*runner\.os\s*\}\}-\$\{\{\s*hashFiles\(/.test(text)
    && text.includes('**/*.csproj')
    && text.includes('**/*.props')
    && text.includes('**/*.targets')
    && text.includes('global.json')
    && text.includes('NuGet.config')
  job.hasPlaywrightCache = usesAction(text, 'actions/cache', 'v4')
    && /path:\s*~\/\.cache\/ms-playwright/.test(text)
    && /key:\s*playwright-\$\{\{\s*runner\.os\s*\}\}-\$\{\{\s*hashFiles\('src\/frontend\/package-lock\.json'\)/.test(text)
  job.npmCiCommands = job.runs.filter((command) => /(?:^|\s)npm\s+--prefix\s+src\/frontend\s+ci(?:\s|$)/.test(command))
  job.playwrightInstallCommands = job.runs.filter((command) => /playwright\s+install/.test(command))
  job.flakyGovernedCommands = job.runs.filter((command) => /tools\/ci\/run-flaky-governed\.mjs/.test(command))
  job.usesMatrixTierCommand = /(?:^|\s)(?:\.\/)?tools\/test\.sh\s+ci-tier\s+\$\{\{\s*matrix\.tier\s*\}\}\s+--no-deps(?:\s|$)/.test(text)
  job.usesGeneratedFastBackendMatrix = /matrix:\s*\$\{\{\s*fromJson\(needs\.validate-matrix\.outputs\.fast_backend_matrix\)\s*\}\}/.test(text)
  job.usesGeneratedFastBackendMaxParallel = /max-parallel:\s*\$\{\{\s*fromJson\(needs\.validate-matrix\.outputs\.fast_backend_max_parallel\)\s*\}\}/.test(text)
  job.generatesFastBackendMatrix = /node tools\/run-test-matrix\.mjs ci-job-matrix fast-backend --github-output "\$GITHUB_OUTPUT"/.test(text)
  job.usesFastSummaryAggregate = /node tools\/run-test-matrix\.mjs aggregate fast-summary(?:\s|$)/.test(text)
  job.usesMatrixPlaywrightWorkers = /FSUSBLOG_PLAYWRIGHT_WORKERS:\s*\$\{\{\s*matrix\.playwright_workers\s*\}\}/.test(text)
  job.playwrightWorkerEnvValues = new Set([...text.matchAll(/FSUSBLOG_PLAYWRIGHT_WORKERS:\s*['"]?(\d+)['"]?/g)].map((match) => Number(match[1])))
  job.downloadsFastBackendArtifacts = /uses:\s*actions\/download-artifact@/.test(text) && /pattern:\s*fast-backend-\*/.test(text)
  job.downloadsFrontendBuildArtifacts = /uses:\s*actions\/download-artifact@/.test(text) && /name:\s*frontend-build/.test(text)
  job.downloadsFastFrontendArtifacts = /uses:\s*actions\/download-artifact@/.test(text) && /pattern:\s*fast-frontend-unit-\*/.test(text)
  job.downloadsFrontendRuntimeContractsArtifacts = /uses:\s*actions\/download-artifact@/.test(text) && /name:\s*frontend-runtime-contracts/.test(text)
  job.downloadsFrontendStaticGovernanceArtifacts = /uses:\s*actions\/download-artifact@/.test(text) && /name:\s*frontend-static-governance/.test(text)
  job.downloadsFastStaticArtifacts = /uses:\s*actions\/download-artifact@/.test(text) && /name:\s*fast-static-governance/.test(text)
  job.referencesValidateMatrixOutputs = /needs\.validate-matrix\.outputs\./.test(text)
  return job
}

function workflowHasGlobalPlaywrightWorkers(text) {
  const jobsIndex = text.search(/^jobs:\s*$/m)
  const header = jobsIndex >= 0 ? text.slice(0, jobsIndex) : text
  return /^env:\s*$[\s\S]*?^  FSUSBLOG_PLAYWRIGHT_WORKERS:/m.test(header)
}

function validateMatrixCoverageDimensions(tiers, errors) {
  const coverageIds = new Set(tiers.flatMap((tier) => Array.isArray(tier.coverage) ? tier.coverage : []))

  for (const prefix of requiredActorDimensionPrefixes) {
    if (![...coverageIds].some((id) => id.startsWith(prefix))) {
      errors.push(`matrix coverage dimensions missing required actor prefix: ${prefix}*`)
    }
  }

  for (const dimension of requiredIdentityKindDimensions) {
    if (!coverageIds.has(dimension)) {
      errors.push(`matrix coverage dimensions missing required identity kind: ${dimension}`)
    }
  }

  for (const id of coverageIds) {
    if (id.startsWith('endpoint-role-protocol-') && !id.includes('deprecated')) {
      errors.push(`matrix coverage dimension ${id} uses legacy endpoint-role-protocol naming without deprecated marker`)
    }
  }
}

function parseWorkflow(text) {
  const jobs = new Map()
  let inJobs = false
  let currentJob = null
  let collectingNeeds = null
  let collectingPath = null
  let collectingRun = null

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
      collectingRun = null
      jobs.set(currentJob, { needs: new Set(), runs: [], timeoutMinutes: null, maxParallel: null, maxParallelOutput: null, uploadPaths: new Set(), lines: [] })
      continue
    }
    if (!currentJob) continue
    jobs.get(currentJob).lines.push(rawLine)

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

    if (collectingRun?.job === currentJob) {
      const indent = rawLine.match(/^(\s*)/)?.[1].length ?? 0
      if (rawLine.trim() === '') continue
      if (indent > collectingRun.indent) {
        jobs.get(currentJob).runs.push(rawLine.trim())
        continue
      }
      collectingRun = null
    }

    const timeoutMatch = rawLine.match(/^    timeout-minutes:\s*(\d+)\s*$/)
    if (timeoutMatch) {
      jobs.get(currentJob).timeoutMinutes = Number(timeoutMatch[1])
      continue
    }

    const maxParallelMatch = rawLine.match(/^\s+max-parallel:\s*(\d+)\s*$/)
    if (maxParallelMatch) {
      jobs.get(currentJob).maxParallel = Number(maxParallelMatch[1])
      continue
    }
    const maxParallelOutputMatch = rawLine.match(/^\s+max-parallel:\s*\$\{\{\s*fromJson\(needs\.(?:validate-matrix|plan-pr-risk)\.outputs\.([A-Za-z0-9_]+_max_parallel)\)\s*\}\}\s*$/)
    if (maxParallelOutputMatch) {
      jobs.get(currentJob).maxParallelOutput = maxParallelOutputMatch[1]
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

    const runMatch = rawLine.match(/^(\s*)-\s+run:\s*(.*?)\s*$/) ?? rawLine.match(/^(\s*)run:\s*(.*?)\s*$/)
    if (runMatch) {
      const [, indent, value] = runMatch
      if (value === '|' || value === '>') {
        collectingRun = { job: currentJob, indent: indent.length }
      } else {
        jobs.get(currentJob).runs.push(value)
      }
    }
  }

  for (const job of jobs.values()) annotateWorkflowJob(job)
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

function coveredTiersForWorkflowJob(job, tiersById, plannedTierIds = []) {
  const covered = new Set()
  if (job.usesMatrixTierCommand) {
    for (const tierId of plannedTierIds) covered.add(tierId)
  }
  if (job.usesFastSummaryAggregate) {
    for (const tierId of plannedTierIds) covered.add(tierId)
  }
  for (const command of job.runs) {
    if (command === 'node tools/run-test-matrix.mjs validate' || command === 'node tools/run-test-matrix.mjs preflight') {
      covered.add('validate-matrix')
      continue
    }
    if (/node\s+tools\/run-test-matrix\.mjs\s+ci-pr-plan(?:\s|$)/.test(command)) {
      covered.add('pr-smart-gate-plan')
      continue
    }

    const testMatch = command.match(/(?:^|\s)(?:\.\/)?tools\/test\.sh\s+(?:ci-tier\s+)?([A-Za-z0-9_-]+)/)
    if (!testMatch) continue
    if (/\$\{\{\s*matrix\.tier\s*\}\}/.test(command)) continue

    const tierId = testMatch[1]
    const noDeps = /(?:^|\s)--no-deps(?:\s|$)/.test(command)
    for (const coveredTier of planTierClosure(tiersById, tierId, noDeps)) {
      covered.add(coveredTier)
    }
  }

  return covered
}

function validateGeneratedFastBackendMatrix(workflowJob, planJob, tiersById, errors) {
  if (planJob.id !== 'fast-backend') return

  const fastBackendTiers = planJob.tiers
    .map((tierId) => tiersById.get(tierId))
    .filter(Boolean)

  if (fastBackendTiers.length <= 1) return

  const canRunAsGeneratedMatrix = fastBackendTiers.every((tier) =>
    tier.parallelizable === true
    && (tier.exclusiveResources?.length ?? 0) === 0
    && (tier.services?.length ?? 0) === 0
  )
  if (!canRunAsGeneratedMatrix) return

  if (!workflowJob.usesGeneratedFastBackendMatrix) {
    errors.push('workflow job fast-backend must use the generated fast_backend_matrix from validate-matrix outputs')
  }
  if (!workflowJob.usesGeneratedFastBackendMaxParallel) {
    errors.push('workflow job fast-backend must use the generated fast_backend_max_parallel from validate-matrix outputs')
  }
  if (!workflowJob.usesMatrixTierCommand) {
    errors.push('workflow job fast-backend must run exactly one ci-tier per matrix tier')
  }

  const serialBackendRuns = workflowJob.runs.filter((command) =>
    /(?:^|\s)(?:\.\/)?tools\/test\.sh\s+(?:backend-fast|backend-auth-state-machine|backend-concurrency|backend-property|backend-golden)\s+--no-deps(?:\s|$)/.test(command)
  )
  if (serialBackendRuns.length > 1) {
    errors.push(`workflow job fast-backend serially runs ${serialBackendRuns.length} backend fast tiers instead of the generated matrix`)
  }
}

function validateFastSummaryAggregate(workflowJob, planJob, errors) {
  if (planJob.id !== 'fast-summary') return

  const testRuns = workflowJob.runs.filter((command) => /(?:^|\s)(?:\.\/)?tools\/test\.sh(?:\s|$)/.test(command))
  if (testRuns.length > 0) {
    errors.push(`workflow job fast-summary must be artifact-only, but runs test commands: ${testRuns.join('; ')}`)
  }
  if (!workflowJob.usesFastSummaryAggregate) {
    errors.push('workflow job fast-summary must aggregate artifacts with tools/run-test-matrix.mjs aggregate fast-summary')
  }
  if (!workflowJob.downloadsFastBackendArtifacts) {
    errors.push('workflow job fast-summary must download fast-backend-* artifacts before aggregating')
  }
  if (!workflowJob.downloadsFrontendBuildArtifacts) {
    errors.push('workflow job fast-summary must download frontend-build artifacts before aggregating')
  }
  if (!workflowJob.downloadsFastFrontendArtifacts) {
    errors.push('workflow job fast-summary must download fast-frontend-unit artifacts before aggregating')
  }
  if (!workflowJob.downloadsFrontendRuntimeContractsArtifacts) {
    errors.push('workflow job fast-summary must download frontend-runtime-contracts artifacts before aggregating')
  }
  if (!workflowJob.downloadsFrontendStaticGovernanceArtifacts) {
    errors.push('workflow job fast-summary must download frontend-static-governance artifacts before aggregating')
  }
  if (!workflowJob.downloadsFastStaticArtifacts) {
    errors.push('workflow job fast-summary must download fast-static-governance artifacts before aggregating')
  }
}

function setupRequirementsForTiers(tierIds, tiersById) {
  const requirements = {
    requiresNode: false,
    requiresDotnet: false,
    requiresPlaywright: 'none',
    cacheProfile: 'none',
    requiresBootstrap: 'none',
    playwrightWorkerValues: new Set(),
    missingPlaywrightWorkerTiers: []
  }
  for (const tierId of tierIds) {
    const tier = tiersById.get(tierId)
    if (!tier) continue
    requirements.requiresNode = requirements.requiresNode || tier.requiresNode === true
    requirements.requiresDotnet = requirements.requiresDotnet || tier.requiresDotnet === true
    requirements.requiresPlaywright = combinePlaywrightRequirement(requirements.requiresPlaywright, tier.requiresPlaywright)
    if (tier.requiresPlaywright !== 'none') {
      if (Number.isInteger(tier.playwrightWorkers) && tier.playwrightWorkers >= 1) {
        requirements.playwrightWorkerValues.add(Number(tier.playwrightWorkers))
      } else {
        requirements.missingPlaywrightWorkerTiers.push(tier.id)
      }
    }
    requirements.cacheProfile = combineCacheProfile(requirements.cacheProfile, tier.cacheProfile)
    requirements.requiresBootstrap = combineCacheProfile(requirements.requiresBootstrap, tier.requiresBootstrap)
  }
  return requirements
}

function bootstrapExecutionsForWorkflowJob(job, tiersById) {
  let count = 0
  for (const command of job.runs) {
    const testMatch = command.match(/(?:^|\s)(?:\.\/)?tools\/test\.sh\s+(?:ci-tier\s+)?([A-Za-z0-9_-]+)/)
    if (!testMatch) continue

    const tierId = testMatch[1]
    const noDeps = /(?:^|\s)--no-deps(?:\s|$)/.test(command)
    if (noDeps) {
      if (tierId === 'bootstrap') count += 1
      continue
    }
    if (planTierClosure(tiersById, tierId, false).has('bootstrap')) count += 1
  }
  return count
}

function manualBootstrapExecutionsForWorkflowJob(job) {
  return job.runs.filter((command) =>
    /(?:^|\s)(?:\.\/)?tools\/test\.sh\s+(?:ci-tier\s+)?bootstrap\s+--no-deps(?:\s|$)/.test(command)
  ).length
}

function planJobCoversBootstrap(planJob, tiersById) {
  return (planJob?.tiers ?? []).some((tierId) => planTierClosure(tiersById, tierId, false).has('bootstrap'))
}

function workflowJobHasBootstrapSource(workflowJob, actualNeeds, planJobsById, tiersById) {
  if (manualBootstrapExecutionsForWorkflowJob(workflowJob) > 0) return true
  for (const need of actualNeeds) {
    if (planJobCoversBootstrap(planJobsById.get(need), tiersById)) return true
  }
  return false
}

function validateWorkflowBootstrapMetadata(jobId, workflowJob, actualNeeds, planJobsById, tiersById, coveredTiers, errors) {
  const manualBootstrapCount = manualBootstrapExecutionsForWorkflowJob(workflowJob)
  if (manualBootstrapCount > 0) {
    for (const tierId of coveredTiers) {
      if (tierId === 'bootstrap') continue
      const tier = tiersById.get(tierId)
      if (tier?.requiresBootstrap !== 'none' && tier?.workflowBootstraps !== true) {
        errors.push(`workflow job ${jobId} manually runs bootstrap but tier ${tierId} does not declare workflowBootstraps=true`)
      }
    }
  }

  const hasBootstrapSource = workflowJobHasBootstrapSource(workflowJob, actualNeeds, planJobsById, tiersById)
  for (const tierId of coveredTiers) {
    const tier = tiersById.get(tierId)
    if (tier?.workflowBootstraps === true && !hasBootstrapSource) {
      errors.push(`workflow job ${jobId} covers workflowBootstraps tier ${tierId} but has no manual bootstrap step or bootstrap-producing need`)
    }
  }
}

function validateWorkflowSetup(jobId, workflowJob, requirements, errors) {
  const needsFrontendCache = requirements.cacheProfile === 'frontend' || requirements.cacheProfile === 'full'
  const needsBackendCache = requirements.cacheProfile === 'backend' || requirements.cacheProfile === 'full'

  if (requirements.requiresNode && !workflowJob.hasSetupNode) {
    errors.push(`workflow job ${jobId} requires Node but has no actions/setup-node step`)
  }
  if (workflowJob.npmCiCommands.length > 0 && !workflowJob.hasNpmLockCache) {
    errors.push(`workflow job ${jobId} runs npm ci without setup-node npm cache keyed by src/frontend/package-lock.json`)
  }
  for (const command of [...workflowJob.npmCiCommands, ...workflowJob.playwrightInstallCommands]) {
    if (!/node\s+tools\/ci\/run-stage\.mjs\s+--stage\s+install\s+--/.test(command)) {
      errors.push(`workflow job ${jobId} install command is not timed through tools/ci/run-stage.mjs: ${command}`)
    }
  }
  if (needsFrontendCache && workflowJob.npmCiCommands.length === 0) {
    errors.push(`workflow job ${jobId} declares frontend cacheProfile but does not run npm --prefix src/frontend ci`)
  }
  if (requirements.requiresDotnet && !workflowJob.hasSetupDotnet) {
    errors.push(`workflow job ${jobId} requires .NET but has no actions/setup-dotnet step`)
  }
  if (needsBackendCache && !workflowJob.hasNugetCache) {
    errors.push(`workflow job ${jobId} declares backend cacheProfile but does not use deterministic NuGet cache`)
  }
  if (requirements.requiresPlaywright !== 'none') {
    const expectedWorkerValues = [...requirements.playwrightWorkerValues].sort((left, right) => left - right)
    if (requirements.missingPlaywrightWorkerTiers.length > 0) {
      errors.push(`workflow job ${jobId} covers Playwright tiers without playwrightWorkers: ${requirements.missingPlaywrightWorkerTiers.join(', ')}`)
    } else if (workflowJob.usesMatrixTierCommand) {
      if (!workflowJob.usesMatrixPlaywrightWorkers) {
        errors.push(`workflow job ${jobId} must pass FSUSBLOG_PLAYWRIGHT_WORKERS from matrix.playwright_workers`)
      }
    } else if (expectedWorkerValues.length === 1) {
      const expected = expectedWorkerValues[0]
      if (!workflowJob.playwrightWorkerEnvValues.has(expected) && !workflowJob.usesMatrixPlaywrightWorkers) {
        errors.push(`workflow job ${jobId} must set FSUSBLOG_PLAYWRIGHT_WORKERS=${expected} from matrix tier policy`)
      }
    } else if (!workflowJob.usesMatrixPlaywrightWorkers) {
      errors.push(`workflow job ${jobId} covers multiple Playwright worker policies (${expectedWorkerValues.join(', ')}); use matrix.playwright_workers`)
    }
    if (!workflowJob.hasPlaywrightCache) {
      errors.push(`workflow job ${jobId} requires Playwright but does not cache ~/.cache/ms-playwright with src/frontend/package-lock.json`)
    }
    if (workflowJob.playwrightInstallCommands.length === 0) {
      errors.push(`workflow job ${jobId} requires Playwright but has no playwright install step`)
    }
    const installCommand = workflowJob.playwrightInstallCommands.join(' && ')
    if (requirements.requiresPlaywright === 'chromium' && !/playwright\s+install\s+--with-deps\s+chromium(?:\s|$)/.test(installCommand)) {
      errors.push(`workflow job ${jobId} must install only chromium for requiresPlaywright=chromium`)
    }
    if (requirements.requiresPlaywright === 'all' && !/\$\{\{\s*matrix\.browser\s*\}\}/.test(installCommand)) {
      errors.push(`workflow job ${jobId} must install the matrix browser for requiresPlaywright=all`)
    }
    if (workflowJob.flakyGovernedCommands.length === 0) {
      errors.push(`workflow job ${jobId} requires Playwright but does not run through tools/ci/run-flaky-governed.mjs`)
    }
  } else if (workflowJob.flakyGovernedCommands.length > 0) {
    errors.push(`workflow job ${jobId} uses flaky retry governance without requiresPlaywright metadata`)
  }
}

function main() {
  const planPath = path.resolve(root, process.argv[2] ?? defaultPlanPath)
  const workflowPath = path.resolve(root, process.argv[3] ?? defaultWorkflowPath)
  const plan = loadPlan(planPath)
  const matrix = parseMatrix(fs.readFileSync(matrixPath, 'utf8'))
  const tiersById = new Map(matrix.tiers.map((tier) => [tier.id, tier]))
  const workflowText = fs.readFileSync(workflowPath, 'utf8')
  const workflowJobs = parseWorkflow(workflowText)
  const errors = []

  if (workflowHasGlobalPlaywrightWorkers(workflowText)) {
    errors.push('workflow must not set FSUSBLOG_PLAYWRIGHT_WORKERS globally; use matrix tier playwrightWorkers policy')
  }
  validateMatrixCoverageDimensions(matrix.tiers, errors)

  const isWorkflowRequiredTier = (tierId) => {
    const tier = tiersById.get(tierId)
    if (!tier) {
      errors.push(`CI plan references missing matrix tier: ${tierId}`)
      return false
    }
    return tier.localOnly !== true && tier.nightlyOnly !== true && tier.manualOnly !== true
  }

  const requiredPlanJobs = plan.jobs.filter((job) => job.tiers.some(isWorkflowRequiredTier))
  const planJobsById = new Map(plan.jobs.map((job) => [job.id, job]))
  const requiredJobIds = new Set(requiredPlanJobs.map((job) => job.id))

  if (requiredJobIds.has('fast-backend') && !workflowJobs.get('validate-matrix')?.generatesFastBackendMatrix) {
    errors.push('workflow job validate-matrix must generate fast_backend_matrix through tools/run-test-matrix.mjs ci-job-matrix')
  }

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
    const workflowJob = workflowJobs.get(job.id)
    if (workflowJob.referencesValidateMatrixOutputs && !actualNeeds.has('validate-matrix')) {
      errors.push(`workflow job ${job.id} reads needs.validate-matrix.outputs but does not declare validate-matrix in needs`)
    }
    const actualTimeout = workflowJobs.get(job.id).timeoutMinutes
    const actualMaxParallel = workflowJobs.get(job.id).maxParallel
    if (actualTimeout !== Number(job.timeoutMinutes)) {
      errors.push(`workflow job ${job.id} timeout-minutes ${actualTimeout ?? 'missing'} does not match ci-plan ${job.timeoutMinutes}`)
    }
    const jobHasShards = job.tiers.some((tierId) => tiersById.get(tierId)?.shardable === true)
    const expectedMaxParallelOutput = `${job.id.replaceAll('-', '_')}_max_parallel`
    const usesExpectedMaxParallelOutput = workflowJob.maxParallelOutput === expectedMaxParallelOutput
    if (jobHasShards && actualMaxParallel !== Number(job.maxParallel) && !usesExpectedMaxParallelOutput) {
      errors.push(`workflow job ${job.id} max-parallel ${actualMaxParallel ?? 'missing'} does not match ci-plan ${job.maxParallel}`)
    }

    for (const need of job.needs.filter((id) => requiredJobIds.has(id))) {
      if (!actualNeeds.has(need)) {
        errors.push(`workflow job ${job.id} is missing ci-plan dependency: ${need}`)
      }
    }

    if (job.id !== 'production-summary') {
      validateGeneratedFastBackendMatrix(workflowJob, job, tiersById, errors)
      validateFastSummaryAggregate(workflowJob, job, errors)
      const coveredTiers = coveredTiersForWorkflowJob(workflowJob, tiersById, job.tiers)
      validateWorkflowBootstrapMetadata(job.id, workflowJob, actualNeeds, planJobsById, tiersById, coveredTiers, errors)
      validateWorkflowSetup(job.id, workflowJob, setupRequirementsForTiers(coveredTiers, tiersById), errors)
      const bootstrapCount = bootstrapExecutionsForWorkflowJob(workflowJob, tiersById)
      if (bootstrapCount > 1) {
        errors.push(`workflow job ${job.id} runs bootstrap ${bootstrapCount} times; bootstrap must run at most once per job`)
      }
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
    const plannedTierIds = plan.jobs.find((job) => job.id === jobId)?.tiers ?? []
    for (const tierId of coveredTiersForWorkflowJob(workflowJob, tiersById, plannedTierIds)) {
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
