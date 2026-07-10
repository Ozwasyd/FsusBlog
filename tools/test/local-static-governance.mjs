#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  executeManifestEntry,
  resolveManifestWorkers,
  validateCommandManifest
} from './run-command-manifest.mjs'
import { executeLimitedWave } from './bundles/wave-runner.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const orderedWriteScripts = new Set([
  'check:dom-depth-static',
  'check:route-asset-budget',
  'check:public-performance-batch'
])
const finalCommandIds = new Set(['views-constraints:public-performance-batch'])
const initialPriority = new Map([
  ['asset-size-budget', 0],
  ['views-constraints:dom-depth-static', 1],
  ['views-constraints:route-asset-budget', 2],
  ['historical-residue-fixture', 3],
  ['views-constraints:fsusui-typecheck-modes', 4],
  ['test-execution-optimization', 5]
])

export function extractChainedNpmScripts(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('views-constraints script is required')

  return [...value.matchAll(/(?:^|&&)\s*npm run ([A-Za-z0-9:_-]+)\s*/gu)].map((match) => match[1])
}

function viewsCoreCommand(value) {
  const [first] = value.split('&&', 1)
  const parts = first.trim().split(/\s+/u)
  if (parts.length !== 2 || parts[0] !== 'node' || !parts[1].endsWith('check-views-constraints.mjs')) {
    throw new Error('check:views-constraints must begin with its direct static checker')
  }
  return parts
}

export function buildLocalStaticManifest(staticManifest, scripts) {
  if (!Array.isArray(staticManifest?.commands)) throw new Error('static command manifest is required')
  const viewsEntry = staticManifest.commands.find((entry) => entry.id === 'views-constraints')
  if (viewsEntry?.script !== 'check:views-constraints') throw new Error('static manifest must contain check:views-constraints')

  const source = scripts?.['check:views-constraints']
  const chainedScripts = extractChainedNpmScripts(source)
  if (chainedScripts.length === 0) throw new Error('check:views-constraints must contain npm run checks')

  const expanded = [
    {
      id: 'views-constraints:core',
      command: viewsCoreCommand(source),
      access: 'read'
    },
    ...chainedScripts.map((script) => ({
      id: `views-constraints:${script.slice('check:'.length)}`,
      script,
      access: orderedWriteScripts.has(script) ? 'write' : 'read'
    }))
  ]

  return {
    ...staticManifest,
    lane: `${staticManifest.lane}:local-production`,
    commands: staticManifest.commands.flatMap((entry) => entry.id === 'views-constraints' ? expanded : [entry])
  }
}

export function planLocalStaticCommands(manifest) {
  const errors = validateCommandManifest(manifest)
  if (errors.length > 0) throw new Error(errors.join('; '))

  const initial = []
  const final = []
  for (const entry of manifest.commands) {
    if (finalCommandIds.has(entry.id)) final.push(entry)
    else initial.push(entry)
  }
  initial.sort((left, right) => {
    const leftPriority = initialPriority.get(left.id) ?? Number.MAX_SAFE_INTEGER
    const rightPriority = initialPriority.get(right.id) ?? Number.MAX_SAFE_INTEGER
    return leftPriority - rightPriority
  })
  if (final.length !== finalCommandIds.size) throw new Error('local static manifest is missing its dependent performance check')

  return { initial, final }
}

export async function runLocalStaticGovernance({ repoRoot = root, env = process.env } = {}) {
  const frontendRoot = path.join(repoRoot, 'src/frontend')
  const staticManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests/frontend/checks/static/manifest.json'), 'utf8'))
  const packageJson = JSON.parse(fs.readFileSync(path.join(frontendRoot, 'package.json'), 'utf8'))
  const manifest = buildLocalStaticManifest(staticManifest, packageJson.scripts)
  const plan = planLocalStaticCommands(manifest)
  const workers = resolveManifestWorkers({ env })
  const execute = (entry) => executeManifestEntry(entry, { cwd: frontendRoot, env })

  await executeLimitedWave(plan.initial, workers, execute)
  await executeLimitedWave(plan.final, workers, execute)
  return manifest
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url

if (isMain) {
  runLocalStaticGovernance().then((manifest) => {
    console.log(`[local-static-governance] ok commands=${manifest.commands.length}`)
  }).catch((error) => {
    console.error(`[local-static-governance] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
