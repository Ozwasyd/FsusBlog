import { execFileSync } from 'node:child_process'

const secretHeader = 'X-Fsus-Runtime-Evidence-Secret'

function localBaseUrl(value, label) {
  const url = new URL(String(value ?? ''))
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error(`${label} must be an explicit loopback Kestrel URL`)
  }
  return url.toString().replace(/\/$/u, '')
}

export function resolveTwoNodeBaseUrls(options) {
  const configured = options.nodeBaseUrls ?? [
    options.baseUrl,
    options.secondaryBaseUrl ?? process.env.FSUSBLOG_RUNTIME_CACHE_SECONDARY_BASE_URL
  ]
  if (!Array.isArray(configured) || configured.length !== 2) {
    throw new Error('runtime cache scenario requires exactly two Kestrel node URLs')
  }
  const nodes = configured.map((value, index) => localBaseUrl(value, `Kestrel node ${index + 1}`))
  if (nodes[0] === nodes[1]) throw new Error('runtime cache scenario requires two distinct Kestrel node URLs')
  return nodes
}

export async function fetchScenarioJson({ fetchImpl, baseUrl, secret, path, method = 'GET', body, timeoutMs = 15000 }) {
  const response = await fetchImpl(`${baseUrl}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      [secretHeader]: secret
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs)
  })
  const text = await response.text()
  let payload
  try {
    payload = text.length === 0 ? null : JSON.parse(text)
  } catch {
    throw new Error(`runtime scenario endpoint returned non-JSON HTTP ${response.status}: ${text.slice(0, 240)}`)
  }
  if (!response.ok) {
    throw new Error(`runtime scenario endpoint returned HTTP ${response.status}: ${JSON.stringify(payload)}`)
  }
  return payload
}

export function createScenarioApi(options) {
  if (options.scenarioApi) return options.scenarioApi
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const common = { fetchImpl, secret: options.secret, timeoutMs: options.timeoutMs ?? 15000 }
  return {
    prepareDistributed: (baseUrl, body) => fetchScenarioJson({ ...common, baseUrl, path: '/_fsus/testing/runtime-cache/scenarios/distributed/prepare', method: 'POST', body }),
    snapshot: (baseUrl, eventId) => fetchScenarioJson({
      ...common,
      baseUrl,
      path: `/_fsus/testing/runtime-cache/scenarios/snapshot${eventId ? `?eventId=${encodeURIComponent(eventId)}` : ''}`
    }),
    cleanup: (baseUrl, body) => fetchScenarioJson({ ...common, baseUrl, path: '/_fsus/testing/runtime-cache/scenarios/cleanup', method: 'POST', body })
  }
}

export function assertRedisNamespaceRemoved(identity, runId, execFile = execFileSync) {
  const output = execFile('docker', [
    'exec', '-i', identity.redisContainer, 'redis-cli', '--scan', '--pattern', `*runtime-cache-evidence:${runId}:*`
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  const keys = String(output).split(/\r?\n/u).filter(Boolean)
  if (keys.length > 0) throw new Error(`runtime cache scenario cleanup left ${keys.length} Redis keys`)
  return true
}

export function policySnapshot(nodeSnapshot, policyId) {
  const policy = nodeSnapshot?.policies?.find((item) => item.policyId === policyId)
  if (!policy) throw new Error(`runtime scenario snapshot is missing ${policyId} residency`)
  for (const field of ['maxEntries', 'maxLogicalBytes', 'maxCapacityBytes', 'entries', 'logicalBytes', 'capacityBytes', 'capacityEvictions', 'invalidatedEvictions', 'contendedLockWaitTicks']) {
    if (!Number.isInteger(policy[field]) || policy[field] < 0) {
      throw new Error(`runtime scenario ${policyId}.${field} is invalid`)
    }
  }
  return policy
}

export function percentile(values, percentage) {
  if (values.length === 0) throw new Error('percentile requires at least one observation')
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1)]
}

export function evidenceAssertion(id, passed, evidence, firstRequest) {
  return {
    assertion: {
      id,
      status: passed ? 'passed' : 'failed',
      expected: { ...evidence, contractSatisfied: true },
      actual: { ...evidence, contractSatisfied: passed }
    },
    firstRequest
  }
}
