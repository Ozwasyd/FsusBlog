import crypto from 'node:crypto'
import path from 'node:path'

const SHA256 = /^sha256:[0-9a-f]{64}$/u
const HMAC_SHA256 = /^hmac-sha256:[0-9a-f]{64}$/u

export function validateStrongAssetCompatibilityEvidence(value, name, errors) {
  const browser = value.browser
  if (browser?.schema !== 'fsusblog.release-asset-browser-evidence.v1' || browser?.status !== 'pass') {
    errors.push(`${name}: controlled browser evidence is missing or failed`)
    return
  }
  if (typeof browser.browser?.name !== 'string' || browser.browser.name.length === 0
    || typeof browser.browser?.version !== 'string' || browser.browser.version.length === 0
    || typeof browser.browser?.executablePath !== 'string' || !path.isAbsolute(browser.browser.executablePath)
    || !SHA256.test(String(browser.browser?.executableSha256 ?? ''))) {
    errors.push(`${name}: browser binary/version evidence is invalid`)
  }
  if (browser.bindings?.rolloutId !== value.rolloutId
    || browser.bindings?.sourceReleaseId !== value.sourceReleaseId
    || browser.bindings?.targetReleaseId !== value.targetReleaseId
    || !SHA256.test(String(browser.bindings?.scenarioSha256 ?? ''))
    || !SHA256.test(String(browser.bindings?.manifestSha256 ?? ''))
    || !SHA256.test(String(browser.bindings?.gcEvidenceSha256 ?? ''))) {
    errors.push(`${name}: browser input binding is invalid`)
  }
  if (browser.beforeSwitch?.status !== 'pass'
    || browser.beforeSwitch?.serviceWorker?.controller?.state !== 'activated') {
    errors.push(`${name}: old page/service worker was not controlled before switch`)
  }
  const delayed = Array.isArray(browser.delayed?.resources) ? browser.delayed.resources : []
  for (const kind of ['javascript', 'stylesheet', 'wasm', 'font']) {
    if (!delayed.some(resource => resource?.kind === kind && resource?.hashMatches === true)) {
      errors.push(`${name}: delayed browser resource missing or failed: ${kind}`)
    }
  }
  if (browser.afterSwitch?.status !== 'pass'
    || browser.compatibility?.oldFrontendToNewBackend?.status !== 'pass'
    || browser.compatibility?.newFrontendToOldBackend?.status !== 'pass') {
    errors.push(`${name}: browser cross-switch compatibility is incomplete`)
  }
  const cacheReads = Array.isArray(browser.afterGc?.cacheReads) ? browser.afterGc.cacheReads : []
  if (browser.afterGc?.status !== 'pass' || cacheReads.length === 0
    || cacheReads.some(read => read?.cacheHit !== true || read?.hashMatches === false)) {
    errors.push(`${name}: GC-after old page/SW/cache evidence is incomplete`)
  }
  if (!Array.isArray(browser.pageErrors) || browser.pageErrors.length !== 0
    || !Array.isArray(browser.network?.failures)) {
    errors.push(`${name}: browser error/network ledger is invalid`)
  }
  const binding = value.browserBinding
  const { browserBinding: ignored, ...unsignedValue } = value
  if (binding?.schema !== 'fsusblog.release-asset-browser-binding.v1'
    || binding?.algorithm !== 'hmac-sha256'
    || !HMAC_SHA256.test(String(binding?.keyId ?? ''))
    || !HMAC_SHA256.test(String(binding?.signature ?? ''))
    || binding?.rolloutId !== value.rolloutId
    || binding?.sourceReleaseId !== value.sourceReleaseId
    || binding?.targetReleaseId !== value.targetReleaseId
    || binding?.browserName !== browser.browser?.name
    || binding?.browserVersion !== browser.browser?.version
    || binding?.browserExecutablePath !== browser.browser?.executablePath
    || binding?.browserExecutableSha256 !== browser.browser?.executableSha256
    || binding?.scenarioSha256 !== browser.bindings?.scenarioSha256
    || binding?.manifestSha256 !== browser.bindings?.manifestSha256
    || binding?.gcEvidenceSha256 !== browser.bindings?.gcEvidenceSha256
    || binding?.payloadSha256 !== sha256Text(canonicalJson(unsignedValue))) {
    errors.push(`${name}: browser HMAC binding structure or payload binding is invalid`)
  }
}

function sha256Text(value)
{
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`
}

function canonicalJson(value)
{
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}
