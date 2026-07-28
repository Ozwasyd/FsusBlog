'use strict'

const fs = require('node:fs')
const { performance } = require('node:perf_hooks')

const nonce = String(process.env.FSUSBLOG_TEMPORAL_HANDSHAKE_NONCE || '')
const existingOwner = String(
  process.env.FSUSBLOG_TEMPORAL_HANDSHAKE_OWNER_PID || ''
)

if (nonce && !existingOwner) {
  process.env.FSUSBLOG_TEMPORAL_HANDSHAKE_OWNER_PID = String(process.pid)
  process.once('exit', () => {
    performance.now()
    const runtime = new Intl.DateTimeFormat().resolvedOptions()
    const payload = {
      nonce,
      observedProcessPid: process.pid,
      emitterPid: process.pid,
      observation: {
        businessEpochUtc:
          process.env.FSUSBLOG_TEST_BUSINESS_EPOCH_UTC || null,
        timezone: runtime.timeZone,
        locale: runtime.locale,
        nodeTimezone: process.env.TZ || null,
        monotonicClockSource: 'performance-now',
        observationBoundary: 'target-node-process-exit-handshake'
      }
    }
    fs.writeSync(
      1,
      `FSUSBLOG_TEMPORAL_CHILD_HANDSHAKE_JSON=${Buffer.from(
        JSON.stringify(payload)
      ).toString('base64url')}\n`
    )
  })
}
