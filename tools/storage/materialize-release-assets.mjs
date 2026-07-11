#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { readReleaseManifest } from '../release/release-manifest.mjs'
import {
  MATERIALIZATION_REPORT_SCHEMA,
  materializeReleaseAssets,
  normalizeSlot,
  writeJsonAtomic
} from './release-assets.mjs'
import { createReleaseCompatibilityMetadata } from './release-compatibility.mjs'

let options = {}
try {
  options = parseArgs(process.argv.slice(2))
  const manifestFile = requiredPath(options, 'release-manifest')
  const slot = normalizeSlot(options.slot)
  const releaseManifest = readReleaseManifest(manifestFile, { requireRegistryDigest: true })
  const storeDirectory = path.resolve(options.store ?? process.env.FSUSBLOG_RELEASE_ASSET_STORE ?? '/var/lib/fsusblog/release-assets')
  const dryRun = options['dry-run'] === true
  const compatibility = createReleaseCompatibilityMetadata({
    releaseId: releaseManifest.releaseId,
    frontendBuildId: releaseManifest.releaseId,
    assetManifestSha256: null
  })

  const { sourceDirectory, cleanup } = resolveSourceDirectory(options.source, releaseManifest.imageRef)
  try {
    const { report } = materializeReleaseAssets({
      releaseId: releaseManifest.releaseId,
      slot,
      sourceDirectory,
      storeDirectory,
      compatibility,
      dryRun
    })
    const output = {
      ...report,
      releaseManifest: manifestFile,
      imageRef: releaseManifest.imageRef,
      source: options.source ? path.resolve(options.source) : `docker://${releaseManifest.imageRef}/app/wwwroot`
    }
    emit(output, options.out)
  } finally {
    cleanup()
  }
} catch (error) {
  const report = {
    schema: MATERIALIZATION_REPORT_SCHEMA,
    status: 'fail',
    releaseId: null,
    slot: options.slot ?? null,
    dryRun: options['dry-run'] === true,
    assets: [],
    actions: [],
    errors: [error instanceof Error ? error.message : String(error)]
  }
  try { emit(report, options.out) } catch { process.stdout.write(`${JSON.stringify(report)}\n`) }
  process.exitCode = 1
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (name === '--dry-run') {
      parsed['dry-run'] = true
      continue
    }
    if (!name?.startsWith('--')) throw new Error(`invalid argument: ${name ?? '<end>'}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${name}`)
    parsed[name.slice(2)] = value
    index += 1
  }
  return parsed
}

function requiredPath(parsed, name) {
  if (!parsed[name]) throw new Error(`missing --${name}`)
  return path.resolve(parsed[name])
}

function resolveSourceDirectory(explicitSource, imageRef) {
  if (explicitSource) return { sourceDirectory: path.resolve(explicitSource), cleanup() {} }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-assets-'))
  let containerId = null
  try {
    const create = spawnSync('docker', ['create', imageRef], { encoding: 'utf8' })
    if (create.status !== 0) throw new Error(`docker create failed: ${(create.stderr || create.stdout).trim()}`)
    containerId = create.stdout.trim()
    if (!/^[0-9a-f]{12,64}$/u.test(containerId)) throw new Error('docker create returned an invalid container id')
    const sourceDirectory = path.join(temporary, 'wwwroot')
    fs.mkdirSync(sourceDirectory, { recursive: true })
    const copy = spawnSync('docker', ['cp', `${containerId}:/app/wwwroot/.`, sourceDirectory], { encoding: 'utf8' })
    if (copy.status !== 0) throw new Error(`docker cp failed: ${(copy.stderr || copy.stdout).trim()}`)
    return {
      sourceDirectory,
      cleanup() {
        removeContainer(containerId)
        fs.rmSync(temporary, { recursive: true, force: true })
      }
    }
  } catch (error) {
    removeContainer(containerId)
    fs.rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}

function removeContainer(containerId) {
  if (containerId) spawnSync('docker', ['rm', '--force', containerId], { stdio: 'ignore' })
}

function emit(report, outputFile) {
  if (outputFile) writeJsonAtomic(path.resolve(outputFile), report)
  process.stdout.write(`${JSON.stringify(report)}\n`)
}
