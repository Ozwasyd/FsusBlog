import { parseYamlDocument, parseYamlScalar } from '../yaml/parse-document.mjs'

export const parseMatrixValue = parseYamlScalar

export function tierExecutionDependencies(tier) {
  return tier?.executionDependsOn ?? tier?.dependsOn ?? []
}

export function parseMatrix(text) {
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
  return {
    ...document,
    localProfiles: document.localProfiles ?? {},
    tiers: document.tiers ?? []
  }
}
