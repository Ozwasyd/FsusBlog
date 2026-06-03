#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

async function readUtf8(path) {
  return await readFile(path, 'utf8')
}

async function main() {
  const clientRoot = process.cwd()
  const hydratePath = resolve(clientRoot, 'src/public-renderers/clientHydrate.ts')
  const guardPath = resolve(clientRoot, 'src/public-renderers/hydrationIdentityGuard.ts')
  const perfPath = resolve(clientRoot, 'src/public-renderers/hydrationPerf.ts')
  const normalizerPath = resolve(clientRoot, 'src/public-renderers/publicPayloadNormalizer.ts')
  const routerPath = resolve(clientRoot, 'src/router/index.ts')
  const appPath = resolve(clientRoot, 'src/App.vue')

  const hydrateSource = await readUtf8(hydratePath)
  assert(hydrateSource.includes('SHELL_SELECTOR = \'#fsus-aot-shell\''), 'missing shell selector constant in clientHydrate.ts')
  assert(hydrateSource.includes('APP_SELECTOR = \'#app\''), 'missing app selector constant in clientHydrate.ts')
  assert(hydrateSource.includes('captureHydrationIdentity'), 'clientHydrate.ts must capture hydration identity before mount')
  assert(hydrateSource.includes('verifyHydrationIdentity'), 'clientHydrate.ts must verify hydration identity after mount')
  assert(hydrateSource.includes('beginHydrationMetrics'), 'clientHydrate.ts must start hydration metrics')
  assert(hydrateSource.includes('finishHydrationMetrics'), 'clientHydrate.ts must finish hydration metrics')
  assert(hydrateSource.includes('normalizePublicHydrationPayload'), 'clientHydrate.ts must normalize payload before hydration')
  assert(hydrateSource.includes('createPublicHydrationRootComponent'), 'clientHydrate.ts must hydrate through the public shell root')
  assert(hydrateSource.includes('removeWhitespaceTextNodes'), 'clientHydrate.ts must normalize SSR fragment whitespace before hydration')
  assert(!hydrateSource.includes('loadPublicAotPageComponent'), 'clientHydrate.ts must not hydrate standalone public-renderer page components')

  const guardSource = await readUtf8(guardPath)
  assert(!guardSource.includes('publicShellIdentity'), 'hydrationIdentityGuard must not write identity markers into SSR DOM')
  assert(guardSource.includes('shell remount detected'), 'hydrationIdentityGuard must throw shell remount detected')
  assert(guardSource.includes('#app subtree rebuilt'), 'hydrationIdentityGuard must throw #app subtree rebuilt')

  const perfSource = await readUtf8(perfPath)
  assert(perfSource.includes('__FSUS_PUBLIC_HYDRATION_METRICS__'), 'hydrationPerf must publish hydration metrics snapshot')
  assert(perfSource.includes('public-hydrate-total'), 'hydrationPerf must measure public-hydrate-total')
  assert(perfSource.includes('public-hydrate-mount'), 'hydrationPerf must measure public-hydrate-mount')

  const normalizerSource = await readUtf8(normalizerPath)
  assert(normalizerSource.includes('normalizePublicHydrationPayload'), 'publicPayloadNormalizer must export normalizePublicHydrationPayload')
  assert(normalizerSource.includes('routeKey'), 'publicPayloadNormalizer must normalize routeKey')

  const routerSource = await readUtf8(routerPath)
  assert(routerSource.includes('export function createAppRouter'), 'router/index.ts must export createAppRouter')
  assert(routerSource.includes('createMemoryHistory'), 'router/index.ts must support SSR memory history')

  const appSource = await readUtf8(appPath)
  assert(appSource.includes('<RouterView v-if="isPublicSeoRoute" />'), 'App.vue must continue to route public SEO pages through the real router tree')

  console.log('[check-public-hydration-identity] ok')
}

main().catch((error) => {
  console.error('[check-public-hydration-identity] fatal:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
