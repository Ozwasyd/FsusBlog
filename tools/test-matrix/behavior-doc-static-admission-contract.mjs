import fs from 'node:fs'
import path from 'node:path'

export const behaviorDocStaticAdmissionTierId = 'behavior-doc-static-admission'
export const behaviorDocStaticAdmissionReceiptSchema =
  'fsusblog.behavior-doc-static-admission-receipt.v1'
export const behaviorDocStaticAdmissionCommand =
  'node tools/docs/behavior-doc-static-admission.mjs'
export const behaviorDocStaticAdmissionReceiptPath =
  '.tmp/behavior-doc-static-admission/receipt.json'

export const localBehaviorDocCandidateBundleIds = Object.freeze([
  'build-static',
  'backend-tests',
  'frontend-tests',
  'runtime-browser'
])

const purePreAdmissionTierContracts = Object.freeze({
  'validate-matrix': Object.freeze({
    command: 'tools/test/run-matrix-governance-once.sh validate-matrix',
    executionDependsOn: []
  }),
  'pr-smart-gate-plan': Object.freeze({
    command: 'node tools/run-test-matrix.mjs ci-pr-plan --out .tmp/pr-plan.json',
    executionDependsOn: ['validate-matrix']
  })
})

const directBehaviorDocAuthorityPattern =
  /(?:behavior-contract-catalog|check-doc-claim|check-prose-claims|doc-claim-staleness-mutation|behavior-doc-static-admission)\.mjs|(?:fact-extractors|generated-fact-sections)\/[^\s"']+\.mjs/u

function tierDependencies(tier) {
  return tier?.executionDependsOn ?? []
}

function hasAdmissionDependency(byId, tierId, visiting = new Set()) {
  if (tierId === behaviorDocStaticAdmissionTierId) return true
  if (visiting.has(tierId)) return false
  visiting.add(tierId)
  const tier = byId.get(tierId)
  return tierDependencies(tier).some((dependencyId) =>
    hasAdmissionDependency(byId, dependencyId, new Set(visiting)))
}

function isEvidenceOnlyTier(tier) {
  const commonStaticContract =
    tierDependencies(tier).length === 0
    && (tier.services ?? []).length === 0
    && tier.requiresBootstrap === 'none'
    && tier.requiresNode === true
    && tier.requiresDotnet === false
    && tier.requiresPlaywright === 'none'
    && tier.cacheProfile === 'none'
  if (!commonStaticContract) return false

  if (tier.executionMode === 'projection' && tier.commandKind === 'projection') {
    return tier.resourceClass === 'io'
      && tier.cost === 'low'
      && (tier.exclusiveResources ?? []).length === 0
      && /^node tools\/test\/project-(?:evidence|rights-v3-evidence)\.mjs(?: |$)/u
        .test(String(tier.command ?? ''))
      && !/(?:&&|\|\||;|\n|`|\$\()/u.test(String(tier.command ?? ''))
  }
  if (tier.executionMode === 'summary' && tier.commandKind === 'aggregate') {
    return /^node tools\/run-test-matrix\.mjs aggregate [a-z0-9][a-z0-9-]*$/u
      .test(String(tier.command ?? ''))
  }
  return tier.executionMode === 'summary'
    && tier.commandKind === 'finalizer'
    && tier.id === 'release-final'
    && tier.command === 'tools/test/lanes/release-final.sh'
}

function evidenceInputsAreAdmissionProtected(byId, tier, visiting = new Set()) {
  if (visiting.has(tier.id)) return false
  const inputs = tier.requiresEvidenceFrom ?? []
  if (inputs.length === 0) return false
  visiting.add(tier.id)
  return inputs.every((inputId) => {
    if (hasAdmissionDependency(byId, inputId)) return true
    const input = byId.get(inputId)
    return input != null
      && isEvidenceOnlyTier(input)
      && evidenceInputsAreAdmissionProtected(byId, input, new Set(visiting))
  })
}

function validatePurePreAdmissionTiers(byId, errors) {
  for (const [tierId, expected] of Object.entries(purePreAdmissionTierContracts)) {
    const tier = byId.get(tierId)
    if (!tier) {
      errors.push(`matrix is missing pure pre-admission tier ${tierId}`)
      continue
    }
    if (tier.command !== expected.command) {
      errors.push(`${tierId}.command must be ${JSON.stringify(expected.command)}`)
    }
    if (JSON.stringify(tierDependencies(tier)) !== JSON.stringify(expected.executionDependsOn)) {
      errors.push(
        `${tierId}.executionDependsOn must be [${expected.executionDependsOn.join(', ')}]`
      )
    }
    if ((tier.services ?? []).length !== 0 || tier.requiresPlaywright !== 'none') {
      errors.push(`${tierId} must remain process-, service-, container-, and browser-free`)
    }
  }
}

function packageJsonFiles(repositoryRoot) {
  const files = []
  const walk = (directory) => {
    if (!fs.existsSync(directory)) return
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === '.tmp' || entry.name === 'node_modules'
        || entry.name === 'bin' || entry.name === 'obj') continue
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile() && entry.name === 'package.json') files.push(absolute)
    }
  }
  walk(repositoryRoot)
  return files.sort()
}

export function validateBehaviorDocStaticAdmissionMatrix(matrix, {
  repositoryRoot = null
} = {}) {
  const errors = []
  const tiers = matrix?.tiers ?? []
  const byId = new Map(tiers.map((tier) => [tier.id, tier]))
  const admissionTiers = tiers.filter((tier) =>
    tier.id === behaviorDocStaticAdmissionTierId
    || String(tier.command ?? '').includes('behavior-doc-static-admission.mjs'))
  if (admissionTiers.length !== 1 || admissionTiers[0]?.id !== behaviorDocStaticAdmissionTierId) {
    errors.push('matrix must declare exactly one BehaviorDoc static admission execution node')
    return errors
  }

  const admission = admissionTiers[0]
  const expected = {
    command: behaviorDocStaticAdmissionCommand,
    outputReceiptSchema: behaviorDocStaticAdmissionReceiptSchema,
    executionClass: 'static-governance',
    fixtureProfile: 'none',
    qualificationEligible: true,
    requiresBootstrap: 'none',
    requiresNode: true,
    requiresDotnet: true,
    requiresPlaywright: 'none',
    smartGateMode: 'always',
    prDefault: true
  }
  for (const [field, value] of Object.entries(expected)) {
    if (admission[field] !== value) {
      errors.push(`${behaviorDocStaticAdmissionTierId}.${field} must be ${JSON.stringify(value)}`)
    }
  }
  if (JSON.stringify(tierDependencies(admission)) !== JSON.stringify(['validate-matrix'])) {
    errors.push(`${behaviorDocStaticAdmissionTierId}.executionDependsOn must be [validate-matrix]`)
  }
  if ((admission.services ?? []).length !== 0) {
    errors.push(`${behaviorDocStaticAdmissionTierId} must not declare services`)
  }
  if ((admission.fixtureCapabilities ?? []).length !== 0) {
    errors.push(`${behaviorDocStaticAdmissionTierId} must not declare fixture capabilities`)
  }
  if (!(admission.artifacts ?? []).includes(behaviorDocStaticAdmissionReceiptPath)
    || !(admission.evidence ?? []).includes(behaviorDocStaticAdmissionReceiptPath)) {
    errors.push(`${behaviorDocStaticAdmissionTierId} must publish its sealed receipt as artifact and evidence`)
  }

  validatePurePreAdmissionTiers(byId, errors)
  const preAdmissionTierIds = new Set([
    behaviorDocStaticAdmissionTierId,
    ...Object.keys(purePreAdmissionTierContracts)
  ])
  for (const tier of tiers) {
    if (preAdmissionTierIds.has(tier.id)) continue
    if (isEvidenceOnlyTier(tier)) {
      if (!evidenceInputsAreAdmissionProtected(byId, tier)) {
        errors.push(
          `${tier.id} evidence-only inputs must all trace to ${behaviorDocStaticAdmissionTierId}`
        )
      }
      continue
    }
    if (!hasAdmissionDependency(byId, tier.id)) {
      errors.push(`${tier.id} must depend on ${behaviorDocStaticAdmissionTierId}`)
    }
  }

  const productionProfile = matrix?.localProfiles?.production
  for (const bundleId of localBehaviorDocCandidateBundleIds) {
    const bundle = productionProfile?.bundles?.find((candidate) => candidate.id === bundleId)
    if (!bundle) {
      errors.push(`localProfiles.production must declare ${bundleId}`)
    } else if (JSON.stringify(bundle.dependsOn ?? [])
      !== JSON.stringify([behaviorDocStaticAdmissionTierId])) {
      errors.push(
        `localProfiles.production.${bundleId}.dependsOn must be [${behaviorDocStaticAdmissionTierId}]`
      )
    }
  }

  if (repositoryRoot) {
    for (const packageFile of packageJsonFiles(repositoryRoot)) {
      let manifest
      try {
        manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'))
      } catch {
        continue
      }
      for (const [scriptId, command] of Object.entries(manifest.scripts ?? {})) {
        if (directBehaviorDocAuthorityPattern.test(String(command))
          && !/(?:^|\s)(?:bash\s+)?(?:\.\.\/)*tools\/test\.sh(?:\s|$)/u.test(String(command))) {
          errors.push(
            `${path.relative(repositoryRoot, packageFile).replaceAll(path.sep, '/')}`
            + ` script ${scriptId} bypasses the unique BehaviorDoc admission tier`
          )
        }
      }
    }
  }
  return errors
}

export function isExternalBehaviorDocAdmissionDependency(dependencyId) {
  return dependencyId === behaviorDocStaticAdmissionTierId
}
