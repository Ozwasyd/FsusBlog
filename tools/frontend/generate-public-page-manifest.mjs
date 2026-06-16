#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '../..')
const sourcePath = resolve(repoRoot, 'src/shared/Contracts/Outputs/PublicPageContracts.cs')
const targetPath = resolve(repoRoot, 'src/frontend/src/public-renderers/generated/publicPageManifest.ts')
const checkOnly = process.argv.includes('--check')

function fail(message) {
  throw new Error(message)
}

function parsePageIds(source) {
  const enumMatch = source.match(/public enum PublicPageId\s*\{([\s\S]*?)\}/u)
  if (!enumMatch) {
    fail('cannot find PublicPageId enum in PublicPageContracts.cs')
  }

  return new Map(
    Array.from(enumMatch[1].matchAll(/^(\s*)([A-Za-z][A-Za-z0-9_]*)\s*=\s*(\d+)\s*,?$/gmu), ([, , name, value]) => [name, Number(value)])
  )
}

function parseDescriptors(source) {
  const descriptorPattern = /public static readonly PublicPageDescriptor\s+([A-Za-z][A-Za-z0-9_]*)\s*=\s*new\(\s*PublicPageId\.([A-Za-z][A-Za-z0-9_]*)\s*,\s*"([^"]+)"\s*,\s*SeoEligible:\s*(true|false)\s*,\s*AotShellReady:\s*(true|false)\s*,\s*DeferSpaBoot:\s*(true|false)\s*,\s*RequiresUserState:\s*(true|false)\s*,\s*FallbackBehavior:\s*([A-Za-z][A-Za-z0-9_.]*)\s*\);/gu
  const descriptors = new Map()

  for (const match of source.matchAll(descriptorPattern)) {
    const [, kind, pageIdName, canonicalSlug, seoEligible, aotShellReady, deferSpaBoot, requiresUserState, fallbackBehaviorExpression] = match

    descriptors.set(kind, {
      kind,
      pageIdName,
      canonicalSlug,
      seoEligible: seoEligible === 'true',
      aotShellReady: aotShellReady === 'true',
      deferSpaBoot: deferSpaBoot === 'true',
      requiresUserState: requiresUserState === 'true',
      fallbackBehaviorExpression
    })
  }

  if (descriptors.size === 0) {
    fail('cannot find PublicPageRegistry descriptors in PublicPageContracts.cs')
  }

  return descriptors
}

function parseRouteIdentityTokens(source) {
  const classMatch = source.match(/public static class PublicRouteIdentityRegistry\s*\{([\s\S]*?)\}/u)
  if (!classMatch) {
    fail('cannot find PublicRouteIdentityRegistry in PublicPageContracts.cs')
  }

  const tokens = {}
  for (const match of classMatch[1].matchAll(/public const string\s+([A-Za-z][A-Za-z0-9_]*)\s*=\s*([^;]+);/gu)) {
    const [, name, expression] = match
    tokens[name] = evaluateConstStringExpression(expression, tokens)
  }

  const requiredTokenNames = [
    'PublicAotShellFallback',
    'PublicSearchSpaFallback',
    'UserStateRuntimeOnlyFallback',
    'SearchRouteKey',
    'SearchPath',
    'AccountPath',
    'UnknownFilterRouteKey',
    'ArticleBucket',
    'ArticlePathPrefix',
    'CategoryBucket',
    'CategoryPathPrefix',
    'TagBucket',
    'TagPathPrefix',
    'TagNameBucket'
  ]

  for (const name of requiredTokenNames) {
    if (typeof tokens[name] !== 'string' || tokens[name].length === 0) {
      fail(`missing PublicRouteIdentityRegistry token: ${name}`)
    }
  }

  return tokens
}

function evaluateConstStringExpression(expression, knownTokens) {
  const parts = expression.split('+').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) {
    fail(`unsupported const string expression: ${expression}`)
  }

  return parts.map((part) => {
    const stringLiteral = part.match(/^"([^"]*)"$/u)
    if (stringLiteral) {
      return stringLiteral[1]
    }

    if (typeof knownTokens[part] === 'string') {
      return knownTokens[part]
    }

    fail(`unsupported const string token part: ${part}`)
  }).join('')
}

function parseRegistryOrder(source, descriptors) {
  const allMatch = source.match(/PublicPageDescriptor\[\]\s+All\s*=\s*\[([\s\S]*?)\];/u)
  if (!allMatch) {
    fail('cannot find PublicPageRegistry.All in PublicPageContracts.cs')
  }

  const order = Array.from(allMatch[1].matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*,?$/gmu), ([, name]) => name)
  if (order.length === 0) {
    fail('PublicPageRegistry.All is empty')
  }

  for (const kind of order) {
    if (!descriptors.has(kind)) {
      fail(`PublicPageRegistry.All references unknown descriptor: ${kind}`)
    }
  }

  return order
}

