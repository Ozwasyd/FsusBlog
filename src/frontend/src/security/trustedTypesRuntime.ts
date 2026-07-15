type TrustedTypePolicyRules = {
  createHTML?: (value: string) => string
  createScript?: (value: string) => string
  createScriptURL?: (value: string) => string
}

type TrustedTypePolicyLike = {
  createHTML(value: string): unknown
  createScript(value: string): unknown
  createScriptURL(value: string): unknown
}

type TrustedTypePolicyFactoryLike = {
  createPolicy(name: string, rules: TrustedTypePolicyRules): TrustedTypePolicyLike
}

const APP_POLICY_NAME = 'fsusblog'
const COMMENT_PRIVACY_PROVER_MODULE_PATH = '/wasm/comment-privacy-prover.js'
const NON_EXECUTABLE_SCRIPT_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/octet-stream'
])
const UNSAFE_HTML_PATTERN = /<\s*(?:script|iframe|object|embed|form|input|button|textarea|select|option|svg|math|foreignobject|link)\b|\s(?:on[a-z]+|srcdoc)\s*=|\s(?:href|src|xlink:href|formaction)\s*=\s*(?:['"]\s*)?javascript:/iu

let appPolicy: TrustedTypePolicyLike | null = null
let policyCreationAttempted = false

export function setSanitizedTemplateHtml(template: HTMLTemplateElement, sanitizedHtml: string): void {
  template.innerHTML = toTrustedSanitizedHtml(sanitizedHtml)
}

export function toTrustedSanitizedHtml(sanitizedHtml: string): string {
  assertSanitizedHtml(sanitizedHtml)
  const policy = getAppPolicy()
  return (policy?.createHTML(sanitizedHtml) ?? sanitizedHtml) as string
}

export function setNonExecutableScriptText(script: HTMLScriptElement, value: string): void {
  const scriptType = script.type.trim().toLowerCase()
  if (!NON_EXECUTABLE_SCRIPT_TYPES.has(scriptType)) {
    throw new Error('trusted_types_executable_script_text_rejected')
  }
  const policy = getAppPolicy()
  script.textContent = (policy?.createScript(value) ?? value) as string
}

export function setCommentPrivacyProverScriptUrl(script: HTMLScriptElement, moduleUrl: string): void {
  const resolved = resolveCommentPrivacyProverModuleUrl(moduleUrl)
  const policy = getAppPolicy()
  script.src = (policy?.createScriptURL(resolved) ?? resolved) as string
}

export function resolveCommentPrivacyProverModuleUrl(moduleUrl: string): string {
  const resolved = resolveApplicationUrl(moduleUrl)
  if (resolved.pathname !== COMMENT_PRIVACY_PROVER_MODULE_PATH || resolved.search || resolved.hash) {
    throw new Error('comment_privacy_prover_artifact_invalid')
  }
  return resolved.href
}

export function resetTrustedTypesRuntimeForTests(): void {
  appPolicy = null
  policyCreationAttempted = false
}

function getAppPolicy(): TrustedTypePolicyLike | null {
  if (policyCreationAttempted) {
    return appPolicy
  }
  policyCreationAttempted = true
  const factory = (globalThis as typeof globalThis & {
    trustedTypes?: TrustedTypePolicyFactoryLike
  }).trustedTypes
  if (!factory || typeof factory.createPolicy !== 'function') {
    return null
  }
  try {
    appPolicy = factory.createPolicy(APP_POLICY_NAME, {
      createHTML: value => value,
      createScript: value => value,
      createScriptURL: value => value
    })
  } catch {
    appPolicy = null
  }
  return appPolicy
}

function assertSanitizedHtml(value: string): void {
  if (UNSAFE_HTML_PATTERN.test(value)) {
    throw new Error('trusted_types_unsanitized_html_rejected')
  }
}

function resolveApplicationUrl(value: string): URL {
  const raw = value.trim()
  if (!raw) {
    throw new Error('comment_privacy_prover_artifact_invalid')
  }
  const runtimeLocation = typeof globalThis.location === 'undefined' ? null : globalThis.location
  const baseHref = runtimeLocation?.href ?? 'http://localhost/'
  let resolved: URL
  try {
    resolved = new URL(raw, baseHref)
  } catch {
    throw new Error('comment_privacy_prover_artifact_invalid')
  }
  const expectedOrigin = runtimeLocation?.origin || new URL(baseHref).origin
  if (resolved.origin !== expectedOrigin || resolved.username || resolved.password) {
    throw new Error('comment_privacy_prover_artifact_invalid')
  }
  return resolved
}
