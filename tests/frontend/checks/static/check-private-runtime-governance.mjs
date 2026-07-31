#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.cwd(), '../..')
const read = (path) => readFileSync(resolve(root, path), 'utf8')
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const registry = read('src/frontend/src/services/privateStorageRegistry.ts')
const binaryTransport = read('src/frontend/src/services/binaryTransport.ts')
const telemetryPrivacy = read('src/frontend/src/services/telemetryPrivacy.ts')
const router = read('src/frontend/src/router/index.ts')
const navigation = read('src/frontend/src/security/privateNavigationPolicy.ts')
const authComposition = read('src/frontend/src/services/authBroadcastComposition.ts')
const serviceWorker = read('src/frontend/public/sw.js')
const matrix = read('tests/frontend/unit/router/index.test.ts')
const lifecycle = read('tests/frontend/unit/bootstrap/sessionExpiryBridge.test.ts')
const postAuthCallers = [
  'src/frontend/src/composables/usePasskeyLogin.ts',
  'src/frontend/src/composables/useAuthLogin.ts',
  'src/frontend/src/composables/useAnonymousOnboarding.ts'
]

for (const registeredValue of [
  'fsus_user_storage',
  'notification_stream_guest_pow',
  'fsusblog-article-recovery-journal',
  'fsus:comment-draft:v1:',
  'fsus:image-upload-session:',
  'fsus:console-welcome-callout:dismissed:',
  'fsusblog_local_fixture_session',
  'fsusblog_local_fixture_admin_session'
]) {
  assert(registry.includes(registeredValue), `private storage registry is missing ${registeredValue}`)
}

assert(!binaryTransport.includes('fsus:binary:failure'), 'binary failure must not use a global CustomEvent')
assert(!binaryTransport.includes('fsus:binary:error'), 'unused global binary error event must stay removed')
assert(binaryTransport.includes('recordBinaryFailureTelemetry({'),
  'binary failures must enter the private telemetry module boundary')
for (const allowedField of ['operationId', 'routeClass', 'status', 'errorCode', 'category', 'frameType']) {
  assert(telemetryPrivacy.includes(`'${allowedField}'`), `binary failure allowlist is missing ${allowedField}`)
}
const binaryAllowlist = telemetryPrivacy.slice(
  telemetryPrivacy.indexOf('export const BINARY_FAILURE_TELEMETRY_FIELDS'),
  telemetryPrivacy.indexOf('] as const')
)
for (const forbiddenField of ['url', 'query', 'details', 'message', 'traceId', 'accountId', 'sessionId']) {
  assert(!binaryAllowlist.includes(`'${forbiddenField}'`), `binary failure allowlist includes forbidden field ${forbiddenField}`)
}

assert(router.includes('privateQueryNeedsSanitizing(to.name, to.query)'),
  'router must sanitize private query fields before history commit')
assert(router.includes('buildPrivateLoginRedirect(to, router)'),
  'private login redirects must use the declared navigation policy')
assert(navigation.includes('PRIVATE_NAVIGATION_ALLOWED_FIELDS'),
  'private navigation policy must expose a machine-readable allowlist')
assert(authComposition.includes('dispatchSessionExpired()'),
  'cross-tab identity invalidation must unload the active private route')

for (const session of ['none', 'account', 'admin', 'dual']) {
  assert(matrix.includes(`session: '${session}'`), `route matrix is missing ${session} session coverage`)
}
for (const primitive of ['createMemoryHistory', 'data-private-view', 'AbortController', 'unsubscribe', 'vi.useFakeTimers']) {
  assert(matrix.includes(primitive) || lifecycle.includes(primitive),
    `local private runtime gate is missing ${primitive}`)
}

assert(serviceWorker.includes('isPrivateOrSensitiveRequest(request, url)'),
  'service worker private network-only boundary must remain active')
assert(serviceWorker.includes('isPublicShellRequest(request, url)'),
  'service worker Public AOT shell boundary must remain active')

for (const path of postAuthCallers) {
  const source = read(path)
  const commitIndex = source.indexOf('if (!await commitPostAuthSession())')
  const broadcastIndex = source.indexOf('await authBroadcastRuntime.broadcastLogin()')
  assert(source.includes("import { usePostAuthCommit } from '@/composables/usePostAuthCommit'"),
    `${path} must delegate identity ownership to usePostAuthCommit`)
  assert(commitIndex >= 0, `${path} must fail closed when the shared post-auth commit fails`)
  assert(broadcastIndex > commitIndex, `${path} must broadcast login only after the shared post-auth commit`)
  assert(!source.includes('ensureBootstrap(true)'), `${path} must not substitute bootstrap for a Session snapshot`)
}

console.log('[check-private-runtime-governance] ok')
