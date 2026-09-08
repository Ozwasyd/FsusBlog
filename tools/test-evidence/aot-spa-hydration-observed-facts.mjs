import { createHash } from 'node:crypto'
import path from 'node:path'

import { digestValue, stable } from '../fact-extractors/lib/canonicalize.mjs'
import { validateBrowserContractReceipt } from '../release/browser-contract-receipt-contract.mjs'

const digestPattern = /^sha256:[a-f0-9]{64}$/u
const fail = (message) => { throw new Error(`[aot-spa-hydration-raw] ${message}`) }
const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

function tagAttributes(tag)
{
  return Object.fromEntries([...tag.matchAll(/([a-zA-Z][\w:-]*)\s*=\s*["']([^"']*)["']/gu)]
    .map(([, key, value]) => [key.toLowerCase(), value]))
}

function htmlProjection(bytes)
{
  const html = bytes.toString('utf8')
  const htmlTag = html.match(/<html\b[^>]*>/iu)?.[0] ?? ''
  const shellTags = [...html.matchAll(/<[^>]+\bid=["']fsus-aot-shell["'][^>]*>/giu)].map(([tag]) => tag)
  const appCount = [...html.matchAll(/\bid=["']app["']/giu)].length
  const canonicalTags = [...html.matchAll(/<link\b[^>]*>/giu)]
    .map(([tag]) => tagAttributes(tag))
    .filter((attributes) => String(attributes.rel ?? '').split(/\s+/u).includes('canonical'))
  const seoMarkerCount = [...html.matchAll(/<script\b[^>]*data-fsus-seo-head-model(?:\s|=|>)[^>]*>/giu)].length
  const shell = shellTags.length === 1 ? tagAttributes(shellTags[0]) : {}
  let canonicalPath = null
  try
  {
    const canonical = canonicalTags[0]?.href
    const parsed = canonical ? new URL(canonical, 'https://fsusblog.invalid') : null
    canonicalPath = parsed ? `${parsed.pathname}${parsed.search}` : null
  }
  catch { canonicalPath = null }
  return stable({
    digest: sha(bytes),
    byteLength: bytes.byteLength,
    locale: tagAttributes(htmlTag).lang ?? null,
    canonicalPath,
    hydrationKind: shell['data-public-hydration-kind'] ?? null,
    appCount,
    shellCount: shellTags.length,
    seoMarkerCount
  })
}

// The caller owns path safety and supplies retained artifact bytes through readBytes.
export function normalizeAotSpaHydrationFacts(inputs, plan, buildReceipt, { readBytes })
{
  const manifest = inputs.manifest.value
  if (manifest.schema !== 'fsusblog.spa-manifest-descriptor.v1') fail('manifest evidence is not a SPA manifest descriptor')
  const descriptorKeys = [
    'schema', 'releaseId', 'sourceCommit', 'worktreeFingerprint', 'buildReceiptDigest',
    'assetRoot', 'manifestPath', 'manifestDigest', 'assetInventoryDigest', 'contentDigest'
  ].sort()
  if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(descriptorKeys))
  {
    fail('SPA manifest descriptor fields are incomplete or unsupported')
  }
  const descriptor = { ...manifest }
  const descriptorDigest = descriptor.contentDigest
  delete descriptor.contentDigest
  if (!digestPattern.test(String(descriptorDigest ?? '')) || `sha256:${digestValue(descriptor)}` !== descriptorDigest)
  {
    fail('SPA manifest descriptor content digest mismatch')
  }
  if (manifest.sourceCommit !== plan.sourceState.commit
    || String(manifest.worktreeFingerprint).replace(/^sha256:/u, '')
      !== plan.sourceState.worktreeFingerprint.replace(/^sha256:/u, '')
    || manifest.buildReceiptDigest !== plan.build.receiptContentDigest
    || manifest.releaseId !== plan.candidate.releaseId
    || !digestPattern.test(String(manifest.manifestDigest ?? ''))
    || !digestPattern.test(String(manifest.assetInventoryDigest ?? '')))
  {
    fail('SPA manifest descriptor does not exact-match the candidate build')
  }
  const assetRoot = path.resolve(String(manifest.assetRoot ?? ''))
  const manifestPath = path.resolve(String(manifest.manifestPath ?? ''))
  const inventoryPath = path.join(assetRoot, 'asset-manifest.json')
  if (!path.isAbsolute(manifest.assetRoot)
    || path.basename(assetRoot) !== plan.candidate.releaseId
    || manifest.assetRoot !== assetRoot
    || manifest.manifestPath !== path.join(assetRoot, '.vite', 'manifest.json')
    || manifestPath !== path.join(assetRoot, '.vite', 'manifest.json'))
  {
    fail('SPA manifest descriptor release, asset root, and manifest path are not canonical')
  }
  for (const [file, label, expectedDigest] of [
    [manifestPath, 'manifest', manifest.manifestDigest],
    [inventoryPath, 'asset inventory', manifest.assetInventoryDigest]
  ])
  {
    if (sha(readBytes(file)) !== expectedDigest)
    {
      fail(`SPA ${label} bytes do not exact-match the retained release`)
    }
  }
  const frontendManifest = (buildReceipt.artifacts ?? [])
    .filter(({ path: artifactPath }) => artifactPath.endsWith('frontend-dist/.vite/manifest.json'))
  if (frontendManifest.length !== 1 || frontendManifest[0].sha256 !== manifest.manifestDigest)
  {
    fail('SPA manifest descriptor does not match the immutable build manifest artifact')
  }

  const browser = inputs.browserContract.value
  const browserErrors = validateBrowserContractReceipt(browser, {
    expectedCommit: plan.sourceState.commit,
    expectedFingerprint: plan.sourceState.worktreeFingerprint,
    expectedBuildReceiptDigest: plan.build.receiptContentDigest,
    requireSuccess: true
  })
  if (browserErrors.length > 0) fail(`Browser Contract authority is non-qualifying: ${browserErrors.join('; ')}`)
  const scenario = (browser.scenarios ?? []).find(({ id }) => id === 'public-hydration-history-reload')
  const observation = scenario?.observation
  if (scenario?.status !== 'success' || scenario.classification !== 'clean'
    || observation?.schema !== 'fsusblog.browser-contract-public-aot-observation.v1')
  {
    fail('canonical Browser Contract public hydration observation is missing')
  }
  const source = browser.sourceState ?? {}
  const lifecycle = browser.fixture?.lifecycle?.identity ?? {}
  if (source.commit !== plan.sourceState.commit
    || String(source.worktreeFingerprint ?? '').replace(/^sha256:/u, '')
      !== plan.sourceState.worktreeFingerprint.replace(/^sha256:/u, '')
    || browser.buildBinding?.receiptContentDigest !== plan.build.receiptContentDigest
    || browser.runIdentity?.runId !== plan.candidate.runId
    || browser.runIdentity?.attemptId !== plan.candidate.attemptId
    || lifecycle.runId !== plan.candidate.runId
    || lifecycle.attemptId !== plan.candidate.attemptId)
  {
    fail('Browser Contract source/build/run/fixture identity does not match the candidate')
  }
  const htmlBytes = Buffer.from(String(observation.response?.serverHtml ?? ''), 'utf8')
  const serverHtml = htmlProjection(htmlBytes)
  const direct = observation.direct ?? {}
  const fixture = observation.fixture ?? {}
  const stableIdentity = (value) => value?.captured === true && value.appSame === true
    && value.shellSame === true && value.firstChildSame === true
    && value.childElementCountSame === true && value.hydrated === true
    && value.appCount === 1 && value.shellCount === 1
    && Array.isArray(value.violations) && value.violations.length === 0
  const resourceUrls = direct.resourceUrls ?? []
  let responseOrigin = null
  try { responseOrigin = new URL(observation.response?.url).origin } catch { responseOrigin = null }
  const resourcesCoherent = responseOrigin !== null && Array.isArray(resourceUrls) && resourceUrls.length > 0
    && resourceUrls.every((url) => {
      try { return new URL(url).origin === responseOrigin } catch { return false }
    })
  const coherent = observation.response?.status === 200
    && String(observation.response?.headers?.['content-type'] ?? '').toLowerCase().startsWith('text/html')
    && observation.response?.headers?.['x-fsus-release-id'] === plan.candidate.releaseId
    && fixture.articlePath === direct.route && fixture.articlePath === direct.canonicalPath
    && fixture.articlePath === serverHtml.canonicalPath
    && String(fixture.articleId) === fixture.articlePath.split('/').at(-1)
    && direct.title === fixture.articleTitle && direct.locale === serverHtml.locale
    && direct.hydrationKind === serverHtml.hydrationKind
    && direct.appCount === 1 && direct.shellCount === 1 && direct.hydrated === true
    && serverHtml.appCount === 1 && serverHtml.shellCount === 1 && serverHtml.seoMarkerCount === 1
    && String(direct.bootstrapText ?? '').length > 0
    && stableIdentity(observation.spa) && stableIdentity(observation.history) && stableIdentity(observation.reload)
    && resourcesCoherent && browser.diagnostics?.unexpectedIssueCount === 0
  if (!coherent)
  {
    fail('canonical server HTML and Browser Contract hydration outputs are not coherent')
  }

  return {
    buildDigest: plan.build.receiptContentDigest,
    manifestDigest: manifest.manifestDigest,
    publicationDigest: sha(Buffer.from(JSON.stringify(stable({
      url: observation.response.url,
      status: observation.response.status,
      headers: observation.response.headers
    })), 'utf8')),
    localeCanaryDigest: sha(Buffer.from(String(direct.locale), 'utf8')),
    dataCanaryDigest: sha(Buffer.from(String(direct.bootstrapText), 'utf8')),
    serverHtmlDigest: sha(htmlBytes),
    hydratedDomDigest: sha(Buffer.from(JSON.stringify(stable(direct)), 'utf8')),
    clientStateDigest: sha(Buffer.from(JSON.stringify(stable({
      spa: observation.spa,
      history: observation.history,
      reload: observation.reload
    })), 'utf8')),
    networkResourceDigest: sha(Buffer.from(JSON.stringify(resourceUrls), 'utf8')),
    coherent: true
  }
}

export function deriveAotSpaHydrationRawFacts(inputs, { readBytes })
{
  const scenario = inputs.browserContract.value.scenarios
    .find(({ id }) => id === 'public-hydration-history-reload')
  const observation = scenario.observation
  const manifestBytes = readBytes(inputs.manifest.value.manifestPath)
  if (sha(manifestBytes) !== inputs.manifest.value.manifestDigest)
  {
    fail('SPA manifest bytes changed during raw observation projection')
  }
  return {
    manifest: JSON.parse(manifestBytes.toString('utf8')),
    publication: { url: observation.response.url, status: observation.response.status, headers: observation.response.headers },
    locale: observation.direct.locale,
    dataCanary: observation.direct.bootstrapText,
    serverHtml: observation.response.serverHtml,
    hydratedDom: observation.direct,
    clientState: { spa: observation.spa, history: observation.history, reload: observation.reload },
    networkResource: observation.direct.resourceUrls
  }
}
