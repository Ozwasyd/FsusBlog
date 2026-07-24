import type { PublicPreviewQualityPolicy, PublicPreviewQualityScenario } from './public-preview-quality.mjs'

export type PublicPreviewScreenshotEntry = PublicPreviewQualityScenario & {
  file: string
  viewport: string
  qualityViewport: { width: number, height: number }
}

export type PublicPreviewRegistry = {
  schema: string
  screenshots: PublicPreviewScreenshotEntry[]
  qualityPolicy: PublicPreviewQualityPolicy
  qualityScenarios: PublicPreviewQualityScenario[]
  visualInputs: Record<string, unknown[]>
  [key: string]: unknown
}

export function loadPublicPreviewRegistry(rootDirectory: string | URL): PublicPreviewRegistry
