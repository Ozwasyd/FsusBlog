#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function main() {
  const clientRoot = resolve(process.cwd())
  const bootstrapFile = resolve(clientRoot, 'src/bootstrap/publicAotBootstrap.ts')
  const binaryPayloadFile = resolve(clientRoot, 'src/bootstrap/publicAotBinaryPayload.ts')
  const rendererIndexFile = resolve(clientRoot, 'src/public-renderers/index.ts')

  const bootstrapSource = readFileSync(bootstrapFile, 'utf8')
  const binaryPayloadSource = readFileSync(binaryPayloadFile, 'utf8')
  const rendererIndexSource = readFileSync(rendererIndexFile, 'utf8')

  assert(bootstrapSource.includes("decodePublicAotPayload"), 'publicAotBootstrap.ts must consume the canonical binary payload decoder')
  assert(bootstrapSource.includes("BOOTSTRAP_SCRIPT_ID = 'fsus-aot-bootstrap'"), 'publicAotBootstrap.ts must read the server AOT bootstrap script')
  assert(binaryPayloadSource.includes('AEDS_VERSION'), 'publicAotBinaryPayload.ts must validate AEDS protocol version')
  assert(binaryPayloadSource.includes('FrameType.PublicAotBootstrap'), 'publicAotBinaryPayload.ts must validate the PublicAotBootstrap frame type')
  assert(rendererIndexSource.includes('hydratePublicPage'), 'public-renderers index must export hydratePublicPage')

  console.log('[check-public-renderer-version-sync] ok (server-aot-binary-bootstrap)')
}

try {
  main()
} catch (error) {
  console.error('[check-public-renderer-version-sync] failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
}
