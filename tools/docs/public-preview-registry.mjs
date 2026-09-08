import fs from 'node:fs'
import { projectPublicPreviewQualityRegistry } from '../release/public-preview-quality-receipt-contract.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function loadPublicPreviewRegistry(rootDirectory) {
  const root = rootDirectory instanceof URL ? fileURLToPath(rootDirectory) : path.resolve(rootDirectory)
  const registry = readJson(path.join(root, 'config/docs/public-preview-screenshots.json'))
  const policy = readJson(path.join(root, String(registry.qualityPolicyFile ?? '')))
  const scenarioDocuments = (registry.qualityScenarioFiles ?? []).map((file) => readJson(path.join(root, String(file))))
  return projectPublicPreviewQualityRegistry(registry, policy, scenarioDocuments)
}
