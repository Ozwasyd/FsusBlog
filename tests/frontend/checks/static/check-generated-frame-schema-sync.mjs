#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  assert,
  loadBackendGoldenCatalog,
  loadMatrix,
  loadProtocol,
  root
} from '../support/crossStackMatrix.mjs'

const matrix = loadMatrix()
const protocol = loadProtocol()
const golden = loadBackendGoldenCatalog()
const frontendDecoder = readFileSync(resolve(root, matrix.schema.frontendDecoder), 'utf8')
const backendEnum = readFileSync(resolve(root, matrix.schema.backendEnum), 'utf8')

const protocolFrames = new Map(protocol.frameTypes.map(frame => [frame.name, frame.value]))
const goldenFrames = new Map(golden.frames.map(frame => [frame.name, frame.value]))

for (const [name, value] of protocolFrames) {
  assert(backendEnum.includes(`${name} = ${value}`), `backend enum missing ${name}=${value}`)
  assert(goldenFrames.get(name) === value, `backend golden catalog mismatch for ${name}`)
}

for (const [name] of goldenFrames) {
  assert(protocolFrames.has(name), `backend golden catalog has stale frame ${name}`)
}

assert(frontendDecoder.includes('aeds-protocol.json'), 'frontend test decoder must read shared protocol JSON')
assert(!/const\s+FRAME_[A-Z0-9_]+\s*=\s*\d+/g.test(frontendDecoder), 'frontend test decoder contains hard-coded frame numbers')
assert(!/const\s+AEDS_VERSION\s*=\s*\d+/g.test(frontendDecoder), 'frontend test decoder contains hard-coded AEDS version')
assert(!/const\s+AEDS_HEADER_LENGTH\s*=\s*\d+/g.test(frontendDecoder), 'frontend test decoder contains hard-coded AEDS header length')

console.log(`[generated-frame-schema-sync] ok frames=${protocol.frameTypes.length}`)
