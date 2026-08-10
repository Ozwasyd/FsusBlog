import type { Locator, Page } from '@playwright/test'

export type ExpectedFontReadiness = Readonly<{
  family: string
  representativeText: string
  weights: readonly number[]
}>
export type FontFaceReadinessSnapshot = Readonly<{
  family: string
  status: FontFaceLoadStatus
  style: string
  weight: string
}>
export type FontLoadingReadinessReport = Readonly<{
  errorFacesAfterProbe: readonly FontFaceReadinessSnapshot[]
  errorFacesBeforeProbe: readonly FontFaceReadinessSnapshot[]
  families: readonly Readonly<{
    family: string
    facesBeforeProbe: readonly FontFaceReadinessSnapshot[]
    loadedWeightsBeforeProbe: readonly number[]
    probes: readonly Readonly<{
      check: boolean
      loadedCount: number
      query: string
      weight: number
    }>[]
    representativeText: string
  }>[]
  fontSetStatusAfterProbe: FontFaceSetLoadStatus
  fontSetStatusBeforeProbe: FontFaceSetLoadStatus
}>

export function waitForObservableReadiness(
  page: Page,
  options: {
    description: string
    predicate: (...args: unknown[]) => unknown
    argument?: unknown
    timeoutMs?: number
  }
): Promise<void>
export function waitForApplicationReady(page: Page, options?: { description?: string; timeoutMs?: number }): Promise<void>
export function applicationReadyPredicate(): boolean
export function waitForPublicHydration(page: Page, options?: { timeoutMs?: number }): Promise<void>
export function waitForSpaRoute(
  page: Page,
  expectedPath: string,
  options?: { content?: Locator; timeoutMs?: number }
): Promise<void>
export function waitForServiceWorkerCacheReady(
  page: Page,
  options?: { cachePrefix?: string; requireShellCache?: boolean; timeoutMs?: number }
): Promise<void>
export function waitForNotificationSuppressed(page: Page, options?: { timeoutMs?: number }): Promise<void>
export function waitForAuthPermissionReady(
  page: Page,
  options: { pathPrefix: string; content: Locator; timeoutMs?: number }
): Promise<void>
export function waitForVisualFrameReady(page: Page, options?: { timeoutMs?: number }): Promise<void>
export function inspectFontLoadingReadiness(
  page: Page,
  expectedFonts: readonly ExpectedFontReadiness[]
): Promise<FontLoadingReadinessReport>
export function runBrowserMeasurementWindow(
  page: Page,
  options: {
    purpose: string
    maxWindowMs: number
    evidenceClass: 'performance' | 'soak' | 'animation-measurement'
  }
): Promise<void>
