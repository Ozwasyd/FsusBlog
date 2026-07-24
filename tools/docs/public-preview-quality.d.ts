import type { Page } from '@playwright/test'

export type PublicPreviewHeaderSample = {
  phase: string
  rect: null | { x: number, y: number, width: number, height: number }
}

export type PublicPreviewQualityScenario = {
  id: string
  route: string
  scope?: string
  tier?: string
  viewport: { width: number, height: number }
  viewportWidth?: number
  viewportHeight?: number
  theme: string
  locale: string
  zoom: number
  surfaceRole?: 'public' | 'task' | string
  linkedIssues?: number[]
  primaryTaskSelectors?: string[]
}

export type PublicPreviewQualityPolicy = {
  mobileMaxWidth?: number
  normalHitTargetMinPx?: number
  primaryHitTargetHeightMinPx?: number
  focusClipTolerancePx?: number
  layoutShiftMaxPx?: number
  overflowTolerancePx?: number
  maxTaskPanels?: number
  maxBadges?: number
  maxPrimaryActions?: number
  maxUnscopedRadiusPx?: number
  reviewerStatuses?: string[]
  localeTokens?: Record<string, string[]>
  uiChromeSelectors?: string[]
  userContentSelectors?: string[]
  primaryHitTargetSelectors?: string[]
  panelSelectors?: string[]
  badgeSelectors?: string[]
  primaryActionSelectors?: string[]
  [key: string]: unknown
}

export type PublicPreviewMachineCheck = {
  status: 'pass' | 'fail'
  findings: unknown[]
  [key: string]: unknown
}

export type PublicPreviewQualityReport = {
  schema: string
  id: string
  route: string
  viewport: { width: number, height: number }
  theme: string
  locale: string
  zoom: number
  surfaceRole: string
  linkedIssues: number[]
  status: 'pass' | 'fail' | 'needs-design-review'
  machine: {
    overflow: PublicPreviewMachineCheck
    overlaps: PublicPreviewMachineCheck
    clippedText: PublicPreviewMachineCheck
    hitTargets: PublicPreviewMachineCheck
    focusClipping: PublicPreviewMachineCheck
    localeCoherence: PublicPreviewMachineCheck
    headerStability: PublicPreviewMachineCheck
    primaryTask: PublicPreviewMachineCheck
  }
  reviewer: {
    classification: 'pass' | 'fail' | 'needs-design-review'
    reasons: string[]
    metrics: Record<string, unknown>
  }
}

export type PublicPreviewQualityMatrix = {
  schema: string
  status: 'pass' | 'fail' | 'needs-design-review'
  policyDigest: string | null
  scenarioCount: number
  reports: PublicPreviewQualityReport[]
}

export const publicPreviewQualityReportSchema: string
export const publicPreviewQualityMatrixSchema: string
export function qualitySidecarFile(directory: string, screenshotFile: string): string
export function applyPublicPreviewZoom(page: Page, zoom: number): Promise<void>
export function measurePublicPreviewHeader(page: Page, phase: string): Promise<PublicPreviewHeaderSample>
export function auditPublicPreviewPage(
  page: Page,
  scenario: PublicPreviewQualityScenario,
  policy: PublicPreviewQualityPolicy,
  options?: { headerSamples?: PublicPreviewHeaderSample[] }
): Promise<PublicPreviewQualityReport>
export function validatePublicPreviewQualityReport(
  report: unknown,
  expected: PublicPreviewQualityScenario,
  policy: PublicPreviewQualityPolicy
): string[]
export function createPublicPreviewQualityMatrix(
  reports: PublicPreviewQualityReport[],
  policyDigest?: string | null
): PublicPreviewQualityMatrix
export function validatePublicPreviewQualityMatrix(
  document: unknown,
  scenarios: PublicPreviewQualityScenario[],
  policy: PublicPreviewQualityPolicy
): string[]
export function writePublicPreviewQualitySidecar(
  directory: string,
  screenshotFile: string,
  report: PublicPreviewQualityReport
): Promise<string>
export function writePublicPreviewQualityMatrix(directory: string, matrix: PublicPreviewQualityMatrix): Promise<string>
