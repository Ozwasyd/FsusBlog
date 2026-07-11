#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'
import { createReleaseManifest, writeReleaseManifestAtomic } from './release-manifest.mjs'

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
  const required = [
    'output', 'release-id', 'commit-sha', 'image-repository', 'image-tag', 'image-digest',
    'frontend-manifest-hash', 'wasm-artifact-hash', 'schema-min-release', 'schema-max-release',
    'dotnet-version', 'node-version', 'docker-version', 'dockerfile-digest'
  ]
  for (const field of required) {
    if (!options[field]) throw new Error(`missing --${field}`)
  }
  const manifest = createReleaseManifest({
    releaseId: options['release-id'],
    commitSha: options['commit-sha'],
    imageRepository: options['image-repository'],
    imageTag: options['image-tag'],
    imageDigest: options['image-digest'],
    registryDigestVerified: true,
    createdAtUtc: options['created-at-utc'],
    frontendManifestHash: options['frontend-manifest-hash'],
    wasmArtifactHash: options['wasm-artifact-hash'],
    schemaMinRelease: options['schema-min-release'],
    schemaMaxRelease: options['schema-max-release'],
    dotnetVersion: options['dotnet-version'],
    nodeVersion: options['node-version'],
    dockerVersion: options['docker-version'],
    dockerfileDigest: options['dockerfile-digest'],
    target: 'final'
  })
  const output = path.resolve(options.output)
  writeReleaseManifestAtomic(output, manifest)
  console.log(JSON.stringify({ status: 'ok', releaseId: manifest.releaseId, imageRef: manifest.imageRef, manifest: output }))
} catch (error) {
  console.error(`[create-release-manifest] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
