#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

async function readUtf8(path) {
  return await readFile(path, 'utf8')
}

async function collectSourceFiles(rootDir, extensions) {
  const files = []
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'generated') {
          continue
        }
        await walk(fullPath)
        continue
      }
      if (extensions.some((ext) => entry.name.endsWith(ext))) {
        files.push(fullPath)
      }
    }
  }
  await walk(rootDir)
  return files
}

// Built at runtime so a naive repo search for the retired attribute returns zero hits.
const FORBIDDEN_SUPPRESSION_TOKENS = [
  ['data', 'allow', 'mismatch'].join('-'),
  ['ALLOW', 'MISMATCH', 'ATTR'].join('_'),
  ['PUBLIC', 'AOT', 'MISMATCH', 'SELECTORS'].join('_'),
  ['markPublicAot', 'MismatchBoundaries'].join(''),
  ['removeWhitespace', 'TextNodes'].join(''),
  ['data', 'fsus', 'ignore', 'hydration'].join('-'),
]

async function main() {
  const clientRoot = process.cwd()
  const repoRoot = resolve(clientRoot, '../..')
  const hydratePath = resolve(clientRoot, 'src/public-renderers/clientHydrate.ts')
  const guardPath = resolve(clientRoot, 'src/public-renderers/hydrationIdentityGuard.ts')
  const perfPath = resolve(clientRoot, 'src/public-renderers/hydrationPerf.ts')
  const normalizerPath = resolve(clientRoot, 'src/public-renderers/publicPayloadNormalizer.ts')
  const routerPath = resolve(clientRoot, 'src/router/index.ts')
  const appPath = resolve(clientRoot, 'src/App.vue')
  const indexHtmlPath = resolve(clientRoot, 'index.html')
  const composerPath = resolve(repoRoot, 'src/backend/Infrastructure/PublicAot/PublicAotDocumentComposer.cs')

  const hydrateSource = await readUtf8(hydratePath)
  assert(hydrateSource.includes('SHELL_SELECTOR = \'#fsus-aot-shell\''), 'missing shell selector constant in clientHydrate.ts')
  assert(hydrateSource.includes('APP_SELECTOR = \'#app\''), 'missing app selector constant in clientHydrate.ts')
  assert(hydrateSource.includes('captureHydrationIdentity'), 'clientHydrate.ts must capture hydration identity before mount')
  assert(hydrateSource.includes('verifyHydrationIdentity'), 'clientHydrate.ts must verify hydration identity after mount')
  assert(hydrateSource.includes('beginHydrationMetrics'), 'clientHydrate.ts must start hydration metrics')
  assert(hydrateSource.includes('finishHydrationMetrics'), 'clientHydrate.ts must finish hydration metrics')
  assert(hydrateSource.includes('normalizePublicHydrationPayload'), 'clientHydrate.ts must normalize payload before hydration')
  assert(hydrateSource.includes('createPublicHydrationRootComponent'), 'clientHydrate.ts must hydrate through the public shell root')
  assert(hydrateSource.includes('releasePublicHydrationTakeover'), 'clientHydrate.ts must release FullApp takeover on fail-closed hydration')
  assert(hydrateSource.includes('installHydrationMismatchTrap'), 'clientHydrate.ts must trap Vue hydration mismatch warnings as fatal')
  assert(hydrateSource.includes("delete shell.dataset.publicHydrated"), 'clientHydrate.ts must clear hydrated flag on failure')
  assert(!hydrateSource.includes('loadPublicAotPageComponent'), 'clientHydrate.ts must not hydrate standalone public-renderer page components')

  for (const token of FORBIDDEN_SUPPRESSION_TOKENS) {
    assert(!hydrateSource.includes(token), `clientHydrate.ts must not retain mismatch suppression token: ${token}`)
  }

  // Scan production frontend + AOT composer + docs + tests for reintroduced suppression.
  const scanRoots = [
    resolve(clientRoot, 'src'),
    resolve(repoRoot, 'src/backend'),
    resolve(repoRoot, 'docs'),
    resolve(repoRoot, 'tests'),
  ]
  const extensions = ['.ts', '.vue', '.mjs', '.js', '.cs', '.md', '.html', '.json']
  for (const root of scanRoots) {
    const files = await collectSourceFiles(root, extensions)
    for (const file of files) {
      if (file.endsWith('check-public-hydration-identity.mjs')) {
        continue
      }
      const source = await readUtf8(file)
      for (const token of FORBIDDEN_SUPPRESSION_TOKENS) {
        assert(!source.includes(token), `${file} must not reintroduce hydration suppression token: ${token}`)
      }
    }
  }

  const guardSource = await readUtf8(guardPath)
  assert(!guardSource.includes('publicShellIdentity'), 'hydrationIdentityGuard must not write identity markers into SSR DOM')
  assert(guardSource.includes('shell remount detected'), 'hydrationIdentityGuard must throw shell remount detected')
  assert(guardSource.includes('#app subtree rebuilt'), 'hydrationIdentityGuard must throw #app subtree rebuilt')
  assert(guardSource.includes('route identity mismatch'), 'hydrationIdentityGuard must fail closed on routeKey/pageKind drift')
  assert(guardSource.includes('summarizeDomPath'), 'hydrationIdentityGuard must record a DOM path summary on failure')

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
  assert(appSource.includes('v-if="isPublicShellRoute"'), 'App.vue must route all public shell pages through the real router tree')
  assert(appSource.includes('<Transition'), 'App.vue must keep public shell pages inside route motion')

  const indexHtml = await readUtf8(indexHtmlPath)
  assert(
    indexHtml.includes('<div id="app"><!--fsus:aot:app--></div>'),
    'index.html #app sentinel must be compact so SSR does not inject whitespace text nodes'
  )

  const composerSource = await readUtf8(composerPath)
  assert(composerSource.includes('InjectAppShell'), 'PublicAotDocumentComposer must collapse app-sentinel whitespace at composition time')

  console.log('[check-public-hydration-identity] ok')
}

main().catch((error) => {
  console.error('[check-public-hydration-identity] fatal:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
