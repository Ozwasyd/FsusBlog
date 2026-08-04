const dangerousProtocol = /^(?:javascript|vbscript|data):/iu

export const productionXssRelevantCspDirectives = Object.freeze([
  'base-uri',
  'child-src',
  'connect-src',
  'default-src',
  'form-action',
  'frame-src',
  'navigate-to',
  'object-src',
  'require-trusted-types-for',
  'script-src',
  'script-src-attr',
  'script-src-elem',
  'trusted-types',
  'worker-src'
])

export function isSecurityRelevantConsoleMessage(message) {
  const text = String(message)
  if (/trusted[ -]types|require-trusted-types-for/iu.test(text)) return true
  if (!/content security policy|violat(?:e|ion)/iu.test(text)) return false
  return productionXssRelevantCspDirectives.some((directive) =>
    new RegExp(`(?:^|[^a-z-])${directive}(?:[^a-z-]|$)`, 'iu').test(text)
  )
}

export function evaluateSecurityObservation(observation) {
  const failures = []
  for (const key of [
    'dialogs',
    'popups',
    'downloads',
    'externalRequests',
    'unexpectedNavigations',
    'cspViolations',
    'trustedTypesErrors'
  ]) {
    if ((observation[key] ?? []).length > 0) failures.push(`${key}:${JSON.stringify(observation[key])}`)
  }
  if ((observation.executionSentinel ?? 0) !== 0) failures.push(`executionSentinel:${observation.executionSentinel}`)
  if ((observation.dangerousDom ?? []).length > 0) failures.push(`dangerousDom:${JSON.stringify(observation.dangerousDom)}`)
  if ((observation.missingText ?? []).length > 0) failures.push(`missingText:${JSON.stringify(observation.missingText)}`)
  if ((observation.missingSelectors ?? []).length > 0) failures.push(`missingSelectors:${JSON.stringify(observation.missingSelectors)}`)
  return failures
}

export function recordMainFrameNavigation(observation, url) {
  const remaining = observation.allowedNavigations?.get(url) ?? 0
  if (remaining > 0) {
    observation.allowedNavigations.set(url, remaining - 1)
  } else if (observation.lastNavigationUrl !== url) {
    observation.unexpectedNavigations.push(url)
  }
  observation.lastNavigationUrl = url
}

export function auditSerializedElementTree(nodes, invariants = {}, baseUrl = 'http://127.0.0.1') {
  const failures = []
  const forbidden = new Set((invariants.forbidSelectors ?? []).map(String))
  for (const node of nodes) {
    if (node.forbiddenSelectors?.some((selector) => forbidden.has(selector))) {
      failures.push(`forbidden-selector:${node.forbiddenSelectors.find((selector) => forbidden.has(selector))}`)
    }
    const namespace = String(node.namespace ?? '')
    if (namespace && !(invariants.allowedNamespaces ?? []).includes(namespace)) {
      failures.push(`namespace:${namespace}`)
    }
    for (const [name, raw] of Object.entries(node.attributes ?? {})) {
      const value = String(raw).trim()
      if (/^on/iu.test(name)) failures.push(`event-attribute:${name}`)
      if (/^(?:href|src|xlink:href|action|formaction|poster)$/iu.test(name)) {
        if (dangerousProtocol.test(value)) failures.push(`dangerous-url:${name}`)
        else if (invariants.forbidExternalUrls === true && /^https?:/iu.test(value)
          && new URL(value, baseUrl).origin !== new URL(baseUrl).origin) {
          failures.push(`external-url:${name}`)
        }
      }
    }
  }
  return failures
}

export const productionXssKillControls = Object.freeze([
  { id: 'script-execution', observation: { executionSentinel: 1 } },
  { id: 'external-request', observation: { externalRequests: ['https://attacker.invalid/x'] } },
  { id: 'csp-violation', observation: { cspViolations: ['script-src'] } },
  { id: 'dangerous-dom', observation: { dangerousDom: ['event-attribute:onerror'] } }
])
