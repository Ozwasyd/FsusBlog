#!/usr/bin/env node

import { access, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const BACKEND_ROOT = path.join(ROOT, 'src/backend')
const CATALOG_PATH = path.join(ROOT, 'tests/backend/Fixtures/background-service-classification.json')
const ALLOWED_CLASSIFICATIONS = new Set(['active-singleton', 'multi-consumer-safe', 'instance-local'])
const ALLOWED_DRAIN = new Set(['cancel', 'finish-current', 'explicit-flush'])

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries
    .filter(entry => entry.name !== 'bin' && entry.name !== 'obj')
    .map(entry => {
      const target = path.join(directory, entry.name)
      return entry.isDirectory() ? listFiles(target) : [target]
    }))
  return nested.flat()
}

function discoverBackgroundServices(source, relativePath) {
  const discovered = []
  const pattern = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^{}]*?\))?\s*:\s*BackgroundService\b/gms
  for (const match of source.matchAll(pattern)) {
    discovered.push({ type: match[1], source: relativePath })
  }
  return discovered
}

function requireText(value, field, owner, errors) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${owner}: ${field} must be a non-empty string`)
  }
}

async function main() {
  const errors = []
  const catalog = JSON.parse(await readFile(CATALOG_PATH, 'utf8'))
  if (catalog.schemaVersion !== 'fsus.background-service-classification.v1') {
    errors.push('catalog: unsupported schemaVersion')
  }
  if (!Array.isArray(catalog.services)) errors.push('catalog: services must be an array')
  if (!Array.isArray(catalog.drainParticipants)) errors.push('catalog: drainParticipants must be an array')

  const csFiles = (await listFiles(BACKEND_ROOT)).filter(file => file.endsWith('.cs'))
  const sources = await Promise.all(csFiles.map(async file => ({
    source: path.relative(ROOT, file).replaceAll(path.sep, '/'),
    text: await readFile(file, 'utf8')
  })))
  const discovered = sources.flatMap(file => discoverBackgroundServices(file.text, file.source))
  const registrations = sources.map(file => file.text).join('\n')

  const catalogByType = new Map()
  for (const service of catalog.services ?? []) {
    const owner = `service ${String(service.type)}`
    requireText(service.type, 'type', owner, errors)
    requireText(service.source, 'source', owner, errors)
    requireText(service.idempotency, 'idempotency', owner, errors)
    requireText(service.fence, 'fence', owner, errors)
    requireText(service.replaySource, 'replaySource', owner, errors)
    if (!ALLOWED_CLASSIFICATIONS.has(service.classification)) {
      errors.push(`${owner}: classification must be active-singleton, multi-consumer-safe or instance-local`)
    }
    if (!ALLOWED_DRAIN.has(service.drain)) {
      errors.push(`${owner}: drain must be cancel, finish-current or explicit-flush`)
    }
    if (!Number.isInteger(service.maxDrainSeconds) || service.maxDrainSeconds < 1 || service.maxDrainSeconds > 300) {
      errors.push(`${owner}: maxDrainSeconds must be an integer between 1 and 300`)
    }
    if (catalogByType.has(service.type)) {
      errors.push(`${owner}: duplicate catalog entry`)
    } else {
      catalogByType.set(service.type, service)
    }
  }

  const discoveredByType = new Map()
  for (const service of discovered) {
    if (discoveredByType.has(service.type)) {
      errors.push(`source: duplicate BackgroundService type ${service.type}`)
    }
    discoveredByType.set(service.type, service)
    const classified = catalogByType.get(service.type)
    if (!classified) {
      errors.push(`${service.source}: BackgroundService ${service.type} is unclassified`)
      continue
    }
    if (classified.source !== service.source) {
      errors.push(`${service.type}: catalog source ${classified.source} does not match ${service.source}`)
    }
    const registrationPatterns = [
      `AddHostedService<${service.type}>`,
      `AddHostedService(sp => sp.GetRequiredService<${service.type}>())`,
      `Singleton<IHostedService, ${service.type}>`,
      `Singleton<IHostedService,${service.type}>`
    ]
    if (!registrationPatterns.some(pattern => registrations.includes(pattern))) {
      errors.push(`${service.type}: no hosted-service registration was found`)
    }

    if (classified.classification === 'active-singleton') {
      const source = sources.find(candidate => candidate.source === service.source)?.text ?? ''
      if (!source.includes('IBackgroundWorkerLease')) {
        errors.push(`${service.type}: active-singleton must consume IBackgroundWorkerLease`)
      }
      if (classified.fence !== 'active-release+worker-lease+pre-commit') {
        errors.push(`${service.type}: active-singleton fence contract must require active release, worker lease and pre-commit guard`)
      }
    }
  }

  for (const [type, service] of catalogByType) {
    if (!discoveredByType.has(type)) {
      errors.push(`${service.source}: catalog type ${type} is not a BackgroundService`)
    }
    try {
      await access(path.join(ROOT, service.source))
    } catch {
      errors.push(`${service.source}: catalog source does not exist`)
    }
  }

  const participantNames = new Set()
  for (const participant of catalog.drainParticipants ?? []) {
    const owner = `drain participant ${String(participant.name)}`
    requireText(participant.name, 'name', owner, errors)
    requireText(participant.source, 'source', owner, errors)
    requireText(participant.strategy, 'strategy', owner, errors)
    requireText(participant.replaySource, 'replaySource', owner, errors)
    if (!Number.isInteger(participant.maxDrainSeconds) || participant.maxDrainSeconds < 1 || participant.maxDrainSeconds > 300) {
      errors.push(`${owner}: maxDrainSeconds must be an integer between 1 and 300`)
    }
    if (participantNames.has(participant.name)) errors.push(`${owner}: duplicate name`)
    participantNames.add(participant.name)
    try {
      await access(path.join(ROOT, participant.source))
    } catch {
      errors.push(`${participant.source}: drain participant source does not exist`)
    }
  }

  const report = {
    schemaVersion: 'fsus.background-service-classification-check.v1',
    catalog: path.relative(ROOT, CATALOG_PATH).replaceAll(path.sep, '/'),
    discoveredCount: discovered.length,
    classifiedCount: catalogByType.size,
    drainParticipantCount: participantNames.size,
    passed: errors.length === 0,
    errors
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (errors.length > 0) process.exitCode = 1
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({
    schemaVersion: 'fsus.background-service-classification-check.v1',
    passed: false,
    errors: [error instanceof Error ? error.message : String(error)]
  }, null, 2)}\n`)
  process.exitCode = 1
})
