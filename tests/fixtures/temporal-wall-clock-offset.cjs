'use strict'

const SystemDate = Date
const offsetMs = Number(process.env.FSUSBLOG_TEST_HOST_CLOCK_OFFSET_MS || 0)

class OffsetDate extends SystemDate {
  constructor(...args) {
    super(...(args.length > 0 ? args : [SystemDate.now() + offsetMs]))
  }

  static now() {
    return SystemDate.now() + offsetMs
  }
}

globalThis.Date = OffsetDate
