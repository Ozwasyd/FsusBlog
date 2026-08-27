import { createHash } from 'node:crypto'

export const digest = (value) => `sha256:${createHash('sha256').update(String(value)).digest('hex')}`

export function runtimeIdentity(overrides = {}) {
  return {
    runId: 'run-runtime-state',
    attemptId: 'attempt-0001',
    sessionId: 'session-a',
    sourceCommit: 'a'.repeat(40),
    sourceFingerprint: digest('source'),
    buildReceiptDigest: digest('build'),
    fixtureDigest: digest('fixture'),
    envelopeDigest: digest('envelope'),
    clockDigest: digest('clock'),
    replayDigest: digest('replay'),
    catalogDigest: digest('catalog'),
    ...overrides
  }
}

export const noSideEffects = () => ({
  writes: 0,
  networkMutations: 0,
  tokenRefreshes: 0,
  repairs: 0,
  lifecycleTransitions: 0
})
