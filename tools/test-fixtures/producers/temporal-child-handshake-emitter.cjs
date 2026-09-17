'use strict'

const { performance } = require('node:perf_hooks')

const runtime = new Intl.DateTimeFormat().resolvedOptions()
performance.now()
const payload = {
  nonce: String(process.env.FSUSBLOG_TEMPORAL_HANDSHAKE_NONCE || ''),
  observedProcessPid: Number(
    process.env.FSUSBLOG_TEMPORAL_HANDSHAKE_OWNER_PID || 0
  ),
  emitterPid: process.pid,
  observation: {
    businessEpochUtc:
      process.env.FSUSBLOG_TEST_BUSINESS_EPOCH_UTC || null,
    timezone: runtime.timeZone,
    locale: runtime.locale,
    nodeTimezone: process.env.TZ || null,
    monotonicClockSource: 'performance-now',
    observationBoundary: 'target-bash-process-exit-handshake'
  }
}
process.stdout.write(
  `FSUSBLOG_TEMPORAL_CHILD_HANDSHAKE_JSON=${Buffer.from(
    JSON.stringify(payload)
  ).toString('base64url')}\n`
)
