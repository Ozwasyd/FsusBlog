#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function main() {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
  const clientRoot = resolve(repoRoot, 'src/frontend')
  const bootstrapFile = resolve(clientRoot, 'src/bootstrap/publicAotBootstrap.ts')
  const binaryPayloadFile = resolve(clientRoot, 'src/bootstrap/publicAotBinaryPayload.ts')
  const rendererIndexFile = resolve(clientRoot, 'src/public-renderers/index.ts')
  const publicEntryCoreFile = resolve(clientRoot, 'src/public-renderers/publicEntryCore.ts')
  const backendConstantsFile = resolve(repoRoot, 'src/backend/Infrastructure/PublicAot/PublicAotConstants.cs')

  const bootstrapSource = readFileSync(bootstrapFile, 'utf8')
  const binaryPayloadSource = readFileSync(binaryPayloadFile, 'utf8')
  const rendererIndexSource = readFileSync(rendererIndexFile, 'utf8')
  const publicEntryCoreSource = readFileSync(publicEntryCoreFile, 'utf8')
  const backendConstantsSource = readFileSync(backendConstantsFile, 'utf8')
  const frontendRendererVersion = publicEntryCoreSource.match(
    /PUBLIC_RENDERER_VERSION\s*=\s*['"]([^'"]+)['"]/u
  )?.[1]
  const backendRendererVersion = backendConstantsSource.match(
    /RendererVersion\s*=\s*"([^"]+)"/u
  )?.[1]

  assert(bootstrapSource.includes("decodePublicAotPayload"), 'publicAotBootstrap.ts must consume the canonical binary payload decoder')
  assert(bootstrapSource.includes("BOOTSTRAP_SCRIPT_ID = 'fsus-aot-bootstrap'"), 'publicAotBootstrap.ts must read the server AOT bootstrap script')
  assert(binaryPayloadSource.includes('AEDS_VERSION'), 'publicAotBinaryPayload.ts must validate AEDS protocol version')
  assert(binaryPayloadSource.includes('FrameType.PublicAotBootstrap'), 'publicAotBinaryPayload.ts must validate the PublicAotBootstrap frame type')
  assert(rendererIndexSource.includes('hydratePublicPage'), 'public-renderers index must export hydratePublicPage')
  assert(frontendRendererVersion, 'publicEntryCore.ts must declare PUBLIC_RENDERER_VERSION')
  assert(backendRendererVersion, 'PublicAotConstants.cs must declare RendererVersion')
  assert(
    frontendRendererVersion === backendRendererVersion,
    `public renderer version drift: frontend=${frontendRendererVersion} backend=${backendRendererVersion}`
  )

  console.log(`[check-public-renderer-version-sync] ok (${frontendRendererVersion})`)
}

try {
  main()
} catch (error) {
  console.error('[check-public-renderer-version-sync] failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
}
