import path from 'node:path'

export const evidenceExecutionModes = ['execute', 'projection', 'summary']

function isSafeRepositoryPath(value) {
  const normalized = String(value ?? '').replaceAll('\\', '/')
  return Boolean(normalized)
    && !path.posix.isAbsolute(normalized)
    && normalized !== '.'
    && !normalized.split('/').includes('..')
}

function validateSortedStrings(tier, field, errors) {
  const values = tier[field]
  if (!Array.isArray(values) || values.length === 0) {
    errors.push(`${tier.id}.${field} must be a non-empty array for projection tiers`)
    return
  }
  if (values.some((value) => typeof value !== 'string' || !value.trim())) {
    errors.push(`${tier.id}.${field} entries must be non-empty strings`)
  }
  if (new Set(values).size !== values.length) errors.push(`${tier.id}.${field} must not contain duplicates`)
  if (JSON.stringify(values) !== JSON.stringify([...values].sort())) errors.push(`${tier.id}.${field} must be sorted`)
}

export function validateEvidenceExecutionDeclaration(tier) {
  const errors = []
  const executionMode = tier.executionMode ?? 'execute'
  if (!evidenceExecutionModes.includes(executionMode)) {
    return [`${tier.id}.executionMode is invalid: ${tier.executionMode}`]
  }
  if (executionMode !== 'projection') {
    for (const field of ['projectionCatalog', 'requiredTestIds', 'requiredCoverageIds', 'requiredArtifactDeclarations']) {
      if (field in tier) errors.push(`${tier.id}.${field} is reserved for projection tiers`)
    }
    return errors
  }

  for (const field of ['executionOwner', 'projectFrom', 'projectionCatalog']) {
    if (typeof tier[field] !== 'string' || !tier[field].trim()) errors.push(`${tier.id}.${field} is required for projection tiers`)
  }
  if (tier.executionOwner !== tier.projectFrom) {
    errors.push(`${tier.id}.executionOwner must equal projectFrom for a single canonical producer`)
  }
  if (!isSafeRepositoryPath(tier.projectionCatalog)) {
    errors.push(`${tier.id}.projectionCatalog must be a repository-relative path without traversal`)
  }
  for (const field of ['requiredTestIds', 'requiredCoverageIds', 'requiresEvidenceFrom']) {
    validateSortedStrings(tier, field, errors)
  }

  const declarations = tier.requiredArtifactDeclarations
  if (!Array.isArray(declarations) || declarations.length === 0) {
    errors.push(`${tier.id}.requiredArtifactDeclarations must be a non-empty array for projection tiers`)
  } else {
    const ids = declarations.map((entry) => entry?.id)
    const paths = declarations.map((entry) => entry?.path)
    if (declarations.some((entry) => !entry || typeof entry.id !== 'string' || !entry.id.trim()
      || !isSafeRepositoryPath(entry.path))) {
      errors.push(`${tier.id}.requiredArtifactDeclarations entries require an ID and safe repository-relative path`)
    }
    if (new Set(ids).size !== ids.length) errors.push(`${tier.id}.requiredArtifactDeclarations must not contain duplicate IDs`)
    if (new Set(paths).size !== paths.length) errors.push(`${tier.id}.requiredArtifactDeclarations must not contain duplicate paths`)
    if (JSON.stringify(ids) !== JSON.stringify([...ids].sort())) errors.push(`${tier.id}.requiredArtifactDeclarations must be sorted by ID`)
  }

  const command = String(tier.command ?? '')
  if (!command.startsWith('node tools/test/project-evidence.mjs ')
    || /(?:&&|\|\||;|\n|`|\$\()/u.test(command)) {
    errors.push(`${tier.id} projection command must exclusively use node tools/test/project-evidence.mjs`)
  }
  if ((tier.services?.length ?? 0) > 0 || (tier.exclusiveResources?.length ?? 0) > 0) {
    errors.push(`${tier.id} projection tier must not declare services or exclusive resources`)
  }
  if (tier.requiresBootstrap !== 'none' || tier.requiresDotnet !== false || tier.requiresNode !== true
    || tier.requiresPlaywright !== 'none' || tier.cacheProfile !== 'none') {
    errors.push(`${tier.id} projection tier must be Node-only without bootstrap, .NET, Playwright, or execution cache`)
  }
  if (tier.resourceClass !== 'io' || tier.cost !== 'low') {
    errors.push(`${tier.id} projection tier must use resourceClass=io and cost=low`)
  }
  if (!tier.dependsOn?.includes(tier.projectFrom) || !tier.requiresEvidenceFrom?.includes(tier.projectFrom)) {
    errors.push(`${tier.id} projection tier must depend on and require evidence from projectFrom=${tier.projectFrom}`)
  }
  return errors
}
