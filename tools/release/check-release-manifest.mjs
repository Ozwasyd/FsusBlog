#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'
import { readLegacyReleaseManifestV1, readReleaseManifest } from './release-manifest.mjs'

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || value === undefined) throw new Error(`invalid argument near ${name ?? '<end>'}`)
    options[name.slice(2)] = value
  }
  return options
}

try {
  const options = parseArgs(process.argv.slice(2))
  if (!options.manifest) throw new Error('missing --manifest')
  const manifestFile = path.resolve(options.manifest)
  const legacyRollback = options['legacy-rollback'] === 'true'
  if (options['legacy-rollback'] !== undefined && !['true', 'false'].includes(options['legacy-rollback'])) {
    throw new Error('--legacy-rollback must be true or false')
  }
  const readOptions = {
    requireRegistryDigest: true,
    requireConcreteRuntimeProfile: true,
    expectedReleaseId: options['release-id'],
    expectedImageRef: options['image-ref'],
    expectedImageDigest: options['image-digest'],
    expectedCommitSha: options['commit-sha']
  }
  const legacyResult = legacyRollback ? readLegacyReleaseManifestV1(manifestFile, readOptions) : null
  const manifest = legacyResult?.manifest ?? readReleaseManifest(manifestFile, readOptions)
  const slot = options.slot ?? 'candidate'
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(slot)) throw new Error('slot must be a safe lowercase identifier')
  const output = {
    schema: 'fsusblog.release-deploy-input.v1',
    status: 'ok',
    legacy: legacyResult?.legacy === true,
    rollbackOnly: legacyResult?.rollbackOnly === true,
    manifest: manifestFile,
    releaseId: manifest.releaseId,
    createdAtUtc: manifest.createdAtUtc,
    commitSha: manifest.commitSha,
    slot,
    imageRef: manifest.imageRef,
    imageTag: manifest.imageTag,
    imageDigest: manifest.imageDigest,
    runtimeProfile: manifest.runtimeProfile ?? null,
    rollbackTarget: manifest.releaseId
  }
  if (options.format === 'lines') {
    for (const field of ['releaseId', 'createdAtUtc', 'commitSha', 'slot', 'imageRef', 'imageTag', 'imageDigest', 'rollbackTarget']) {
      console.log(output[field])
    }
  } else {
    console.log(JSON.stringify(output))
  }
} catch (error) {
  console.error(`[check-release-manifest] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
