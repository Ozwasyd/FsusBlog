import type { Locator, Page } from '@playwright/test'

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
export function runBrowserMeasurementWindow(
  page: Page,
  options: {
    purpose: string
    maxWindowMs: number
    evidenceClass: 'performance' | 'soak' | 'animation-measurement'
  }
): Promise<void>
