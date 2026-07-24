import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function loadPublicPreviewRegistry(rootDirectory) {
  const root = rootDirectory instanceof URL ? fileURLToPath(rootDirectory) : path.resolve(rootDirectory)
  const registry = readJson(path.join(root, 'config/docs/public-preview-screenshots.json'))
  if (registry.schema !== 'fsusblog.public-preview-screenshot-registry.v1') {
    throw new Error(`unexpected screenshot registry schema: ${registry.schema ?? 'missing'}`)
  }
  const policy = readJson(path.join(root, String(registry.qualityPolicyFile ?? '')))
  const scenarioDocuments = (registry.qualityScenarioFiles ?? []).map((file) => readJson(path.join(root, String(file))))
  if (policy.schema !== 'fsusblog.public-preview-quality-policy.v1') {
    throw new Error(`unexpected public-preview quality policy schema: ${policy.schema ?? 'missing'}`)
  }
  if (scenarioDocuments.length === 0 || scenarioDocuments.some((document) => document.schema !== 'fsusblog.public-preview-quality-scenarios.v1')) {
    throw new Error('unexpected public-preview quality scenarios schema')
  }
  const profiles = policy.screenshotProfiles && typeof policy.screenshotProfiles === 'object'
    ? policy.screenshotProfiles
    : {}
  const screenshots = registry.screenshots.map((entry) => {
    const profile = profiles[entry.id]
    if (!profile) throw new Error(`public-preview quality profile missing: ${entry.id}`)
    return { ...entry, ...profile }
  })
  const profileIds = Object.keys(profiles).sort()
  const screenshotIds = screenshots.map((entry) => entry.id).sort()
  if (JSON.stringify(profileIds) !== JSON.stringify(screenshotIds)) {
    throw new Error('public-preview quality profile ids must match screenshot ids')
  }
  if (!policy.qualityPolicy || typeof policy.qualityPolicy !== 'object') {
    throw new Error('public-preview quality policy is missing')
  }
  const qualityScenarios = scenarioDocuments.flatMap((document) => document.qualityScenarios ?? [])
  if (qualityScenarios.length === 0) throw new Error('public-preview quality scenarios are missing')
  const scenarioIds = qualityScenarios.map((entry) => entry.id)
  if (new Set(scenarioIds).size !== scenarioIds.length) throw new Error('public-preview quality scenario ids must be unique')
  return {
    ...registry,
    screenshots,
    qualityPolicy: policy.qualityPolicy,
    qualityScenarios
  }
}
