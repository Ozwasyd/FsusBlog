#!/usr/bin/env node
import fs from 'node:fs'
import process from 'node:process'

const requestIndex = process.argv.indexOf('--request')
const outputIndex = process.argv.indexOf('--output')
const requestFile = requestIndex >= 0 ? process.argv[requestIndex + 1] : null
const outputFile = outputIndex >= 0 ? process.argv[outputIndex + 1] : null
if (!requestFile || !outputFile || process.env.FSUSBLOG_RUNTIME_MATRIX_EXECUTOR !== '1') process.exit(2)
const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'))
fs.writeFileSync(outputFile, `${JSON.stringify({
  schema: 'fsusblog.runtime-publish-profile-result.v1',
  status: 'failed',
  identity: request.identity,
  error: 'fixture retained the executor failure detail'
})}\n`, { flag: 'wx', mode: 0o600 })
process.exit(17)
