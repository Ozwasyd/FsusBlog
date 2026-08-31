#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const verificationCommands = [
  ['dotnet', ['build', 'src/migration/FsusBlog.Migration.csproj', '-c', 'Release', '--no-restore']],
  ['dotnet', ['test', 'tests/migration/FsusBlog.Migration.Tests.csproj', '-c', 'Release', '--no-restore']]
]
const extractedSources = new Map([
  ['src/migration/ContentAssetCutoverBackfillStep.cs', ['src/backend/Infrastructure/SchemaMigration/ContentAssetCutoverBackfill.cs']],
  ['src/migration/OnlineSchemaBackfillPrimitives.cs', ['src/backend/Infrastructure/SchemaMigration/OnlineSchemaMigrationCoordinator.cs']],
  ['src/migration/SchemaMigrationExecution.cs', ['src/backend/Infrastructure/SchemaMigration/SchemaMigrationRunner.cs']],
  ['src/migration/Definitions/CommentRevisionMigrationRows.cs', [
    'src/backend/Entities/Comment.cs',
    'src/backend/Entities/CommentRevision.cs'
  ]]
])

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function walk(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const fullPath = join(directory, entry.name)
      if (entry.name === 'bin' || entry.name === 'obj') return []
      return entry.isDirectory() ? walk(fullPath) : [fullPath]
    })
}

function declaredSymbols(source) {
  const symbols = []
  const pattern = /\b(?:public|internal|private|protected)?\s*(?:sealed\s+|static\s+|abstract\s+|readonly\s+)*\b(?:class|interface|enum|struct|record(?:\s+(?:class|struct))?)\s+([A-Za-z_][A-Za-z0-9_]*)/g
  for (const match of source.matchAll(pattern)) symbols.push(match[1])
  return [...new Set(symbols)].sort()
}

function git(root, args, trim = true) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return result.status === 0 ? (trim ? result.stdout.trim() : result.stdout) : null
}

const legacyRegistryPath = 'src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs'

function resolveSourceBaseCommit(root, previousReceipt) {
  const candidates = [
    previousReceipt?.sourceTransition?.baseCommit,
    git(root, ['rev-parse', 'HEAD^']),
    git(root, ['merge-base', 'HEAD', 'origin/master']),
    git(root, ['rev-parse', 'HEAD'])
  ].filter((value, index, values) => typeof value === 'string' && value.length > 0 && values.indexOf(value) === index)
  for (const commit of candidates) {
    if (readOldSource(root, commit, legacyRegistryPath) !== null) return commit
  }
  return candidates[0] ?? 'unavailable'
}

function oldPathsFor(newPath) {
  if (extractedSources.has(newPath)) return extractedSources.get(newPath)
  if (newPath.startsWith('src/migration/Catalogs/') || newPath.startsWith('src/migration/Definitions/')) {
    return [newPath.replace('src/migration/', 'src/backend/Infrastructure/SchemaMigration/')]
  }
  const fileName = newPath.slice('src/migration/'.length)
  if (!fileName.includes('/') && [
    'AccountSubjectHashBackfillStep.cs',
    'DestructiveMigrationProofs.cs',
    'SchemaMigrationDdlPrimitives.cs',
    'SchemaMigrationManifest.cs',
    'SchemaMigrationPrimitives.cs',
    'SchemaMigrationRegistry.cs'
  ].includes(fileName)) {
    return [`src/backend/Infrastructure/SchemaMigration/${fileName}`]
  }
  return []
}

function readOldSource(root, baseCommit, path) {
  return git(root, ['show', `${baseCommit}:${path}`], false)
}

