import { parseYamlDocument, parseYamlScalar } from '../yaml/parse-document.mjs'

export const parseMatrixValue = parseYamlScalar

export function tierExecutionDependencies(tier) {
  return tier?.executionDependsOn ?? tier?.dependsOn ?? []
}

export function parseMatrix(text, { validateDependencyFields = true } = {}) {
  const document = parseYamlDocument(text, { source: 'test matrix' })
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('test matrix root must be a YAML mapping')
  }
  if (document.localProfiles != null &&
      (typeof document.localProfiles !== 'object' || Array.isArray(document.localProfiles))) {
    throw new Error('test matrix localProfiles must be a YAML mapping')
  }
  if (document.tiers != null && !Array.isArray(document.tiers)) {
    throw new Error('test matrix tiers must be a YAML sequence')
  }
  if (validateDependencyFields) {
    for (const tier of document.tiers ?? []) {
      const id = tier?.id ?? '<unknown>'
      if (Object.hasOwn(tier ?? {}, 'dependsOn')) {
        throw new Error(`tier ${id} uses retired dependsOn; use executionDependsOn`)
      }
      if (!Array.isArray(tier?.executionDependsOn)) {
        throw new Error(`tier ${id} must declare executionDependsOn as an array`)
      }
      if (Object.hasOwn(tier ?? {}, 'requiresEvidenceFrom') && !Array.isArray(tier.requiresEvidenceFrom)) {
        throw new Error(`tier ${id} must declare requiresEvidenceFrom as an array`)
      }
    }
  }
  return {
    ...document,
    localProfiles: document.localProfiles ?? {},
    tiers: document.tiers ?? []
  }
}
