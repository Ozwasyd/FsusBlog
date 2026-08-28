import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Page } from '@playwright/test'

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const frontendRoot = path.join(repositoryRoot, 'src/frontend')
const viteCli = path.join(frontendRoot, 'node_modules/vite/bin/vite.js')
const productionSurfaceNamespace = resolveProductionSurfaceNamespace()
const productionSurfaceRoot = `/assets/__issue2379_lightbox_${productionSurfaceNamespace}`
const productionSurfaceDocument =
  `${productionSurfaceRoot}/test-fixtures/article-lightbox-production-surface.html`
const productionSurfaceAsset = `${productionSurfaceRoot}/assets/`
let productionSurfaceBuild: Promise<void> | null = null

export type ArticleLightboxProductionSurfaceHarness = Readonly<{
  navigationRequests: () => number
  productionAssetRequests: () => number
}>

export async function installArticleLightboxProductionSurface(
  page: Page,
  articleId: number
): Promise<ArticleLightboxProductionSurfaceHarness> {
  await ensureArticleLightboxProductionSurfaceBuilt()
  let navigationRequests = 0
  let productionAssetRequests = 0

  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith(productionSurfaceAsset)) {
      productionAssetRequests += 1
    }
  })

  await page.route(`**/article/${articleId}`, async (route) => {
    if (!route.request().isNavigationRequest()) {
      await route.continue()
      return
    }
    navigationRequests += 1
    const fixtureUrl = new URL(productionSurfaceDocument, route.request().url()).href
    const fixtureResponse = await route.fetch({ url: fixtureUrl })
    if (!fixtureResponse.ok()) {
      throw new Error(
        `article_lightbox_production_surface_unavailable:${fixtureResponse.status()}`
      )
    }
    await route.fulfill({ response: fixtureResponse })
  })

  return {
    navigationRequests: () => navigationRequests,
    productionAssetRequests: () => productionAssetRequests
  }
}

function resolveProductionSurfaceNamespace(): string {
  const candidate = process.env.TEST_WORKER_INDEX?.trim() || 'manual'
  if (!/^(?:manual|\d+)$/u.test(candidate)) {
    throw new Error(`invalid article lightbox production surface namespace: ${candidate}`)
  }
  return candidate
}

async function ensureArticleLightboxProductionSurfaceBuilt(): Promise<void> {
  productionSurfaceBuild ??= new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [
      viteCli,
      'build',
      '--config',
      'vite.article-lightbox-production.config.ts',
      '--logLevel',
      'warn'
    ], {
      cwd: frontendRoot,
      env: {
        ...process.env,
        FSUSBLOG_LIGHTBOX_FIXTURE_NAMESPACE: productionSurfaceNamespace,
        VITE_FSUSBLOG_BUILD_ID: process.env.VITE_FSUSBLOG_BUILD_ID
          || '20000101000000-000000000000'
      },
      stdio: 'inherit'
    })
    child.once('error', reject)
    child.once('close', (exitCode, signal) => {
      if (exitCode === 0) {
        resolve()
        return
      }
      reject(new Error(
        `article lightbox production surface build failed: exit=${String(exitCode)} signal=${String(signal)}`
      ))
    })
  })
  await productionSurfaceBuild
}
