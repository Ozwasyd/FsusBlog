#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function validateCommandManifest(manifest) {
  const errors = []
  if (manifest?.schema !== 'fsusblog.test-command-manifest.v1') {
    errors.push('schema must be fsusblog.test-command-manifest.v1')
  }
  if (typeof manifest?.lane !== 'string' || !manifest.lane.trim()) {
    errors.push('lane must be a non-empty string')
  }
  if (!Array.isArray(manifest?.commands) || manifest.commands.length === 0) {
    errors.push('commands must be a non-empty array')
    return errors
  }

  const ids = new Set()
  for (const command of manifest.commands) {
    if (typeof command?.id !== 'string' || !command.id.trim()) errors.push('command id must be non-empty')
    else if (ids.has(command.id)) errors.push(`duplicate command id: ${command.id}`)
    else ids.add(command.id)
    if (!['read', 'write'].includes(command?.access)) errors.push(`${command?.id ?? 'unknown'}.access must be read or write`)
    const hasScript = typeof command?.script === 'string' && command.script.trim().length > 0
    const hasCommand = Array.isArray(command?.command) && command.command.length > 0 && command.command.every((part) => typeof part === 'string')
    if (hasScript === hasCommand) errors.push(`${command?.id ?? 'unknown'} must declare exactly one of script or command`)
  }
  return errors
}

export function resolveManifestWorkers({
  env = process.env,
  cpuCount = os.availableParallelism?.() ?? os.cpus().length,
  freeMemoryBytes = os.freemem(),
  load1 = os.loadavg()[0] ?? 0
} = {}) {
  const override = positiveInteger(env.FSUSBLOG_COMMAND_MANIFEST_WORKERS)
  if (override) return override
  const cpus = Math.max(1, Math.floor(Number(cpuCount) || 1))
  const memoryCap = Math.max(1, Math.floor((Number(freeMemoryBytes) || 0) / (768 * 1024 ** 2)))
  const loadCap = Math.max(1, Math.floor(cpus - Math.max(0, Number(load1) || 0)))
  return Math.max(1, Math.min(cpus, memoryCap, loadCap, 4))
}

function commandArguments(entry) {
  return entry.script
    ? ['npm', 'run', entry.script]
    : entry.command
}

async function execute(entry, { cwd, env }) {
  const command = commandArguments(entry)
  console.log(`[command-manifest] start id=${entry.id} access=${entry.access}`)
  const startedAt = Date.now()
  await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env,
      stdio: 'inherit'
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${entry.id} failed (${signal ? `signal ${signal}` : `exit ${code}`})`))
    })
  })
  console.log(`[command-manifest] done id=${entry.id} durationMs=${Date.now() - startedAt}`)
}

async function runReadOnly(commands, options) {
  const workers = resolveManifestWorkers({ env: options.env })
  for (let index = 0; index < commands.length; index += workers) {
    const batch = commands.slice(index, index + workers)
    const results = await Promise.allSettled(batch.map((command) => execute(command, options)))
    const failed = results.find((result) => result.status === 'rejected')
    if (failed) throw failed.reason
  }
}

export async function runCommandManifest(manifest, { cwd = process.cwd(), env = process.env } = {}) {
  const errors = validateCommandManifest(manifest)
  if (errors.length > 0) throw new Error(errors.join('; '))

  const readOnly = manifest.commands.filter((command) => command.access === 'read')
  const writing = manifest.commands.filter((command) => command.access === 'write')
  await runReadOnly(readOnly, { cwd, env })
  for (const command of writing) await execute(command, { cwd, env })
}

async function main(argv) {
  const manifestArgument = argv[0]
  if (!manifestArgument) throw new Error('usage: run-command-manifest.mjs <manifest.json> [--cwd path]')
  const cwdIndex = argv.indexOf('--cwd')
  const cwd = cwdIndex >= 0 ? path.resolve(argv[cwdIndex + 1] ?? '') : process.cwd()
  const manifestPath = path.resolve(cwd, manifestArgument)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await runCommandManifest(manifest, { cwd, env: process.env })
  console.log(`[command-manifest] ok lane=${manifest.lane} commands=${manifest.commands.length}`)
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[command-manifest] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