function buildManifestEntries(source) {
  const pageIds = parsePageIds(source)
  const descriptors = parseDescriptors(source)
  const order = parseRegistryOrder(source, descriptors)
  const routeIdentityTokens = parseRouteIdentityTokens(source)

  return order.map((kind) => {
    const descriptor = descriptors.get(kind)
    if (!descriptor) {
      fail(`missing descriptor for ${kind}`)
    }

    if (descriptor.pageIdName !== kind) {
      fail(`descriptor ${kind} points to mismatched page id ${descriptor.pageIdName}`)
    }

    const pageId = pageIds.get(descriptor.pageIdName)
    if (!Number.isInteger(pageId)) {
      fail(`missing PublicPageId value for ${descriptor.pageIdName}`)
    }

    return {
      kind,
      pageId,
      canonicalSlug: descriptor.canonicalSlug,
      seoEligible: descriptor.seoEligible,
      aotShellReady: descriptor.aotShellReady,
      deferSpaBoot: descriptor.deferSpaBoot,
      requiresUserState: descriptor.requiresUserState,
      fallbackBehavior: resolveFallbackBehavior(descriptor.fallbackBehaviorExpression, routeIdentityTokens)
    }
  })
}

function resolveFallbackBehavior(expression, routeIdentityTokens) {
  const prefix = 'PublicRouteIdentityRegistry.'
  if (expression.startsWith(prefix)) {
    const tokenName = expression.slice(prefix.length)
    if (typeof routeIdentityTokens[tokenName] === 'string') {
      return routeIdentityTokens[tokenName]
    }
  }

  fail(`unsupported fallback behavior expression: ${expression}`)
}

function renderManifest(entries, routeIdentityTokens) {
  const renderedEntries = entries.map((entry) => `  ${entry.kind}: {
    kind: '${entry.kind}',
    pageId: ${entry.pageId},
    canonicalSlug: '${entry.canonicalSlug}',
    seoEligible: ${entry.seoEligible},
    aotShellReady: ${entry.aotShellReady},
    deferSpaBoot: ${entry.deferSpaBoot},
    requiresUserState: ${entry.requiresUserState},
    fallbackBehavior: '${entry.fallbackBehavior}'
  }`).join(',\n')

  const renderedTokens = `export const PUBLIC_ROUTE_IDENTITY_TOKENS = Object.freeze({
  publicAotShellFallback: '${routeIdentityTokens.PublicAotShellFallback}',
  publicSearchSpaFallback: '${routeIdentityTokens.PublicSearchSpaFallback}',
  userStateRuntimeOnlyFallback: '${routeIdentityTokens.UserStateRuntimeOnlyFallback}',
  searchRouteKey: '${routeIdentityTokens.SearchRouteKey}',
  searchPath: '${routeIdentityTokens.SearchPath}',
  accountPath: '${routeIdentityTokens.AccountPath}',
  unknownFilterRouteKey: '${routeIdentityTokens.UnknownFilterRouteKey}',
  articleBucket: '${routeIdentityTokens.ArticleBucket}',
  articlePathPrefix: '${routeIdentityTokens.ArticlePathPrefix}',
  categoryBucket: '${routeIdentityTokens.CategoryBucket}',
  categoryPathPrefix: '${routeIdentityTokens.CategoryPathPrefix}',
  tagBucket: '${routeIdentityTokens.TagBucket}',
  tagPathPrefix: '${routeIdentityTokens.TagPathPrefix}',
  tagNameBucket: '${routeIdentityTokens.TagNameBucket}'
} as const)
`

  return `// Auto-generated from src/shared/Contracts/Outputs/PublicPageContracts.cs
// Run: node ../../tools/frontend/generate-public-page-manifest.mjs

export const PUBLIC_PAGE_MANIFEST = Object.freeze({
${renderedEntries}
} as const)

${renderedTokens}

export type SharedPublicPageKind = keyof typeof PUBLIC_PAGE_MANIFEST

type SharedPublicPageManifest = typeof PUBLIC_PAGE_MANIFEST

type SharedPageKindsWithFlag<TFlag extends keyof SharedPublicPageManifest[SharedPublicPageKind]> = {
  [K in SharedPublicPageKind]: SharedPublicPageManifest[K][TFlag] extends true ? K : never
}[SharedPublicPageKind]

export type SharedSeoEligiblePublicPageKind = SharedPageKindsWithFlag<'seoEligible'>
export type SharedAotShellReadyPublicPageKind = SharedPageKindsWithFlag<'aotShellReady'>

export function getSharedPublicPageManifestEntry<TKind extends SharedPublicPageKind>(kind: TKind): SharedPublicPageManifest[TKind] {
  return PUBLIC_PAGE_MANIFEST[kind]
}
`
}

async function main() {
  const source = await readFile(sourcePath, 'utf8')
  const entries = buildManifestEntries(source)
  const routeIdentityTokens = parseRouteIdentityTokens(source)
  const output = renderManifest(entries, routeIdentityTokens)

  if (checkOnly) {
    const current = await readFile(targetPath, 'utf8').catch(() => null)
    if (current !== output) {
      fail('publicPageManifest.ts is out of sync; run node ../../tools/frontend/generate-public-page-manifest.mjs')
    }

    console.log('[generate-public-page-manifest] ok')
    return
  }

  await mkdir(dirname(targetPath), { recursive: true })
  await writeFile(targetPath, output, 'utf8')
  console.log(`[generate-public-page-manifest] wrote ${targetPath}`)
}

main().catch((error) => {
  console.error('[generate-public-page-manifest] fatal:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