function transitionInventory(root, baseCommit, files, fallback = null) {
  const fallbackByPath = new Map((fallback?.files ?? []).map(item => [item.newPath, item]))
  const transitions = files
    .filter(file => file.path.endsWith('.cs'))
    .map(file => {
      const configuredOldPaths = oldPathsFor(file.path)
      const fallbackTransition = fallbackByPath.get(file.path)
      let historyAvailable = configuredOldPaths.length === 0
      const oldFiles = configuredOldPaths.map(path => {
        const source = readOldSource(root, baseCommit, path)
        if (source !== null) {
          historyAvailable = true
          return { path, sha256: sha256(source), symbols: declaredSymbols(source) }
        }
        return fallbackTransition?.oldFiles?.find(item => item.path === path) ?? null
      }).filter(Boolean)
      const oldSymbols = new Set(oldFiles.flatMap(item => item.symbols))
      return {
        newPath: file.path,
        newSha256: file.sha256,
        oldFiles,
        movedSymbols: file.symbols.filter(symbol => oldSymbols.has(symbol)),
        newSymbols: file.symbols.filter(symbol => !oldSymbols.has(symbol)),
        oldPathsDeleted: historyAvailable
          ? oldFiles.filter(item => !existsSync(join(root, item.path))).map(item => item.path)
          : (fallbackTransition?.oldPathsDeleted ?? [])
      }
    })
    .sort((left, right) => left.newPath.localeCompare(right.newPath))

  const oldFiles = transitions.flatMap(item => item.oldFiles)
    .filter((item, index, values) => values.findIndex(candidate => candidate.path === item.path) === index)
    .sort((left, right) => left.path.localeCompare(right.path))
  return {
    baseCommit,
    files: transitions,
    oldContentDigest: sha256(oldFiles.map(file => `${file.path}\0${file.sha256}`).join('\n')),
    deletedOldPaths: transitions.flatMap(item => item.oldPathsDeleted).sort()
  }
}

function validationResults(inputDigest, results = []) {
  const byCommand = new Map(results.map(result => [result.command, result]))
  return verificationCommands.map(([command, args]) => {
    const text = [command, ...args].join(' ')
    const existing = byCommand.get(text)
    return {
      command: text,
      status: existing?.status ?? 'not-run',
      exitCode: Number.isInteger(existing?.exitCode) ? existing.exitCode : null,
      inputDigest: existing?.inputDigest ?? inputDigest,
      summary: typeof existing?.summary === 'string' ? existing.summary : ''
    }
  })
}

export function buildReceipt(root = defaultRoot, options = {}) {
  const sourceRoot = join(root, 'src/migration')
  const files = walk(sourceRoot)
    .filter(file => file.endsWith('.cs') || file.endsWith('.csproj'))
    .map(file => {
      const content = readFileSync(file)
      const path = relative(root, file).replaceAll('\\', '/')
      return {
        path,
        sha256: sha256(content),
        symbols: file.endsWith('.cs') ? declaredSymbols(content.toString('utf8')) : []
      }
    })
    .sort((left, right) => left.path.localeCompare(right.path))
  const contentDigest = sha256(files.map(file => `${file.path}\0${file.sha256}`).join('\n'))
  const testFiles = walk(join(root, 'tests/migration'))
    .filter(file => file.endsWith('.cs') || file.endsWith('.csproj') || file.endsWith('.json'))
    .map(file => {
      const content = readFileSync(file)
      return {
        path: relative(root, file).replaceAll('\\', '/'),
        sha256: sha256(content)
      }
    })
    .sort((left, right) => left.path.localeCompare(right.path))
  const testContentDigest = sha256(testFiles.map(file => `${file.path}\0${file.sha256}`).join('\n'))
  const verificationInputDigest = sha256(`${contentDigest}\0${testContentDigest}`)
  const baseCommit = options.baseCommit
    ?? options.previousReceipt?.sourceTransition?.baseCommit
    ?? git(root, ['rev-parse', 'HEAD'])
    ?? 'unavailable'

  return {
    schema: 'fsusblog.migration-assembly-receipt.v2',
    identity: {
      oldProject: 'src/backend/FsusBlog.Server.csproj',
      oldAssembly: 'FsusBlog.Server',
      oldNamespace: 'FsusBlog.Server.Infrastructure.SchemaMigration',
      newProject: 'src/migration/FsusBlog.Migration.csproj',
      newAssembly: 'FsusBlog.Migration',
      newNamespace: 'FsusBlog.Migration',
      targetFramework: 'net10.0'
    },
    dependencies: {
      projectReferences: ['src/shared/FsusBlog.Shared.csproj'],
      providerPackages: ['SqlSugarCoreNoDrive']
    },
    files,
    sourceTransition: transitionInventory(root, baseCommit, files, options.previousReceipt?.sourceTransition),
    contentDigest,
    testFiles,
    testContentDigest,
    verificationInputDigest,
    verificationResults: validationResults(verificationInputDigest, options.verificationResults)
  }
}

export function receiptPath(root = defaultRoot) {
  return join(root, 'artifacts/schema-migration/migration-assembly-receipt.json')
}

export function bindingPath(root = defaultRoot) {
  return join(root, 'artifacts/schema-migration/migration-assembly-binding.json')
}

export function buildBinding(receipt) {
  const receiptContent = serialized(receipt)
  return {
    schema: 'fsusblog.migration-assembly-binding.v1',
    receipt: 'artifacts/schema-migration/migration-assembly-receipt.json',
    receiptSha256: sha256(receiptContent),
    sourceContentDigest: receipt.contentDigest,
    testContentDigest: receipt.testContentDigest,
    verificationInputDigest: receipt.verificationInputDigest,
    sourceBaseCommit: receipt.sourceTransition.baseCommit,
    movedFileCount: receipt.sourceTransition.files.filter(item => item.oldFiles.length > 0).length,
    deletedOldPathCount: receipt.sourceTransition.deletedOldPaths.length,
    verificationDigest: sha256(receipt.verificationResults.map(result =>
      `${result.command}\0${result.status}\0${result.exitCode}\0${result.inputDigest}`).join('\n'))
  }
}

function serialized(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function summarize(output, root) {
  return output.replaceAll(root, '<repo>')
    .split(/\r?\n/u).map(line => line.trim()).filter(Boolean).slice(-3).join(' | ').slice(0, 1000)
}

function executeVerification(root, inputDigest) {
  return verificationCommands.map(([command, args]) => {
    const result = spawnSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PublishClientAssets: 'false' }
    })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    process.stdout.write(output)
    return {
      command: [command, ...args].join(' '),
      status: result.status === 0 ? 'passed' : 'failed',
      exitCode: result.status,
      inputDigest,
      summary: summarize(output, root)
    }
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rootIndex = process.argv.indexOf('--root')
  const root = rootIndex >= 0 ? resolve(process.argv[rootIndex + 1]) : defaultRoot
  const receiptOutput = receiptPath(root)
  const bindingOutput = bindingPath(root)
  const previousReceipt = existsSync(receiptOutput) ? JSON.parse(readFileSync(receiptOutput, 'utf8')) : null
  let receipt = buildReceipt(root, { previousReceipt })

  if (process.argv.includes('--write')) {
    const results = executeVerification(root, receipt.verificationInputDigest)
    if (results.some(result => result.status !== 'passed')) {
      console.error('[migration-assembly-receipt] independent build/test verification failed; receipt was not written')
      process.exitCode = 1
    } else {
      receipt = buildReceipt(root, {
        baseCommit: resolveSourceBaseCommit(root, previousReceipt),
        previousReceipt,
        verificationResults: results
      })
      const binding = buildBinding(receipt)
      mkdirSync(dirname(receiptOutput), { recursive: true })
      writeFileSync(receiptOutput, serialized(receipt))
      writeFileSync(bindingOutput, serialized(binding))
      console.log(`[migration-assembly-receipt] wrote ${relative(root, receiptOutput)}`)
      console.log(`[migration-assembly-receipt] wrote ${relative(root, bindingOutput)}`)
    }
  } else {
    const expectedReceipt = serialized(buildReceipt(root, {
      previousReceipt,
      verificationResults: previousReceipt?.verificationResults ?? []
    }))
    const expectedBinding = previousReceipt ? serialized(buildBinding(JSON.parse(expectedReceipt))) : ''
    const stale = !existsSync(receiptOutput)
      || readFileSync(receiptOutput, 'utf8') !== expectedReceipt
      || !existsSync(bindingOutput)
      || readFileSync(bindingOutput, 'utf8') !== expectedBinding
    if (stale) {
      console.error('[migration-assembly-receipt] receipt or binding is missing/stale; run with --write')
      process.exitCode = 1
    } else {
      console.log('[migration-assembly-receipt] ok')
    }
  }
}
